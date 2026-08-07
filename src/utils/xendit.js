const axios = require("axios");

const getAuthToken = () => {
  const secretKey = process.env.XENDIT_SECRET_KEY || "";
  return Buffer.from(secretKey + ":").toString("base64");
};

/**
 * THE UNIT BOUNDARY.
 *
 * Everything in this database is sen. Xendit's MYR `amount` is RINGGIT — the
 * live MAX subscription was created when Plan.price held 99 and it bills RM99,
 * which is what proves the unit. Once prices moved to sen, `Plan.price` for PRO
 * became 2900 and was still being handed to Xendit unconverted: the next person
 * to subscribe would have been asked to authorise RM2,900 a month for a RM29
 * plan, on a real card, with a real mandate.
 *
 * So this file converts exactly once, here, at the moment of leaving. Arithmetic
 * above it is in sen; the number in the payload is ringgit. Nothing in between.
 */
const toRinggit = (sen) => Math.round(Number(sen) || 0) / 100;

/**
 * Applies a promo code to a price. Sen in, sen out.
 *
 * PERCENTAGE is unit-agnostic. FIXED is not: `discountValue` is a Float an
 * admin typed into a form, and nobody types "500" meaning RM5 off — it is
 * ringgit, and converting it is the only reading that matches the number on
 * the screen. Exported so the billing page can show the same figure this
 * function will charge; two implementations of a discount is how a customer
 * gets billed something other than the price they were quoted.
 */
function applyDiscount(senPrice, discount) {
  const base = Number(senPrice) || 0;
  if (!discount) return base;
  if (discount.discountType === "PERCENTAGE") {
    return Math.max(0, Math.round(base * (1 - Number(discount.discountValue) / 100)));
  }
  if (discount.discountType === "FIXED") {
    return Math.max(0, Math.round(base - Number(discount.discountValue) * 100));
  }
  return base;
}

/**
 * Creates a recurring plan in Xendit.
 * Billed monthly. `basePrice` is SEN, as Plan.price is.
 */
async function createRecurringPlan(
  user,
  planName,
  basePrice,
  discount = null,
  successUrl = null,
  failureUrl = null,
) {
  if (basePrice === undefined || basePrice === null) {
    throw new Error("Missing price for this subscription plan");
  }

  /* Sen throughout. Converted only in the payload below. */
  const amount = applyDiscount(basePrice, discount);

  const referenceId = `sub_${user.id}_${planName}_${Date.now()}`;

  const payload = {
    reference_id: referenceId,
    customer_id: user.xenditCustomerId || undefined, // Can be undefined if customer not created yet, but Xendit requires customer for plans.
    // Wait, Xendit API requires customer_id for recurring payments. We need to create it first.
    recurring_action: "PAYMENT",
    currency: "MYR",
    /* Ringgit. The only place in this codebase where money is not sen. */
    amount: toRinggit(amount),
    schedule: {
      reference_id: `schedule_${referenceId}`,
      interval: "MONTH",
      interval_count: 1,
    },
    notification_config: {
      recurring_created: ["EMAIL"],
      recurring_succeeded: ["EMAIL"],
      recurring_failed: ["EMAIL"],
    },
    success_return_url:
      successUrl ||
      `${process.env.FRONTEND_URL || "http://localhost:3000"}/settings?tab=billing&success=true`,
    failure_return_url:
      failureUrl ||
      `${process.env.FRONTEND_URL || "http://localhost:3000"}/settings?tab=billing&failed=true`,
  };

  // 1. If no xenditCustomerId, create a Customer first
  let customerId = user.xenditCustomerId;
  if (!customerId) {
    const customerResponse = await axios.post(
      "https://api.xendit.co/customers",
      {
        reference_id: `cust_${user.id}_${Date.now()}`,
        type: "INDIVIDUAL",
        individual_detail: {
          given_names: user.name || "User",
        },
        email: user.email,
        mobile_number: user.companyPhone || user.phoneNumber || undefined,
      },
      {
        headers: {
          Authorization: `Basic ${getAuthToken()}`,
          "Content-Type": "application/json",
        },
      },
    );
    customerId = customerResponse.data.id;
  }

  payload.customer_id = customerId;

  // 2. Create the plan
  const response = await axios.post(
    "https://api.xendit.co/recurring/plans",
    payload,
    {
      headers: {
        Authorization: `Basic ${getAuthToken()}`,
        "Content-Type": "application/json",
      },
    },
  );

  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();

  await prisma.subscription.create({
    data: {
      userId: user.id,
      xenditSubscriptionId: response.data.id || referenceId,
      plan: planName,
      /* Sen, matching the column. Not the ringgit figure sent to Xendit. */
      amount: amount,
      status: "PENDING", // Will be ACTIVE upon successful webhook
    },
  });

  return { plan: response.data, customerId };
}

async function cancelRecurringPlan(planId) {
  if (!planId) return;

  try {
    await axios.post(
      `https://api.xendit.co/recurring/plans/${planId}/deactivate`,
      {},
      {
        headers: {
          Authorization: `Basic ${getAuthToken()}`,
          "Content-Type": "application/json",
        },
      },
    );
    return true;
  } catch (error) {
    console.error(`Failed to deactivate Xendit plan ${planId}:`, error.message);
    return false;
  }
}

/**
 * A one-off charge, for top-ups (spec 01).
 *
 * Deliberately not a recurring plan: a top-up is a single purchase of extra
 * chased invoices for the current period, and it does not roll over. Xendit's
 * Invoice API is the right primitive — it returns a hosted payment page and
 * fires the same webhook infrastructure on settlement.
 */
/* `amount` is SEN, like every other amount in this codebase. Converted on the
   way out, same as the recurring plan above. */
async function createOneOffCharge({ externalId, amount, description, payerEmail, successUrl, failureUrl }) {
  const response = await axios.post(
    "https://api.xendit.co/v2/invoices",
    {
      external_id: externalId,
      amount: toRinggit(amount),
      description,
      payer_email: payerEmail,
      currency: "MYR",
      success_redirect_url: successUrl,
      failure_redirect_url: failureUrl,
      /* Short window on purpose: this buys headroom for the CURRENT period, so
         a link paid three weeks later would credit a period that has closed. */
      invoice_duration: 86400,
    },
    { headers: { Authorization: getAuthToken(), "Content-Type": "application/json" } },
  );
  return { id: response.data.id, checkoutUrl: response.data.invoice_url };
}

module.exports = {
  createOneOffCharge,
  createRecurringPlan,
  cancelRecurringPlan,
  applyDiscount,
  toRinggit,
};
