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
      await page.goto(url, { waitUntil: "networkidle0" });

      // Wait for any animations or dynamic content
      await new Promise((r) => setTimeout(r, 500));

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
