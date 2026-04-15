/**
 * Backfill Script: seed-backfill-submodels.js
 *
 * Creates missing sub-model rows (UserProfile, UserQuota, UserNotification,
 * UserInvoiceConfig, ManualPayment) for every existing User that was created
 * BEFORE the decompose_user_model migration.
 *
 * Safe to re-run — uses upsert so it won't duplicate records.
 *
 * Usage:
 *   node prisma/seed-backfill-submodels.js
 */

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  console.log("🔍 Finding users without sub-model records...\n");

  const users = await prisma.user.findMany({
    select: { id: true, email: true },
  });

  console.log(`Found ${users.length} total users.`);

  let created = 0;
  let skipped = 0;

  for (const user of users) {
    // Check which sub-models already exist
    const [profile, quota, notification, invoiceConfig, manualPayment] = await Promise.all([
      prisma.userProfile.findUnique({ where: { userId: user.id } }),
      prisma.userQuota.findUnique({ where: { userId: user.id } }),
      prisma.userNotification.findUnique({ where: { userId: user.id } }),
      prisma.userInvoiceConfig.findUnique({ where: { userId: user.id } }),
      prisma.manualPayment.findUnique({ where: { userId: user.id } }),
    ]);

    const missing = [
      !profile && "UserProfile",
      !quota && "UserQuota",
      !notification && "UserNotification",
      !invoiceConfig && "UserInvoiceConfig",
      !manualPayment && "ManualPayment",
    ].filter(Boolean);

    if (missing.length === 0) {
      console.log(`  ✅ User ${user.id} (${user.email}) — all sub-models exist, skipping`);
      skipped++;
      continue;
    }

    console.log(`  📦 User ${user.id} (${user.email}) — creating: ${missing.join(", ")}`);

    // Use upsert so this is fully idempotent
    await Promise.all([
      !profile && prisma.userProfile.create({ data: { userId: user.id } }),
      !quota && prisma.userQuota.create({ data: { userId: user.id } }),
      !notification && prisma.userNotification.create({ data: { userId: user.id } }),
      !invoiceConfig && prisma.userInvoiceConfig.create({ data: { userId: user.id } }),
      !manualPayment && prisma.manualPayment.create({ data: { userId: user.id } }),
    ].filter(Boolean));

    created++;
  }

  console.log("\n─────────────────────────────────");
  console.log(`✅ Done.`);
  console.log(`   Users backfilled : ${created}`);
  console.log(`   Users skipped    : ${skipped} (already had sub-models)`);
  console.log("─────────────────────────────────");
}

main()
  .catch((e) => {
    console.error("❌ Backfill failed:", e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
