const crypto = require("crypto");

/**
 * SenangPay Integration Utility - Hardened for Production
 */
class SenangPay {
  constructor(merchantId, secretKey) {
    this.merchantId = merchantId;
    this.secretKey = secretKey;
    this.baseUrl = process.env.SENANGPAY_SANDBOX === "true"
      ? "https://sandbox.senangpay.my/payment"
      : "https://app.senangpay.my/payment";
  }

  /**
   * Create a payment URL for SenangPay
   */
  async createBill(data) {
    const detail = data.billDescription;
    const amount = data.amount.toFixed(2);
    const order_id = data.externalId;

    const sourceString = this.secretKey + detail + amount + order_id;
    const hash = crypto
      .createHash("sha256")
      .update(sourceString)
      .digest("hex");

    const paymentUrl = `${this.baseUrl}/${this.merchantId}?detail=${encodeURIComponent(detail)}&amount=${amount}&order_id=${order_id}&hash=${hash}&name=${encodeURIComponent(data.payerName)}&email=${encodeURIComponent(data.payerEmail)}&phone=${encodeURIComponent(data.payerPhone || "")}`;

    return {
      billId: order_id, 
      paymentUrl: paymentUrl
    };
  }

  /**
   * Verify SenangPay Webhook Hash (Hardened Production Logic)
   * The Hashing is MD5 by default or SHA256 if configured in dashboard.
   * Most modern ones use the concatenated hash.
   */
  verifyHash(params) {
    const { status_id, order_id, transaction_id, msg, hash } = params;
    
    // Exact production sequence: SecretKey + status_id + order_id + transaction_id + msg
    const sourceString = this.secretKey + status_id + order_id + transaction_id + msg;
    
    // We try SHA256 first as it's the modern standard
    const expectedHash = crypto
      .createHash("sha256")
      .update(sourceString)
      .digest("hex");

    return expectedHash === hash;
  }
}

module.exports = SenangPay;
