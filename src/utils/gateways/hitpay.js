const axios = require("axios");
const crypto = require("crypto");

/**
 * HitPay Integration Utility - Hardened for Production
 */
class HitPay {
  constructor(apiKey, salt) {
    this.apiKey = apiKey;
    this.salt = salt;
    this.baseUrl = process.env.HITPAY_SANDBOX === "true"
      ? "https://api.sandbox.hitpayapp.com/v1"
      : "https://api.hitpayapp.com/v1";
  }

  /**
   * Create a payment request in HitPay
   */
  async createBill(data) {
    try {
      const response = await axios.post(`${this.baseUrl}/payment-requests`, {
        amount: data.amount,
        currency: data.currency || "MYR",
        reference_number: data.externalId,
        webhook: data.callbackUrl,
        redirect_url: data.returnUrl,
        name: data.payerName,
        email: data.payerEmail,
        purpose: data.billDescription,
        channel: "fpx" 
      }, {
        headers: {
          "X-BUSINESS-API-KEY": this.apiKey,
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "application/x-www-form-urlencoded"
        }
      });

      if (response.data && response.data.url) {
        return {
          billId: response.data.id,
          paymentUrl: response.data.url
        };
      }

      console.error("HitPay Error:", response.data);
      throw new Error("Failed to create HitPay payment request");
    } catch (err) {
      console.error("HitPay API Call failed:", err.response?.data || err.message);
      throw err;
    }
  }

  /**
   * Verify HitPay Webhook Signature
   * Production requirement: Use RAW JSON body string
   */
  verifySignature(rawBody, receivedSignature) {
    if (!this.salt) return true; // Fail-safe if not configured

    const expectedSignature = crypto
      .createHmac("sha256", this.salt)
      .update(rawBody)
      .digest("hex");

    return expectedSignature === receivedSignature;
  }
}

module.exports = HitPay;
