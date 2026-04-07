const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function migrate() {
  console.log("🚀 Starting Profile Migration...");

  try {
    const users = await prisma.user.findMany({
      include: { profile: true },
    });

    console.log(`🔍 Found ${users.length} users. Checking for missing profiles...`);

    let createdCount = 0;
    let skipCount = 0;

    for (const user of users) {
      if (!user.profile) {
        console.log(`➕ Creating missing profile for user: ${user.email}`);
        
        // Attempt to extract a default name from email if name is missing
        const defaultName = user.email.split("@")[0];

        await prisma.profile.create({
          data: {
            userId: user.id,
            name: defaultName,
            // Set sensible defaults for a professional invoice experience
            invoiceIncludeName: true,
            invoiceIncludeCompanyName: true,
            invoiceIncludeAddress: true,
            invoiceIncludeCompanyPhone: true,
            defaultCurrency: "MYR",
            invoicePrefix: "INV",
          },
        });
        createdCount++;
      } else {
        skipCount++;
      }
    }

    console.log("\n✅ Migration Complete!");
    console.log(`📊 Stats:`);
    console.log(`   - Profiles Created: ${createdCount}`);
    console.log(`   - Profiles Skipped (Already Exists): ${skipCount}`);

  } catch (error) {
    console.error("❌ Migration Failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

migrate();
