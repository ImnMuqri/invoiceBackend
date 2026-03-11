const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Create some clients
  const client1 = await prisma.client.upsert({
    where: { id: "CLI-001" },
    update: {},
    create: {
      id: "CLI-001",
      name: "Acme Corp",
      email: "billing@acmecorp.com",
      company: "Acme Corp LLC",
      riskScore: 15,
      averageDelayDays: 2,
      totalRevenue: 45000,
      profitMargin: 35,
      status: "Active",
    },
  });

  const client2 = await prisma.client.upsert({
    where: { id: "CLI-002" },
    update: {},
    create: {
      id: "CLI-002",
      name: "Stark Industries",
      email: "tony@stark.com",
      company: "Stark Industries",
      riskScore: 85,
      averageDelayDays: 45,
      totalRevenue: 120000,
      profitMargin: 10,
      status: "Active",
    },
  });

  const client3 = await prisma.client.upsert({
    where: { id: "CLI-003" },
    update: {},
    create: {
      id: "CLI-003",
      name: "Wayne Enterprises",
      email: "finance@wayne.com",
      company: "Wayne Enterprises",
      riskScore: 40,
      averageDelayDays: 12,
      totalRevenue: 85000,
      profitMargin: 25,
      status: "Active",
    },
  });

  // Create some invoices
  await prisma.invoice.upsert({
    where: { id: "INV-2023-001" },
    update: {},
    create: {
      id: "INV-2023-001",
      clientId: client1.id,
      date: new Date("2023-10-01"),
      dueDate: new Date("2023-10-15"),
      amount: 5000,
      status: "Paid",
      currency: "MYR",
      latePrediction: "Low",
      riskScore: 12,
      whatsappStatus: "Not Sent",
    },
  });

  await prisma.invoice.upsert({
    where: { id: "INV-2023-002" },
    update: {},
    create: {
      id: "INV-2023-002",
      clientId: client2.id,
      date: new Date("2023-11-01"),
      dueDate: new Date("2023-11-15"),
      amount: 25000,
      status: "Overdue",
      currency: "MYR",
      latePrediction: "High",
      riskScore: 88,
      predictedDelayDays: 14,
      whatsappStatus: "Not Sent",
    },
  });

  await prisma.invoice.upsert({
    where: { id: "INV-2023-003" },
    update: {},
    create: {
      id: "INV-2023-003",
      clientId: client3.id,
      date: new Date("2023-11-20"),
      dueDate: new Date("2023-12-05"),
      amount: 12000,
      status: "Pending",
      currency: "MYR",
      latePrediction: "Medium",
      riskScore: 45,
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
