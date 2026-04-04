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
1. Provide EXACTLY 3 insights (no more, no less).
2. "chaser" type: Help the user identify overdue payments with a focus on recovery.
   - Description: Be friendly and explain who is late and for how long.
   - Action: Use a gentle and helpful phrase (e.g., "Give them a warm nudge", "Say hello").
3. "profit" type: Highlight your most valuable client relationships.
   - Description: Praise their high margin or ultra-fast payments.
   - Action: Cheer the user on (e.g., "Keep up the great work!", "You're crushing it!").
4. "growth" type: Identify positive trends or potential areas for expansion.
   - Description: Celebrate revenue milestones or increasing trends.
   - Action: Encourage them warmly (e.g., "Way to go!", "Exciting times ahead!").
5. "info" type: General encouraging business advice or "all caught up" messages.
6. Make descriptions conversational and written in complete sentences. DO NOT write disjointed fragments like "Iman Muqri: 25% margin". Instead write: "Iman Muqri is currently generating a fantastic 25% margin for you."
7. Keep descriptions under 120 characters but ensure they flow naturally.
8. Actions MUST be casual, warm, and highly encouraging (e.g., "Send a quick hello", "Keep it up!", "Awesome work!"). AVOID rigid robotic commands entirely (NEVER use "Scale now", "Stay focused", or "Send reminder").
`;

  const userPrompt = `
CONTEXT:
- Default Currency: ${context.currency}
- Total Revenue (30d): ${context.totalRevenue}
- Outstanding Amount: ${context.outstandingAmount}
- Overdue Invoices: ${JSON.stringify(context.overdueInvoices)}
- Top Clients: ${JSON.stringify(context.topClients)}
- Current Date: ${new Date().toISOString().split("T")[0]}

Please generate exactly 3 friendly, tactical, and naturally-phrased insights for the user.
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
