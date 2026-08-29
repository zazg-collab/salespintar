const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const password = await bcrypt.hash('ciabot', 10);
  const business = await prisma.business.create({
    data: {
      name: 'SalesPintar MVP',
      slug: 'salespintar-mvp',
      isActive: true,
      users: {
        create: {
          name: 'Angga Fatih',
          email: 'angga.movi@gmail.com',
          password: password,
          role: 'ADMIN'
        }
      }
    }
  });
  console.log('User created:', business);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
