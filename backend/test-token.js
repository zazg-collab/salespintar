const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'salespintar-secret-key-32-chars-!';
const ENCRYPTION_IV = process.env.ENCRYPTION_IV || 'salespintar-16ch';
const ALGORITHM = 'aes-256-cbc';

function decrypt(text) {
  if (!text) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), Buffer.from(ENCRYPTION_IV));
    let decrypted = decipher.update(text, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    return null;
  }
}

async function run() {
  const bms = await prisma.metaBusinessManager.findMany({
    orderBy: { createdAt: 'desc' },
    take: 1
  });
  if (bms.length === 0) { console.log('no bm'); return; }
  const bm = bms[0];
  console.log('Testing BM:', bm.name);
  const token = decrypt(bm.accessToken);
  
  // Test 1: me/adaccounts
  const res1 = await fetch(`https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name&access_token=${token}`);
  console.log('me/adaccounts:', await res1.json());
  
  // Test 2: {metaBusinessId}/client_ad_accounts
  if (bm.metaBusinessId && bm.metaBusinessId !== 'Auto-Detected') {
    const res2 = await fetch(`https://graph.facebook.com/v21.0/${bm.metaBusinessId}/client_ad_accounts?fields=id,name&access_token=${token}`);
    console.log('client_ad_accounts:', await res2.json());
    
    const res3 = await fetch(`https://graph.facebook.com/v21.0/${bm.metaBusinessId}/owned_ad_accounts?fields=id,name&access_token=${token}`);
    console.log('owned_ad_accounts:', await res3.json());
  } else {
    // try to get business ID from token
    const bRes = await fetch(`https://graph.facebook.com/v21.0/me/businesses?access_token=${token}`);
    const bData = await bRes.json();
    console.log('me/businesses:', bData);
    if (bData.data && bData.data.length > 0) {
       const bid = bData.data[0].id;
       const res2 = await fetch(`https://graph.facebook.com/v21.0/${bid}/client_ad_accounts?fields=id,name&access_token=${token}`);
       console.log('client_ad_accounts:', await res2.json());
       const res3 = await fetch(`https://graph.facebook.com/v21.0/${bid}/owned_ad_accounts?fields=id,name&access_token=${token}`);
       console.log('owned_ad_accounts:', await res3.json());
    }
  }
}
run();
