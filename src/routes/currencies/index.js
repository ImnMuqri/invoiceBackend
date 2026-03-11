async function currencyRoutes(fastify, opts) {
  fastify.get("/", async (request, reply) => {
    // Define available currencies
    const currencies = [
      { value: "MYR", label: "MYR (RM)" },
      { value: "USD", label: "USD ($)" },
      { value: "EUR", label: "EUR (€)" },
    ];
    return currencies;
  });
}

module.exports = currencyRoutes;
