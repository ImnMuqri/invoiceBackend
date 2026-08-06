const fp = require("fastify-plugin");
const puppeteer = require("puppeteer");

async function puppeteerPlugin(fastify, opts) {
  let browser;

  fastify.decorate("generatePDF", async (url) => {
    if (!browser) {
      browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    }

    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

      // Wait for the invoice content to be rendered
      await page.waitForSelector("#invoice-content", { visible: true, timeout: 5000 });

      // Then wait for the webfonts specifically. This used to be a flat 200ms
      // guess captioned "for fonts/animations to settle", which is not a wait
      // for fonts — it is a wait for 200ms. The faces are declared
      // `font-display: swap`, so text paints in the fallback first and swaps
      // when the file arrives; print 200ms in and the invoice can go out set in
      // Arial. It matters more now that every figure on the document — the
      // amount due included — is set in Geist Mono, where the fallback is
      // whatever monospace the server happens to have.
      //
      // document.fonts.ready resolves once font loading has finished, so this
      // waits for exactly the thing the comment always claimed to. Guarded by a
      // timeout so a font that never loads delays the PDF rather than failing it.
      await Promise.race([
        page.evaluate(() => document.fonts.ready),
        new Promise((r) => setTimeout(r, 3000)),
      ]);

      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        margin: {
          top: "5mm",
          right: "5mm",
          bottom: "5mm",
          left: "5mm",
        },
      });
      return pdf;
    } finally {
      await page.close();
    }
  });

  fastify.addHook("onClose", async (fastify) => {
    if (browser) await browser.close();
  });
}

module.exports = fp(puppeteerPlugin);
