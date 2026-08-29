import sys, io, os

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

def patch(relpath, pairs):
    path = os.path.join(ROOT, relpath)
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    for old, new in pairs:
        n = src.count(old)
        if n != 1:
            print(f'FAIL {relpath}: pola ditemukan {n}x (harus 1):\n---\n{old[:220]}\n---')
            sys.exit(1)
        src = src.replace(old, new)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'OK   {relpath} ({len(pairs)} substitusi)')


patch('backend/src/queues/shadow-mining.worker.ts', [

# ── A1. Prompt: larang fakta volatil sejak awal ─────────────────────────────
(
"""1. HAPUS SEMUA DATA PRIBADI: nama pelanggan spesifik, nomor HP, alamat, nomor resi/pesanan
2. Ganti data pribadi dengan placeholder: [NAMA_PELANGGAN], [NO_RESI], [ALAMAT], [NO_HP]
3. Fokus pada informasi UMUM yang bisa dipakai ulang untuk pelanggan lain""",
"""1. HAPUS SEMUA DATA PRIBADI: nama pelanggan spesifik, nomor HP, alamat, nomor resi/pesanan
2. Ganti data pribadi dengan placeholder: [NAMA_PELANGGAN], [NO_RESI], [ALAMAT], [NO_HP]
3. Fokus pada informasi UMUM yang bisa dipakai ulang untuk pelanggan lain

ATURAN PALING PENTING — DILARANG MENCANTUMKAN FAKTA YANG BISA BERUBAH:
   Chat ini bisa jadi berumur berbulan-bulan. Apa pun yang diketik CS waktu itu
   BELUM TENTU masih berlaku hari ini. Karena itu, JANGAN PERNAH menuliskan:
   - Harga, nominal, total, ongkir, diskon, atau angka rupiah apa pun
   - Klaim ketersediaan stok ("ready", "tersedia", "masih ada")
   - Janji waktu pengiriman ("besok sampai", "2 hari", "same day")
   - Jaminan atau janji pasti ("kami jamin", "dijamin", "pasti")

   Kalau percakapan membahas hal-hal di atas, tulis PROSEDUR dan CARA MENJAWABnya,
   bukan angkanya. Contoh yang BENAR: "Ongkir dihitung berdasarkan berat paket dan
   kota tujuan; CS mengeceknya lewat aplikasi ekspedisi sebelum menjawab."
   Contoh yang SALAH: "Ongkir ke Surabaya Rp 25.000."

   Angka yang MENGGAMBARKAN BARANG boleh ditulis, karena tidak berubah:
   ukuran, berat, panjang, bahan, grit, kapasitas. Contoh: "pisau 8 inci",
   "batu asah grit 1000".""",
),

# ── A2. Karantina jadi jaring, bukan beban review harian ────────────────────
(
"""  // ── Lapis 2.5: karantina ──
  // Setelan Otomatis berhenti jadi bypass menyeluruh dan berubah jadi bersyarat.
  // Dokumen prosedur murni tetap lewat sendiri; begitu ada klaim yang bisa basi
  // atau isinya ternyata hampa, dokumennya jatuh ke Draft_AI menunggu diperiksa.
  const assessment = assessDocument(extracted);""",
"""  // ── Lapis 2.5: jaring pengaman ──
  // Sesudah prompt Layer 2 dilarang keras menulis fakta volatil, lapis ini
  // seharusnya JARANG sekali menyala. Dia bukan lagi beban review harian,
  // melainkan penangkap kalau model membandel. Kalau lapis ini sering menyala,
  // itu sinyal prompt-nya yang perlu diperbaiki, bukan Angga yang perlu rajin.
  const assessment = assessDocument(extracted);""",
),
])

print('SELESAI')
