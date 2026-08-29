import fs from 'fs';
import { LeadProfilerService } from '../modules/leads/lead-profiler.service';
import { redisCache } from '../config/redis';

// Mock Redis methods to bypass the connection error
(redisCache as any).setnx = async () => 1;
(redisCache as any).expire = async () => 1;
(redisCache as any).del = async () => 1;
(redisCache as any).get = async () => null;
(redisCache as any).set = async () => 'OK';
(redisCache as any).on = () => {};

async function main() {
  const filePath = '/Users/anggafatih/Downloads/chat 9 orang/Chat WhatsApp dengan +62 858-2115-1845/Chat WhatsApp dengan +62 858-2115-1845.txt';
  
  if (!fs.existsSync(filePath)) {
    console.log('File Tatti tidak ditemukan!');
    return;
  }

  const transcript = fs.readFileSync(filePath, 'utf-8');
  
  console.log(`🚀 Menjalankan Profiler untuk Tatti (Tanpa DB Redis)...`);
  
  try {
    const profile = await LeadProfilerService.processConversation({
      businessId: 'mock-business-id',
      contactJid: `6285821151845@s.whatsapp.net`,
      csPhone: '628123456789',
      csName: 'Aluna',
      rawTranscript: transcript,
      messageTimestamp: new Date(),
    });

    console.log('\n✅ === HASIL LEAD PROFILER TEPAT SAAT INI === ✅');
    console.log(JSON.stringify(profile, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Error saat proses profiler:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
