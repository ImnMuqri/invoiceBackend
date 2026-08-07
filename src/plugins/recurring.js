const fp = require("fastify-plugin");
const cadence = require("../utils/cadence");
const { createNotification } = require("../utils/notificationUtils");
const { sen } = require("../utils/invoiceMoney");

/**
 * Recurring invoice generation (spec 02).
 *
 * Runs daily in Asia/Kuala_Lumpur and creates every instance that has become
 * due since the last run. Three properties matter more than anything else here:
 *
 *  1. IDEMPOTENT. Each instance carries (scheduleId, schedulePeriod) under a
 *     unique constraint, so a job that runs twice — or a retry after a partial
 *     failure — cannot produce two invoices for the same period. The constraint
 *     does the work; the code just has to not swallow the wrong error.
 *
 *  2. CATCHES UP. If the job did not run for three days, the next run issues all
 *     three missed periods. Late is acceptable, missing is not: a skipped period
 *     is a month of work never billed, and the user will not notice until they
 *     reconcile.
 *
 *  3. NEVER FAILS TO INVOICE OVER A PLAN LIMIT. If WhatsApp allowance is gone
 *     the instance is still created and still delivered, by email. Losing the
 *     invoice entirely is far worse than a downgraded channel.
 */
async function recurringPlugin(fastify, opts) {
  const { prisma } = fastify;

  const money = (items, taxRate) => {
    const sub = items.reduce(
      (n, i) => n + (Number(i.price) || 0) * (Number(i.quantity) || 0),
      0,
    );
    return sub * (1 + (Number(taxRate) || 0) / 100);
  };

  /** Next invoice number for a user, matching the manual create path. */
  const nextInvoiceNumber = async (tx, userId) => {
    const config = await tx.userInvoiceConfig.findUnique({
      where: { userId },
      select: { invoicePrefix: true },
    });
    const prefix = config?.invoicePrefix || "INV";
    const last = await tx.invoice.findFirst({
      where: { kind: "INVOICE", userId },
      orderBy: { userInvoiceNumber: "desc" },
      select: { userInvoiceNumber: true },
    });
    const next = (last?.userInvoiceNumber || 0) + 1;
    return { next, number: `${prefix}-${String(next).padStart(4, "0")}` };
  };

  /**
   * Create one instance. Returns null when it already exists, which is the
   * normal outcome of a second run rather than an error.
   */
  const createInstance = async (schedule, occurrence) => {
    try {
      return await prisma.$transaction(async (tx) => {
        const { next, number } = await nextInvoiceNumber(tx, schedule.userId);
        return tx.invoice.create({
          data: {
            kind: "INVOICE",
            userId: schedule.userId,
            clientId: schedule.clientId,
            scheduleId: schedule.id,
            schedulePeriod: occurrence.periodKey,
            invoiceName: schedule.invoiceName,
            subject: schedule.subject,
            currency: schedule.currency,
            /* Values from the SCHEDULE, not current account defaults. A retainer
               agreed at one rate keeps issuing at that rate until the schedule
               itself is edited. */
            amount: money(schedule.items, schedule.taxRate),
            date: occurrence.issueAt,
            dueDate: cadence.dueDateFor(schedule, occurrence.issueAt),
            /* Review mode lands as a draft and is never delivered until a human
               approves it. */
            status: schedule.mode === "AUTO" ? "Pending" : "Draft",
            userInvoiceNumber: next,
            invoiceNumber: number,
            items: {
              create: schedule.items.map((i) => ({
                name: i.name,
                price: i.price,
                quantity: i.quantity,
                total: (Number(i.price) || 0) * (Number(i.quantity) || 0),
              })),
            },
          },
          include: { client: true, items: true },
        });
      });
    } catch (err) {
      /* P2002 on (scheduleId, schedulePeriod) means another run got there
         first. That is the constraint doing its job, not a failure. */
      if (err?.code === "P2002") return null;
      throw err;
    }
  };

  /** Deliver an instance on the schedule's channels, degrading if needed. */
  const deliver = async (schedule, invoice) => {
    const channels = schedule.channels || ["EMAIL"];
    let deliveredEmail = false;

    if (channels.includes("WHATSAPP") && invoice.client?.phone) {
      const decision = await fastify.chase.canChase(schedule.userId, invoice.id);
      if (decision.allowed) {
        try {
          await fastify.whatsapp.sendMessage(
            invoice.client.phone,
            /* sen(), not toFixed(2) — the amount is sen, so toFixed printed
               "50000.00" for a RM500 invoice. */
            `Invoice ${invoice.invoiceNumber} for ${invoice.currency} ${sen(invoice.amount)}.`,
            null,
          );
          await fastify.chase.consumeChase(schedule.userId, invoice.id, decision);
          await fastify.chase.logMessage({
            userId: schedule.userId,
            invoiceId: invoice.id,
            channel: "WHATSAPP",
            purpose: "SEND",
            category: "UTILITY",
          });
        } catch (err) {
          fastify.log.warn({ err, invoiceId: invoice.id }, "Recurring WhatsApp send failed");
        }
      } else {
        /* The rule from spec 01: never drop it, downgrade it. */
        fastify.log.info(
          { invoiceId: invoice.id, reason: decision.reason },
          "Recurring instance downgraded to email",
        );
        await fastify.chase.logMessage({
          userId: schedule.userId,
          invoiceId: invoice.id,
          channel: "EMAIL",
          purpose: "SEND",
          downgraded: true,
          downgradeReason: decision.reason,
        });
        await fastify.chase.notifyDowngradeOnce(schedule.userId);
      }
    }

    if (channels.includes("EMAIL") || !deliveredEmail) {
      if (invoice.client?.email) {
        try {
          await fastify.email.send({
            to: invoice.client.email,
            subject: `Invoice ${invoice.invoiceNumber}`,
            html: `<p>Invoice ${invoice.invoiceNumber} for ${invoice.currency} ${sen(invoice.amount)} is attached to your account.</p>`,
          });
          deliveredEmail = true;
        } catch (err) {
          fastify.log.warn({ err, invoiceId: invoice.id }, "Recurring email send failed");
        }
      }
    }
  };

  /** One schedule's worth of work. Exported for tests and manual runs. */
  const runSchedule = async (schedule, now = new Date()) => {
    const made = [];

    /* A client who is gone cannot be invoiced. Pause and say so — silently
       continuing invoices a deleted relationship, silently stopping loses the
       user a month of income without telling them. */
    if (!schedule.client || schedule.client.status === "Archived") {
      await prisma.recurringSchedule.update({
        where: { id: schedule.id },
        data: { status: "PAUSED", statusReason: "Client archived or removed" },
      });
      await createNotification(
        prisma,
        schedule.userId,
        "Recurring schedule paused",
        `The schedule for ${schedule.client?.name || "a removed client"} is paused because the client is no longer active.`,
        "RECURRING",
      );
      return made;
    }

    for (const occurrence of cadence.dueOccurrences(schedule, now)) {
      if (schedule.skipWhileUnpaid) {
        const unpaid = await prisma.invoice.findFirst({
          where: {
            scheduleId: schedule.id,
            status: { notIn: ["Paid", "Cancelled", "Void"] },
          },
          select: { id: true },
        });
        if (unpaid) {
          fastify.log.info(
            { scheduleId: schedule.id },
            "Skipping issue: previous instance still unpaid",
          );
          break;
        }
      }

      const invoice = await createInstance(schedule, occurrence);
      /* Already existed. Still advance the counter, or the schedule retries the
         same period forever. */
      const counted = (schedule.occurrences || 0) + 1;
      schedule.occurrences = counted;

      await prisma.recurringSchedule.update({
        where: { id: schedule.id },
        data: {
          occurrences: counted,
          lastPeriodKey: occurrence.periodKey,
          nextIssueAt: cadence.nextIssueAt({ ...schedule, occurrences: counted }, now),
          ...(schedule.reviewRemaining > 0
            ? { reviewRemaining: schedule.reviewRemaining - 1 }
            : {}),
        },
      });
      if (schedule.reviewRemaining > 0) schedule.reviewRemaining -= 1;

      if (!invoice) continue;
      made.push(invoice);

      if (schedule.mode === "AUTO") {
        await deliver(schedule, invoice);
      } else {
        await createNotification(
          prisma,
          schedule.userId,
          "Recurring invoice ready to review",
          `${invoice.invoiceNumber} for ${invoice.client.name} is drafted and waiting for your approval.`,
          "RECURRING",
        );
      }
    }

    /* Two clean cycles is the point at which the spec says to ask. */
    if (
      schedule.mode === "REVIEW" &&
      schedule.reviewRemaining <= 0 &&
      !schedule.reviewPromptSent &&
      schedule.occurrences >= 2
    ) {
      await prisma.recurringSchedule.update({
        where: { id: schedule.id },
        data: { reviewPromptSent: true },
      });
      await createNotification(
        prisma,
        schedule.userId,
        "Send this schedule automatically?",
        `The schedule for ${schedule.client.name} has run twice without a problem. You can switch it to send without waiting for your approval.`,
        "RECURRING",
      );
    }

    /* Ended is a terminal, read-only state. */
    if (cadence.isPastEnd(schedule, schedule.occurrences)) {
      await prisma.recurringSchedule.update({
        where: { id: schedule.id },
        data: { status: "ENDED", nextIssueAt: null },
      });
    }

    return made;
  };

  const generate = async (now = new Date()) => {
    const schedules = await prisma.recurringSchedule.findMany({
      where: { status: "ACTIVE" },
      include: { items: true, client: true },
    });

    let created = 0;
    for (const schedule of schedules) {
      try {
        const made = await runSchedule(schedule, now);
        created += made.length;
      } catch (err) {
        /* One broken schedule must not stop the rest of the run. */
        fastify.log.error({ err, scheduleId: schedule.id }, "Recurring generation failed");
      }
    }
    if (created) fastify.log.info({ created }, "Recurring instances created");
    return created;
  };

  fastify.decorate("recurring", { generate, runSchedule, createInstance, deliver });
}

module.exports = fp(recurringPlugin);
