const Groq = require("groq-sdk");

const SYSTEM_PROMPT = `
AI Invoice Parser:

Input: current invoice JSON + user instruction  
Output: JSON of only changed fields for a partial update

Rules:
1. JSON only, no text/markdown
2. Include only fields that changed
3. If client name given without email, infer name@client.com
4. New items must have: name, priceStr (comma format), priceNum (int), qty (int), tax
5. If removing item, return full "lineItems" array without that item
6. If instruction unrelated to invoices, return exactly: {"error":"I can only help with creating and managing your invoices."}
7. Do NOT modify the "from" object or its child fields. These represent the user's own business details and are protected.
9. Existing Clients: You will receive a list of clients. If the user asks to bill to a client whose name is in this list (exact or very close match), MUST return that client's "clientId" (string).
10. Registration: If the client is NOT in the list, or if the user provides new specific details (different address/company/phone), return a "manualClient" object.
11. Mandatory Fields: New clients MUST have "name", "email", and "phone". If missing, return exactly: {"error":"New clients must provide a Name, Email, and Phone Number to proceed."}
12. Edit Guard: If the flag IS_EDIT is true, you are strictly forbidden from changing the client. Do NOT return "clientId", "manualClient", or "showManualClient". If the user asks to change the client, return exactly: {"error":"Sorry, the billed client cannot be changed for an existing invoice. Please create a new invoice if you need to bill a different client."}
13. Protected Field: The "invoiceNumber" is strictly read-only. If the user asks to change it, return exactly: {"error":"The invoice number is permanent and cannot be changed."}
14. Currencies: We only support "MYR", "USD", and "EUR". If the user asks for any other currency, return exactly: {"error":"Sorry, we only support MYR, USD, and EUR at the moment."}
15. Calculations: Do NOT return "amount" or "total". To change the price, update "lineItems". To apply a discount, update "discountPercentage" (0-100) and set "addDiscount" to true.
16. Memory: You do not see chat history. If the user asks to "undo", "restore", or "revert", you must explain that you don't have memory of the previous state and ask them for the specific change again.
`;

async function aiRoutes(fastify, opts) {
  const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY || "",
  });

  // Apply authentication
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.post(
    "/parse-invoice",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          errorResponseBuilder: (request, context) => ({
            statusCode: 429,
            error: "Too Many Requests",
            message:
              "Please slow down! You are sending messages too quickly to the AI. Please wait a moment before trying again.",
          }),
        },
      },
    },
    async (request, reply) => {
    try {
      // 1. Initial check (prevent usage if already at limit)
      await fastify.usage.checkOnly(request.user.id, "ai");

      const { currentFormState, instruction, isEdit } = request.body;

      if (!process.env.GROQ_API_KEY) {
        return reply.internalServerError("GROQ_API_KEY is not configured.");
      }

      const existingClients = await fastify.prisma.client.findMany({
        where: { userId: request.user.id },
        select: {
          id: true,
          name: true,
          company: true,
          email: true,
          phone: true,
          address: true,
        },
      });

      // 2. Call Groq
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: `EXISTING_CLIENTS:\n${JSON.stringify(existingClients, null, 2)}\n\nIS_EDIT: ${isEdit}\n\nCURRENT STATE:\n${JSON.stringify(currentFormState, null, 2)}\n\nUSER INSTRUCTION:\n"${instruction}"`,
          },
        ],
        model: "llama-3.3-70b-versatile",
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const replyContent = chatCompletion.choices[0]?.message?.content || "{}";
      const parsedUpdate = JSON.parse(replyContent);

      // 3. Increment usage after successful AI response
      await fastify.usage.checkAndIncrement(request.user.id, "ai");

      // Validation Layer: Protect "From" details and restrict currencies
      if (parsedUpdate.from) delete parsedUpdate.from;
      if (parsedUpdate.invoiceNumber) delete parsedUpdate.invoiceNumber;
      if (parsedUpdate.amount) delete parsedUpdate.amount;
      if (parsedUpdate.total) delete parsedUpdate.total;

      if (isEdit) {
        if (parsedUpdate.clientId) delete parsedUpdate.clientId;
        if (parsedUpdate.manualClient) delete parsedUpdate.manualClient;
        if (parsedUpdate.showManualClient) delete parsedUpdate.showManualClient;
      }

      const allowedCurrencies = ["MYR", "USD", "EUR"];
      if (
        parsedUpdate.currency &&
        !allowedCurrencies.includes(parsedUpdate.currency)
      ) {
        delete parsedUpdate.currency;
      }

      return {
        status: "success",
        update: parsedUpdate,
      };
    } catch (error) {
      fastify.log.error("Groq parsing error:", error);
      return reply.internalServerError(
        error.message || "Failed to parse instructions with AI.",
      );
    }
  });
}

module.exports = aiRoutes;
