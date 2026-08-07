/**
 * Plan administration.
 *
 * These rows now decide what every customer is actually allowed to do — see
 * plugins/usage.js — so what gets written here matters more than it used to.
 * Access is already restricted: routes/admin/index.js registers this as a child
 * plugin behind `authenticate` and `isAdmin` preHandlers, which child plugins
 * inherit. What was missing is what an authorised admin could write: the
 * handlers passed `data: request.body` straight to Prisma.
 *
 * Unfiltered, that means a stray key is a 500, a negative number is a limit
 * nobody can ever satisfy, "20" as a string is a type error at enforcement
 * time, and a fat-fingered `isActive` silently removes a tier from the pricing
 * page. Whitelisting is not about distrusting the admin; it is about the blast
 * radius of a typo in a form that governs billing.
 */

/** Only these columns may be written, and only in these shapes. */
const COUNTERS = [
  "invoices",
  "quotes",
  "waSends",
  "emailSends",
  "waReminders",
  "emailReminders",
  "aiCredits",
  /* Spec 01. chasedInvoices is the metered unit and the number that should lead
     the pricing page; the other two are guard rails. Editable here on purpose —
     the allowance should be tunable against real per-message cost without a
     deploy. */
  "chasedInvoices",
  "trialChases",
  "waPerInvoiceCap",
];

function cleanPlanInput(body = {}, { requireName = false } = {}) {
  const data = {};
  const errors = [];

  if (body.name !== undefined) {
    const name = String(body.name).trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,20}$/.test(name)) {
      errors.push("Plan name must be 2-20 characters, letters, digits or underscore.");
    } else {
      /* Uppercase, always. The live data held both 'Starter' and 'STARTER' and
         the lookup was exact-match, so one of them silently resolved to Free. */
      data.name = name;
    }
  } else if (requireName) {
    errors.push("A plan name is required.");
  }

  if (body.description !== undefined) data.description = String(body.description).trim() || null;
  if (body.currency !== undefined) data.currency = String(body.currency).trim().toUpperCase();
  if (body.interval !== undefined) data.interval = String(body.interval).trim().toLowerCase();
  if (body.isActive !== undefined) data.isActive = !!body.isActive;

  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) errors.push("Price must be zero or more.");
    else data.price = price;
  }

  for (const key of COUNTERS) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    /* Whole numbers only. A limit of 2.5 invoices compares strangely and reads
       as a bug wherever it surfaces. */
    if (!Number.isInteger(n) || n < 0) {
      errors.push(`${key} must be a whole number, zero or more.`);
    } else {
      data[key] = n;
    }
  }

  if (Array.isArray(body.features)) {
    data.features = body.features.map((f) => String(f)).filter(Boolean);
  }

  return { data, errors };
}

async function planRoutes(fastify, opts) {
  const { prisma } = fastify;

  // GET / - List all plans (Admin only)
  fastify.get("/", async (request, reply) => {
    try {
      const plans = await prisma.plan.findMany({
        orderBy: { price: "asc" },
      });
      return plans;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch plans");
    }
  });

  // POST / - Create a new plan
  fastify.post("/", async (request, reply) => {
    try {
      const { data, errors } = cleanPlanInput(request.body, { requireName: true });
      if (errors.length) return reply.badRequest(errors.join(" "));

      const clash = await prisma.plan.findFirst({ where: { name: data.name } });
      if (clash) return reply.conflict(`A plan named ${data.name} already exists.`);

      const plan = await prisma.plan.create({ data });

      // Plan list is cached on the read path; drop it so this is visible now.
      fastify.refCache?.delete("plans");
      return plan;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to create plan");
    }
  });

  // PUT /:id - Update a plan
  fastify.put("/:id", async (request, reply) => {
    try {
      const { id } = request.params;
      const { data, errors } = cleanPlanInput(request.body);
      if (errors.length) return reply.badRequest(errors.join(" "));

      /* Renaming a plan orphans every User.plan and Subscription.plan that
         still names it, and those are matched by name. Blocked outright — a
         rename is a data migration, not a form field. */
      if (data.name) {
        const current = await prisma.plan.findUnique({ where: { id: parseInt(id) } });
        if (current && current.name !== data.name) {
          return reply.badRequest(
            "A plan cannot be renamed here — customers reference it by name. Create the new plan and migrate them.",
          );
        }
        delete data.name;
      }

      const plan = await prisma.plan.update({
        where: { id: parseInt(id) },
        data,
      });

      // Plan list is cached on the read path; drop it so this is visible now.
      fastify.refCache?.delete("plans");
      return plan;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to update plan");
    }
  });

  // DELETE /:id - Delete a plan
  fastify.delete("/:id", async (request, reply) => {
    try {
      const { id } = request.params;
      await prisma.plan.delete({
        where: { id: parseInt(id) },
      });
      return { success: true, message: "Plan deleted successfully" };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to delete plan");
    }
  });
}

module.exports = planRoutes;
