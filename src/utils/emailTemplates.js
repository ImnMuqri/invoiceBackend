/**
 * Generates a professional HTML email template for invoices
 */
const getInvoiceEmailTemplate = ({
  clientName,
  senderName,
  senderCompany,
  invoiceNumber,
  amount,
  currency,
  dueDate,
  status,
  publicUrl,
}) => {
  const statusColor = status === "Overdue" ? "#ef4444" : "#6366f1";
  const statusBg = status === "Overdue" ? "#fee2e2" : "#eef2ff";

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; color: #1e293b; margin: 0; padding: 0; background-color: #f8fafc; width: 100% !important; }
        .container { max-width: 600px; width: 100%; margin: 40px auto; padding: 32px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
        .header-table { width: 100%; margin-bottom: 32px; }
        .logo-svg { width: 32px; height: 32px; display: inline-block; vertical-align: middle; }
        .logo { font-size: 24px; font-weight: 800; color: #0f172a; letter-spacing: -0.025em; display: inline-block; vertical-align: middle; margin-left: 12px; }
        .intro { margin-bottom: 32px; font-size: 16px; color: #475569; }
        
        /* UI Card Styling */
        .invoice-card { background-color: #f1f5f9; border-radius: 12px; padding: 24px; margin-bottom: 32px; text-align: center; }
        .status-badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: ${statusColor}; background-color: ${statusBg}; margin-bottom: 16px; }
        .invoice-id { font-size: 14px; color: #64748b; margin-bottom: 8px; display: block; }
        .amount-label { font-size: 14px; color: #475569; margin-bottom: 4px; display: block; }
        .amount-value { font-size: 36px; font-weight: 800; color: #0f172a; margin-bottom: 16px; }
        .due-date { font-size: 14px; color: #64748b; padding-top: 16px; border-top: 1px solid #e2e8f0; }

        .button { display: inline-block; background-color: #0f172a; color: #ffffff !important; padding: 14px 28px; border-radius: 10px; font-weight: 600; text-decoration: none; transition: background-color 0.2s; margin-bottom: 24px; }
        .footer { text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 24px; }
      </style>
    </head>
    <body>
      <div class="container">
        <table class="header-table" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center">
              <img
                src="${process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/['"]/g, "").replace(/\/$/, "") : "http://localhost:3000"}/InvoKitaLogo.png"
                alt="InvoKita Logo"
                style="width: 32px; height: 32px; vertical-align: middle;" />
              <span class="logo">InvoKita</span>
            </td>
          </tr>
        </table>
        
        <p class="intro">
          Hi <strong>${clientName}</strong>,
          <br><br>
          You have received an invoice from <strong>${senderName}</strong> ${senderCompany ? `at <strong>${senderCompany}</strong>` : ""} via InvoKita.
        </p>

        <div class="invoice-card">
          <span class="status-badge">${status}</span>
          <span class="invoice-id">${invoiceNumber}</span>
          <span class="amount-label">Amount Due</span>
          <div class="amount-value">${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div class="due-date">Due ${new Date(dueDate).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}</div>
        </div>

        <div style="text-align: center;">
          <a href="${publicUrl}" class="button">View & Pay Invoice</a>
        </div>

        <p style="font-size: 14px; color: #64748b; text-align: center; margin-bottom: 32px;">
          A PDF copy of your invoice is also attached to this email.
        </p>

        <div class="footer">
          This email was sent via InvoKita. 
          <br>
          Accurate & Professional Invoicing.
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = {
  getInvoiceEmailTemplate,
};
