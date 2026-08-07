/**
 * Client import endpoints (spec 08).
 *
 * Three routes and a hard rule between them:
 *
 *   GET  /api/clients/import/template  the optional CSV template
 *   POST /api/clients/import/preview   text in, analysed rows out, writes nothing
 *   POST /api/clients/import/commit    the same text in, clients written
 *
 * THE COMMIT RE-ANALYSES THE TEXT. It does not accept the rows the preview
 * produced. That is the whole safety property of this feature: if the browser
 * sent back a list of rows to write, then what the user approved on screen and
 * what actually reached the database would be two different things separated by
 * a network hop and a JSON payload anyone can edit. Instead the commit takes the
 * original text plus the user's DECISIONS (the mapping, and per-row skip /
 * update / create) and re-derives everything through the same pure functions in
 * utils/clientImport.js. Same input, same code, same answer.
 *
 * Deliberately small, per the spec. No invoice history, no third-party formats,
 * no sync. It reads a list of people and stops.
 */

const {
  FIELDS,
  FIELD_KEYS,
  analyse,
  templateCsv,
} = require("../../utils/clientImport");

/* A paste is a person's client list, not a data feed. This is generous enough
   that nobody real will hit it and small enough that the endpoint cannot be
   used to make the server chew through megabytes of text. */
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_ROWS = 500;

const IMPORT_BODY = {
  type: "object",
  required: ["text"],
  additionalProperties: false,
  properties: {
    text: { type: "string", maxLength: MAX_TEXT_BYTES },
    /* The user's corrections from the mapping step. One entry per column;
       null means "ignore this column". */
    mapping: {
      type: "array",
      maxItems: 64,
      items: { type: ["string", "null"] },
    },
    /* Overrides the header sniff when the user disagrees with it. */
    hasHeader: { type: "boolean" },
  },
};

async function clientImportRoutes(fastify, opts) {
  const { prisma } = fastify;

  fastify.addHook("onRequest", fastify.authenticate);

  /**
   * The user's existing clients, in the shape the matcher wants.
   *
   * Loaded once per request rather than queried per row: a 200-row paste would
   * otherwise be 600 round trips, and on Railway the app and the database are
   * separate services so every one of those is a network hop.
   */
  const loadExisting = (userId) =>
    prisma.client.findMany({
      where: { userId },
      select: { id: true, name: true, email: true, phone: true },
    });

  /** Shared by preview and commit so the two cannot drift. */
  const run = async (request) => {
    const { text, mapping, hasHeader } = request.body;
    const existing = await loadExisting(request.user.id);
    return analyse(text, {
      mappingOverride: Array.isArray(mapping) ? mapping : null,
      hasHeaderOverride: typeof hasHeader === "boolean" ? hasHeader : null,
      existing,
    });
  };

  /**
   * GET /api/clients/import/template
   *
   * Offered, never required — the spec is explicit that the paste path matters
   * more precisely because it needs no export step. This exists for the person
   * who would rather start from a known-good file.
   */
  fastify.get("/template", async (request, reply) => {
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="invokita-clients-template.csv"');
    return templateCsv();
  });

  /** The field list, so the mapping dropdown is built from one definition. */
  fastify.get("/fields", async () => ({ fields: FIELDS }));

  /**
   * POST /api/clients/import/preview
   *
   * Writes nothing. Always called before a commit — the spec requires a preview
   * of what will be created, what matched a duplicate, and what has problems
   * and why, before anything is written.
   */
  fastify.post(
    "/preview",
    { schema: { body: IMPORT_BODY } },
    async (request, reply) => {
      const result = await run(request);

      if (result.rows.length > MAX_ROWS) {
        return reply.badRequest(
          `That is ${result.rows.length} rows and the limit is ${MAX_ROWS}. Import it in a couple of batches.`,
        );
      }

      return result;
    },
  );

  /**
   * POST /api/clients/import/commit
   *
   * `decisions` is a map of row index to "skip" | "create" | "update", carrying
   * the per-row choices the user made in the preview. Anything not named keeps
   * the default the analysis worked out — which for a duplicate is skip, so a
   * list imported twice with nothing touched creates nothing.
   */
  fastify.post(
    "/commit",
    {
      schema: {
        body: {
          ...IMPORT_BODY,
          properties: {
            ...IMPORT_BODY.properties,
            decisions: {
              type: "object",
              additionalProperties: { type: "string", enum: ["skip", "create", "update"] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await run(request);
      const decisions = request.body.decisions || {};

      if (result.rows.length > MAX_ROWS) {
        return reply.badRequest(
          `That is ${result.rows.length} rows and the limit is ${MAX_ROWS}. Import it in a couple of batches.`,
        );
      }

      const created = [];
      const updated = [];
      const skipped = [];

      for (const row of result.rows) {
        const chosen = decisions[String(row.index)] || row.action;

        /* A row with problems is never written, whatever the browser asked for.
           The preview showed it as unimportable; honouring a "create" for it
           here would mean the screen and the database disagreed. */
        if (row.status === "problem") {
          skipped.push({
            index: row.index,
            name: row.values.name || row.raw.name || "(no name)",
            reason: row.issues.map((i) => i.message).join("; ") || "Row has problems",
          });
          continue;
        }

        if (chosen === "skip") {
          skipped.push({
            index: row.index,
            name: row.values.name,
            reason: row.match
              ? `Already in your clients (matched on ${row.matchedOn})`
              : "Skipped",
          });
          continue;
        }

        const v = row.values;
        const payload = {
          name: v.name,
          email: v.email,
          phone: v.phone,
          company: v.company,
          address: v.address,
          registrationNumber: v.registrationNumber,
          tin: v.tin,
          notes: v.notes,
        };

        try {
          if (chosen === "update" && row.match) {
            /* Only fields the import actually carries a value for. An import
               that blanked the address of every client whose spreadsheet
               column happened to be empty would be a data-loss bug wearing the
               costume of a feature. */
            const patch = {};
            for (const [key, value] of Object.entries(payload)) {
              if (value !== null && value !== undefined && value !== "") patch[key] = value;
            }
            const client = await prisma.client.update({
              where: { id: row.match.id, userId: request.user.id },
              data: patch,
            });
            updated.push({ index: row.index, id: client.id, name: client.name });
          } else {
            const client = await prisma.client.create({
              data: { ...payload, userId: request.user.id },
            });
            created.push({ index: row.index, id: client.id, name: client.name });
          }
        } catch (err) {
          /* One bad row must not lose the other 199. The import is deliberately
             not a transaction: a user who imports 200 clients and hits a
             constraint on row 173 wants the 172 that worked, not an error and
             an empty client list. */
          fastify.log.error({ err, index: row.index }, "Client import row failed");
          skipped.push({
            index: row.index,
            name: v.name,
            reason: "Could not be saved — try this one by hand",
          });
        }
      }

      fastify.log.info(
        {
          userId: request.user.id,
          created: created.length,
          updated: updated.length,
          skipped: skipped.length,
        },
        "Client import committed",
      );

      return {
        created,
        updated,
        skipped,
        counts: {
          created: created.length,
          updated: updated.length,
          skipped: skipped.length,
          total: result.rows.length,
        },
        message:
          created.length || updated.length
            ? `${created.length} added${updated.length ? `, ${updated.length} updated` : ""}${
                skipped.length ? `, ${skipped.length} skipped` : ""
              }.`
            : "Nothing was imported.",
      };
    },
  );
}

module.exports = clientImportRoutes;
module.exports.MAX_ROWS = MAX_ROWS;
module.exports.FIELD_KEYS = FIELD_KEYS;
