const crypto = require("crypto");

/**
 * Constant-time comparison of two hex digests.
 *
 * `a === b` on a signature leaks, through timing, how many leading characters
 * were correct — which turns forging one into a few thousand requests rather
 * than brute force. crypto.timingSafeEqual is the fix, but it throws when the
 * buffers differ in length, and an attacker controls the length of what they
 * send. Compare the lengths first, in the clear: length is not a secret, and
 * every real signature from a given provider is the same length anyway.
 */
function safeEqual(expected, received) {
  if (typeof expected !== "string" || typeof received !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { safeEqual };
