/**
 * mode-wa.ts — nyalakan/matikan jalur WhatsApp di database LOKAL, tanpa menyentuh
 * kredensialnya.
 *
 * ── Kenapa alat ini ada ──────────────────────────────────────────────────────
 * Sejak SalesPintar pindah ke `vps-upcloud` (Fase 73), laptop jadi CADANGAN, bukan
 * yang melayani. Tapi backend TIDAK punya sakelar untuk mematikan WhatsApp — saat
 * bootstrap ia selalu:
 *
 *   1. `waCredential.findMany({ where: { status: 'CONNECTED' } })` lalu
 *      `baileysManager.connect()` untuk tiap barisnya  (server.ts:158-182)
 *   2. `humanLearningManager.restoreActiveSessions()` untuk sesi CS yang
 *      statusnya CONNECTED/CONNECTING  (server.ts:200)
 *
 * Kalau laptop dinyalakan begitu saja, kedua jalur itu menyambar WhatsApp dan
 * server kena `Stream Errored (conflict) statusCode: 440`. Dan karena Fase 43
 * SENGAJA mematikan auto-reconnect saat conflict, **server tidak bangun sendiri** —
 * persis kejadian 31 Juli 2026, ketika saya menjalankan api di server sementara
 * laptop masih hidup dan bot laptop mati diam selama beberapa menit.
 *
 * Yang menutup kedua jalur itu bukan menghapus kredensial (itu merusak cadangan),
 * melainkan cukup mengubah `status`. Bootstrap memfilter tepat di kolom itu, jadi
 * dengan status DISCONNECTED **tidak ada satu pun socket WhatsApp dibuka** —
 * `session_data` dan `wa_sessions/` tetap utuh dan siap dipakai kapan saja.
 *
 * ── Pakai ────────────────────────────────────────────────────────────────────
 *   npx tsx mode-wa.ts             # cuma laporkan keadaan sekarang
 *   npx tsx mode-wa.ts --mati      # kunci: laptop nyala tanpa menyentuh WhatsApp
 *   npx tsx mode-wa.ts --hidup     # buka lagi (HANYA kalau server sedang mati)
 *
 * Biasanya dipanggil lewat `./jalankan.sh --matikan-wa`, bukan langsung.
 */

import fs from 'fs';
import path from 'path';
import { prisma } from './src/config/prisma';
import { env } from './src/config/env';

const MERAH = '\x1b[31m';
const HIJAU = '\x1b[32m';
const KUNING = '\x1b[33m';
const TEBAL = '\x1b[1m';
const RESET = '\x1b[0m';

/** Sesi CS hanya bisa dipulihkan kalau creds.json-nya ada — cerminan `restoreActiveSessions()`. */
function punyaCredsDiDisk(csPhone: string): boolean {
  return fs.existsSync(path.resolve(env.WA_SESSIONS_DIR, `cs-${csPhone}`, 'creds.json'));
}

async function laporkan(): Promise<{ botAktif: number; csAktif: number }> {
  const bot = await prisma.waCredential.findMany({
    select: { waNumber: true, status: true, sessionData: true, business: { select: { name: true, isActive: true } } },
    orderBy: { waNumber: 'asc' },
  });
  const cs = await prisma.csHumanLearningSession.findMany({
    select: { csPhone: true, csName: true, status: true },
    orderBy: { csPhone: 'asc' },
  });

  console.log(`\n${TEBAL}Bot utama (wa_credentials)${RESET}`);
  if (bot.length === 0) console.log('  (tidak ada)');
  for (const b of bot) {
    const nyala = b.status === 'CONNECTED';
    const warna = nyala ? MERAH : HIJAU;
    console.log(
      `  ${warna}${b.status.padEnd(13)}${RESET} ${b.waNumber.padEnd(16)} ${b.business.name}` +
      `${b.sessionData ? '' : `  ${KUNING}(tanpa session_data)${RESET}`}` +
      `${b.business.isActive ? '' : `  ${KUNING}(business nonaktif)${RESET}`}`,
    );
  }

  console.log(`\n${TEBAL}Sesi CS (cs_human_learning_sessions)${RESET}`);
  if (cs.length === 0) console.log('  (tidak ada)');
  for (const c of cs) {
    const nyala = c.status === 'CONNECTED' || c.status === 'CONNECTING';
    const warna = nyala ? MERAH : HIJAU;
    console.log(
      `  ${warna}${c.status.padEnd(13)}${RESET} ${c.csPhone.padEnd(16)} ${c.csName}` +
      `${punyaCredsDiDisk(c.csPhone) ? '' : `  ${KUNING}(tanpa creds.json)${RESET}`}`,
    );
  }

  const botAktif = bot.filter((b) => b.status === 'CONNECTED').length;
  const csAktif = cs.filter((c) => c.status === 'CONNECTED' || c.status === 'CONNECTING').length;

  console.log('');
  if (botAktif === 0 && csAktif === 0) {
    console.log(`${HIJAU}${TEBAL}WA MATI${RESET} — backend boleh dinyalakan, tidak akan menyentuh WhatsApp.`);
  } else {
    console.log(
      `${MERAH}${TEBAL}WA HIDUP${RESET} — ${botAktif} bot + ${csAktif} sesi CS akan tersambung otomatis ` +
      `saat backend nyala.\n${MERAH}Kalau server vps-upcloud juga hidup, ini menyebabkan conflict 440 ` +
      `dan server TIDAK bangun sendiri.${RESET}`,
    );
  }
  return { botAktif, csAktif };
}

async function matikan(): Promise<void> {
  // Kredensial TIDAK disentuh — cuma statusnya. Itu yang membuat laptop tetap
  // jadi cadangan yang siap pakai, bukan cadangan yang sudah dikosongkan.
  const a = await prisma.waCredential.updateMany({
    where: { status: { not: 'DISCONNECTED' } },
    data: { status: 'DISCONNECTED', qrCode: null, qrExpiresAt: null },
  });
  const b = await prisma.csHumanLearningSession.updateMany({
    where: { status: { not: 'DISCONNECTED' } },
    data: { status: 'DISCONNECTED', qrCode: null, qrExpiresAt: null },
  });
  console.log(`${HIJAU}WA dimatikan${RESET}: ${a.count} kredensial bot + ${b.count} sesi CS → DISCONNECTED.`);
  console.log('Kredensial & wa_sessions/ tidak disentuh sama sekali.');
  console.log(`${KUNING}Catatan: jangan tekan tombol Connect / pindai QR di dashboard laptop —${RESET}`);
  console.log(`${KUNING}itu satu-satunya sisa jalan menuju conflict 440.${RESET}`);
}

async function hidupkan(): Promise<void> {
  console.log(`${MERAH}${TEBAL}PERINGATAN${RESET} — WhatsApp hanya boleh hidup di SATU tempat.`);
  console.log(`Pastikan container ${TEBAL}salespintar-api${RESET} di vps-upcloud sudah berhenti:`);
  console.log(`  ssh vps-upcloud 'docker stop salespintar-api'\n`);

  // Hanya baris yang memang bisa dipulihkan yang dinyalakan — cerminan persis
  // syarat di bootstrap. Menyalakan baris tanpa kredensial cuma menghasilkan
  // percobaan sambung yang gagal, lalu status yang berbohong.
  // Penyaringan `sessionData` sengaja dilakukan di JS, bukan di `where`: filter
  // Json di Prisma punya perilaku null yang berbeda dari kolom biasa, dan di sini
  // yang dibutuhkan cuma "ada isinya atau tidak".
  const bot = await prisma.waCredential.findMany({
    where: { business: { isActive: true } },
    select: { id: true, waNumber: true, sessionData: true },
  });
  const layak = bot.filter((b) => b.sessionData !== null);
  for (const b of layak) {
    await prisma.waCredential.update({ where: { id: b.id }, data: { status: 'CONNECTED' } });
  }

  const cs = await prisma.csHumanLearningSession.findMany({ select: { id: true, csPhone: true } });
  let csLayak = 0;
  for (const c of cs) {
    if (!punyaCredsDiDisk(c.csPhone)) continue;
    await prisma.csHumanLearningSession.update({ where: { id: c.id }, data: { status: 'CONNECTED' } });
    csLayak++;
  }

  console.log(`${KUNING}WA dihidupkan${RESET}: ${layak.length} kredensial bot + ${csLayak} sesi CS → CONNECTED.`);
  const dilewati = (bot.length - layak.length) + (cs.length - csLayak);
  if (dilewati > 0) {
    console.log(`${dilewati} baris dilewati karena tidak punya session_data / creds.json —`);
    console.log('menyalakannya cuma menghasilkan sambungan gagal dan status yang berbohong.');
  }
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2);
  const mati = arg.includes('--mati');
  const hidup = arg.includes('--hidup');

  if (mati && hidup) {
    console.error('Pilih salah satu: --mati atau --hidup.');
    process.exit(2);
  }

  if (mati) await matikan();
  else if (hidup) await hidupkan();

  await laporkan();
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(`${MERAH}Gagal:${RESET} ${e instanceof Error ? e.message : e}`);
  console.error('Pastikan Postgres lokal hidup: npm run infra:up');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
