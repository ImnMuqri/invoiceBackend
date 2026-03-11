const fp = require("fastify-plugin");
const twilio = require("twilio");

async function whatsappPlugin(fastify, opts) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromWhatsAppNumber =
    process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";

  let client = null;

  if (accountSid && authToken) {
    try {
      client = twilio(accountSid, authToken);
      fastify.log.info(
        "WhatsApp plugin initialized with Twilio SID: " + accountSid,
      );
    } catch (error) {
      fastify.log.error(
        "Failed to initialize Twilio client with provided credentials: " +
          error.message,
      );
      fastify.log.warn("WhatsApp plugin falling back to MOCK mode.");
    }
  } else {
    fastify.log.warn(
      "WhatsApp plugin initialized in MOCK mode. Please provide TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env.",
    );
  }

  const whatsapp = {
    async sendMessage(to, message, credentials = null) {
      if (!to) throw new Error("Recipient number (to) is required");
      if (!message) throw new Error("Message content is required");

      const toWhatsAppNumber = to.startsWith("whatsapp:")
        ? to
        : `whatsapp:${to}`;

      let currentClient = client;
      let currentFrom = fromWhatsAppNumber;

      if (credentials?.sid && credentials?.token && credentials?.phoneNumber) {
        currentClient = twilio(credentials.sid, credentials.token);
        currentFrom = credentials.phoneNumber.startsWith("whatsapp:")
          ? credentials.phoneNumber
          : `whatsapp:${credentials.phoneNumber}`;
      }

      if (currentClient) {
        try {
          const result = await currentClient.messages.create({
            body: message,
            from: currentFrom,
            to: toWhatsAppNumber,
          });
          fastify.log.info(`WhatsApp message sent to ${to}: ${result.sid}`);
          return result;
        } catch (error) {
          fastify.log.error(
            `Failed to send WhatsApp message to ${to}: ${error.message}`,
          );
          throw error;
        }
      } else {
        fastify.log.info(
          `[MOCK WHATSAPP] To: ${toWhatsAppNumber} | Body: ${message}`,
        );
        return { sid: "mock_sid_" + Date.now(), status: "sent" };
      }
    },
  };

  fastify.decorate("whatsapp", whatsapp);
}

module.exports = fp(whatsappPlugin);
