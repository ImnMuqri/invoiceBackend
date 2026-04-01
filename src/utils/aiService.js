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
You are a strategic business consultant for an entrepreneur. 
Your goal is to provide high-value, tactical, and brief insights based on their invoice and client data.

OUTPUT FORMAT:
JSON only: { "insights": [ { "type": "chaser" | "profit" | "info" | "growth", "title": "...", "description": "...", "action": "..." } ] }

RULES:
1. Provide exactly 3 insights.
2. "chaser" type: Use for overdue invoices. Be specific about the client name and delay days.
3. "profit" type: Use for margin analysis or high-value clients.
4. "growth" type: Use for positive trends or potential upsell opportunities.
5. "info" type: General business advice or "all caught up" statuses.
6. Keep descriptions under 140 characters.
7. Tone should be professional, encouraging, and tactical.
`;

  const userPrompt = `
CONTEXT:
- Default Currency: ${context.currency}
- Total Revenue (30d): ${context.totalRevenue}
- Outstanding Amount: ${context.outstandingAmount}
- Overdue Invoices: ${JSON.stringify(context.overdueInvoices)}
- Top Clients: ${JSON.stringify(context.topClients)}
- Current Date: ${new Date().toISOString().split("T")[0]}

Please generate 3 tactical insights for the user.
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
