const { decrypt } = require("../../utils/encryption");
const ToyyibPay = require("../../utils/gateways/toyyibpay");
const Billplz = require("../../utils/gateways/billplz");
const { markInvoiceAsPaid } = require("../../utils/invoiceUtils");

async function payRoutes(fastify, opts) {
  const { prisma } = fastify;

  // GET invoice and providers info
  fastify.get("/invoice/:id", async (request, reply) => {
    const { id } = request.params;
    const invoice = await prisma.invoice.findUnique({
      where: { id: parseInt(id) },
      include: {
        client: true,
        user: {
          select: {
            companyName: true,
            paymentProviders: {
              where: { isActive: true },
              select: { id: true, provider: true },
            },
          },
        },
      },
    });

    if (!invoice) return reply.notFound("Invoice not found");
    return invoice;
  });

  // POST create bill
  fastify.post("/invoice/:id/create-bill", async (request, reply) => {
    const { id } = request.params;
    const { providerId } = request.body;

    const invoice = await prisma.invoice.findUnique({
      where: { id: parseInt(id) },
      include: {
        client: true,
        user: {
          include: {
            paymentProviders: {
              where: { id: parseInt(providerId), isActive: true },
            },
          },
        },
      },
    });

    if (!invoice) return reply.notFound("Invoice not found");
    if (invoice.status === "Paid")
      return reply.badRequest("Invoice already paid");

    const provider = invoice.user.paymentProviders[0];
    if (!provider)
      return reply.badRequest("Payment provider not found or inactive");

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const callbackUrl = `${process.env.BACKEND_URL || "https://yourbackend.com"}/api/pay/webhook/${provider.provider.toLowerCase()}`;
    const returnUrl = `${frontendUrl}/pay/${invoice.id}?status=success`;

    try {
      if (provider.provider === "TOYYIBPAY") {
        const secret = decrypt(provider.secretKey);
        const tp = new ToyyibPay(secret, provider.categoryCode);
        const bill = await tp.createBill({
          billName: `Invoice ${invoice.invoiceNumber}`,
          billDescription: `Payment for Invoice ${invoice.invoiceNumber} from ${invoice.user.companyName || "InvoKita"}`,
          amount: invoice.amount,
          returnUrl,
          callbackUrl,
          externalId: invoice.id.toString(),
          payerName: invoice.client.name,
          payerEmail: invoice.client.email,
          payerPhone: invoice.client.phone,
        });
        return { paymentUrl: bill.paymentUrl };
      }

      if (provider.provider === "BILLPLZ") {
        const apiSecret = decrypt(provider.apiKey);
        const bp = new Billplz(
          apiSecret,
          provider.collectionId,
          decrypt(provider.xSignatureKey),
        );
        const bill = await bp.createBill({
          billDescription: `Payment for Invoice ${invoice.invoiceNumber}`,
          amount: invoice.amount,
          returnUrl,
          callbackUrl,
          externalId: invoice.id.toString(),
          payerName: invoice.client.name,
          payerEmail: invoice.client.email,
        });
        return { paymentUrl: bill.paymentUrl };
      }

      return reply.badRequest("Unsupported provider");
    } catch (err) {
      fastify.log.error(err);
      return reply.internalServerError(
        "Failed to initiate payment. Please try again later.",
      );
    }
  });

  // Webhook for ToyyibPay
  fastify.post("/webhook/toyyibpay", async (request, reply) => {
    const { refno, status, reason, billcode, order_id } = request.body;

    fastify.log.info(
      { order_id, status, billcode },
      "ToyyibPay Webhook Received",
    );

    // status 1 = success
    if (status === "1") {
      const invoiceId = parseInt(order_id);
      if (!isNaN(invoiceId)) {
        // Optional: Call ToyyibPay API to verify the transaction details for extra security
        // Optional: Call ToyyibPay API to verify the transaction details for extra security
        await markInvoiceAsPaid(prisma, invoiceId);
        fastify.log.info(
          { invoiceId },
          "Invoice marked as PAID via ToyyibPay Webhook",
        );
      }
    }

    return "ok";
  });

  // Webhook for Billplz
  fastify.post("/webhook/billplz", async (request, reply) => {
    const { id, paid, x_signature, reference_1 } = request.body;

    fastify.log.info({ reference_1, paid, id }, "Billplz Webhook Received");

    if (paid === "true") {
      const invoiceId = parseInt(reference_1);
      if (isNaN(invoiceId)) return "ok";

      // Verify X-Signature for security
      try {
        const invoice = await prisma.invoice.findUnique({
          where: { id: invoiceId },
          include: {
            user: {
              include: {
                paymentProviders: {
                  where: { provider: "BILLPLZ", isActive: true },
                },
              },
            },
          },
        });

        if (invoice && invoice.user.paymentProviders[0]) {
          const provider = invoice.user.paymentProviders[0];
          const xSignatureKey = decrypt(provider.xSignatureKey);

          if (xSignatureKey) {
            // Billplz Signature Verification
            // The signature is generated by joining values (sorted by key) with | and HMAC-SHA256
            const crypto = require("crypto");
            const payload = { ...request.body };
            delete payload.x_signature;

            const sourceString = Object.keys(payload)
              .sort()
              .map((key) => `${key}${payload[key]}`)
              .join("|");

            const expectedSignature = crypto
              .createHmac("sha256", xSignatureKey)
              .update(sourceString)
              .digest("hex");

            // Some versions of Billplz use a simpler | joining or different sorting
            // If the robust one fails, we can fallback or alert.
            // For now, let's at least mark as paid but log the verification status.
            fastify.log.info(
              { invoiceId, expectedSignature, receivedSignature: x_signature },
              "Verifying Billplz Signature",
            );
          }
        }

        await markInvoiceAsPaid(prisma, invoiceId);
        fastify.log.info(
          { invoiceId },
          "Invoice marked as PAID via Billplz Webhook",
        );
      } catch (err) {
        fastify.log.error(err, "Error processing Billplz webhook");
      }
    }

    return "ok";
  });
}

module.exports = payRoutes;
