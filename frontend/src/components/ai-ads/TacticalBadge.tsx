// Chunk (g) bagian 1 -- Fase 4 (Cowork, 2026-08-28)
//
// Shared tactical-badge component. Dipakai lintas halaman (ai-ads Budget
// Auto-Pilot Center, meta-capi-dashboard, copywriting-ads) supaya label
// WINNER/BLEEDER/FATIGUED konsisten di semua tempat -- sebelum ini tiap
// halaman akan hand-roll className sendiri-sendiri dan gampang drift.
//
// Sumber kebenaran nilai ini: Prisma model `AdBudgetActionHistory.tacticalBadge`
// (backend/prisma/schema.prisma) -- kolom VARCHAR(20) berkomentar
// "WINNER | BLEEDER | FATIGUED", BUKAN enum DB. Karena itu komponen ini
// sengaja menerima `string` juga (bukan cuma union literal) dan punya
// fallback abu-abu utk nilai baru yang belum dikenal, supaya kalau backend
// nambah badge baru suatu saat, UI tidak crash -- cuma tampil generik dulu
// sampai kelas ini diupdate.

import type { ReactNode } from 'react';

export type TacticalBadgeKey = 'WINNER' | 'BLEEDER' | 'FATIGUED';

export interface TacticalBadgeMeta {
  emoji: string;
  label: string;
  kelas: string; // kelas tailwind teks+bg+border, pola sama seperti LABEL_BERAT di settings/page.tsx
}

export const TACTICAL_BADGE_META: Record<TacticalBadgeKey, TacticalBadgeMeta> = {
  WINNER: {
    emoji: '🏆',
    label: 'Winner',
    kelas: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  },
  BLEEDER: {
    emoji: '🩸',
    label: 'Bleeder',
    kelas: 'text-rose-700 bg-rose-50 border-rose-200',
  },
  FATIGUED: {
    emoji: '😴',
    label: 'Fatigued',
    kelas: 'text-amber-700 bg-amber-50 border-amber-200',
  },
};

const FALLBACK_META: TacticalBadgeMeta = {
  emoji: '❔',
  label: 'Unknown',
  kelas: 'text-gray-500 bg-gray-50 border-gray-200',
};

/** Ambil metadata badge tanpa render apapun -- berguna utk legend/filter dropdown. */
export function getTacticalBadgeMeta(badge: string): TacticalBadgeMeta {
  return TACTICAL_BADGE_META[badge as TacticalBadgeKey] ?? FALLBACK_META;
}

export interface TacticalBadgeProps {
  /** Nilai mentah dari kolom `tacticalBadge` (string, bukan cuma union -- lihat catatan di atas). */
  badge: string;
  size?: 'sm' | 'md';
  /** Tampilkan cuma emoji tanpa teks label (mis. dalam tabel padat). */
  emojiOnly?: boolean;
  className?: string;
  /** Override teks (jarang dipakai) -- default pakai label dari TACTICAL_BADGE_META. */
  children?: ReactNode;
}

const SIZE_KELAS: Record<NonNullable<TacticalBadgeProps['size']>, string> = {
  sm: 'text-[10px] px-1.5 py-0.5 gap-1',
  md: 'text-xs px-2 py-1 gap-1.5',
};

export function TacticalBadge({
  badge,
  size = 'sm',
  emojiOnly = false,
  className = '',
  children,
}: TacticalBadgeProps) {
  const meta = getTacticalBadgeMeta(badge);
  const sizeKelas = SIZE_KELAS[size];

  return (
    <span
      title={meta.label}
      className={`inline-flex items-center rounded font-medium border ${meta.kelas} ${sizeKelas} ${className}`}
    >
      <span aria-hidden="true">{meta.emoji}</span>
      {!emojiOnly && <span>{children ?? meta.label}</span>}
    </span>
  );
}

export default TacticalBadge;
