import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import * as authService from '../services/auth.service';

const router = Router();

router.post('/register', validate(authService.registerSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await authService.register(req.body);
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

router.post('/login', validate(authService.loginSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await authService.login(req.body);
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
    if (!refreshToken) return res.status(401).json({ error: { message: 'Refresh token required' } });
    const result = await authService.refreshTokens(refreshToken);
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/logout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) await authService.logout(refreshToken);
    res.clearCookie('refreshToken');
    res.json({ message: 'Logged out' });
  } catch (err) { next(err); }
});

router.get('/sessions', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessions = await authService.getSessions(req.user!.userId, req.user!.businessId);
    res.json(sessions);
  } catch (err) { next(err); }
});

router.delete('/sessions/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await authService.revokeSession(req.params.id as string, req.user!.userId, req.user!.businessId);
    res.json({ message: 'Session revoked' });
  } catch (err) { next(err); }
});

router.post('/accept-invite', validate(authService.acceptInviteSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await authService.acceptInvite(req.body);
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/invite', authenticate, authorize('ADMIN'), validate(authService.inviteSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await authService.inviteUser(req.user!.businessId, req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

export default router;
