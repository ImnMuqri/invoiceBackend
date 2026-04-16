const axios = require("axios");

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
   * Create a bill in Billplz
   */
  async createBill(data) {
    const auth = Buffer.from(`${this.apiKey}:`).toString("base64");
    
    try {
      const response = await axios.post(`${this.baseUrl}/bills`, {
        collection_id: this.collectionId,
        email: data.payerEmail,
        name: data.payerName,
        amount: Math.round(data.amount * 100), // In cents
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
   * Verify Billplz X-Signature
   */
  verifySignature(params, receivedSignature) {
    if (!this.xSignatureKey) return true; // Fail-safe if not configured

    // 1. Get all keys except x_signature
    const keys = Object.keys(params)
      .filter((key) => key !== "x_signature")
      .sort();

    // 2. Join into a string: key1value1|key2value2|...
    const sourceString = keys
      .map((key) => `${key}${params[key]}`)
      .join("|");

    // 3. Compute HMAC-SHA256
    const expectedSignature = require("crypto")
      .createHmac("sha256", this.xSignatureKey)
      .update(sourceString)
      .digest("hex");

    return expectedSignature === receivedSignature;
  }
}

module.exports = Billplz;
