const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

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
      features: ["5 Invoices/mo", "5 Email Deliveries/mo"],
      isActive: true,
    },
    {
      name: "PRO",
      description: "Perfect for freelancers",
      price: 59,
      currency: "MYR",
      interval: "month",
      waSends: 50,
      emailSends: 100,
      aiCredits: 20,
      waReminders: 50,
      emailReminders: 100,
      invoices: 100,
      features: [
        "100 Invoices/mo",
        "50 WhatsApp Sends & Reminders",
        "100 Email Deliveries & Reminders",
        "20 AI Drafts/mo",
        "Auto-Chaser",
      ],
      isActive: true,
    },
    {
      name: "MAX",
      description: "Power users",
      price: 99,
      currency: "MYR",
      interval: "month",
      waSends: 100,
      emailSends: 999999,
      aiCredits: 100,
      waReminders: 100,
      emailReminders: 999999,
      invoices: 999999,
      features: [
        "Unlimited Invoices/mo",
        "100 WhatsApp Sends & Reminders",
        "Unlimited Email Deliveries & Reminders",
        "100 AI Drafts/mo",
        "Auto-Chaser",
        "White Labelling",
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
