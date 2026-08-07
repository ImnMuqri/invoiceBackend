const archiver = require("archiver");
const ex = require("../../utils/accountantExport");

/**
 * Accountant export (spec 04).
 *
 * Nothing is written to disk. Uploads on this service go to local storage,
 * which on Railway is ephemeral — a generated file would survive until the next
 * deploy and then 404 from somebody's inbox. Exports are streamed on request
 * instead, so a link is a request rather than a file, and re-opening an old one
 * simply regenerates it.
 */

const INCLUDE_PDFS_LIMIT = 100;

async function exportRoutes(fastify, opts) {
  const { prisma } = fastify;

  /** Everything the export needs, in one query. */
  const load = (userId, query) =>
    prisma.invoice.findMany({
      where: ex.whereFor(userId, query),
      orderBy: { date: "asc" },
      include: {
        client: {
          select: { name: true, registrationNumber: true, tin: true, company: true },
        },
        items: { select: { total: true } },
        payments: {
          select: {
            receivedAt: true, amount: true, method: true,
            reference: true, automatic: true, note: true,
          },
        },
      },
    });

  const parseRange = (q = {}) => ({
    from: q.from || null,
    to: q.to || null,
    clientId: q.clientId || null,
    status: q.status || null,
    includeVoided: q.includeVoided === "true" || q.includeVoided === true,
  });

  /** Filename stem, so a folder of exports is sortable and self-describing. */
  const stem = (range) =>
    `invokita-${range.from ? ex.isoDate(range.from) : "start"}-to-${range.to ? ex.isoDate(range.to) : "today"}`;

  fastify.register(async function (protectedInstance) {
    protectedInstance.addHook("onRequest", fastify.authenticate);

    /** What a range contains, before committing to generating it. */
    protectedInstance.get("/preview", async (request) => {
      const range = parseRange(request.query);
      const invoices = await load(request.user.id, range);
      return {
        ...ex.summarise(invoices),
        /* Told up front rather than discovered after a long wait. */
        pdfsIncluded: invoices.length <= INCLUDE_PDFS_LIMIT,
        pdfLimit: INCLUDE_PDFS_LIMIT,
      };
    });

    protectedInstance.get("/invoices.csv", async (request, reply) => {
      const range = parseRange(request.query);
      const invoices = await load(request.user.id, range);
      const csv = ex.toCsv(ex.INVOICE_COLUMNS, invoices.map(ex.invoiceRow));

      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${stem(range)}-invoices.csv"`)
        .send(csv);
    });

    /** The detail behind the one-row-per-invoice file. */
    protectedInstance.get("/payments.csv", async (request, reply) => {
      const range = parseRange(request.query);
      const invoices = await load(request.user.id, range);
      const csv = ex.toCsv(ex.PAYMENT_COLUMNS, ex.paymentRows(invoices));

      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${stem(range)}-payments.csv"`)
        .send(csv);
    });

    /**
     * The pack: a cover and listing PDF, plus every invoice PDF, as a ZIP.
     *
     * A ZIP rather than one merged document, deliberately. Each invoice PDF is
     * a Puppeteer render; merging a year of them means holding a hundred
     * buffers in memory to produce a 400-page file nobody scrolls. An
     * accountant wants them as files.
     */
    protectedInstance.get("/pack.zip", async (request, reply) => {
      const range = parseRange(request.query);
      const invoices = await load(request.user.id, range);

      const profile = await prisma.userProfile.findUnique({
        where: { userId: request.user.id },
      });

      reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${stem(range)}.zip"`);

      const zip = archiver("zip", { zlib: { level: 9 } });
      const chunks = [];
      zip.on("data", (c) => chunks.push(c));

      /* Assembled fully, then sent — not streamed.
         Streaming looked right and was not: entries appended after an `await`
         (each invoice PDF is a Puppeteer render) did not make it into the
         archive, because the response had already been handed the stream and
         finalised around them. The CSVs landed and the PDFs silently did not,
         which is the worst kind of bug in an export — a file that looks
         complete.

         Buffering is safe here precisely because the pack is capped at
         INCLUDE_PDFS_LIMIT invoices; above that the PDFs are omitted anyway, so
         the buffer has a known ceiling rather than growing with the range. */
      const done = new Promise((resolve, reject) => {
        zip.on("end", resolve);
        zip.on("error", reject);
      });

      zip.append(ex.toCsv(ex.INVOICE_COLUMNS, invoices.map(ex.invoiceRow)), {
        name: "invoices.csv",
      });
      zip.append(ex.toCsv(ex.PAYMENT_COLUMNS, ex.paymentRows(invoices)), {
        name: "payments.csv",
      });
      zip.append(coverText(profile, range, ex.summarise(invoices), invoices.length), {
        name: "summary.txt",
      });

      /* Above the threshold the invoice PDFs are left out rather than silently
         taking ten minutes. The preview endpoint says so before the user
         commits, and a note in the ZIP says so after. */
      if (invoices.length <= INCLUDE_PDFS_LIMIT) {
        const { createRenderToken } = require("../../utils/renderToken");
        const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000")
          .replace(/['"]/g, "")
          .replace(/\/$/, "");

        for (const inv of invoices) {
          try {
            const url = `${frontendUrl}/invoices/${inv.id}/export?renderToken=${createRenderToken(inv.id)}`;
            const pdf = await fastify.generatePDF(url);
            zip.append(Buffer.from(pdf), {
              name: `invoices/${inv.invoiceNumber || inv.id}.pdf`,
            });
          } catch (err) {
            /* One unrenderable invoice must not cost the whole export. Say so
               in the archive rather than leaving a silent gap. */
            fastify.log.warn({ err, invoiceId: inv.id }, "Export: PDF failed");
            zip.append(
              `This invoice could not be rendered when the export was generated.
`,
              { name: `invoices/${inv.invoiceNumber || inv.id}-FAILED.txt` },
            );
          }
        }
      } else {
        zip.append(
          `This period contains ${invoices.length} invoices, above the ${INCLUDE_PDFS_LIMIT} included in a pack.
` +
            `The CSV files cover every one of them. Export a shorter range to get the individual PDFs.
`,
          { name: "invoices/README.txt" },
        );
      }

      zip.finalize();
      await done;

      return reply.send(Buffer.concat(chunks));
    });
  });
}

/** The cover page, as text. Plain on purpose: it is read, not designed. */
function coverText(profile, range, s, count) {
  const money = (v) => ex.amount(v);
  return [
    `${profile?.companyName || "Your business"}`,
    profile?.registrationNumber ? `Registration no: ${profile.registrationNumber}` : null,
    profile?.tin ? `TIN: ${profile.tin}` : null,
    profile?.sstNumber ? `SST no: ${profile.sstNumber}` : null,
    "",
    `Period: ${range.from ? ex.isoDate(range.from) : "start"} to ${range.to ? ex.isoDate(range.to) : "today"}`,
    `Generated: ${ex.isoDate(new Date())}`,
    range.includeVoided ? "Voided invoices: included" : "Voided invoices: excluded",
    "",
    "SUMMARY",
    `  Invoices issued      ${String(s.issued).padStart(6)}   ${money(s.issuedTotal)}`,
    `  Settled              ${String(s.settled).padStart(6)}   ${money(s.settledTotal)}`,
    `  Still outstanding    ${String(s.outstanding).padStart(6)}   ${money(s.outstandingTotal)}`,
    `  With credit notes    ${String(s.credited).padStart(6)}   ${money(s.creditedTotal)}`,
    "",
    `Individual invoice PDFs: ${count <= 100 ? "included" : "not included, see invoices/README.txt"}`,
    "",
    "invoices.csv holds one row per invoice. payments.csv holds every individual",
    "payment, for invoices settled in more than one instalment.",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

module.exports = exportRoutes;
module.exports.INCLUDE_PDFS_LIMIT = INCLUDE_PDFS_LIMIT;
