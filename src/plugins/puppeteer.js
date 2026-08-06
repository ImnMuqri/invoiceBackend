const fp = require("fastify-plugin");
const puppeteer = require("puppeteer");

/**
 * PDF rendering.
 *
 * Four things were wrong with the previous version, in rough order of how badly
 * they end:
 *
 *  1. The launch guard raced. `if (!browser) browser = await launch()` has an
 *     await between the check and the assignment, so N concurrent first requests
 *     all saw undefined and all launched a Chrome. Only the last was kept; the
 *     rest were unreachable, uncloseable, and held their memory until the
 *     container died. Measured with the real control flow: 8 concurrent first
 *     requests produced 8 browsers and leaked 7. Two PDF requests arriving
 *     together after a deploy was enough. The fix is to store the PROMISE, so
 *     everyone awaits the same launch.
 *
 *  2. Nothing bounded concurrency. Every request opened a tab; twenty
 *     simultaneous PDFs meant twenty live Chrome tabs on one instance, which is
 *     an OOM kill that takes the whole API down, not just the PDF.
 *
 *  3. `waitUntil: "networkidle0"` waits for 500ms of complete network silence
 *     on top of everything else — a hard floor on every render, for a signal we
 *     do not actually need, because the page tells us when it is ready.
 *
 *  4. If Chrome died, `browser` stayed truthy and every later newPage() threw
 *     until the process restarted.
 */

const MAX_CONCURRENT_PAGES = 2;

async function puppeteerPlugin(fastify, opts) {
  /* The launch PROMISE, not the browser. This is the whole fix for the race:
     the second caller finds a pending promise and awaits it rather than
     starting a second Chrome. */
  let launching = null;

  async function getBrowser() {
    if (launching) {
      const b = await launching;
      if (b.connected) return b;
      launching = null; // died since; fall through and relaunch
    }

    launching = puppeteer
      .launch({
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          /* Chrome's default /dev/shm is 64MB in most containers, and exceeding
             it crashes the tab mid-render rather than failing cleanly. */
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      })
      .then((b) => {
        /* Recovery. Without this a crashed browser stayed cached forever and
           every subsequent PDF threw until someone restarted the service. */
        b.on("disconnected", () => {
          fastify.log.warn("Puppeteer browser disconnected; will relaunch on next use");
          launching = null;
        });
        return b;
      })
      .catch((err) => {
        launching = null; // a failed launch must not be cached
        throw err;
      });

    return launching;
  }

  /* A tiny semaphore. Requests past the limit queue instead of each opening a
     tab, which turns a traffic spike into slower PDFs rather than a dead
     container. */
  let active = 0;
  const waiting = [];

  function acquire() {
    if (active < MAX_CONCURRENT_PAGES) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }

  fastify.decorate("generatePDF", async (url) => {
    await acquire();
    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();

      /* domcontentloaded, not networkidle0. The two waits below are the real
         readiness signals — the content wrapper being visible, and the fonts
         having resolved — and both are specific to this document. networkidle0
         only added a 500ms silence requirement on top of them. */
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      await page.waitForSelector("#invoice-content", {
        visible: true,
        timeout: 15000,
      });

      /* Wait for the webfonts. This used to be a flat 200ms guess captioned
         "for fonts/animations to settle", which is not a wait for fonts — it is
         a wait for 200ms. The faces are declared `font-display: swap`, so text
         paints in the fallback first and swaps when the file arrives; print
         200ms in and the invoice can go out set in Arial. It matters more now
         that every figure on the document — the amount due included — is set in
         Geist Mono, where the fallback is whatever monospace the server has.
         Raced against a timeout so a font that never loads delays the PDF
         rather than failing it. */
      await Promise.race([
        page.evaluate(() => document.fonts.ready),
        new Promise((r) => setTimeout(r, 3000)),
      ]);

      return await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: "5mm", right: "5mm", bottom: "5mm", left: "5mm" },
      });
    } finally {
      /* Closing the page must never mask the real error, and the slot must be
         released even if closing fails — otherwise one bad render permanently
         costs the service a unit of concurrency. */
      if (page) {
        try {
          await page.close();
        } catch (err) {
          fastify.log.warn({ err }, "Failed to close Puppeteer page");
        }
      }
      release();
    }
  });

  fastify.addHook("onClose", async () => {
    if (!launching) return;
    try {
      const browser = await launching;
      await browser.close();
    } catch {
      /* Shutting down; a browser that already died is not a problem. */
    }
  });
}

module.exports = fp(puppeteerPlugin);
