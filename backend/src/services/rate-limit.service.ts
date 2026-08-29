/**
 * Kuota balasan AI per pelanggan per hari.
 *
 * ── Bug yang diperbaiki modul ini ────────────────────────────────────────────
 * Sebelumnya `leads.daily_ai_count` hanya pernah DINAIKKAN. Tidak ada satu pun
 * kode yang mengembalikannya ke nol — komentar di sumber lama mengakuinya
 * sendiri: *"direset setiap hari via cron (belum ada, nanti Fase 6 atau
 * manual)"*, dan Fase 6 ternyata dipakai untuk Supervisor Layer.
 *
 * Akibatnya `GROQ_DAILY_CAP_PER_LEAD` bukan batas harian melainkan **batas
 * seumur hidup**: pelanggan yang sudah 50 kali dibalas akan menerima pesan
 * "hari ini kami sudah sangat ramai" selamanya — besok, bulan depan, tahun
 * depan. Dan yang paling cepat kena justru pelanggan paling aktif.
 *
 * ── Kenapa tidak pakai cron ──────────────────────────────────────────────────
 * Cron tengah malam terdengar wajar tapi rapuh: kalau server mati saat jadwal
 * lewat, resetnya hilang tanpa jejak dan semua pelanggan terblokir sampai ada
 * yang sadar. Menyimpan TANGGAL hitungan lalu membandingkannya saat dipakai
 * tidak bisa "kelewatan" — tidak ada momen yang harus ditepati.
 *
 * ── Kenapa satu pernyataan SQL ───────────────────────────────────────────────
 * Baca-lalu-tulis dari sisi aplikasi punya lomba: dua pesan yang tiba bersamaan
 * sama-sama membaca 49, sama-sama menulis 50, dan satu balasan lolos melewati
 * kuota. `UPDATE ... SET x = CASE ...` diselesaikan atomik oleh Postgres.
 */

import { prisma } from '../config/prisma';
import { env } from '../config/env';

/**
 * Zona waktu penentu pergantian hari.
 *
 * Sengaja eksplisit, bukan `CURRENT_DATE`. Server produksi lazimnya berjalan di
 * UTC, dan `CURRENT_DATE` di sana berganti pukul 07.00 WIB — kuota pelanggan
 * akan ter-reset di tengah jam kerja pagi, bukan tengah malam. Ini persis jenis
 * perbedaan yang baru ketahuan sesudah pindah ke VPS.
 */
const DAY_BOUNDARY_TZ = 'Asia/Jakarta';

/** Ekspresi tanggal "hari ini menurut jam Indonesia". */
const TODAY = `((NOW() AT TIME ZONE '${DAY_BOUNDARY_TZ}')::date)`;

/**
 * Berapa balasan AI yang sudah dipakai lead ini HARI INI.
 * Hitungan dari hari-hari sebelumnya dianggap nol tanpa perlu ditulis ulang.
 */
export async function getTodayAiCount(leadId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ used: number }[]>(
    `SELECT CASE WHEN daily_count_date = ${TODAY} THEN daily_ai_count ELSE 0 END::int AS used
       FROM leads WHERE id = $1::uuid`,
    leadId,
  );
  return rows[0]?.used ?? 0;
}

export async function isDailyCapReached(leadId: string): Promise<boolean> {
  return (await getTodayAiCount(leadId)) >= env.GROQ_DAILY_CAP_PER_LEAD;
}

/**
 * Naikkan hitungan hari ini. Kalau catatan terakhir dari hari lain, hitungannya
 * dimulai ulang dari 1 — inilah "reset" yang dulu tidak pernah terjadi.
 *
 * Mengembalikan hitungan sesudah dinaikkan, supaya pemanggil bisa mencatat log
 * tanpa query tambahan.
 */
export async function incrementTodayAiCount(leadId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ daily_ai_count: number }[]>(
    `UPDATE leads
        SET daily_ai_count = CASE WHEN daily_count_date = ${TODAY}
                                  THEN daily_ai_count + 1
                                  ELSE 1 END,
            daily_count_date = ${TODAY},
            updated_at = NOW()
      WHERE id = $1::uuid
      RETURNING daily_ai_count`,
    leadId,
  );
  return rows[0]?.daily_ai_count ?? 0;
}
