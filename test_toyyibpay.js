const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const ToyyibPay = require('./src/utils/gateways/toyyibpay');
const { decrypt } = require('./src/utils/encryption');

async function run() {
  const provider = await prisma.paymentProvider.findFirst({
    where: { provider: 'TOYYIBPAY' }
  });
  
  if (!provider) return console.log('No toyyibpay provider found');
  
  let secret;
  try {
     secret = decrypt(provider.secretKey);
  } catch (e) {
     return console.log('Decryption failed, key is bad:', e.message);
  }
  
  console.log('Decrypted key:', secret.substring(0,4) + '***');
  console.log('Category Code:', provider.categoryCode);
  
  const tp = new ToyyibPay(secret, provider.categoryCode);
  // Optional: mimic sandbox env var locally
  process.env.TOYYIBPAY_SANDBOX = "true";
  
  try {
     const res = await tp.createBill({
          billName: `Invoice ${invoice.invoiceNumber || '1'}`,
          billDescription: `Payment for Invoice ${invoice.invoiceNumber || '1'} from ${invoice.user.companyName || "InvoKita"}`,
          amount: invoice.amount || 10,
          returnUrl: 'http://localhost/return',
          callbackUrl: 'http://localhost/callback',
          externalId: invoice.id.toString(),
          payerName: invoice.client.name || 'Test',
          payerEmail: invoice.client.email || 'test@test.com',
          payerPhone: invoice.client.phone || undefined,
     });
     console.log('SUCCESS:', res);
  } catch (e) {
     console.error('ERROR OCCURRED:', e.message);
     if (e.response && e.response.data) console.error('Response details:', JSON.stringify(e.response.data));
  }
}
run();
