const { decrypt } = require("../../utils/encryption");
const ToyyibPay = require("../../utils/gateways/toyyibpay");
const Billplz = require("../../utils/gateways/billplz");
const HitPay = require("../../utils/gateways/hitpay");
const SenangPay = require("../../utils/gateways/senangpay");
const { recordGatewayPayment, markInvoiceAsPaid, handlePaymentFailure } = require("../../utils/invoiceUtils");

async function payRoutes(fastify, opts) {
  const { prisma } = fastify;

  // GET invoice and providers info
  fastify.get("/invoice/:id", async (request, reply) => {
    const { id } = request.params;
    const invoice = await prisma.invoice.findFirst({
      // Invoices only. A quotation has nothing to pay.
      where: { id: parseInt(id), kind: "INVOICE" },
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
    // Cached; see the prisma plugin. This is the public pay page, so it is the
    // one route where an unauthenticated visitor triggers the lookup.
    const systemConfig = (await fastify.getSystemConfig()) ?? { paymentsEnabled: true };

    return { ...invoice, system: systemConfig };
  });

  // POST create bill
  fastify.post("/invoice/:id/create-bill", async (request, reply) => {
    const { id } = request.params;
    const { providerId } = request.body;

    const invoice = await prisma.invoice.findFirst({
      // Invoices only. A quotation has nothing to pay.
      where: { id: parseInt(id), kind: "INVOICE" },
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

    const invoice = await prisma.invoice.findFirst({
      // Invoices only. A quotation has nothing to pay.
      where: { id: parseInt(id), kind: "INVOICE" },
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
            /* Bind the bill to THIS invoice. Checking only "is some transaction
               on this billcode paid" let anyone settle any invoice with a
               billcode from any paid bill on the same merchant account — pay
               your own RM1 bill, replay its code here. The webhook path always
               matched billExternalReferenceNo; this one did not. */
            const match = response.data.find(
              (txn) =>
                String(txn.billExternalReferenceNo) === String(id) &&
                String(txn.billpaymentStatus) === "1",
            );
            /* UNITS: ToyyibPay reports billpaymentAmount in RINGGIT, and
               invoice.amount is SEN. Both sides used to be multiplied by 100,
               which compared ringgit-cents against sen-hundredths — off by a
               hundred, so a genuinely paid invoice never cleared this gate. */
            const enough =
              match &&
              (match.billpaymentAmount == null ||
                Math.round(Number(match.billpaymentAmount) * 100) >=
                  Math.round(Number(invoice.amount)));
            if (match && enough) {
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
          
          /* Same binding for Billplz: reference_1 is the invoice id we set when
             the bill was created, so require it to match, and require the paid
             amount (in cents) to cover the invoice. */
          const belongs = bill && String(bill.reference_1) === String(id);
          /* Billplz reports paid_amount in SEN, and invoice.amount is SEN, so
             they compare directly. The `* 100` here predated the migration. */
          const covered =
            bill &&
            (bill.paid_amount == null ||
              Number(bill.paid_amount) >= Math.round(Number(invoice.amount)));
          if (belongs && covered && (bill.paid === true || String(bill.paid) === "true")) {
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

  /* ─── Settlement gate ──────────────────────────────────────────────────
     Every webhook goes through here, and nothing settles an invoice unless all
     of the following hold. Each was previously skippable.

     The bug this replaces: verification used to sit inside
     `if (invoice && invoice.user.paymentProviders[0]) { ... }`, and
     markInvoiceAsPaid was called AFTER that block regardless. So when the
     lookup found no active provider for that gateway — which is the normal case
     for any user who connected a different one — execution fell straight past
     the checks and settled the invoice. An unauthenticated POST naming any
     invoice id was enough. Three of the four endpoints were unguarded for any
     given invoice, because merchants typically connect one gateway.

     Failing closed is the whole point: a missing provider, a missing signing
     key, an unverifiable signature and a short payment all end the request
     without touching the invoice. */
  async function settle(request, {
    invoiceId,
    providerKey,
    verify,
    paidAmount = null,
    amountNote = "",
    /* The gateway's own id for this transaction. Carries the deduplication. */
    gatewayRef = null,
  }) {
    if (!Number.isInteger(invoiceId)) return { ok: false, why: "bad invoice id" };

    const invoice = await prisma.invoice.findFirst({
      // Quotations have nothing to pay; a webhook must never settle one.
      where: { id: invoiceId, kind: "INVOICE" },
      select: {
        id: true,
        amount: true,
        status: true,
        user: {
          select: {
            paymentProviders: {
              where: { provider: providerKey, isActive: true },
            },
          },
        },
      },
    });

    if (!invoice) return { ok: false, why: "invoice not found" };
    if (invoice.status === "Paid") return { ok: true, already: true };

    const provider = invoice.user.paymentProviders[0];
    /* No active provider for THIS gateway means this callback cannot be about
       this invoice, whoever sent it. Previously the point where verification
       was skipped; now the point where it stops. */
    if (!provider) return { ok: false, why: `no active ${providerKey} for this invoice` };

    let verified = false;
    try {
      verified = await verify(provider, invoice);
    } catch (err) {
      request.log.error(err, `${providerKey} verification threw`);
      return { ok: false, why: "verification error" };
    }
    if (!verified) return { ok: false, why: "signature/status verification failed" };

    /* Amount. Nothing checked this before, so a one-sen payment settled any
       invoice. Compared in cents to keep float noise out of it.

       Resolved AFTER verify, and callable for that reason: toyyibPay only
       learns the amount during verification, from the API response. Passing it
       as a plain value — or worse as a getter on the argument object, which is
       evaluated at destructuring time — reads it before it exists. */
    const due = typeof paidAmount === "function" ? paidAmount() : paidAmount;
    /* No longer a refusal. Before spec 03 an invoice was paid or unpaid, so a
       short payment had to be rejected or it would have marked the whole
       invoice settled. Now it becomes a partial payment and the balance speaks
       for itself — which is both more honest and what actually happens when a
       client pays half. The amount is still verified: it comes from the
       gateway's own confirmation, not from the request body. */
    if (due !== null && due !== undefined && !Number.isFinite(Number(due))) {
      return { ok: false, why: "gateway reported an unreadable amount" };
    }

    /* Spec 03: record the money, do not flip a flag.
       A gateway confirming less than the full amount leaves the invoice
       PARTIALLY PAID rather than settled, and the chaser then talks about the
       remaining balance instead of the original total. Deduplicated on the
       gateway's reference, so a webhook delivered twice records it once. */
    /* UNITS: `paidAmount` is RINGGIT at every call site, because that is what
       three of the four gateways report and the fourth (Billplz, which reports
       sen) is normalised to it where it is read. It is converted to sen here,
       once. This is the only argument in the backend that is not sen — if you
       add a gateway, normalise to ringgit at the call site, not here. */
    await recordGatewayPayment(prisma, invoiceId, {
      amount: due !== null && due !== undefined
        ? Math.round(Number(due) * 100)
        : invoice.amount,
      method: providerKey,
      gatewayRef: gatewayRef || null,
    });
    return { ok: true, amountNote };
  }

  /** Uniform logging so a refused settlement is never silent. */
  function record(request, gateway, invoiceId, result) {
    if (result.ok) {
      request.log.info({ gateway, invoiceId, already: !!result.already }, "Invoice settled");
    } else {
      request.log.warn({ gateway, invoiceId, reason: result.why }, "Settlement REFUSED");
    }
  }

  // ── ToyyibPay ────────────────────────────────────────────────────────────
  // No callback signature exists; toyyibPay's guidance is to confirm through
  // getBillTransactions, which is what verify does here.
  fastify.post("/webhook/toyyibpay", async (request, reply) => {
    const { status, reason, billcode, order_id } = request.body || {};
    const invoiceId = parseInt(order_id, 10);

    if (status === "3") {
      if (Number.isInteger(invoiceId)) {
        await handlePaymentFailure(prisma, invoiceId, reason || "Payment failed");
      }
      return "ok";
    }
    if (status !== "1") return "ok";

    let confirmedAmount = null;
    const result = await settle(request, {
      invoiceId,
      providerKey: "TOYYIBPAY",
      verify: async (provider) => {
        if (!billcode) return false;
        const tp = new ToyyibPay(decrypt(provider.secretKey), provider.categoryCode);
        const txns = await tp.getBillTransactions(billcode);
        /* Match the bill's own external reference to this invoice. Without it
           any paid billcode from this merchant settles any of its invoices. */
        const paid = (txns || []).find(
          (t) =>
            String(t.billExternalReferenceNo) === String(order_id) &&
            String(t.billpaymentStatus) === "1",
        );
        if (!paid) return false;
        if (paid.billpaymentAmount != null) confirmedAmount = paid.billpaymentAmount;
        return true;
      },
      paidAmount: () => confirmedAmount,
      gatewayRef: billcode ? `toyyibpay:${billcode}` : null,
    });

    record(request, "toyyibpay", invoiceId, result);
    return "ok";
  });

  // ── Billplz ──────────────────────────────────────────────────────────────
  fastify.post("/webhook/billplz", async (request, reply) => {
    const body = request.body || {};
    const { paid, x_signature, reference_1, paid_amount } = body;
    const invoiceId = parseInt(reference_1, 10);

    if (String(paid) !== "true") {
      if (Number.isInteger(invoiceId)) {
        await handlePaymentFailure(
          prisma,
          invoiceId,
          "Transaction was not successful or was cancelled.",
        );
      }
      return "ok";
    }

    const result = await settle(request, {
      invoiceId,
      providerKey: "BILLPLZ",
      // paid_amount is in cents.
      paidAmount: paid_amount != null ? Number(paid_amount) / 100 : null,
      gatewayRef: body.id ? `billplz:${body.id}` : null,
      verify: async (provider) => {
        const xSignatureKey = decrypt(provider.xSignatureKey);
        // No key configured is now a refusal, not a free pass.
        if (!xSignatureKey) return false;
        const bp = new Billplz(decrypt(provider.apiKey), provider.collectionId, xSignatureKey);
        return bp.verifySignature(body, x_signature);
      },
    });

    record(request, "billplz", invoiceId, result);
    return "ok";
  });

  // ── HitPay ───────────────────────────────────────────────────────────────
  fastify.post("/webhook/hitpay", async (request, reply) => {
    const body = request.body || {};
    const { reference_number, status, hmac, amount } = body;
    const invoiceId = parseInt(reference_number, 10);

    const result = await settle(request, {
      invoiceId,
      providerKey: "HITPAY",
      paidAmount: amount != null ? Number(amount) : null,
      gatewayRef: body.payment_id ? `hitpay:${body.payment_id}` : null,
      verify: async (provider) => {
        if (status !== "completed") return false;
        const salt = decrypt(provider.salt);
        if (!salt) return false;
        const hp = new HitPay(decrypt(provider.apiKey), salt);
        // v1 signs the parsed FIELDS, not the raw body — see hitpay.js.
        return hp.verifySignature(body, hmac);
      },
    });

    if (!result.ok && status && status !== "completed") {
      await handlePaymentFailure(prisma, invoiceId, `HitPay status: ${status}`);
    }
    record(request, "hitpay", invoiceId, result);
    return "ok";
  });

  // ── SenangPay ────────────────────────────────────────────────────────────
  fastify.get("/webhook/senangpay", async (request, reply) => {
    const q = request.query || {};
    const { status_id, order_id, msg } = q;
    const invoiceId = parseInt(order_id, 10);

    if (status_id !== "1") {
      if (Number.isInteger(invoiceId)) {
        await handlePaymentFailure(prisma, invoiceId, msg || "SenangPay transaction failed");
      }
      return reply.type("text/plain").send("OK");
    }

    const result = await settle(request, {
      invoiceId,
      providerKey: "SENANGPAY",
      /* senangPay's return parameters are status_id, order_id, transaction_id,
         msg and hash — no amount among them, so there is nothing to compare and
         this stays null rather than being faked. The hash covers order_id, so
         the callback cannot be pointed at a different invoice; it just cannot
         prove how much was paid. */
      paidAmount: null,
      amountNote: "senangPay sends no amount; settled on hash + order_id only",
      gatewayRef: q.transaction_id ? `senangpay:${q.transaction_id}` : null,
      verify: async (provider) => {
        const sp = new SenangPay(provider.merchantId, decrypt(provider.secretKey));
        return sp.verifyHash(q);
      },
    });

    record(request, "senangpay", invoiceId, result);
    return reply.type("text/plain").send("OK");
  });
}

module.exports = payRoutes;
