const fp = require("fastify-plugin");
const { Resend } = require("resend");

async function emailPlugin(fastify, opts) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  /**
   * Send an email using Resend
   * @param {Object} options - Email options
   * @param {string} options.to - Recipient email
   * @param {string} options.subject - Email subject
   * @param {string} options.html - HTML content
   * @param {string} [options.text] - Plain text content
   * @param {string} [options.from] - Sender email (defaults to InvoKita)
   */
  const send = async ({ to, subject, html, text, from, attachments }) => {
    try {
      if (attachments && attachments.length > 0) {
        fastify.log.info(
          { attachmentCount: attachments.length },
          "Sending email with attachments",
        );
      }
      const { data, error } = await resend.emails.send({
        from: "InvoKita <invo@invokita.bsyx.com>", // Default for unverified domains
        to,
        subject,
        html,
        text,
        attachments,
      });

      if (error) {
        fastify.log.error("Resend Error:", error);
        throw error;
      }

      return data;
    } catch (err) {
      fastify.log.error("Email Service Error:", err);
      throw err;
    }
  };

  fastify.decorate("email", { send });
}

module.exports = fp(emailPlugin);
