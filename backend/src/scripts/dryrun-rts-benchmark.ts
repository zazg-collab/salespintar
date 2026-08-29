import { RtsRiskEngine } from '../modules/leads/rts-risk.engine';
import { ConversionStatus } from '../modules/leads/dto/lead-profile.dto';

interface TestLeadCase {
  id: string;
  name: string;
  source: string;
  rawTranscript: string;
  expectedConversion: ConversionStatus;
  expectedRtsLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  expectedMaxScore: number;
}

const BAMBANG_TRANSCRIPT = `
15/08/26 07.23 - Bambang: Halo, saya sudah melakukan pemesanan Golok Situmang 3 - Fb - NPM, atas nama Bambang. Mohon segera diproses ya 🙏🏻
15/08/26 07.30 - Cordova Store Aluna: Hai kak Bambang 👋
Terima kasih sudah mengisi form pemesanan Golok Situmang 3 - Fb - NPM di toko kami !
📦 Produk: Golok Situmang 3 - Fb - NPM 
💰 Harga: Rp192.000 
📍Formulir Pemesanan :
Nama: Bambang  
No HP: 08126338314  
Alamat: Kec. Dolok Masihul link 3 kampung lalang. Kabupaten Serdang Bedagai provinsi sumatera utara
15/08/26 07.31 - Cordova Store Aluna: *RINCIAN BIAYA*
1. Harga  : 192.000 
2. Ongkir : ~50.000~ diskon jadi 43.000
*TOTAL COD : 235.000 
* Kurir : JNT
Memastikan kembali untuk pembayaran nya mau langsung saya proses COD atau mau transfer? 
15/08/26 07.32 - Bambang: Cod saja min, warna coklat ya min
15/08/26 07.33 - Cordova Store Aluna: Baik Pak untuk patokan rumahnya dekat apa ya?
15/08/26 07.34 - Bambang: Depan mesjid min
15/08/26 07.34 - Bambang: Kampung lalang
15/08/26 07.34 - Cordova Store Aluna: Baik pak untuk total codnya jadi *235.000* sudah termasuk ongkos kirim yaa🙏😊
15/08/26 07.35 - Bambang: 👍👍
15/08/26 07.36 - Cordova Store Aluna: Baik kami proses.. 
CATATAN
1. Pastikan hp Selalu Aktif selama masa pengiriman
2. Jika ada kurir menghubungi, tolong Dibalas / Dijawab
3. Pastikan Ada Orang dirumah / lokasi tujuan
4. Pastikan Jangan Lupa bahwa sudah pesan barang.
5. pastikan bayar cod ke kurir, dan jangan lupa vidio unboxingnya untuk klaim garansinya ya pak😊🙏
15/08/26 12.01 - Bambang: Kelurahan Dolok Masihul kecamatan Dolok masihul
15/08/26 12.05 - Cordova Store Aluna: Siap pak makasii 🙏😊
`;

const TUMADI_TRANSCRIPT = `
15/08/26 05.37 - Cordova Store Aluna: Hai kak 👋
Terima kasih sudah mengisi form pemesanan Golok Black Mamba - Fb - NFR di toko kami !
📦 Produk: Golok Black Mamba - Fb - NFR 
💰 Harga: Rp199.000 
📍Formulir Pemesanan :
Nama:   
No HP: 85265752122  
Alamat: Jln Tuk antan jinggo km 70 Dayun RT/ RW 004002 siak Riau.
15/08/26 05.38 - Cordova Store Aluna: *RINCIAN BIAYA*
1. Harga : 199.000 
2. Ongkir : ~60.000~ diskon jadi 53.000
*TOTAL COD : 252.000 
* Kurir : JNE
Memastikan kembali untuk pembayaran nya mau langsung saya proses COD atau mau transfer? 
15/08/26 05.43 - Tumadimadi: COD saja..
15/08/26 05.43 - Cordova Store Aluna: Baik Pak untuk nama pemesan siapa ya?
15/08/26 05.46 - Tumadimadi: Tumadi, jalur masjid mutmainnah pagar hitam.
15/08/26 05.46 - Cordova Store Aluna: Boleh di cantumkan nama kelurahan dan kecamatan apa ya?
15/08/26 05.49 - Tumadimadi: Kota: Siak Riau, Kecamatan: Dayun
15/08/26 05.56 - Cordova Store Aluna: Baik pak untuk total codnya jadi *252.000* sudah termasuk ongkos kirim yaa🙏😊
15/08/26 06.29 - Cordova Store Aluna: Baik kami proses.. 
CATATAN
1. Pastikan hp Selalu Aktif selama masa pengiriman
2. Jika ada kurir menghubungi, tolong Dibalas / Dijawab
3. Pastikan Ada Orang dirumah / lokasi tujuan
4. Pastikan Jangan Lupa bahwa sudah pesan barang.
5. pastikan bayar cod ke kurir, dan jangan lupa vidio unboxingnya untuk klaim garansinya ya pak😊🙏
15/08/26 07.06 - Tumadimadi: Tolong ke aslian barang nya..
15/08/26 07.27 - Cordova Store Aluna: Oke Pak
`;

const DAME_TRANSCRIPT = `
15/08/26 10.26 - gdame5844: Halo, saya sudah melakukan pemesanan Golok Situmang 2 - Fb - NFR, atas nama +6282164808354. Mohon segera diproses ya 🙏🏻
15/08/26 10.27 - Cordova Store Aluna: Hai kak 👋
Terima kasih sudah mengisi form pemesanan Golok Situmang 2 - Fb - NFR di toko kami !
📦 Produk: Golok Situmang 2 - Fb - NFR 
💰 Harga: Rp192.000 
📍Formulir Pemesanan :
Nama:   
No HP: 82164808354  
Alamat: Desa. Pokan baru. Dusun parsaguan. Kec. Juta bayu raja. Kabupaten Simalungun
15/08/26 10.28 - Cordova Store Aluna: *RINCIAN BIAYA*
1. Harga  : 192.000 
2. Ongkir : ~60.000~ diskon jadi 54.000
*TOTAL COD : 246.000 
* Kurir : JNE
15/08/26 10.29 - gdame5844: COD kk untuk warna hitam y
15/08/26 10.30 - Cordova Store Aluna: Baik pak untuk patokan rumahnya dekat apa ya?
15/08/26 10.31 - gdame5844: Sekolah SD Inpres parsaguan
15/08/26 10.32 - Cordova Store Aluna: Baik pak untuk total codnya jadi *246.000* sudah termasuk ongkos kirim yaa🙏😊
15/08/26 10.33 - Cordova Store Aluna: Deal proses kirim codnya pak?
15/08/26 10.34 - gdame5844: Y
15/08/26 10.36 - Cordova Store Aluna: Baik kami proses.. 
CATATAN
1. Pastikan hp Selalu Aktif selama masa pengiriman
2. Jika ada kurir menghubungi, tolong Dibalas / Dijawab
3. Pastikan Ada Orang dirumah / lokasi tujuan
4. Pastikan Jangan Lupa bahwa sudah pesan barang.
5. pastikan bayar cod ke kurir, dan jangan lupa vidio unboxingnya untuk klaim garansinya ya pak😊🙏
15/08/26 10.36 - Cordova Store Aluna: Nama pemesan siapa pak?
15/08/26 10.37 - gdame5844: Dame
15/08/26 10.39 - Cordova Store Aluna: Oke
`;

async function main() {
  console.log('🧪 =========================================================================');
  console.log('🧪 DRY-RUN BENCHMARK: VALIDASI ATURAN BARU RTS RISK ENGINE DENGAN DATA NYATA');
  console.log('🧪 =========================================================================\n');

  const testCases: TestLeadCase[] = [
    {
      id: '628126338314',
      name: 'Bambang (Export Chat Nyata)',
      source: 'Chat WhatsApp dengan Bambang.txt',
      rawTranscript: BAMBANG_TRANSCRIPT,
      expectedConversion: 'CLOSING',
      expectedRtsLevel: 'LOW',
      expectedMaxScore: 15,
    },
    {
      id: '6285265752122',
      name: 'Tumadi (Export Chat Nyata)',
      source: 'Chat WhatsApp dengan Tumadimadi.txt',
      rawTranscript: TUMADI_TRANSCRIPT,
      expectedConversion: 'CLOSING',
      expectedRtsLevel: 'LOW',
      expectedMaxScore: 15,
    },
    {
      id: '6282164808354',
      name: 'Dame (Export Chat Nyata)',
      source: 'Chat WhatsApp dengan gdame5844.txt',
      rawTranscript: DAME_TRANSCRIPT,
      expectedConversion: 'CLOSING',
      expectedRtsLevel: 'LOW',
      expectedMaxScore: 15,
    },
    {
      id: '6281267033010',
      name: 'To.harmoni (Kasus At-Risk: Tanpa RT/RW & Tanpa Patokan)',
      source: 'Evaluasi Kasus Lapangan',
      rawTranscript: `
[BUYER] Halo kak saya pesan GKE 30 ke Desa Air Molek Kabupaten INHU Riau.
[CS] Baik bapak untuk total COD jadi Rp 180.000 sudah termasuk ongkir ya. Mau diproses?
[BUYER] Iya kirim ya mas.
[CS] Baik kami proses.. 
CATATAN
1. Pastikan hp Selalu Aktif selama masa pengiriman
2. Jika ada kurir menghubungi tolong dibalas
3. Pastikan ada orang di rumah
4. Bayar COD ke kurir
`,
      expectedConversion: 'CLOSING',
      expectedRtsLevel: 'MEDIUM',
      expectedMaxScore: 45,
    },
    {
      id: '6281294968339',
      name: 'Enday (Kasus Solid: Form Iklan + Patokan + SOP Lengkap)',
      source: 'Evaluasi Kasus Lapangan',
      rawTranscript: `
[BUYER] Halo saya sudah pesan Golok Situmang 3
Nama: Enday
Alamat: Jl. Raya Cikarang Blok B no 12 RT 03/05, dekat Masjid Al-Falah, Cikarang Utara, Bekasi
[CS] Halo kak Enday. Total COD Rp 235.000 ya. Mau diproses COD?
[BUYER] Siap mas COD saja.
[CS] Baik kami proses ya..
CATATAN
1. Pastikan hp Selalu Aktif selama masa pengiriman
2. Siapkan uang pas saat kurir tiba
`,
      expectedConversion: 'CLOSING',
      expectedRtsLevel: 'LOW',
      expectedMaxScore: 15,
    },
    {
      id: '6289999999999',
      name: 'Prospek Batal (Kemahalan / Cancel)',
      source: 'Evaluasi Kasus Lost',
      rawTranscript: `
[BUYER] Berapa harganya min?
[CS] Harganya 192.000 kak.
[BUYER] Waduh mahal banget ya, gak jadi deh mas cancel dulu.
[CS] Baik kak terima kasih.
`,
      expectedConversion: 'LOST',
      expectedRtsLevel: 'LOW',
      expectedMaxScore: 0,
    },
  ];

  let passCount = 0;
  let failCount = 0;

  for (const tc of testCases) {
    const isClosing = tc.expectedConversion === 'CLOSING';
    const evalQuality = RtsRiskEngine.evaluateChatQuality(tc.rawTranscript, tc.expectedConversion, isClosing);
    const blendResult = RtsRiskEngine.blendRtsRisk(evalQuality.chatQualityScore, evalQuality.chatReasons, null, tc.expectedConversion);

    const isMatch = blendResult.rtsRiskLevel === tc.expectedRtsLevel;
    if (isMatch) passCount++;
    else failCount++;

    console.log(`--------------------------------------------------------------------------------`);
    console.log(`📌 Kontak: ${tc.name} [${tc.id}]`);
    console.log(`   Sumber Transkrip : ${tc.source}`);
    console.log(`   Status Konversi  : ${tc.expectedConversion}`);
    console.log(`   Hasil Engine     : Level = ${blendResult.rtsRiskLevel} (Skor Risiko = ${blendResult.rtsRiskScore}%, Kualitas Chat = ${blendResult.chatQualityScore}/100)`);
    console.log(`   Target Diharapkan: Level = ${tc.expectedRtsLevel}`);
    console.log(`   Alasan Terdeteksi:`);
    blendResult.reasons.forEach(r => console.log(`     • ${r}`));
    console.log(`   Status Akurasi   : ${isMatch ? '✅ PASSED (SYNC)' : '❌ MISMATCH'}`);
  }

  console.log(`\n================================================================================`);
  console.log(`📊 REKAPITULASI HASIL DRY-RUN BENCHMARK:`);
  console.log(`   Total Kasus Diuji : ${testCases.length}`);
  console.log(`   Berhasil Sinkron  : ${passCount} / ${testCases.length} (${Math.round((passCount / testCases.length) * 100)}%)`);
  console.log(`   Gagal / Drift     : ${failCount}`);
  console.log(`================================================================================\n`);
}

main().catch(console.error);
