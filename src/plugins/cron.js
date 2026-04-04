const fp = require("fastify-plugin");
const cron = require("node-cron");

async function cronPlugin(fastify, opts) {
  // Function to process reminders
  const processReminders = async () => {
    fastify.log.info("Starting automated reminders chaser...");

    try {
      const now = new Date();

      // 1. Find users who have automated reminders enabled
      const users = await fastify.prisma.user.findMany({
        where: {
          globalAutoChaser: true,
          reminderInterval: { not: 0 },
          plan: { in: ["PRO", "MAX"] }, // Optimization: Save DB/Processing if not Pro
        },
      });

      fastify.log.info(
        `Found ${users.length} users with automated reminders enabled.`,
      );

      for (const user of users) {
        const interval = user.reminderInterval;

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
          let shouldRemind = false;
          const dueDate = new Date(invoice.dueDate);

          if (interval < 0) {
            // Before Due Date logic (e.g., -3 means 3 days before)
            const daysBefore = Math.abs(interval);
            const targetDate = new Date(dueDate);
            targetDate.setDate(targetDate.getDate() - daysBefore);
            targetDate.setHours(0, 0, 0, 0);

            const today = new Date(now);
            today.setHours(0, 0, 0, 0);

            // If today is on or after the target date AND we haven't sent a reminder yet for this window
            if (today >= targetDate && today < dueDate) {
              const lastSent =
                invoice.emailLastReminderSent ||
                invoice.whatsappLastReminderSent;
              if (!lastSent || lastSent < targetDate) {
                shouldRemind = true;
              }
            }
          } else if (interval > 0) {
            // After Due Date logic (e.g., 3 means every 3 days)
            if (now > dueDate) {
              const lastSent =
                invoice.emailLastReminderSent ||
                invoice.whatsappLastReminderSent;
              if (!lastSent) {
                shouldRemind = true;
              } else {
                const diffTime = Math.abs(now - lastSent);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                if (diffDays >= interval) {
                  shouldRemind = true;
                }
              }
            }
          }

          if (shouldRemind) {
            await sendAutomatedReminder(user, invoice);
          }
        }
      }
    } catch (error) {
      fastify.log.error("Error in cron reminder job: " + error.message);
    }
  };

  const sendAutomatedReminder = async (user, invoice) => {
    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000")
      .replace(/['"]/g, "")
      .replace(/\/$/, "");
    const invoiceUrl = `${frontendUrl}/pay/${invoice.id}`;

    // 1. Email Reminder
    if (invoice.client.autoEmailChaser) {
      try {
        await fastify.usage.checkAndIncrement(user.id, "emailReminder");

        const { getInvoiceEmailTemplate } = require("../utils/emailTemplates");
        const html = getInvoiceEmailTemplate({
          clientName: invoice.client.name,
          senderName: user.name || "Our Company",
          senderCompany: user.companyName,
          invoiceNumber: invoice.invoiceNumber || `#${invoice.id}`,
          amount: invoice.amount,
          currency: invoice.currency,
          dueDate: invoice.dueDate,
          status: "Payment Reminder",
          publicUrl: invoiceUrl,
        });

        await fastify.email.send({
          to: invoice.client.email,
          subject: `Reminder: Invoice #${invoice.invoiceNumber || invoice.id} from ${user.companyName || user.name}`,
          html,
        });

        await fastify.prisma.invoice.update({
          where: { id: invoice.id },
          data: { emailLastReminderSent: new Date() },
        });

        fastify.log.info(
          `Auto Email Reminder sent for Invoice #${invoice.invoiceNumber}`,
        );
      } catch (err) {
        fastify.log.error(
          `Auto Email failed for #${invoice.id}: ${err.message}`,
        );
      }
    }

    // 2. WhatsApp Reminder
    if (invoice.client.phone && invoice.client.autoChaser) {
      try {
        await fastify.usage.checkAndIncrement(user.id, "waReminder");

        const template =
          user.whatsappReminderTemplate ||
          "Friendly reminder for {{clientName}}: Your invoice {{invoiceNumber}} ({{totalAmount}} {{currency}}) is due on {{dueDate}}. View: {{invoiceUrl}}";
        const message = template
          .replace(/{{userName}}/g, user.name || "")
          .replace(/{{companyName}}/g, user.companyName || "InvoKita User")
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
        if (user.whatsappMode === "CUSTOM") {
          credentials = {
            sid: user.twilioSid,
            token: user.twilioAuthToken,
            phoneNumber: user.twilioPhoneNumber,
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
        fastify.log.info(
          `Auto WA Reminder sent for Invoice #${invoice.invoiceNumber}`,
        );
      } catch (err) {
        fastify.log.error(`Auto WA failed for #${invoice.id}: ${err.message}`);
      }
    }
  };

  // Function to mark invoices as overdue
  const markOverdueInvoices = async () => {
    fastify.log.info("Starting automated overdue status update...");
    try {
      const now = new Date();
      const result = await fastify.prisma.invoice.updateMany({
        where: {
          status: "Pending",
          dueDate: { lt: now },
        },
        data: {
          status: "Overdue",
        },
      });
      if (result.count > 0) {
        fastify.log.info(`Updated ${result.count} invoices to Overdue status.`);
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
