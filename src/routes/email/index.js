async function emailRoutes(fastify, opts) {
  const { prisma } = fastify;

  // Apply authentication to all routes in this plugin
  fastify.addHook("onRequest", fastify.authenticate);

  /**
   * POST /api/email/test
   * Sends a test email to the logged-in user
   */
  fastify.post("/test", async (request, reply) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
      });

      if (!user) return reply.notFound("User not found");

      const result = await fastify.email.send({
        to: user.email,
        subject: "Test Email from InvoKita",
        html: `
          <div style="font-family: sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #0f172a;">Hello, ${user.name || "User"}!</h2>
            <p style="color: #475569;">This is a test email to confirm that your Resend integration is working perfectly.</p>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
            <p style="font-size: 12px; color: #94a3b8;">Sent via InvoKita Dashboard</p>
          </div>
        `,
      });

      return { success: true, message: "Test email sent successfully", data: result };
    } catch (err) {
      fastify.log.error("Test Email Error:", err);
      return reply.internalServerError("Failed to send test email");
    }
  });

  /**
   * POST /api/email
   * Generic send email endpoint
   */
  fastify.post("/", async (request, reply) => {
    const { to, subject, html, text } = request.body;

    if (!to || !subject || !html) {
      return reply.badRequest("Missing required fields: to, subject, html");
    }

    try {
      // Basic usage check (optional, but good for consistency)
      await fastify.usage.checkAndIncrement(request.user.id, "emailSend");

      const result = await fastify.email.send({ to, subject, html, text });
      return { success: true, message: "Email sent successfully", data: result };
    } catch (err) {
      fastify.log.error("Generic Email Error:", err);
      if (err.statusCode === 403) throw err;
      return reply.internalServerError("Failed to send email");
    }
  });
}

module.exports = emailRoutes;
