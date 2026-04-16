const { decrypt } = require("../../utils/encryption");
const ToyyibPay = require("../../utils/gateways/toyyibpay");
const Billplz = require("../../utils/gateways/billplz");
const HitPay = require("../../utils/gateways/hitpay");
const SenangPay = require("../../utils/gateways/senangpay");
const { markInvoiceAsPaid, handlePaymentFailure } = require("../../utils/invoiceUtils");

async function payRoutes(fastify, opts) {
  const { prisma } = fastify;

  // GET invoice and providers info
  fastify.get("/invoice/:id", async (request, reply) => {
    const { id } = request.params;
    const invoice = await prisma.invoice.findUnique({
      where: { id: parseInt(id) },
      select: {
        id: true,
        invoiceNumber: true,
        invoiceName: true,
        subject: true,
        status: true,
        amount: true,
        currency: true,
        date: true,
        dueDate: true,
        template: true,
        fromName: true,
        fromEmail: true,
        fromCompanyName: true,
        fromAddress: true,
        items: {
          select: { id: true, name: true, quantity: true, price: true, total: true },
        },
        client: {
          select: { name: true, email: true, company: true, address: true },
        },
        user: {
          select: {
            plan: true,
            manualPayment: true,
            paymentProviders: {
              where: { isActive: true },
              select: { id: true, provider: true, isPreferred: true },
            },
          },
        },
      },
    });

    if (!invoice) return reply.notFound("Invoice not found");

    // Flatten manual payment fields for frontend compatibility
    if (invoice.user?.manualPayment) {
      const mp = invoice.user.manualPayment;
      invoice.user.manualBankName = mp.bankName;
      invoice.user.manualAccountNumber = mp.accountNumber;
      invoice.user.manualAccountName = mp.accountName;
      invoice.user.manualQrCode = mp.qrCode;
      delete invoice.user.manualPayment;
    }

    // Fetch only necessary system toggles
    const systemConfig = await prisma.systemConfiguration.findFirst({
      select: { paymentsEnabled: true },
    }) ?? { paymentsEnabled: true };

    return { ...invoice, system: systemConfig };
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

    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
    const backendUrl = (process.env.BACKEND_URL || "https://yourbackend.com").replace(/\/$/, "");
    const callbackUrl = `${backendUrl}/api/pay/webhook/${provider.provider.toLowerCase()}`;
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

      if (provider.provider === "HITPAY") {
        const apiKey = decrypt(provider.apiKey);
        const salt = decrypt(provider.salt);
        const hp = new HitPay(apiKey, salt);
        const bill = await hp.createBill({
          billDescription: `Invoice ${invoice.invoiceNumber}`,
          amount: invoice.amount,
          currency: invoice.currency,
          returnUrl,
          callbackUrl,
          externalId: invoice.id.toString(),
          payerName: invoice.client.name,
          payerEmail: invoice.client.email,
        });
        return { paymentUrl: bill.paymentUrl };
      }

      if (provider.provider === "SENANGPAY") {
        const secretKey = decrypt(provider.secretKey);
        const sp = new SenangPay(provider.merchantId, secretKey);
        const bill = await sp.createBill({
          billDescription: `Invoice ${invoice.invoiceNumber}`,
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

      return reply.badRequest("Unsupported provider");
    } catch (err) {
      fastify.log.error(err);
      return reply.internalServerError(
        "Failed to initiate payment. Please try again later.",
      );
    }
  });

  // GET verify payment (Fallback for when webhooks fail/delay or sandbox local dev)
  fastify.get("/invoice/:id/verify", async (request, reply) => {
    const { id } = request.params;
    const { billcode, transaction_id } = request.query;

    const invoice = await prisma.invoice.findUnique({
      where: { id: parseInt(id) },
      include: {
        user: {
          include: {
            paymentProviders: {
              where: { isActive: true },
            },
          },
        },
      },
    });

    if (!invoice) return reply.notFound("Invoice not found");
    if (invoice.status === "Paid") return { status: "Paid" };

    const billplzId = request.query["billplz[id]"];
    const toyyibpayCode = request.query.billcode;

    // Explicit Fallback Check for ToyyibPay
    if (toyyibpayCode) {
      const provider = invoice.user.paymentProviders.find(p => p.provider === "TOYYIBPAY");
      if (provider) {
        try {
          const axios = require("axios");
          const baseUrl = process.env.TOYYIBPAY_SANDBOX === "true" ? "https://dev.toyyibpay.com" : "https://toyyibpay.com";
          const form = new URLSearchParams();
          form.append("billCode", toyyibpayCode);
          
          const response = await axios.post(`${baseUrl}/index.php/api/getBillTransactions`, form);

          if (Array.isArray(response.data) && response.data.length > 0) {
            const isPaid = response.data.some((txn) => String(txn.billpaymentStatus) === "1");
            if (isPaid) {
              await markInvoiceAsPaid(prisma, parseInt(id));
              fastify.log.info({ invoiceId: invoice.id, toyyibpayCode }, "Invoice marked as PAID via Explicit Frontend Verification (ToyyibPay)");
              return { status: "Paid" };
            }
          }
        } catch (err) {
          fastify.log.error(err, "Explicit Verification Failed for ToyyibPay");
        }
      }
    }
    
    // Explicit Fallback Check for Billplz
    if (billplzId) {
      const provider = invoice.user.paymentProviders.find(p => p.provider === "BILLPLZ");
      if (provider) {
        try {
          const xSignatureKey = decrypt(provider.xSignatureKey);
          const bp = new Billplz(
            decrypt(provider.apiKey),
            provider.collectionId,
            xSignatureKey,
          );
          
          const bill = await bp.getBill(billplzId);
          
          // bill.paid can be boolean or "true" string depending on API version
          if (bill && (bill.paid === true || String(bill.paid) === "true")) {
            await markInvoiceAsPaid(prisma, parseInt(id));
            fastify.log.info({ invoiceId: invoice.id, billplzId }, "Invoice marked as PAID via Explicit Frontend Verification (Billplz)");
            return { status: "Paid" };
          } else {
            fastify.log.warn({ invoiceId: invoice.id, billplzId, billStatus: bill?.state, billPaid: bill?.paid }, "Billplz check: Not paid yet or unexpected response structure");
          }
        } catch (err) {
          fastify.log.error(err, "Explicit Verification Failed for Billplz");
        }
      }
    }

    return { status: invoice.status };
  });

  // Webhook for ToyyibPay
  fastify.post("/webhook/toyyibpay", async (request, reply) => {
    const { refno, status, reason, billcode, order_id } = request.body;

    fastify.log.info(
      { order_id, status, billcode },
      "ToyyibPay Webhook Received",
    );

    // status 1 = success, 3 = failed, 2 = pending
    if (status === "1") {
      const invoiceId = parseInt(order_id);
      if (isNaN(invoiceId)) return "ok";

      try {
        const invoice = await prisma.invoice.findUnique({
          where: { id: invoiceId },
          include: {
            user: {
              include: {
                paymentProviders: {
                  where: { provider: "TOYYIBPAY", isActive: true },
                },
              },
            },
          },
        });

        if (invoice && invoice.user.paymentProviders[0]) {
          const provider = invoice.user.paymentProviders[0];
          const secret = decrypt(provider.secretKey);
          const tp = new ToyyibPay(secret, provider.categoryCode);
          
          // Hardening: Verify the status directly with ToyyibPay API
          const transactions = await tp.getBillTransactions(billcode);
          const isActuallyPaid = transactions.some(
            (txn) => String(txn.billExternalReferenceNo) === order_id && String(txn.billpaymentStatus) === "1"
          );

          if (!isActuallyPaid) {
            fastify.log.warn({ invoiceId, billcode }, "ToyyibPay Webhook Verification Failed: API reports not paid");
            return "ok";
          }
        }

        await markInvoiceAsPaid(prisma, invoiceId);
        fastify.log.info({ invoiceId }, "Invoice marked as PAID via ToyyibPay Webhook (Verified)");
      } catch (err) {
        fastify.log.error(err, "Error verifying ToyyibPay webhook");
      }
    } else if (status === "3") {
      const invoiceId = parseInt(order_id);
      if (!isNaN(invoiceId)) {
        await handlePaymentFailure(prisma, invoiceId, reason || "Payment failed");
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
          const bp = new Billplz(decrypt(provider.apiKey), provider.collectionId, xSignatureKey);

          if (xSignatureKey) {
            if (!bp.verifySignature(request.body, x_signature)) {
              fastify.log.warn({ invoiceId }, "Billplz X-Signature Verification Failed");
              return "ok";
            }
          }
        }

        await markInvoiceAsPaid(prisma, invoiceId);
        fastify.log.info({ invoiceId }, "Invoice marked as PAID via Billplz Webhook (Verified)");
      } catch (err) {
        fastify.log.error(err, "Error processing Billplz webhook");
      }
    } else {
      const invoiceId = parseInt(reference_1);
      if (!isNaN(invoiceId)) {
        await handlePaymentFailure(prisma, invoiceId, "Transaction was not successful or was cancelled.");
        fastify.log.info(
          { invoiceId },
          "Invoice payment FAILED via Billplz Webhook",
        );
      }
    }

    return "ok";
  });

  // Webhook for HitPay
  fastify.post("/webhook/hitpay", async (request, reply) => {
    const { reference_number, status, hmac } = request.body;
    
    fastify.log.info({ reference_number, status }, "HitPay Webhook Received");

    const invoiceId = parseInt(reference_number);
    if (isNaN(invoiceId)) return "ok";

    // Verify Signature
    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          user: {
            include: {
              paymentProviders: {
                where: { provider: "HITPAY", isActive: true },
              },
            },
          },
        },
      });

      if (invoice && invoice.user.paymentProviders[0]) {
        const provider = invoice.user.paymentProviders[0];
        const salt = decrypt(provider.salt);
        const hp = new HitPay(decrypt(provider.apiKey), salt);
        
        if (!hp.verifySignature(request.rawBody, hmac)) {
          fastify.log.warn({ invoiceId }, "HitPay Signature Verification Failed (Hardened)");
          return "ok";
        }
      }

      if (status === "completed") {
        await markInvoiceAsPaid(prisma, invoiceId);
      } else {
        await handlePaymentFailure(prisma, invoiceId, `HitPay status: ${status}`);
      }
    } catch (err) {
      fastify.log.error(err, "Error processing HitPay webhook");
    }

    return "ok";
  });

  // Webhook for SenangPay
  fastify.get("/webhook/senangpay", async (request, reply) => {
    const { status_id, order_id, transaction_id, msg, hash } = request.query;

    fastify.log.info({ order_id, status_id, msg }, "SenangPay Webhook Received");

    const invoiceId = parseInt(order_id);
    if (isNaN(invoiceId)) return "ok";

    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          user: {
            include: {
              paymentProviders: {
                where: { provider: "SENANGPAY", isActive: true },
              },
            },
          },
        },
      });

      if (invoice && invoice.user.paymentProviders[0]) {
        const provider = invoice.user.paymentProviders[0];
        const sp = new SenangPay(provider.merchantId, decrypt(provider.secretKey));
        
        if (!sp.verifyHash(request.query)) {
          fastify.log.warn({ invoiceId }, "SenangPay Hash Verification Failed");
          return "ok";
        }
      }

      // SenangPay status_id: 1 = Success, 0 = Failed
      if (status_id === "1") {
        await markInvoiceAsPaid(prisma, invoiceId);
      } else {
        await handlePaymentFailure(prisma, invoiceId, msg || "SenangPay transaction failed");
      }
    } catch (err) {
      fastify.log.error(err, "Error processing SenangPay webhook");
    }

    return reply.type("text/plain").send("OK");
  });
}

module.exports = payRoutes;
