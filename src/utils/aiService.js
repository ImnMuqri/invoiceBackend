const Groq = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || "",
});

/**
 * Generate AI Insights for the dashboard
 * @param {Object} context - Data about the user's business
 * @returns {Promise<Array>} - Array of insight objects
 */
async function generateInsights(context) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not configured.");
  }

  const systemPrompt = `
You are a friendly and savvy strategic business partner for an entrepreneur. 
Your goal is to provide high-value, tactical, and supportive insights based on their invoice and client data.

Tone: Warm, encouraging, and professional. Speak like a supportive mentor who wants to see them grow. 
Instead of robotic titles like "Overdue Invoice", use more human titles like "Payment Opportunity" or "Client Spotlight".

OUTPUT FORMAT:
JSON only: { "insights": [ { "type": "chaser" | "profit" | "info" | "growth", "title": "...", "description": "...", "action": "..." } ] }

RULES:
1. Provide up to 5 insights (minimum 2). 
2. "chaser" type: Help the user identify overdue payments with a focus on recovery.
3. "profit" type: Highlight your most valuable client relationships.
4. "growth" type: Identify positive trends or potential areas for expansion.
5. "info" type: General encouraging business advice or "all caught up" messages.
6. Keep descriptions friendly and concise (under 180 characters).
`;

  const userPrompt = `
CONTEXT:
- Default Currency: ${context.currency}
- Total Revenue (30d): ${context.totalRevenue}
- Outstanding Amount: ${context.outstandingAmount}
- Overdue Invoices: ${JSON.stringify(context.overdueInvoices)}
- Top Clients: ${JSON.stringify(context.topClients)}
- Current Date: ${new Date().toISOString().split("T")[0]}

Please generate up to 5 friendly and tactical insights for the user.
`;

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      response_format: { type: "json_object" },
    });

    const content = chatCompletion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    return parsed.insights || [];
  } catch (error) {
    console.error("AI Insight Generation Error:", error);
    return [
      {
        type: "info",
        title: "AI Analysis Paused",
        description:
          "We couldn't reach the tactical advisor at this time. Using rule-based fallback.",
        action: "View All",
      },
    ];
  }
}

module.exports = {
  generateInsights,
};
