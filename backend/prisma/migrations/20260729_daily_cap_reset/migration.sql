-- Kuota balasan AI harian: simpan TANGGAL hitungan supaya bisa dibandingkan
-- saat dipakai, bukan direset oleh cron yang bisa terlewat.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "daily_count_date" DATE;

-- Baris lama tidak punya tanggal, jadi hitungannya otomatis dianggap nol pada
-- pemakaian berikutnya. Itu justru yang diinginkan: pelanggan yang selama ini
-- terblokir permanen langsung bebas begitu migrasi ini jalan.
