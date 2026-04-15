const axios = require("axios");

/**
 * ToyyibPay Integration Utility
 */
class ToyyibPay {
  constructor(secretKey, categoryCode) {
    this.secretKey = secretKey;
    this.categoryCode = categoryCode;
    this.baseUrl = process.env.TOYYIBPAY_SANDBOX === "true"
      ? "https://dev.toyyibpay.com"
      : "https://toyyibpay.com";
  }

  /**
   * Create a bill in ToyyibPay
   */
  async createBill(data) {
    const params = new URLSearchParams();
    params.append("userSecretKey", this.secretKey);
    params.append("categoryCode", this.categoryCode);
    params.append("billName", data.billName);
    params.append("billDescription", data.billDescription);
    params.append("billPriceSetting", 1); // Fixed price
    params.append("billPayorInfo", 1); // Show payor info
    params.append("billAmount", Math.round(data.amount * 100)); // In cents
    params.append("billReturnUrl", data.returnUrl);
    params.append("billCallbackUrl", data.callbackUrl);
    params.append("billExternalReferenceNo", data.externalId);
    params.append("billTo", data.payerName);
    params.append("billEmail", data.payerEmail);
    params.append("billPhone", data.payerPhone || "");

    try {
      const response = await axios.post(`${this.baseUrl}/index.php/api/createBill`, params);
      
      if (Array.isArray(response.data) && response.data[0]?.BillCode) {
        return {
          billCode: response.data[0].BillCode,
          paymentUrl: `${this.baseUrl}/${response.data[0].BillCode}`
        };
      }
      
      console.error("ToyyibPay Error:", response.data);
      throw new Error("Failed to create ToyyibPay bill");
    } catch (err) {
      console.error("ToyyibPay API Call failed:", err.message);
      throw err;
    }
  }
}

module.exports = ToyyibPay;
