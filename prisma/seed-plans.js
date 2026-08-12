/**
 * Seeds the Plan table.
 *
 * THIS FILE UPSERTS OVER LIVE ROWS. `update: plan` means every field listed
 * here is written to an existing plan, so anything stale in it is not a
 * harmless default — it is a silent rollback of whatever migration last set
 * that column. Two ways that has already nearly happened, both fixed here:
 *
 *   1. `price` is SEN. It was RM until migration 20260807190000 converted every
 *      money column, and this file was not updated — so seeding a migrated
 *      database would have priced Pro at 59 sen. RM 0.59 a month, upserted over
 *      the real price, with the Xendit plan still billing the old amount.
 *
 *   2. The limits here predated spec 01. Running this would have taken paid
 *      plans off unlimited invoices, email and AI and back to metered caps,
 *      while leaving `chasedInvoices` untouched — a half-migrated state that
 *      enforces caps the pricing page says do not exist.
 *
 * If you change a limit, change it in the admin panel or in a migration. This
 * file exists to bring a BLANK database to the current shape, and it has to
 * agree with the migrations for that to mean anything.
 *
 * `waSends` / `waReminders` are kept only because the columns still exist.
 * Nothing reads them any more: metering moved to chased invoices, and chase.js
 * gates on `chasedInvoices` plus `waPerInvoiceCap`.
 */

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

/** The app's "no limit" sentinel: at or above this, no check is applied. */
const UNLIMITED = 999999;

async function main() {
  const plans = [
    {
      name: "FREE",
      description: "For starters",
      price: 0,
      currency: "MYR",
      interval: "month",
      waSends: 0,
      emailSends: 5,
      aiCredits: 2,
      waReminders: 0,
      emailReminders: 0,
      invoices: 5,
      quotes: 5,
      /* No monthly chase allowance, but a one-time grant of 3 so a free account
         can watch one full chase cycle complete before deciding. */
      chasedInvoices: 0,
      trialChases: 3,
      features: [
        "5 Invoices/mo",
        "5 Email Deliveries/mo",
        "2 AI Drafts/mo",
        "3 Chased Invoices (one-time trial)",
      ],
      isActive: true,
    },
    {
      name: "PRO",
      description: "Perfect for active freelancers",
      price: 2900,
      currency: "MYR",
      interval: "month",
      waSends: 50,
      emailSends: UNLIMITED,
      /* A fair-use ceiling, not a withheld feature — high enough that drafting
         every invoice never reaches it. "Unlimited" is what Max buys. */
      aiCredits: 50,
      waReminders: 50,
      emailReminders: UNLIMITED,
      invoices: UNLIMITED,
      quotes: UNLIMITED,
      chasedInvoices: 25,
      trialChases: 0,
      features: [
        "25 Chased Invoices/mo",
        "Unlimited Invoices & Quotations",
        "Unlimited Email Deliveries & Reminders",
        "50 AI Drafts/mo",
        "Auto-Chaser",
      ],
      isActive: true,
    },
    {
      name: "MAX",
      description: "Power users",
      price: 4900,
      currency: "MYR",
      interval: "month",
      waSends: 100,
      emailSends: UNLIMITED,
      aiCredits: UNLIMITED,
      waReminders: 100,
      emailReminders: UNLIMITED,
      invoices: UNLIMITED,
      quotes: UNLIMITED,
      chasedInvoices: 75,
      trialChases: 0,
      features: [
        "75 Chased Invoices/mo",
        "Unlimited Invoices & Quotations",
        "Unlimited Email Deliveries & Reminders",
        "Unlimited AI Drafts",
        "Auto-Chaser",
        /* Enforced in utils/attribution.js, which denylists FREE and PRO. */
        'Remove "Sent with InvoKita"',
      ],
      isActive: true,
    },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { name: plan.name },
      update: plan,
      create: plan,
    });
  }

  console.log("Plans seeded successfully");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
