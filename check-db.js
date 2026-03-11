const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  try {
    const result = await prisma.$queryRaw`
      SELECT column_name, data_type, udt_name 
      FROM information_schema.columns 
      WHERE table_name = 'User'
    `;
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("Error fetching info:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
