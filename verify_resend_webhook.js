const axios = require('axios');
const { Webhook } = require('svix');

async function testWebhookSecurity() {
  const url = 'http://localhost:3002/api/support/webhook';
  const secret = 'whsec_test_secret_123'; // Dummy secret for testing
  
  // We need to set the environment variable temporarily if we want the actual server to use it,
  // but since we are testing "unauthorized" first, we can just run it.
  
  const payload = JSON.stringify({
    id: "re_inbound_test_" + Date.now(),
    from: "testuser@example.com",
    subject: "Security Test",
    text: "Testing signature verification"
  });

  console.log('--- Phase 1: Test WITHOUT signature ---');
  try {
    // This should fail if the server has RESEND_WEBHOOK_SECRET set
    // But since we can't easily change the running server's ENV, 
    // we'll simulate the "invalid" case by sending WRONG headers.
    await axios.post(url, JSON.parse(payload), {
      headers: {
        'svix-id': 'msg_123',
        'svix-timestamp': Math.floor(Date.now() / 1000).toString(),
        'svix-signature': 'v1,invalid_sig'
      }
    });
    console.log('❌ Error: Server accepted invalid signature (Check if RESEND_WEBHOOK_SECRET is set)');
  } catch (err) {
    if (err.response && err.response.status === 400) {
      console.log('✅ Success: Server rejected invalid signature with 400 Bad Request');
    } else {
      console.error('❌ Unexpected error:', err.message);
    }
  }

  console.log('\n--- Phase 2: Test WITH valid signature ---');
  const wh = new Webhook(secret);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const msgId = 'msg_' + Date.now();
  const signature = wh.sign(msgId, timestamp, payload);

  try {
    // Note: This only works if the server's RESEND_WEBHOOK_SECRET matches our dummy secret
    // For this to really work in the test, you must add RESEND_WEBHOOK_SECRET=whsec_test_secret_123 to .env
    const response = await axios.post(url, JSON.parse(payload), {
      headers: {
        'svix-id': msgId,
        'svix-timestamp': timestamp,
        'svix-signature': signature
      }
    });
    console.log('✅ Success: Server accepted valid signature:', response.data);
  } catch (err) {
    console.error('❌ Error: Server rejected valid signature (Check if secrets match)');
    if (err.response) {
      console.log('Status:', err.response.status);
      console.log('Data:', err.response.data);
    }
  }
}

testWebhookSecurity();
