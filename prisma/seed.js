const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Create a default user if none exists
  const defaultUser = await prisma.user.upsert({
    where: { email: "admin@invokita.com" },
    update: {},
    create: {
      email: "admin@invokita.com",
      password: "hashed_password_here", // In a real app, use bcrypt
      plan: "PRO",
      role: "ADMIN",
      onboardingCompleted: true,
    },
  });

  // Create some clients
  const client1 = await prisma.client.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      name: "Acme Corp",
      email: "billing@acmecorp.com",
      company: "Acme Corp LLC",
      averageDelayDays: 2,
      totalRevenue: 45000,
      profitMargin: 35,
      status: "Active",
      userId: defaultUser.id,
    },
  });

  const client2 = await prisma.client.upsert({
    where: { id: 2 },
    update: {},
    create: {
      id: 2,
      name: "Stark Industries",
      email: "tony@stark.com",
      company: "Stark Industries",
      averageDelayDays: 45,
      totalRevenue: 120000,
      profitMargin: 10,
      status: "Active",
      userId: defaultUser.id,
    },
  });

  const client3 = await prisma.client.upsert({
    where: { id: 3 },
    update: {},
    create: {
      id: 3,
      name: "Wayne Enterprises",
      email: "finance@wayne.com",
      company: "Wayne Enterprises",
      averageDelayDays: 12,
      totalRevenue: 85000,
      profitMargin: 25,
      status: "Active",
      userId: defaultUser.id,
    },
  });

  // Create some invoices
  await prisma.invoice.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      clientId: client1.id,
      userId: defaultUser.id,
      date: new Date("2023-10-01"),
      dueDate: new Date("2023-10-15"),
      amount: 5000,
      status: "Paid",
      currency: "MYR",
      latePrediction: "Low",
      whatsappStatus: "Not Sent",
    },
  });

  await prisma.invoice.upsert({
    where: { id: 2 },
    update: {},
    create: {
      id: 2,
      clientId: client2.id,
      userId: defaultUser.id,
      date: new Date("2023-11-01"),
      dueDate: new Date("2023-11-15"),
      amount: 25000,
      status: "Overdue",
      currency: "MYR",
      latePrediction: "High",
      predictedDelayDays: 14,
      whatsappStatus: "Not Sent",
    },
  });

  await prisma.invoice.upsert({
    where: { id: 3 },
    update: {},
    create: {
      id: 3,
      clientId: client3.id,
      userId: defaultUser.id,
      date: new Date("2023-11-20"),
      dueDate: new Date("2023-12-05"),
      amount: 12000,
      status: "Pending",
      currency: "MYR",
      latePrediction: "Medium",
      predictedDelayDays: 3,
      whatsappStatus: "Sent",
    },
  });

  console.log("Seeding completed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
