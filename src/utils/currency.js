/**
 * Simple currency conversion utility.
 * In a production environment, these rates should be fetched from an external API
 * and cached in a database or Redis.
 */

const EXCHANGE_RATES = {
  MYR: 1.0,
  USD: 4.45, // 1 USD = 4.45 MYR
  EUR: 4.85, // 1 EUR = 4.85 MYR
};

/**
 * Converts an amount from one currency to another.
 * @param {number} amount - The amount to convert.
 * @param {string} fromCurrency - The currency code to convert from (e.g., 'USD').
 * @param {string} toCurrency - The currency code to convert to (e.g., 'MYR').
 * @returns {number} The converted amount.
 */
function convertAmount(amount, fromCurrency, toCurrency) {
  if (!amount) return 0;
  if (!fromCurrency || !toCurrency) return amount;
  if (fromCurrency === toCurrency) return amount;

  const fromRate = EXCHANGE_RATES[fromCurrency.toUpperCase()] || 1.0;
  const toRate = EXCHANGE_RATES[toCurrency.toUpperCase()] || 1.0;

  // Convert to base (MYR) then to target
  const amountInBase = amount * fromRate;
  const convertedAmount = amountInBase / toRate;

  /* Sen in, sen out. `toFixed(2)` here was rounding to a hundredth of a SEN —
     a leftover from when amounts were ringgit — so converted figures carried
     fractional sen that then summed into totals. Whole sen is the smallest
     unit that exists; anything finer is noise the integer model exists to
     eliminate. */
  return Math.round(convertedAmount);
}

module.exports = {
  convertAmount,
  EXCHANGE_RATES,
};
