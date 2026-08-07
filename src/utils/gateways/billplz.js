const axios = require("axios");
const crypto = require("crypto");
const { safeEqual } = require("./compare");

/**
 * Billplz Integration Utility
 */
class Billplz {
  constructor(apiKey, collectionId, xSignatureKey) {
    this.apiKey = apiKey;
    this.collectionId = collectionId;
    this.xSignatureKey = xSignatureKey;
    this.baseUrl = process.env.BILLPLZ_SANDBOX === "true"
      ? "https://www.billplz-sandbox.com/api/v3"
      : "https://www.billplz.com/api/v3";
  }

  /**
   * Create a bill in Billplz.
   *
   * `data.amount` is SEN, matching Invoice.amount and every other money value
   * in this codebase. Billplz's `amount` is also sen, so it passes straight
   * through — this used to read `Math.round(data.amount * 100)` because the
   * argument was ringgit, and after the migration to integer sen that multiply
   * was still there: a RM500 invoice generated a Billplz bill for RM50,000.
   */
  async createBill(data) {
    const auth = Buffer.from(`${this.apiKey}:`).toString("base64");
    
    try {
      const response = await axios.post(`${this.baseUrl}/bills`, {
        collection_id: this.collectionId,
        email: data.payerEmail,
        name: data.payerName,
        amount: Math.round(Number(data.amount) || 0), // sen, as Billplz expects
        callback_url: data.callbackUrl,
        redirect_url: data.returnUrl,
        description: data.billDescription,
        reference_1_label: "Invoice ID",
        reference_1: data.externalId
      }, {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json"
        }
      });

      if (response.data && response.data.url) {
        return {
          billId: response.data.id,
          paymentUrl: response.data.url
        };
      }

      console.error("Billplz Error:", response.data);
      throw new Error("Failed to create Billplz bill");
    } catch (err) {
      console.error("Billplz API Call failed:", err.message);
      throw err;
    }
  }
  /**
   * Get bill details from Billplz
   */
  async getBill(billId) {
    const auth = Buffer.from(`${this.apiKey}:`).toString("base64");
    
    try {
      const response = await axios.get(`${this.baseUrl}/bills/${billId}`, {
        headers: {
          Authorization: `Basic ${auth}`
        }
      });
      return response.data;
    } catch (err) {
      console.error("Billplz Get Bill failed:", err.message);
      throw err;
    }
  }

  /**
   * Verify Billplz X-Signature.
   *
   * Per the Billplz API reference: take every posted key except `x_signature`,
   * sort ascending case-insensitively, build "keyvalue" per pair with NO
   * separator inside the pair, join the pairs with "|", then HMAC-SHA256 with
   * the X-Signature key.
   *
   *   amount100|collection_idyhx5t1pp|due_at2018-9-27|idzq0tm2wc|paidtrue|...
   *
   * Two things that were wrong here:
   *   - .sort() is ASCII, so it is case-SENSITIVE. The spec says
   *     case-insensitive. Billplz keys are lowercase today, so this was latent
   *     rather than broken, but it is one added mixed-case field from breaking.
   *   - A missing key returned TRUE. That is fail-open: a provider connected
   *     without its X-Signature key accepted every forged callback. It is a
   *     hard reject now, and the caller refuses to settle without a key.
   */
  verifySignature(params, receivedSignature) {
    if (!this.xSignatureKey) return false;
    if (!receivedSignature) return false;

    const sourceString = Object.keys(params)
      .filter((key) => key !== "x_signature")
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((key) => `${key}${params[key]}`)
      .join("|");

    const expected = crypto
      .createHmac("sha256", this.xSignatureKey)
      .update(sourceString)
      .digest("hex");

    return safeEqual(expected, String(receivedSignature));
  }
}

module.exports = Billplz;
