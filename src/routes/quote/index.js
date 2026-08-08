/**
 * The client-facing quotation page (spec 07).
 *
 * PUBLIC ON PURPOSE. There is no `fastify.authenticate` hook in this file and
 * there must never be one — the person these routes serve is the user's client,
 * who has no account and is not going to make one to answer a quotation. Note
 * the singular prefix: /api/quote is the public surface, /api/quotes is the
 * owner's, and the split is deliberate so a route cannot drift from one side to
 * the other by accident. The frontend mirrors it at /quote/:token.
 *
 * Addressed by TOKEN, never by row id. /api/pay/invoice/:id can live on an
 * integer because the worst a stranger does by walking it is look at a bill
 * that is not theirs. These endpoints WRITE — accepting a quotation is a
 * commercial answer recorded against the user's business — so an enumerable url
 * would be a button anyone on the internet could press on anyone's behalf.
 *
 * Nothing in this file schedules anything. The client is never messaged as a
 * consequence of what they do here; the user is.
 */

const {
  isExpired,
  effectiveStatus,
  isAnswerable,
} = require("../../utils/quoteLifecycle");
const { getQuoteAnsweredEmail } = require("../../utils/quoteEmail");
const { createNotification } = require("../../utils/notificationUtils");

/* Everything the page needs and nothing else. This payload goes to an
   unauthenticated visitor, so it is an explicit select rather than an include:
   a column added to Invoice later must not appear here because somebody forgot
   this file existed. Nothing about the user's plan, gateways or bank details is
   in it — a quotation has nothing to pay. */
const PUBLIC_QUOTE_SELECT = {
  id: true,
  invoiceNumber: true,
  invoiceName: true,
  subject: true,
  status: true,
  amount: true,
  currency: true,
  date: true,
  validUntil: true,
  viewedAt: true,
  acceptedAt: true,
  acceptedName: true,
  declinedAt: true,
  fromName: true,
  fromCompanyName: true,
  fromEmail: true,
  fromPhone: true,
  fromAddress: true,
  /* Frozen identifiers (spec 05), shown under the same switch the invoice page
     honours — a quotation is a document the client keeps too. */
  fromRegistrationNumber: true,
  fromTin: true,
  fromMsicCode: true,
  fromSstNumber: true,
  items: {
    select: { id: true, name: true, quantity: true, price: true, total: true },
  },
  client: {
    select: {
      name: true,
      email: true,
      company: true,
      address: true,
      registrationNumber: true,
      tin: true,
      isIndividual: true,
    },
  },
  user: {
    select: {
      plan: true,
      /* The sender's letterhead. It was missing, so this page carried OUR logo
         at the top and nothing of theirs anywhere — while the PDF of the same
         quotation showed their logo properly. The client opens the link
         expecting a document from the person who sent it, and got an unbranded
         page from a company they have never heard of. */
      profile: { select: { logoUrl: true } },
      invoiceConfig: {
        select: {
          invoiceIncludeTaxIdentifiers: true,
          invoiceIncludeClientIdentifiers: true,
        },
      },
    },
  },
  /* Not returned to the client — read so the response can say whether the
     quotation has already been billed, without exposing the invoice. */
  convertedTo: { select: { id: true } },
};

/** Shape the row for the page: flags lifted, internals dropped. */
function present(quote) {
  const out = { ...quote };
  out.showTaxIdentifiers =
    quote.user?.invoiceConfig?.invoiceIncludeTaxIdentifiers ?? true;
  out.showClientIdentifiers =
    quote.user?.invoiceConfig?.invoiceIncludeClientIdentifiers ?? true;
  out.watermark = quote.user?.plan !== "MAX";
  /* Lifted to the top level like the other display flags, so the page reads one
     field rather than reaching through a nested user object — and so nothing
     else from `user` can drift into a public payload later. */
  out.logoUrl = quote.user?.profile?.logoUrl || null;
  delete out.user;

  /* findByToken selects two columns this function is responsible for removing.
     `userId` is an internal account id and there is no reason an unauthenticated
     visitor should learn it. `publicToken` the caller already holds — it is in
     the url they arrived on — but echoing a credential back in a response body
     is how it ends up in a log, a screenshot or a referrer. Neither is on
     PUBLIC_QUOTE_SELECT; both are added by the lookup because the handlers need
     them, which is exactly why they have to be stripped here rather than
     assumed absent. */
  delete out.userId;
  delete out.publicToken;

  /* The stored status is only refreshed by the nightly sweep, so between a
     quote lapsing and 01:15 the next morning the row still says Sent. The
     client must not be shown an accept button on a quotation that has run out,
     so the page reads the computed status and the computed answerability. */
  out.status = effectiveStatus(quote);
  out.expired = isExpired(quote);
  out.answerable = isAnswerable(quote);
  /* No `declinable` flag alongside this, deliberately. The decline handler
     still accepts a lapsed quotation, but only to catch the client who tapped
     decline a moment after the sweep relabelled it — the page never offers a
     decline button on something it has just told the visitor has expired.
     Shipping a flag the UI does not use would invite somebody to build that
     confusing screen later. */
  out.invoiced = !!quote.convertedTo;
  delete out.convertedTo;
  return out;
}

/** The client's address, best effort, for the acceptance record. */
function callerIp(request) {
  /* request.ip already honours trustProxy when it is configured; the header is
     a fallback for when it is not. Truncated because this is a record of who
     accepted, not a tracking field, and an over-long forwarded chain is noise. */
  const forwarded = request.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = (raw ? String(raw).split(",")[0].trim() : "") || request.ip || "";
  return ip.slice(0, 45) || null;
}

async function publicQuoteRoutes(fastify, opts) {
  const { prisma } = fastify;

  /** Load a quote by token, or answer 404. Never leaks whether a token exists. */
  const findByToken = async (token) =>
    prisma.invoice.findFirst({
      where: { kind: "QUOTE", publicToken: token },
      select: { ...PUBLIC_QUOTE_SELECT, userId: true, publicToken: true },
    });

  /**
   * Tell the owner what happened, on both channels they have.
   *
   * Never throws into the request. The client pressed a button and their answer
   * is already recorded; a mail server having a bad afternoon must not turn
   * that into an error page that makes them press it again.
   */
  const notifyOwner = async (quote, { accepted, acceptedName, reason }) => {
    const verb = accepted ? "accepted" : "declined";
    try {
      await createNotification(
        prisma,
        quote.userId,
        accepted ? "Quotation accepted" : "Quotation declined",
        accepted
          ? `${quote.client?.name || "Your client"} accepted ${quote.invoiceNumber}. Nothing has been billed yet — raise the invoice when you are ready.`
          : `${quote.client?.name || "Your client"} declined ${quote.invoiceNumber}.${reason ? ` They said: ${reason}` : ""}`,
        accepted ? "QUOTE_ACCEPTED" : "QUOTE_DECLINED",
      );
    } catch (err) {
      fastify.log.warn({ err, quoteId: quote.id }, `Quote ${verb} notification failed`);
    }

    try {
      const owner = await prisma.user.findUnique({
        where: { id: quote.userId },
        select: { email: true },
      });
      if (!owner?.email) return;

      const { subject, html, text } = getQuoteAnsweredEmail({
        accepted,
        quoteNumber: quote.invoiceNumber,
        clientName: quote.client?.name || "Your client",
        acceptedName,
        reason,
        amount: quote.amount,
        currency: quote.currency,
        quoteId: quote.id,
      });
      /* Not metered. This is the product talking to its own user about their
         own account, the same as any other notification email — the send
         allowance covers messages to CLIENTS. */
      await fastify.email.send({ to: owner.email, subject, html, text });
    } catch (err) {
      fastify.log.warn({ err, quoteId: quote.id }, `Quote ${verb} email failed`);
    }
  };

  /**
   * GET /api/quote/:token
   *
   * The quotation, as the client sees it. Opening the link is what moves a quote
   * from Sent to Viewed — the difference between "they have not replied" and
   * "they have not even looked", which is what the user actually wants to know.
   *
   * Recorded only the FIRST time. viewedAt is when they first opened it, not
   * when they last refreshed, and a status that flickered back to Viewed after
   * an answer would overwrite the answer.
   */
  fastify.get(
    "/:token",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const quote = await findByToken(request.params.token);
      if (!quote) return reply.notFound("Quotation not found");

      /* Only a quotation that has actually been SENT records a view.
         The link exists from the moment the quote is created, so a user can
         open it themselves to check what their client will see — and if that
         stamped viewedAt on a Draft, the row would be permanently marked as
         seen and the real Sent → Viewed transition could never happen again.
         The user would then be told their client had opened it when nobody
         had, which is worse than not tracking views at all. */
      if (!quote.viewedAt && ["Sent", "Viewed"].includes(quote.status)) {
        const now = new Date();
        /* Conditional, so two tabs opened at once cannot both write. */
        const { count } = await prisma.invoice.updateMany({
          where: { id: quote.id, viewedAt: null },
          data: {
            viewedAt: now,
            /* Sent advances to Viewed. Nothing else moves: Accepted, Declined
               and Expired are answers and do not go backwards. */
            ...(quote.status === "Sent" ? { status: "Viewed" } : {}),
          },
        });
        if (count === 1) {
          quote.viewedAt = now;
          if (quote.status === "Sent") quote.status = "Viewed";
        }
      }

      return present(quote);
    },
  );

  /**
   * POST /api/quote/:token/accept
   *
   * One tap, no account, no login. A typed name stands as a simple signature —
   * it is not verified, and nothing in the product claims it is.
   *
   * Idempotent on a second press: the first acceptance stands and is returned
   * again rather than being overwritten with a later timestamp. Somebody
   * double-tapping on a phone must not rewrite the record of when they agreed.
   */
  fastify.post(
    "/:token/accept",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string", maxLength: 120 } },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const quote = await findByToken(request.params.token);
      if (!quote) return reply.notFound("Quotation not found");

      if (quote.acceptedAt) return { ...present(quote), alreadyAnswered: true };
      if (quote.declinedAt) {
        return reply.conflict("This quotation was already declined.");
      }
      if (isExpired(quote)) {
        return reply.gone(
          "This quotation has passed its validity date. Ask for an updated one.",
        );
      }
      if (!isAnswerable(quote)) {
        return reply.conflict("This quotation is not open for a response.");
      }

      const name = (request.body?.name || "").trim() || null;
      const now = new Date();

      /* Conditional write, and everything after it hangs off the row count.
         Read-then-write was wrong in three ways at once: a double-tap on a
         phone overwrote the timestamp of the first acceptance, it emailed the
         owner twice about one decision, and it raced the nightly expiry sweep's
         updateMany. Making the guard part of the WHERE means the database
         decides who wins, and only the winner notifies. */
      const { count } = await prisma.invoice.updateMany({
        where: {
          id: quote.id,
          acceptedAt: null,
          declinedAt: null,
          status: { in: ["Sent", "Viewed"] },
        },
        data: {
          status: "Accepted",
          acceptedAt: now,
          acceptedName: name,
          acceptedIp: callerIp(request),
        },
      });

      if (count === 0) {
        /* Somebody — a second tap, or the sweep — got there first. Show what
           the quotation says now rather than an error about what it said a
           moment ago. */
        const fresh = await findByToken(request.params.token);
        return { ...present(fresh || quote), alreadyAnswered: true };
      }

      quote.status = "Accepted";
      quote.acceptedAt = now;
      quote.acceptedName = name;

      await notifyOwner(quote, { accepted: true, acceptedName: name });

      fastify.log.info({ quoteId: quote.id }, "Quotation accepted by client");
      return present(quote);
    },
  );

  /**
   * POST /api/quote/:token/decline
   *
   * A reason is optional on purpose. Asking is useful; requiring it gets you an
   * empty box or a polite lie, and a declined quotation with no reason is still
   * far better than a quotation the user is left guessing about.
   */
  fastify.post(
    "/:token/decline",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { reason: { type: "string", maxLength: 500 } },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const quote = await findByToken(request.params.token);
      if (!quote) return reply.notFound("Quotation not found");

      if (quote.declinedAt) return { ...present(quote), alreadyAnswered: true };
      if (quote.acceptedAt) {
        return reply.conflict("This quotation was already accepted.");
      }
      /* Expiry does NOT block declining, and "Expired" is in the list below for
         exactly that reason. Saying no to something that has run out is still a
         useful answer, and it is genuinely reachable: a client can open a live
         quotation, think about it, and tap decline a minute after the nightly
         sweep relabelled it. Refusing that answer would leave the user chasing
         a decision that has already been made. The page does not offer a
         decline button on a lapsed quotation, so this path exists for the race,
         not as a second route into it. */
      if (!["Sent", "Viewed", "Expired"].includes(quote.status)) {
        return reply.conflict("This quotation is not open for a response.");
      }

      const reason = (request.body?.reason || "").trim() || null;
      const now = new Date();

      /* Conditional for the same reason accept is — see the comment there. */
      const { count } = await prisma.invoice.updateMany({
        where: {
          id: quote.id,
          acceptedAt: null,
          declinedAt: null,
          status: { in: ["Sent", "Viewed", "Expired"] },
        },
        data: { status: "Declined", declinedAt: now, declineReason: reason },
      });

      if (count === 0) {
        const fresh = await findByToken(request.params.token);
        return { ...present(fresh || quote), alreadyAnswered: true };
      }

      quote.status = "Declined";
      quote.declinedAt = now;

      await notifyOwner(quote, { accepted: false, reason });

      fastify.log.info({ quoteId: quote.id }, "Quotation declined by client");
      return present(quote);
    },
  );
}

module.exports = publicQuoteRoutes;
module.exports.PUBLIC_QUOTE_SELECT = PUBLIC_QUOTE_SELECT;
