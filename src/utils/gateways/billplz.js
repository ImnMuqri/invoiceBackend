const axios = require("axios");

/**
 * Billplz Integration Utility
 */
class Billplz {
  constructor(apiKey, collectionId, xSignatureKey) {
    this.apiKey = apiKey;
    this.collectionId = collectionId;
    this.xSignatureKey = xSignatureKey;
    this.baseUrl = "https://www.billplz.com/api/v3";
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
}

module.exports = Billplz;
