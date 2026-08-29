/**
 * Alat uji manual parser ekspor WhatsApp — TIDAK dipakai aplikasi.
 *
 * Sengaja diletakkan DI DALAM folder backend, bukan di /tmp: Node mencari modul
 * relatif terhadap lokasi file skrip, bukan folder tempat perintah dijalankan.
 * Skrip di /tmp tidak akan menemukan node_modules milik proyek ini.
 *
 * Pakai:
 *   npx tsx uji-parser.ts ~/Downloads/nama-file.zip
 *
 * Hanya membaca file. Tidak menyentuh database, Groq, maupun server.
 * Aman dihapus kapan saja.
 */
import AdmZip from 'adm-zip';
import { parseWhatsAppExport, guessCsNames } from './src/services/wa-export-parser';

const zipPath = process.argv[2];
if (!zipPath) {
  console.error('Pakai: npx tsx uji-parser.ts /path/ke/ekspor.zip');
  process.exit(1);
}

const entries = new AdmZip(zipPath)
  .getEntries()
  .filter(
    e =>
      !e.isDirectory &&
      e.entryName.toLowerCase().endsWith('.txt') &&
      !e.entryName.toLowerCase().includes('__macosx/'),
  );

console.log(`\nFile .txt di dalam zip: ${entries.length}\n`);

const chats = entries.map(e => {
  const chat = parseWhatsAppExport(e.getData().toString('utf-8'));
  console.log(`— ${e.entryName}`);
  console.log(`  pesan terbaca : ${chat.messages.length}`);
  console.log(`  peserta       : ${chat.participants.join(', ') || '(tidak terbaca)'}`);
  console.log(
    `  dilewati      : sistem ${chat.skipped.systemMessages}, media ${chat.skipped.mediaPlaceholders}, gagal ${chat.skipped.unparsable}`,
  );
  if (chat.messages.length) {
    console.log(`  contoh awal   : <${chat.messages[0]!.sender}> ${chat.messages[0]!.text.slice(0, 70)}`);
    const last = chat.messages[chat.messages.length - 1]!;
    console.log(`  contoh akhir  : <${last.sender}> ${last.text.slice(0, 70)}`);
  }
  console.log();
  return chat;
});

console.log('TEBAKAN CS (nama yang muncul di hampir semua file):');
console.log(' ', guessCsNames(chats).join(', ') || '(tidak ada — wajar kalau cuma 1 file)');
