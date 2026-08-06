const crypto = require("crypto");
const { safeEqual } = require("./compare");

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
   * Verify a senangPay return/callback hash.
   *
   * senangPay's guide documents MD5, not SHA256:
   *
   *   $string_to_hash = SecretKey . status_id . order_id . transaction_id . msg
   *   $final_hash = md5($string_to_hash);
   *
   * This class was computing a plain SHA256, so it never matched and every
   * senangPay payment failed verification.
   *
   * Both digests are accepted. Newer senangPay accounts can be switched to
   * HMAC-SHA256 in the dashboard, and there is no field in the callback saying
   * which is in force — so the only way to support both merchants is to try
   * each. This does not weaken anything: producing EITHER digest requires the
   * merchant secret, so an attacker gains nothing from a second acceptable
   * form. Both comparisons are constant-time.
   *
   * MD5 is used here because the provider specifies it for this signature, not
   * as a choice — it is a shared-secret integrity check on data we re-verify
   * against the invoice amount anyway, not a password hash.
   */
  verifyHash(params) {
    const { status_id, order_id, transaction_id, msg, hash } = params;
    if (!hash || !this.secretKey) return false;

    const payload = `${status_id}${order_id}${transaction_id}${msg}`;
    const received = String(hash);

    const md5 = crypto
      .createHash("md5")
      .update(`${this.secretKey}${payload}`)
      .digest("hex");
    if (safeEqual(md5, received)) return true;

    const hmac = crypto
      .createHmac("sha256", this.secretKey)
      .update(payload)
      .digest("hex");
    return safeEqual(hmac, received);
  }
}

module.exports = SenangPay;
