const cadence = require("../../utils/cadence");
const { assertCreationEnabled } = require("../../utils/systemGuards");

/**
 * Recurring schedules (spec 02).
 *
 * A schedule is a template plus a cadence. Editing one affects FUTURE instances
 * only — there is no path here that reaches back into an issued invoice, which
 * is deliberate: an invoice the client already has must keep saying what it
 * said.
 */

const FREQUENCIES = ["WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"];
const CHANNELS = ["EMAIL", "WHATSAPP"];

function cleanInput(body = {}) {
  const errors = [];
  const data = {};

  if (body.clientId !== undefined) data.clientId = Number(body.clientId);
  if (body.invoiceName !== undefined) data.invoiceName = String(body.invoiceName).trim() || null;
  if (body.subject !== undefined) data.subject = String(body.subject).trim() || null;
  if (body.currency !== undefined) data.currency = String(body.currency).trim().toUpperCase();

  if (body.taxRate !== undefined) {
    const n = Number(body.taxRate);
    if (!Number.isFinite(n) || n < 0) errors.push("Tax rate must be zero or more.");
    else data.taxRate = n;
  }

  if (body.frequency !== undefined) {
    const f = String(body.frequency).toUpperCase();
    if (!FREQUENCIES.includes(f)) errors.push("Unknown cadence.");
    else data.frequency = f;
  }

  if (body.interval !== undefined) {
    const n = Number(body.interval);
    if (!Number.isInteger(n) || n < 1 || n > 12) errors.push("Interval must be between 1 and 12.");
    else data.interval = n;
  }

  if (body.issueDay !== undefined && body.issueDay !== null) {
    const n = Number(body.issueDay);
    if (!Number.isInteger(n) || n < 0 || n > 31) errors.push("Issue day is out of range.");
    else data.issueDay = n;
  }

  if (body.startDate !== undefined) {
    const d = new Date(body.startDate);
    if (Number.isNaN(d.getTime())) errors.push("Start date is not a date.");
    else data.startDate = d;
  }

  if (body.endMode !== undefined) {
    const m = String(body.endMode).toUpperCase();
    if (!["NEVER", "AFTER_N", "ON_DATE"].includes(m)) errors.push("Unknown end condition.");
    else data.endMode = m;
  }
  if (body.endAfter !== undefined) data.endAfter = body.endAfter === null ? null : Number(body.endAfter);
  if (body.endDate !== undefined) data.endDate = body.endDate ? new Date(body.endDate) : null;

  if (body.paymentTermsDays !== undefined) {
    const n = Number(body.paymentTermsDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) errors.push("Payment terms must be 0 to 365 days.");
    else data.paymentTermsDays = n;
  }

  if (Array.isArray(body.channels)) {
    const set = body.channels.map((c) => String(c).toUpperCase()).filter((c) => CHANNELS.includes(c));
    if (!set.length) errors.push("Pick at least one delivery channel.");
    else data.channels = [...new Set(set)];
  }

  if (body.autoChase !== undefined) data.autoChase = !!body.autoChase;
  if (body.reminderInterval !== undefined) {
    data.reminderInterval = body.reminderInterval === null ? null : Number(body.reminderInterval);
  }
  if (body.mode !== undefined) {
    const m = String(body.mode).toUpperCase();
    if (!["AUTO", "REVIEW"].includes(m)) errors.push("Unknown mode.");
    else data.mode = m;
  }
  if (body.skipWhileUnpaid !== undefined) data.skipWhileUnpaid = !!body.skipWhileUnpaid;

  return { data, errors };
}

async function recurringRoutes(fastify, opts) {
  const { prisma } = fastify;

  fastify.register(async function (protectedInstance) {
    protectedInstance.addHook("onRequest", fastify.authenticate);

    protectedInstance.get("/", async (request) => {
      const rows = await prisma.recurringSchedule.findMany({
        where: { userId: request.user.id },
        include: {
          client: { select: { id: true, name: true, company: true } },
          items: true,
          _count: { select: { invoices: true } },
        },
        orderBy: [{ status: "asc" }, { nextIssueAt: "asc" }],
      });

      /* Rounded to whole sen. The tax multiply is the one fractional step in
         an otherwise integer pipeline, and an unrounded result travels to the
         frontend as a float — which is exactly the drift integer sen exists to
         prevent. */
      return rows.map((r) => ({
        ...r,
        amount: Math.round(
          r.items.reduce((n, i) => n + i.price * i.quantity, 0) *
            (1 + (r.taxRate || 0) / 100),
        ),
      }));
    });

    protectedInstance.get("/:id", async (request, reply) => {
      const schedule = await prisma.recurringSchedule.findFirst({
        where: { id: Number(request.params.id), userId: request.user.id },
        include: {
          client: true,
          items: true,
          invoices: {
            orderBy: { date: "desc" },
            select: {
              id: true, invoiceNumber: true, status: true, amount: true,
              currency: true, date: true, dueDate: true, amountPaid: true,
            },
          },
        },
      });
      if (!schedule) return reply.notFound("Schedule not found");
      return schedule;
    });

    protectedInstance.post("/", async (request, reply) => {
      if (!(await assertCreationEnabled(prisma, reply, "Recurring schedules"))) return;

      const { data, errors } = cleanInput(request.body);
      if (!data.clientId) errors.push("Pick a client.");
      if (!data.startDate) errors.push("A start date is required.");
      const items = Array.isArray(request.body?.items) ? request.body.items : [];
      if (!items.length) errors.push("Add at least one line.");
      if (errors.length) return reply.badRequest(errors.join(" "));

      const client = await prisma.client.findFirst({
        where: { id: data.clientId, userId: request.user.id },
        select: { id: true },
      });
      if (!client) return reply.badRequest("That client does not exist.");

      const created = await prisma.recurringSchedule.create({
        data: {
          ...data,
          userId: request.user.id,
          items: {
            create: items.map((i) => ({
              name: String(i.name || "").trim() || "Item",
              price: Number(i.price) || 0,
              quantity: Number(i.quantity) || 1,
            })),
          },
        },
        include: { items: true, client: true },
      });

      /* Shown in the list immediately rather than after the first job run. */
      await prisma.recurringSchedule.update({
        where: { id: created.id },
        data: { nextIssueAt: cadence.nextIssueAt(created) },
      });

      return created;
    });

    protectedInstance.put("/:id", async (request, reply) => {
      const id = Number(request.params.id);
      const existing = await prisma.recurringSchedule.findFirst({
        where: { id, userId: request.user.id },
      });
      if (!existing) return reply.notFound("Schedule not found");
      if (existing.status === "ENDED") {
        return reply.badRequest("This schedule has ended and is read-only.");
      }

      const { data, errors } = cleanInput(request.body);
      if (errors.length) return reply.badRequest(errors.join(" "));

      const items = Array.isArray(request.body?.items) ? request.body.items : null;

      const updated = await prisma.recurringSchedule.update({
        where: { id },
        data: {
          ...data,
          ...(items
            ? {
                items: {
                  deleteMany: {},
                  create: items.map((i) => ({
                    name: String(i.name || "").trim() || "Item",
                    price: Number(i.price) || 0,
                    quantity: Number(i.quantity) || 1,
                  })),
                },
              }
            : {}),
        },
        include: { items: true, client: true },
      });

      /* Editing changes what happens NEXT. Instances already issued are not
         touched — there is deliberately no code path here that does. */
      await prisma.recurringSchedule.update({
        where: { id },
        data: { nextIssueAt: cadence.nextIssueAt(updated) },
      });

      return updated;
    });

    /** pause | resume | cancel | auto | review */
    protectedInstance.post("/:id/:action", async (request, reply) => {
      const id = Number(request.params.id);
      const action = String(request.params.action);
      const existing = await prisma.recurringSchedule.findFirst({
        where: { id, userId: request.user.id },
        include: { items: true },
      });
      if (!existing) return reply.notFound("Schedule not found");

      const moves = {
        /* Paused stops generating but keeps chasing what is already out —
           the outstanding invoices are still owed. */
        pause: { status: "PAUSED", statusReason: null },
        resume: { status: "ACTIVE", statusReason: null },
        cancel: { status: "CANCELLED", nextIssueAt: null },
        auto: { mode: "AUTO", reviewRemaining: 0 },
        review: { mode: "REVIEW" },
      };
      const data = moves[action];
      if (!data) return reply.badRequest("Unknown action.");
      if (existing.status === "ENDED") return reply.badRequest("This schedule has ended.");

      const updated = await prisma.recurringSchedule.update({
        where: { id },
        data: {
          ...data,
          ...(action === "resume"
            ? { nextIssueAt: cadence.nextIssueAt({ ...existing, status: "ACTIVE" }) }
            : {}),
        },
      });
      return updated;
    });

    /**
     * Turn an existing invoice into a schedule, prefilled from it.
     * The spec calls this the most likely creation path, so it is one call.
     */
    protectedInstance.post("/from-invoice/:invoiceId", async (request, reply) => {
      const invoiceId = Number(request.params.invoiceId);
      const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, userId: request.user.id, kind: "INVOICE" },
        include: { items: true },
      });
      if (!invoice) return reply.notFound("Invoice not found");

      const { data } = cleanInput(request.body || {});
      const issued = new Date(invoice.date || Date.now());
      const terms = invoice.dueDate
        ? Math.max(0, Math.round((new Date(invoice.dueDate) - issued) / 86400000))
        : 14;

      const created = await prisma.recurringSchedule.create({
        data: {
          userId: request.user.id,
          clientId: invoice.clientId,
          invoiceName: invoice.invoiceName,
          subject: invoice.subject,
          currency: invoice.currency,
          paymentTermsDays: terms,
          /* Starts one period from the invoice it came from, not today: the
             invoice in hand already covers the current period. */
          startDate: data.startDate || new Date(issued.getTime() + 30 * 86400000),
          frequency: data.frequency || "MONTHLY",
          issueDay: data.issueDay ?? cadence.mytParts(issued).day,
          ...data,
          items: {
            create: invoice.items.map((i) => ({
              name: i.name,
              price: i.price,
              quantity: i.quantity,
            })),
          },
        },
        include: { items: true, client: true },
      });

      await prisma.recurringSchedule.update({
        where: { id: created.id },
        data: { nextIssueAt: cadence.nextIssueAt(created) },
      });

      return created;
    });

    /** Manual generation, for testing and for a user who wants it issued now. */
    protectedInstance.post("/run", async (request) => {
      const created = await fastify.recurring.generate();
      return { created };
    });
  });
}

module.exports = recurringRoutes;
