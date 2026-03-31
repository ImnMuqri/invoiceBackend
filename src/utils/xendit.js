const axios = require("axios");

const getAuthToken = () => {
  const secretKey = process.env.XENDIT_SECRET_KEY || "";
  return Buffer.from(secretKey + ":").toString("base64");
};

/**
 * Creates a recurring plan in Xendit.
 * Billed monthly.
 */
async function createRecurringPlan(user, planName, discount = null) {
  // Determine pricing based on plan
  let amount = 0;
  if (planName === "PRO") amount = 59;
  else if (planName === "MAX") amount = 99;
  else throw new Error("Invalid plan for subscription");

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
    success_return_url: `${process.env.FRONTEND_URL || "http://localhost:3000"}/settings?tab=billing&success=true`,
    failure_return_url: `${process.env.FRONTEND_URL || "http://localhost:3000"}/settings?tab=billing&failed=true`,
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
        mobile_number: user.phone || undefined,
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

module.exports = {
  createRecurringPlan,
};
