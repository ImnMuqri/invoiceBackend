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

      // Wait a tiny bit more for fonts/animations to settle
      await new Promise((r) => setTimeout(r, 200));

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
