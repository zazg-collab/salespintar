const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

const key = Buffer.from('acb6cc1873057d008cdd7710beee05eb31a6412745f35cfea36da28e82ae0021', 'hex');

function decrypt(stored) {
  const parts = stored.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const ciphertext = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

async function run() {
  const bms = await prisma.metaBusinessManager.findMany({
    orderBy: { createdAt: 'desc' },
    take: 1
  });
  const bm = bms[0];
  console.log('Testing BM:', bm.name);
  const token = decrypt(bm.accessToken);
  
  const res1 = await fetch(`https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name&access_token=${token}`);
  console.log('me/adaccounts:', await res1.json());
  
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
run();
