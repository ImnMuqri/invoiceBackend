const axios = require("axios");

const getAuthToken = () => {
  const secretKey = process.env.XENDIT_SECRET_KEY || "";
  return Buffer.from(secretKey + ":").toString("base64");
};

/**
 * Creates a recurring plan in Xendit.
 * Billed monthly.
 */
async function createRecurringPlan(
  user,
  planName,
  basePrice,
  discount = null,
  successUrl = null,
  failureUrl = null,
) {
  // Determine pricing based on plan
  let amount = basePrice;
  if (amount === undefined || amount === null) {
    throw new Error("Missing price for this subscription plan");
  }

  // Apply discount if present
  if (discount) {
    if (discount.discountType === "PERCENTAGE") {
      amount = amount * (1 - discount.discountValue / 100);
    } else if (discount.discountType === "FIXED") {
      amount = Math.max(0, amount - discount.discountValue);
    }
    // Round to 2 decimal places for Xendit
    amount = Math.round(amount * 100) / 100;
  }

  const referenceId = `sub_${user.id}_${planName}_${Date.now()}`;

  const payload = {
    reference_id: referenceId,
    customer_id: user.xenditCustomerId || undefined, // Can be undefined if customer not created yet, but Xendit requires customer for plans.
    // Wait, Xendit API requires customer_id for recurring payments. We need to create it first.
    recurring_action: "PAYMENT",
    currency: "MYR",
    amount: amount,
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
async function createOneOffCharge({ externalId, amount, description, payerEmail, successUrl, failureUrl }) {
  const response = await axios.post(
    "https://api.xendit.co/v2/invoices",
    {
      external_id: externalId,
      amount,
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
};
