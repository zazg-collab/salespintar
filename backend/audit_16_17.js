const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { LeadProfilerService } = require('./dist/modules/leads/lead-profiler.service');

async function runAudit() {
  console.log('Load dataset...');
  const data = JSON.parse(fs.readFileSync('/Users/anggafatih/.gemini/antigravity/brain/5c2f28d1-9ba8-428e-83dc-5e9c1f545567/scratch/forensic_aug17_detailed.json', 'utf8'));
  
  console.log(`Found ${data.length} leads. Running LeadProfiler on each...`);
  const results = [];
  
  let i = 0;
  for (const lead of data) {
    i++;
    console.log(`\n[${i}/${data.length}] Processing WA: ${lead.wa}...`);
    
    // Simulate Head-Tail compression
    const lines = lead.full_text.split('\n');
    let rawTranscript = lead.full_text;
    if (lines.length > 35) {
      const head = lines.slice(0, 10);
      const tail = lines.slice(-25);
      rawTranscript = head.join('\n') + `\n\n[... ${lines.length - 35} pesan disembunyikan ...]\n\n` + tail.join('\n');
    }
    
    // Since LeadProfiler uses Prisma, it will write to DB. That's fine.
    try {
      const result = await LeadProfilerService.processConversation({
        businessId: '11111111-1111-1111-1111-111111111111', // Dummy
        contactJid: `${lead.wa}@s.whatsapp.net`,
        csPhone: '6281234567890', // Dummy
        csName: lead.cs || 'Nisa',
        rawTranscript: rawTranscript
      });
      
      console.log(` -> Result: ${result ? result.conversion : 'BYPASSED'} / ${result ? result.objectionType : ''}`);
      results.push({
        wa: lead.wa,
        name: lead.name,
        compressedLines: lines.length > 35 ? 35 : lines.length,
        originalLines: lines.length,
        conversion: result ? result.conversion : 'BYPASSED',
        insight: result ? result.lastInsight : '',
        objectionType: result ? result.objectionType : '',
        taktikCS: result ? result.taktikCS : '',
        draftWA: result ? result.draftWA : '',
        minatProduk: result ? result.minatProduk : ''
      });
    } catch (err) {
      console.log(` -> ERROR: ${err.message}`);
    }
    
    // Small delay for rate limits
    await new Promise(r => setTimeout(r, 1000));
  }
  
  fs.writeFileSync('audit_results_16_17.json', JSON.stringify(results, null, 2));
  console.log('\nAudit complete! Saved to audit_results_16_17.json');
}

runAudit().catch(console.error).finally(() => prisma.$disconnect());
