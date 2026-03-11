const fp = require("fastify-plugin");
const cron = require("node-cron");

async function cronPlugin(fastify, opts) {
  // Function to process reminders
  const processReminders = async () => {
    fastify.log.info("Starting automated WhatsApp reminders chaser...");

    try {
      const users = await fastify.prisma.user.findMany({
        where: {
          clients: {
            some: {
              OR: [{ autoChaser: true }, { autoEmailChaser: true }],
              invoices: {
                some: {
                  status: { in: ["Pending", "Overdue"] },
                },
              },
            },
          },
        },
      });

      fastify.log.info(
        `Found ${users.length} users with eligible reminder candidates.`,
      );

      for (const user of users) {
        const pendingInvoices = await fastify.prisma.invoice.findMany({
          where: {
            userId: user.id,
            status: { in: ["Pending", "Overdue"] },
            OR: [
              { client: { autoChaser: true } },
              { client: { autoEmailChaser: true } },
            ],
          },
          include: {
            client: true,
          },
        });

        if (pendingInvoices.length === 0) continue;

        const template =
          user.whatsappReminderTemplate ||
          "{{userName}} {{companyName}} via InvoKita\n\nFriendly reminder for {{clientName}}: Your invoice {{invoiceNumber}} ({{totalAmount}} {{currency}}) is due on {{dueDate}}. Please ignore if already paid.";

        let credentials = null;
        if (user.whatsappMode === "CUSTOM") {
          credentials = {
            sid: user.twilioSid,
            token: user.twilioAuthToken,
            phoneNumber: user.twilioPhoneNumber,
          };
        }

        const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        for (const invoice of pendingInvoices) {
          const invoiceUrl = `${frontendUrl}/pay/${invoice.id}`;
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
              new Date(invoice.dueDate).toLocaleDateString("en-US", {
                day: "numeric",
                month: "short",
                year: "numeric",
              }),
            );

          // WhatsApp Reminder (Independent)
          if (
            invoice.client.phone &&
            invoice.client.autoChaser &&
            (!invoice.whatsappLastReminderSent ||
              invoice.whatsappLastReminderSent < oneDayAgo)
          ) {
            try {
              // Usage check for WA reminder
              await fastify.usage.checkAndIncrement(user.id, "waReminder");

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
                `WA Reminder sent for Invoice #${invoice.invoiceNumber} (User: ${user.email})`,
              );
            } catch (err) {
              fastify.log.error(
                `Failed to send WA reminder for Invoice #${invoice.id}: ${err.message}`,
              );
            }
          }

          // Email Reminder (Independent)
          if (
            invoice.client.email &&
            invoice.client.autoEmailChaser &&
            (!invoice.emailLastReminderSent ||
              invoice.emailLastReminderSent < oneDayAgo)
          ) {
            try {
              // Usage check for Email reminder
              await fastify.usage.checkAndIncrement(user.id, "emailReminder");

              await fastify.mailer.sendMail({
                to: invoice.client.email,
                subject: `Reminder: Invoice #${invoice.invoiceNumber || invoice.id} from ${user.companyName || user.name}`,
                text: message,
                html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                        <h2 style="color: #0f172a;">Invoice Reminder</h2>
                        <p>${message.replace(/\n/g, "<br>")}</p>
                        <a href="${invoiceUrl}" style="display: inline-block; background: #0f172a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; margin-top: 20px;">View & Pay Invoice</a>
                       </div>`,
              });

              await fastify.prisma.invoice.update({
                where: { id: invoice.id },
                data: {
                  emailLastReminderSent: new Date(),
                },
              });

              fastify.log.info(
                `Email Reminder sent for Invoice #${invoice.invoiceNumber} (User: ${user.email})`,
              );
            } catch (err) {
              fastify.log.error(
                `Failed to send Email reminder for Invoice #${invoice.id}: ${err.message}`,
              );
            }
          }
        }
      }
    } catch (error) {
      fastify.log.error("Error in cron reminder job: " + error.message);
    }
  };

  // Schedule cron job: Daily at 9 AM
  // "0 9 * * *"
  cron.schedule("0 9 * * *", processReminders);

  // Also expose the function for manual triggering if needed
  fastify.decorate("runReminderJob", processReminders);

  fastify.log.info(
    "Cron plugin initialized: Automated reminders scheduled daily at 9 AM.",
  );
}

module.exports = fp(cronPlugin);
