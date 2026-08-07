/**
 * Public e-Invoice scope checker API (spec 06).
 *
 * PUBLIC ON PURPOSE — there is no `fastify.authenticate` hook in this file and
 * there must never be one. The tool's whole job is to answer the question a
 * stranger has before they sign up, and gating the answer behind an account
 * kills the sharing that makes it worth building. Note that this also means
 * routeAccess.ts on the frontend must keep these pages out of the protected
 * prefixes; the two decisions have to agree.
 *
 * Nothing here reads or writes the database. The rules are a file.
 */

const { evaluate, publicRuleset, ScopeInputError } = require("../../utils/einvoiceScope");
const { renderVerdict, LOCALES } = require("../../utils/einvoiceCopy");
const { getScopeResultEmail } = require("../../utils/einvoiceEmail");

/* The four answers the form collects. Shared by both POST routes so the check
   and the emailed copy can never accept different inputs. */
const CHECK_INPUT = {
  type: "object",
  required: ["turnoverBand", "startYear", "partOfGroup", "businessType"],
  additionalProperties: false,
  properties: {
    turnoverBand: { type: "string", maxLength: 40 },
    startYear: { type: "integer" },
    partOfGroup: { type: "boolean" },
    businessType: { type: "string", maxLength: 40 },
    locale: { type: "string", enum: LOCALES },
  },
};

async function einvoiceRoutes(fastify, opts) {
  /**
   * GET /api/einvoice/rules
   *
   * The rule set the public form renders itself from — bands, thresholds, the
   * review date. Serving it rather than hardcoding the numbers in the Nuxt app
   * is what keeps the acceptance criterion honest: change a threshold in the
   * config and the dropdown labels move with the answers, no code change.
   */
  fastify.get("/rules", async (request, reply) => {
    /* Rules change a few times a year. Let the CDN and the browser hold it. */
    reply.header("Cache-Control", "public, max-age=300, s-maxage=3600");
    return publicRuleset();
  });

  /**
   * POST /api/einvoice/check
   *
   * Four answers in, a verdict plus rendered copy out. Returns copy for BOTH
   * locales in one response: it is a few hundred bytes, and it means the
   * language toggle on the result is instant and provably the same verdict
   * rather than a second round trip that could disagree with the first.
   */
  fastify.post(
    "/check",
    {
      schema: { body: CHECK_INPUT },
      config: {
        /* Generous — this is a form someone fiddles with, and there is nothing
           expensive or abusable behind it. It is here to cap a script, not a
           curious person. */
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      try {
        const verdict = evaluate(request.body);
        return {
          verdict,
          copy: Object.fromEntries(LOCALES.map((l) => [l, renderVerdict(verdict, l)])),
        };
      } catch (err) {
        if (err instanceof ScopeInputError) {
          return reply.badRequest(`${err.field}: ${err.message}`);
        }
        throw err;
      }
    }
  );

  /**
   * POST /api/einvoice/email
   *
   * Emails a copy of the result. Offered AFTER the answer is on screen, never
   * as the price of seeing it.
   *
   * The body carries the four answers, not the rendered result. That matters:
   * an endpoint that mails arbitrary caller-supplied text to an arbitrary
   * address is an open relay with extra steps. Here the only thing the caller
   * controls is the recipient, and the entire body is regenerated server-side
   * from four enums. There is no field a spammer can write a message into.
   */
  fastify.post(
    "/email",
    {
      schema: {
        body: {
          type: "object",
          required: [...CHECK_INPUT.required, "email"],
          additionalProperties: false,
          properties: {
            ...CHECK_INPUT.properties,
            email: { type: "string", format: "email", maxLength: 200 },
          },
        },
      },
      config: {
        /* Tight, because this one costs money and lands in someone's inbox.
           Per-IP, per-hour: enough for a person who mistyped their address
           twice, not enough to be a mailing tool. */
        rateLimit: { max: 5, timeWindow: "1 hour" },
      },
    },
    async (request, reply) => {
      const { email, locale = "en", ...input } = request.body;

      let verdict;
      try {
        verdict = evaluate(input);
      } catch (err) {
        if (err instanceof ScopeInputError) {
          return reply.badRequest(`${err.field}: ${err.message}`);
        }
        throw err;
      }

      const rendered = renderVerdict(verdict, LOCALES.includes(locale) ? locale : "en");
      const { subject, html, text } = getScopeResultEmail(rendered, verdict);

      try {
        await fastify.email.send({ to: email, subject, html, text });
      } catch (err) {
        fastify.log.error({ err }, "e-Invoice scope result email failed");
        return reply.internalServerError("Could not send that email right now");
      }

      /* No echo of the address in the response body — the caller already knows
         what they typed, and not reflecting it keeps this endpoint useless as
         an address-validity oracle. */
      return { sent: true };
    }
  );
}

module.exports = einvoiceRoutes;
