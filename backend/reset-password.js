const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const password = await bcrypt.hash('ciabot123', 10);
  
  await prisma.user.updateMany({
    where: { email: 'angga.movi@gmail.com' },
    data: { password: password }
  });
  
  console.log('Password updated successfully to: ciabot');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
