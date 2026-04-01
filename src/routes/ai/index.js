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
`;

async function aiRoutes(fastify, opts) {
  const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY || "",
  });

  // Apply authentication
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.post("/parse-invoice", async (request, reply) => {
    try {
      // Usage check (Only check if credits available, don't increment yet)
      await fastify.usage.checkOnly(request.user.id, "ai");

      const { currentFormState, instruction } = request.body;

      if (!process.env.GROQ_API_KEY) {
        return reply.internalServerError("GROQ_API_KEY is not configured.");
      }

      const chatCompletion = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: `CURRENT STATE:\n${JSON.stringify(currentFormState, null, 2)}\n\nUSER INSTRUCTION:\n"${instruction}"`,
          },
        ],
        model: "llama-3.3-70b-versatile",
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const replyContent = chatCompletion.choices[0]?.message?.content || "{}";
      const parsedUpdate = JSON.parse(replyContent);

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
