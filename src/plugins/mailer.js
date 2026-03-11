const fp = require("fastify-plugin");
const nodemailer = require("nodemailer");

async function mailerPlugin(fastify, opts) {
  // Using Ethereal for placeholder testing or standard SMTP if provided
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.ethereal.email",
    port: process.env.SMTP_PORT || 587,
    auth: {
      user: process.env.SMTP_USER || "placeholder@ethereal.email",
      pass: process.env.SMTP_PASS || "placeholder-pass",
    },
  });

  fastify.decorate("mailer", transporter);
}

module.exports = fp(mailerPlugin);
