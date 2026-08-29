// ──────────────────────────────────────────────────────────────────────────────
// Normalisasi JID WhatsApp
//
// Latar belakang: penyaring pesan masuk dulu hanya berupa satu baris
// `if (remoteJid.endsWith('@g.us')) return` — daftar-larangan dengan satu isi.
// Segala JID lain otomatis dianggap chat pelanggan pribadi, termasuk:
//
//   status@broadcast  → update Status WhatsApp orang lain. Bot membuat lead
//                       bernama "status" DAN MEMBALAS story-nya. Ini bukan
//                       sekadar data sampah: membalas story secara otomatis
//                       adalah pola yang dipakai WhatsApp untuk menandai nomor
//                       sebagai spam.
//   *@newsletter      → WhatsApp Channel.
//   *@lid             → identitas perangkat internal (LID). Tersimpan sebagai
//                       "nomor WA" berisi angka seperti 27608184053792, yang
//                       bukan nomor telepon siapa pun.
//
// Karena itu logikanya dibalik jadi daftar-izin: apa pun yang tidak jelas-jelas
// chat pribadi akan dibuang.
// ──────────────────────────────────────────────────────────────────────────────

const USER_SUFFIX = '@s.whatsapp.net';
const LID_SUFFIX = '@lid';
const GROUP_SUFFIX = '@g.us';
const BROADCAST_SUFFIX = '@broadcast';
const NEWSLETTER_SUFFIX = '@newsletter';

/** Bentuk minimal `key` dari pesan Baileys yang kita butuhkan. */
export interface IncomingKeyLike {
  remoteJid?: string | null;
  /** Diisi Baileys saat pengalamatan LID: berisi JID nomor telepon aslinya. */
  remoteJidAlt?: string | null;
}

/**
 * Tentukan JID yang sah dipakai sebagai identitas percakapan pelanggan.
 * Mengembalikan null kalau pesan ini bukan chat pribadi dan harus diabaikan.
 */
export function resolveIncomingJid(key: IncomingKeyLike | null | undefined): string | null {
  const primary = key?.remoteJid ?? '';
  if (!primary) return null;

  // ── Penolakan WAJIB dievaluasi terhadap remoteJid ASLI ────────────────────
  // Jangan pernah melihat remoteJidAlt untuk keputusan ini. status@broadcast
  // JUGA membawa remoteJidAlt berisi nomor telepon asli pengunggahnya — contoh
  // nyata dari log 2026-07-29:
  //   remoteJid: "status@broadcast", remoteJidAlt: "62816619312@s.whatsapp.net"
  // Kalau kita asal "pakai alt bila ada", setiap update status justru berubah
  // jadi chat pribadi yang sah — lebih parah daripada bug aslinya.
  if (primary.endsWith(GROUP_SUFFIX)) return null;
  if (primary.endsWith(BROADCAST_SUFFIX)) return null;
  if (primary.endsWith(NEWSLETTER_SUFFIX)) return null;

  // Chat pribadi biasa.
  if (primary.endsWith(USER_SUFFIX)) return primary;

  // Pengalamatan LID: utamakan nomor telepon asli kalau Baileys menyertakannya.
  // Kalau tidak ada, LID-nya tetap dipakai apa adanya — pengirimnya orang
  // sungguhan, dan membuangnya berarti kehilangan pelanggan nyata. Lebih baik
  // punya lead ber-ID aneh daripada pesan yang hilang tanpa jejak.
  if (primary.endsWith(LID_SUFFIX)) {
    const alt = key?.remoteJidAlt ?? '';
    return alt.endsWith(USER_SUFFIX) ? alt : primary;
  }

  // Suffix yang tidak dikenal — perlakukan sebagai bukan chat pelanggan.
  return null;
}

/**
 * Ubah `waId`/`waNumber` yang tersimpan menjadi JID yang siap dikirimi pesan.
 *
 * Kode lama memakai pola ini di beberapa tempat:
 *   `waId.includes('@s.whatsapp.net') ? waId : `${waId}@s.whatsapp.net``
 * Pola itu rusak untuk JID yang sudah punya domain LAIN. Untuk lead LID,
 * `27608184053792@lid` berubah jadi `27608184053792@lid@s.whatsapp.net` —
 * alamat yang tidak akan pernah sampai ke siapa pun, dan pesannya hilang diam-diam.
 */
export function toSendableJid(waId: string | null | undefined): string | null {
  if (!waId) return null;
  const value = waId.trim();
  if (!value) return null;

  // Sudah berupa JID lengkap yang bisa dikirimi.
  if (value.endsWith(USER_SUFFIX) || value.endsWith(LID_SUFFIX)) return value;

  // Punya domain lain (grup/broadcast/channel) — jangan pernah dikirimi.
  if (value.includes('@')) return null;

  // Nomor telanjang → lengkapi domainnya.
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 5) return null;
  return `${digits}${USER_SUFFIX}`;
}
