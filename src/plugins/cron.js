const fp = require("fastify-plugin");
const cron = require("node-cron");
const { createNotification } = require("../utils/notificationUtils");

async function cronPlugin(fastify, opts) {
  // Function to process reminders
  const processReminders = async () => {
    fastify.log.info("Starting automated reminders chaser...");

    try {
      const now = new Date();

      // 1. Find users who have automated reminders enabled via UserNotification
      const users = await fastify.prisma.user.findMany({
        where: {
          plan: { in: ["PRO", "MAX"] },
          notification: {
            globalAutoChaser: true,
            OR: [
              { reminderInterval: { not: 0 } },
              { whatsappReminderInterval: { not: 0 } },
            ],
          },
        },
        select: {
          id: true,
          plan: true,
          profile: { select: { name: true, companyName: true } },
          notification: true,
        },
      });

      fastify.log.info(
        `Found ${users.length} users with automated reminders enabled.`,
      );

      for (const user of users) {
        // 2. Find pending/overdue invoices for this user
        const pendingInvoices = await fastify.prisma.invoice.findMany({
          where: {
            userId: user.id,
            status: { in: ["Pending", "Overdue"] },
            client: {
              OR: [{ autoChaser: true }, { autoEmailChaser: true }],
            },
          },
          include: { client: true },
        });

        for (const invoice of pendingInvoices) {
          const dueDate = new Date(invoice.dueDate);
          const today = new Date(now);
          today.setHours(0, 0, 0, 0);

          const notif = user.notification || {};

          // --- 3a. Process Email Reminder ---
          if (notif.reminderInterval !== 0 && invoice.client.autoEmailChaser) {
            let shouldRemindEmail = false;
            const interval = notif.reminderInterval;

            if (interval < 0) {
              const daysBefore = Math.abs(interval);
              const targetDate = new Date(dueDate);
              targetDate.setDate(targetDate.getDate() - daysBefore);
              targetDate.setHours(0, 0, 0, 0);

              if (today >= targetDate && today < dueDate) {
                if (
                  !invoice.emailLastReminderSent ||
                  invoice.emailLastReminderSent < targetDate
                ) {
                  shouldRemindEmail = true;
                }
              }
            } else if (interval > 0 && now > dueDate) {
              if (!invoice.emailLastReminderSent) {
                shouldRemindEmail = true;
              } else {
                const diffDays = Math.ceil(
                  Math.abs(now - invoice.emailLastReminderSent) /
                    (1000 * 60 * 60 * 24),
                );
                if (diffDays >= interval) shouldRemindEmail = true;
              }
            }

            if (shouldRemindEmail) {
              await sendEmailReminder(user, invoice);
            }
          }

          // --- 3b. Process WhatsApp Reminder ---
          if (
            notif.whatsappReminderInterval !== 0 &&
            invoice.client.autoChaser
          ) {
            let shouldRemindWa = false;
            const interval = notif.whatsappReminderInterval;

            if (interval < 0) {
              const daysBefore = Math.abs(interval);
              const targetDate = new Date(dueDate);
              targetDate.setDate(targetDate.getDate() - daysBefore);
              targetDate.setHours(0, 0, 0, 0);

              if (today >= targetDate && today < dueDate) {
                if (
                  !invoice.whatsappLastReminderSent ||
                  invoice.whatsappLastReminderSent < targetDate
                ) {
                  shouldRemindWa = true;
                }
              }
            } else if (interval > 0 && now > dueDate) {
              if (!invoice.whatsappLastReminderSent) {
                shouldRemindWa = true;
              } else {
                const diffDays = Math.ceil(
                  Math.abs(now - invoice.whatsappLastReminderSent) /
                    (1000 * 60 * 60 * 24),
                );
                if (diffDays >= interval) shouldRemindWa = true;
              }
            }

            if (shouldRemindWa) {
              await sendWaReminder(user, invoice);
            }
          }
        }
      }
    } catch (error) {
      fastify.log.error("Error in cron reminder job: " + error.message);
    }
  };

  const sendEmailReminder = async (user, invoice) => {
    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000")
      .replace(/['"]/g, "")
      .replace(/\/$/, "");
    const invoiceUrl = `${frontendUrl}/pay/${invoice.id}`;
    const profile = user.profile || {};

    try {
      await fastify.usage.checkAndIncrement(user.id, "emailReminder");

      const { getInvoiceEmailTemplate } = require("../utils/emailTemplates");
      const html = getInvoiceEmailTemplate({
        clientName: invoice.client.name,
        senderName: profile.name || "Our Company",
        senderCompany: profile.companyName,
        invoiceNumber: invoice.invoiceNumber || `#${invoice.id}`,
        amount: invoice.amount,
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        status: "Payment Reminder",
        publicUrl: invoiceUrl,
      });

      await fastify.email.send({
        to: invoice.client.email,
        subject: `Reminder: Invoice #${invoice.invoiceNumber || invoice.id} from ${profile.companyName || profile.name}`,
        html,
      });

      await fastify.prisma.invoice.update({
        where: { id: invoice.id },
        data: { emailLastReminderSent: new Date() },
      });

      // Notify App
      await createNotification(fastify.prisma, user.id, "Email Sent", `Automated email reminder sent to ${invoice.client.name} for invoice ${invoice.invoiceNumber || invoice.id}.`, "EMAIL_SENT");

      fastify.log.info(
        `Auto Email Reminder sent for Invoice #${invoice.invoiceNumber}`,
      );
    } catch (err) {
      fastify.log.error(`Auto Email failed for #${invoice.id}: ${err.message}`);
    }
  };

  const sendWaReminder = async (user, invoice) => {
    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000")
      .replace(/['"]/g, "")
      .replace(/\/$/, "");
    const invoiceUrl = `${frontendUrl}/pay/${invoice.id}`;
    const notif = user.notification || {};
    const profile = user.profile || {};

    try {
      await fastify.usage.checkAndIncrement(user.id, "waReminder");

      const template =
        notif.whatsappReminderTemplate ||
        "Friendly reminder for {{clientName}}: Your invoice {{invoiceNumber}} ({{totalAmount}} {{currency}}) is due on {{dueDate}}. View: {{invoiceUrl}}";
      const message = template
        .replace(/{{userName}}/g, profile.name || "")
        .replace(/{{companyName}}/g, profile.companyName || "InvoKita User")
        .replace(/{{clientName}}/g, invoice.client.name)
        .replace(/{{invoiceNumber}}/g, invoice.invoiceNumber || invoice.id)
        .replace(/{{totalAmount}}/g, invoice.amount.toLocaleString())
        .replace(/{{currency}}/g, invoice.currency)
        .replace(/{{invoiceUrl}}/g, invoiceUrl)
        .replace(
          /{{dueDate}}/g,
          new Date(invoice.dueDate).toLocaleDateString(),
        );

      let credentials = null;
      if (notif.whatsappMode === "CUSTOM") {
        credentials = {
          sid: notif.twilioSid,
          token: notif.twilioAuthToken,
          phoneNumber: notif.twilioPhoneNumber,
        };
      }

      await fastify.whatsapp.sendMessage(
        invoice.client.phone,
        message,
        credentials,
      );

      await fastify.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          whatsappLastReminderSent: new Date(),
          whatsappStatus: "Sent Reminder",
        },
      });
      
      // Notify App
      await createNotification(fastify.prisma, user.id, "WhatsApp Sent", `Automated WhatsApp reminder sent to ${invoice.client.name} for invoice ${invoice.invoiceNumber || invoice.id}.`, "WHATSAPP_SENT");

      fastify.log.info(
        `Auto WA Reminder sent for Invoice #${invoice.invoiceNumber}`,
      );
    } catch (err) {
      fastify.log.error(`Auto WA failed for #${invoice.id}: ${err.message}`);
    }
  };

  // Function to mark invoices as overdue
  const markOverdueInvoices = async () => {
    fastify.log.info("Starting automated overdue status update...");
    try {
      const now = new Date();
      const overdueInvoices = await fastify.prisma.invoice.findMany({
        where: {
          status: { in: ["Pending", "Partially Paid"] },
          dueDate: { lt: now },
        },
        include: { client: true },
      });

      if (overdueInvoices.length > 0) {
        await fastify.prisma.invoice.updateMany({
          where: {
            id: { in: overdueInvoices.map(inv => inv.id) }
          },
          data: {
            status: "Overdue",
          },
        });

        // Notify App for each overdue invoice
        for (const inv of overdueInvoices) {
          await createNotification(fastify.prisma, inv.userId, "Invoice Overdue", `Invoice ${inv.invoiceNumber || inv.id} for ${inv.client?.name || "client"} is now overdue.`, "OVERDUE");
        }

        fastify.log.info(`Updated ${overdueInvoices.length} invoices to Overdue status.`);
      }
    } catch (error) {
      fastify.log.error("Error in overdue update job: " + error.message);
    }
  };

  // Schedule cron jobs
  // Daily at 9 AM: Reminders
  cron.schedule("0 9 * * *", processReminders);

  // Daily at 1 AM: Overdue status updates
  cron.schedule("0 1 * * *", markOverdueInvoices);

  // Also expose the functions for manual triggering if needed
  fastify.decorate("runReminderJob", processReminders);
  fastify.decorate("runOverdueJob", markOverdueInvoices);

  fastify.log.info(
    "Cron plugin initialized: Automated reminders and overdue checks scheduled.",
  );
}

module.exports = fp(cronPlugin);
