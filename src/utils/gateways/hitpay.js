const axios = require("axios");
const crypto = require("crypto");
const { safeEqual } = require("./compare");

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
   * Create a payment request in HitPay.
   *
   * `data.amount` is SEN. HitPay's `amount` is a decimal in the MAJOR unit
   * ("500.00"), so this is one of the two places money leaves as ringgit — the
   * argument used to be ringgit and was passed through untouched, which after
   * the sen migration billed a RM500 invoice as RM50,000.
   */
  async createBill(data) {
    try {
      const response = await axios.post(`${this.baseUrl}/payment-requests`, {
        amount: ((Number(data.amount) || 0) / 100).toFixed(2),
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
   * Verify a HitPay v1 payment-request webhook.
   *
   * This was hashing the RAW BODY, which is the v2 scheme. The v1
   * /payment-requests webhook — the one createBill above subscribes to — posts
   * application/x-www-form-urlencoded and signs the FIELDS. HitPay's own
   * reference implementation:
   *
   *   foreach ($args as $key => $val) { $hmacSource[$key] = "{$key}{$val}"; }
   *   ksort($hmacSource);
   *   $sig = implode("", array_values($hmacSource));   // no separator
   *   hash_hmac('sha256', $sig, $secret);
   *
   * Note "implode with empty string" — unlike Billplz, there is no "|" between
   * pairs. Hashing the raw body could never match this, so every HitPay payment
   * silently failed verification and no invoice was ever settled through it.
   *
   * Values must come from the parsed form as strings, exactly as sent. Do not
   * re-serialise numbers: "599.00" and 599 hash differently.
   */
  verifySignature(fields, receivedSignature) {
    if (!this.salt) return false;
    if (!receivedSignature) return false;

    const sourceString = Object.keys(fields)
      .filter((key) => key !== "hmac")
      .sort()
      .map((key) => `${key}${fields[key]}`)
      .join("");

    const expected = crypto
      .createHmac("sha256", this.salt)
      .update(sourceString)
      .digest("hex");

    return safeEqual(expected, String(receivedSignature));
  }
}

module.exports = HitPay;
