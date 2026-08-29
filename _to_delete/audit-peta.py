import io

SRC = 'cek-cod.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:90]
    s = s.replace(old, new)

once(
    """import { collectCandidates, prettyPlace, type LocationRow } from './src/utils/location-resolver';""",
    """import { collectCandidates, prettyPlace, type LocationRow } from './src/utils/location-resolver';
import { __PETA_COD, __namaEkspedisi, __statusCod } from './src/services/mengantar.service';"""
)

# Sisipkan bagian audit peta sesudah bagian 1.
once(
    """  // ── Bagian 2: apakah harga yang kita kutip memuat biaya COD ───────────────""",
    """  // ── Bagian 1b: AUDIT PETA — bagian yang paling perlu dibuktikan ───────────
  //
  // Yang diperiksa di sini bukan datanya, melainkan TAFSIRAN kita atas nama
  // field-nya. Tiga cara peta ini bisa salah, dan ketiganya kelihatan di bawah:
  //
  //   1. Ada kurir yang dikutip ke pelanggan tapi tidak punya padanan field
  //      → statusnya "belum diketahui" selamanya, dan pelanggan tidak pernah
  //        ditawari kurir itu untuk COD walau sebenarnya bisa.
  //   2. Ada field COD di data yang tidak dipakai satu pun kurir
  //      → kemungkinan nama kurirnya belum dikenali, jadi jawabannya terbuang.
  //   3. Peta menunjuk field yang tidak ada sama sekali di baris alamat
  //      → salah tulis nama field; hasilnya "belum diketahui" tanpa sebab jelas.
  judul('1b. Audit peta: apakah tafsiran nama field kita benar');

  const semuaFieldCod = new Set(fieldCod);
  const dipakaiPeta = new Set<string>();
  for (const fs of Object.values(__PETA_COD)) for (const f of fs) dipakaiPeta.add(f);

  // Kurir apa saja yang sungguh dikutip untuk tujuan ini?
  let kurirNyata: string[] = [];
  try {
    const qq = `origin_id=${encodeURIComponent(env.MENGANTAR_ORIGIN_ID ?? '')}&destination_id=${encodeURIComponent(destId)}&weight=1`;
    const e = await ambil(`/order/estimate?${qq}&courier=all`);
    kurirNyata = Object.entries(e as Record<string, any>)
      .filter(([k, v]) => !['success', 'message', 'status', 'data', 'result'].includes(k) && v && typeof v === 'object' && !v.unsupported)
      .map(([k]) => k);
  } catch { /* dilaporkan di bagian 2 */ }

  if (kurirNyata.length > 0) {
    console.log('Kurir yang dikutip untuk tujuan ini, beserta field yang dipakai menilainya:\\n');
    console.log('  kunci API        nama tampilan          field yang dipakai              status');
    console.log('  ' + '-'.repeat(84));
    const tanpaField: string[] = [];
    for (const k of kurirNyata) {
      const nama = __namaEkspedisi(k);
      const fs = __PETA_COD[nama] ?? [];
      const st = __statusCod(pilih.row, nama);
      if (fs.length === 0) tanpaField.push(`${k} → "${nama}"`);
      console.log(
        `  ${k.padEnd(16)} ${nama.padEnd(22)} ${(fs.join(', ') || '(tidak ada)').padEnd(31)} ${st}`,
      );
    }
    console.log('');
    if (tanpaField.length > 0) {
      console.log(`⚠️  ${tanpaField.length} kurir tanpa padanan field COD: ${tanpaField.join(', ')}`);
      console.log(`    Untuk JNE ini SUDAH DIKETAHUI dan benar — data alamat memang tidak punya`);
      console.log(`    "unsupportedCodJNE". Untuk nama lain, berarti peta perlu ditambah.`);
    } else {
      console.log('Semua kurir yang dikutip punya padanan field.');
    }
  }

  // Field COD yang ada di data tapi tidak dipakai peta.
  const yatim = [...semuaFieldCod].filter(f => !dipakaiPeta.has(f));
  if (yatim.length > 0) {
    console.log(`\\n⚠️  ${yatim.length} field COD ada di data tapi TIDAK dipakai peta mana pun:`);
    for (const f of yatim) console.log(`      ${f} = ${JSON.stringify((pilih.row as Record<string, unknown>)[f])}`);
    console.log(`    Kalau salah satunya milik kurir yang sungguh dipakai toko, jawabannya`);
    console.log(`    sedang terbuang percuma.`);
  }

  // Peta menunjuk field yang tidak ada di baris alamat.
  const hantu = [...dipakaiPeta].filter(f => !(f in (pilih.row as Record<string, unknown>)));
  if (hantu.length > 0) {
    console.log(`\\n⚠️  Peta menunjuk ${hantu.length} field yang TIDAK ADA di baris alamat ini:`);
    for (const f of hantu) console.log(`      ${f}`);
    console.log(`    Bisa berarti salah tulis nama field, atau field itu memang cuma muncul`);
    console.log(`    di sebagian daerah. Coba beberapa tujuan sebelum menyimpulkan.`);
  }

  // ── Bagian 2: apakah harga yang kita kutip memuat biaya COD ───────────────"""
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   cek-cod.ts')
