import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://salespintar:salespintar@localhost:5432/salespintar'
    }
  }
});

async function main() {
  const email = 'angga.movi@gmail.com';
  const password = 'ciabot';
  const hashedPassword = await bcrypt.hash(password, 10);

  const business = await prisma.business.create({
    data: {
      name: 'Bisnis Angga',
      slug: 'bisnis-angga-' + Date.now(),
      users: {
        create: {
          name: 'Angga',
          email: email,
          password: hashedPassword,
          role: 'ADMIN',
        }
      }
    }
  });

  console.log(`Successfully injected user ${email} for business ${business.name}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
