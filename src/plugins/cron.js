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
        /* Reads amountDue, never amount. Spec 03 calls this the correctness
           problem at the heart of the product: the chaser was sending
           full-amount reminders to clients who had already paid something, and
           that is the failure most likely to embarrass a user in front of their
           client and make them switch chasing off entirely. */
        const pendingInvoices = await fastify.prisma.invoice.findMany({
          where: {
            userId: user.id,
            // Invoices only. A quotation is not owed, so it is never chased.
            kind: "INVOICE",
            /* Partially Paid is chased too — it is still owed, just less of it.
               Void, Cancelled, Draft and Paid are not. */
            status: { in: ["Pending", "Overdue", "Partially Paid"] },
            /* And the balance is what decides, not the label. An invoice whose
               status is stale for any reason still will not be chased if
               nothing is outstanding. */
            amountDue: { gt: 0 },
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
      /* Spec 01's single most important rule: never silently drop a scheduled
         reminder. Out of WhatsApp allowance means the reminder goes by EMAIL,
         recorded as downgraded — it does not mean the client hears nothing.
         An invoice chased twice and then abandoned is worse than one never
         chased, because the user blames us for the unpaid invoice. */
      const decision = await fastify.chase.canChase(user.id, invoice.id);
      if (!decision.allowed) {
        fastify.log.info(
          { invoiceId: invoice.id, reason: decision.reason },
          "WhatsApp reminder downgraded to email",
        );
        await sendEmailReminder(user, invoice);
        await fastify.chase.logMessage({
          userId: user.id,
          invoiceId: invoice.id,
          channel: "EMAIL",
          purpose: "REMINDER",
          downgraded: true,
          downgradeReason: decision.reason,
        });
        await fastify.chase.notifyDowngradeOnce(user.id);
        return;
      }

      /* Two default templates, not one.
         "Your invoice is unpaid" sent to somebody who paid half is exactly the
         message that does the damage the spec describes. When part of the
         balance has been settled the reminder says so, thanks them for what
         arrived, and asks only for what is left.

         Malay alongside English because a payment reminder is read by the
         CLIENT, not the account owner — the one surface where the wrong
         language costs money. This copy is a starting point and worth a native
         check before it goes out at volume. */
      const partial = invoice.amountPaid > 0 || invoice.amountAdjusted > 0;
      const DEFAULTS = {
        en: {
          full: "Friendly reminder for {{clientName}}: Your invoice {{invoiceNumber}} ({{totalAmount}} {{currency}}) is due on {{dueDate}}. View: {{invoiceUrl}}",
          partial:
            "Hello {{clientName}}, thank you for the payment received on {{invoiceNumber}}. There is {{remainingAmount}} {{currency}} still outstanding, due {{dueDate}}. View: {{invoiceUrl}}",
        },
        ms: {
          full: "Peringatan mesra untuk {{clientName}}: Invois {{invoiceNumber}} ({{totalAmount}} {{currency}}) perlu dijelaskan pada {{dueDate}}. Lihat: {{invoiceUrl}}",
          partial:
            "Salam {{clientName}}, terima kasih atas pembayaran yang diterima bagi {{invoiceNumber}}. Baki sebanyak {{remainingAmount}} {{currency}} masih belum dijelaskan, tarikh akhir {{dueDate}}. Lihat: {{invoiceUrl}}",
        },
      };
      const lang = DEFAULTS[user.locale === "ms" ? "ms" : "en"];

      const template =
        (partial
          ? notif.whatsappPartialTemplate || lang.partial
          : notif.whatsappReminderTemplate || lang.full);
      const message = template
        .replace(/{{userName}}/g, profile.name || "")
        .replace(/{{companyName}}/g, profile.companyName || "InvoKita User")
        .replace(/{{clientName}}/g, invoice.client.name)
        .replace(/{{invoiceNumber}}/g, invoice.invoiceNumber || invoice.id)
        .replace(/{{totalAmount}}/g, (invoice.amount / 100).toFixed(2))
        /* The whole reason this exists: the figure a partially-paid client
           needs to see is what is LEFT, not what the invoice was for. */
        .replace(/{{remainingAmount}}/g, (invoice.amountDue / 100).toFixed(2))
        .replace(/{{amountPaid}}/g, (invoice.amountPaid / 100).toFixed(2))
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

      /* Consumed AFTER the provider accepted it. Charging the allowance before
         the send would burn a chased invoice on a message that never left. */
      await fastify.chase.consumeChase(user.id, invoice.id, decision);
      await fastify.chase.logMessage({
        userId: user.id,
        invoiceId: invoice.id,
        channel: "WHATSAPP",
        purpose: "REMINDER",
        /* Reminder copy is transactional, so it qualifies as utility — which is
           materially cheaper than marketing in Malaysia. Logged per message so
           the bill can be reconciled against what was actually sent. */
        category: "UTILITY",
      });

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
          // A quote past its validUntil is stale, not overdue, and marking it
          // Overdue would put it in the user's late-money figures.
          kind: "INVOICE",
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
  /* Every job is pinned to Asia/Kuala_Lumpur.
     node-cron uses the server clock when no timezone is given, and on Railway
     that is UTC — so "0 9 * * *" was firing at 17:00 Malaysia time. A payment
     reminder landing at 5pm on a working day is far more likely to be read
     tomorrow than acted on today. */
  const TZ = { timezone: "Asia/Kuala_Lumpur" };

  cron.schedule("0 9 * * *", processReminders, TZ);

  // Daily at 1 AM: Overdue status updates
  cron.schedule("0 1 * * *", markOverdueInvoices, TZ);

  /* Recurring generation, early enough that an instance issued today is out
     before the working day starts, and before the 09:00 reminder sweep so a
     newly issued invoice is never chased in the same pass that created it. */
  cron.schedule(
    "0 6 * * *",
    async () => {
      try {
        await fastify.recurring.generate();
      } catch (err) {
        fastify.log.error(err, "Recurring generation job failed");
      }
    },
    TZ,
  );

  // Also expose the functions for manual triggering if needed
  fastify.decorate("runReminderJob", processReminders);
  fastify.decorate("runOverdueJob", markOverdueInvoices);

  fastify.log.info(
    "Cron plugin initialized: Automated reminders and overdue checks scheduled.",
  );
}

module.exports = fp(cronPlugin);
