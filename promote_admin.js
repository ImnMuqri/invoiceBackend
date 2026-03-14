const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function promoteToAdmin(email) {
  if (!email) {
    console.error('Please provide an email address.');
    console.log('Usage: node promote_admin.js <email>');
    process.exit(1);
  }

  try {
    const user = await prisma.user.update({
      where: { email },
      data: { role: 'ADMIN' },
    });
    console.log(`Successfully promoted ${user.name} (${user.email}) to ADMIN.`);
  } catch (error) {
    if (error.code === 'P2025') {
      console.error(`User with email "${email}" not found.`);
    } else {
      console.error('An error occurred:', error.message);
    }
  } finally {
    await prisma.$disconnect();
  }
}

const email = process.argv[2];
promoteToAdmin(email);
