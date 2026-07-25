import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { hashPassword, comparePassword, signAccessToken, signRefreshToken, verifyRefreshToken, hashRefreshToken } from '../utils/crypto';
import { ConflictError, UnauthorizedError, NotFoundError } from '../utils/errors';
import { env } from '../config/env';

const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export const registerSchema = z.object({
  businessName: z.string().min(2).max(200),
  name: z.string().min(2).max(100),
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(128),
});

export const inviteSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email().max(255),
  role: z.enum(['SALES']).default('SALES'),
});

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

export async function register(data: z.infer<typeof registerSchema>) {
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw new ConflictError('Email already registered');

  const baseSlug = generateSlug(data.businessName);
  let slug = baseSlug;
  let counter = 1;
  while (await prisma.business.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  const business = await prisma.business.create({
    data: {
      name: data.businessName,
      slug,
      aiConfig: {},
      settings: { timezone: 'Asia/Jakarta', language: 'id' },
    },
  });

  const passwordHash = await hashPassword(data.password);

  const user = await prisma.user.create({
    data: {
      businessId: business.id,
      name: data.name,
      email: data.email,
      password: passwordHash,
      role: 'ADMIN',
    },
  });

  const payload = { userId: user.id, businessId: business.id, role: user.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

  await prisma.session.create({
    data: {
      businessId: business.id,
      userId: user.id,
      refreshToken: hashRefreshToken(refreshToken),
      expiresAt,
    },
  });

  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    business: { id: business.id, name: business.name, slug: business.slug },
    accessToken,
    refreshToken,
  };
}

export async function login(data: z.infer<typeof loginSchema>) {
  const user = await prisma.user.findUnique({
    where: { email: data.email },
    include: { business: true },
  });

  if (!user) throw new UnauthorizedError('Invalid email or password');
  if (!user.isActive) throw new UnauthorizedError('Account is inactive');
  if (!user.business.isActive) throw new UnauthorizedError('Business account is inactive');

  const valid = await comparePassword(data.password, user.password);
  if (!valid) throw new UnauthorizedError('Invalid email or password');

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const payload = { userId: user.id, businessId: user.businessId, role: user.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

  await prisma.session.create({
    data: {
      businessId: user.businessId,
      userId: user.id,
      refreshToken: hashRefreshToken(refreshToken),
      expiresAt,
    },
  });

  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    business: { id: user.business.id, name: user.business.name, slug: user.business.slug },
    accessToken,
    refreshToken,
  };
}

export async function refreshTokens(refreshToken: string) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new UnauthorizedError('Invalid refresh token');
  }

  const hashedToken = hashRefreshToken(refreshToken);

  const session = await prisma.session.findUnique({
    where: { refreshToken: hashedToken },
    include: { user: { include: { business: true } } },
  });

  if (!session) throw new UnauthorizedError('Refresh token not found');
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } });
    throw new UnauthorizedError('Refresh token expired');
  }

  if (!session.user.isActive) throw new UnauthorizedError('Account inactive');
  if (!session.user.business.isActive) throw new UnauthorizedError('Business inactive');

  await prisma.session.delete({ where: { id: session.id } });

  const newPayload = {
    userId: session.user.id,
    businessId: session.user.businessId,
    role: session.user.role,
  };
  const newAccessToken = signAccessToken(newPayload);
  const newRefreshToken = signRefreshToken(newPayload);

  await prisma.session.create({
    data: {
      businessId: session.businessId,
      userId: session.userId,
      refreshToken: hashRefreshToken(newRefreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS),
    },
  });

  return { accessToken: newAccessToken, refreshToken: newRefreshToken };
}

export async function logout(refreshToken: string) {
  const hashedToken = hashRefreshToken(refreshToken);
  const session = await prisma.session.findUnique({
    where: { refreshToken: hashedToken },
  });
  if (session) {
    await prisma.session.delete({ where: { id: session.id } });
  }
}

export async function getSessions(userId: string, businessId: string) {
  return prisma.session.findMany({
    where: { userId, businessId },
    select: {
      id: true,
      userAgent: true,
      ipAddress: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function revokeSession(sessionId: string, userId: string, businessId: string) {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId, businessId },
  });
  if (!session) throw new NotFoundError('Session');
  await prisma.session.delete({ where: { id: session.id } });
}

export async function acceptInvite(data: z.infer<typeof acceptInviteSchema>) {
  const user = await prisma.user.findFirst({
    where: { inviteToken: data.token, isActive: true },
  });
  if (!user) throw new UnauthorizedError('Invalid or expired invite token');

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: await hashPassword(data.password),
      inviteToken: null,
    },
  });

  const payload = { userId: user.id, businessId: user.businessId, role: user.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

  await prisma.session.create({
    data: {
      businessId: user.businessId,
      userId: user.id,
      refreshToken: hashRefreshToken(refreshToken),
      expiresAt,
    },
  });

  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    accessToken,
    refreshToken,
  };
}

export async function inviteUser(businessId: string, data: z.infer<typeof inviteSchema>) {
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw new ConflictError('Email already registered');

  const inviteToken = crypto.randomBytes(32).toString('hex');
  const invitedPassword = crypto.randomBytes(8).toString('hex');

  const user = await prisma.user.create({
    data: {
      businessId,
      name: data.name,
      email: data.email,
      password: await hashPassword(invitedPassword),
      role: data.role,
      inviteToken,
    },
  });

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    inviteToken,
    message: 'User invited. Share the invite token with them to set their password.',
  };
}
