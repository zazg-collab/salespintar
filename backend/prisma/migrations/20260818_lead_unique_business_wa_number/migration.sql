-- Temuan 1.1/1.2 (audit Tahap 2, 2026-08-18) — race Opsi A (real-time,
-- human-learning.service.ts) vs Opsi B (sweeper 7x/hari,
-- reconciliation-sweeper.*) sama-sama melakukan `findFirst` lalu `create` untuk
-- lead baru. Kalau keduanya findFirst di window yang sama-sama "belum ada lead",
-- keduanya create, dan kontak yang sama berakhir dengan DUA baris `leads`
-- (kejadian ini konsisten dengan sebagian data ganjil di dataset forensik
-- 17 Agu 2026). Constraint unik ini menutup celah race di level database —
-- lapisan terakhir setelah leads.repository.ts diubah ke `prisma.lead.upsert()`.
--
-- ================= WAJIB DIJALANKAN MANUAL SEBELUM MIGRASI INI =================
-- Cek dulu apakah SUDAH ADA duplikat (businessId, waNumber) di database produksi.
-- Kalau ada, migrasi ini akan GAGAL KERAS (unique violation) — bukan diam-diam
-- korup data, tapi TETAP jangan langsung dedupe otomatis dari sini: baris duplikat
-- punya relasi cascade-delete ke Conversation & Message, jadi salah pilih baris yang
-- dihapus bisa membuang riwayat chat asli. Tinjau manual dulu tiap kasus.
--
--   SELECT business_id, wa_number, COUNT(*), array_agg(id) AS lead_ids
--   FROM leads
--   GROUP BY business_id, wa_number
--   HAVING COUNT(*) > 1;
--
-- Kalau query di atas mengembalikan baris apa pun, JANGAN jalankan migrasi ini
-- dulu — laporkan hasilnya dan putuskan bersama baris mana yang jadi baris utama
-- (biasanya yang conversionStatus = CLOSING / REPEAT_ORDER, atau yang paling
-- banyak totalMessages) sebelum baris lain digabung/dihapus manual.
-- =================================================================================

ALTER TABLE leads
  ADD CONSTRAINT leads_business_id_wa_number_key UNIQUE (business_id, wa_number);
