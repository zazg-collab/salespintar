'use client';

// Chunk (g) bagian 3 -- Fase 4 (Cowork, 2026-08-28)
//
// Kartu "Budget Waste & CAPI EMQ 9.3+" utk halaman /app/meta-capi-dashboard. Sengaja dibikin
// component TERPISAH (bukan ditambahkan langsung ke page.tsx yang sudah 3983 baris) -- lebih aman
// utk file sebesar itu, dan component ini self-contained (fetch data sendiri) jadi pemasangannya
// di page.tsx cuma butuh 1 baris import + 1 baris render, minim risiko nyenggol logic lain di sana.
//
// Sumber data: GET /business/budget-waste-audits (baca-saja dari model Prisma BudgetWasteAudit),
// yang diisi `sentinel_scan.py` (VPS45) -- Layer 16 Exclusion Leakage (estimasi rupiah waste dari
// budget yang lari ke exclusion salah) digabung dgn Layer 17 EMQ Audit (skor Event Match Quality
// Purchase/Lead), per akun per tick (30 menit). Target EMQ dari komentar schema.prisma:
// Purchase >= 9.3, Lead >= 8.0 -- itu asal nama "CAPI EMQ 9.3+" di judul kartu ini.
//
// PENTING: `emqScoreLead` bisa berisi sentinel -1.0 (dikirim sentinel_scan.py kalau pixel akun itu
// belum punya event Lead sama sekali di tick tsb) -- ini BUKAN skor asli, harus ditampilkan "N/A",
// jangan pernah dirender sbg angka -1 atau dianggap "di bawah target".

import { useEffect, useState } from 'react';
import { AlertTriangle, DollarSign, Gauge, Loader2, RefreshCw, ShieldQuestion } from 'lucide-react';
import { apiGet } from '../../lib/api';

interface BudgetWasteAuditItem {
  id: string;
  adAccountId: string;
  estimatedWaste: string; // Decimal Prisma -> string di JSON
  emqScorePurchase: string;
  emqScoreLead: string;
  findings?: unknown;
  createdAt: string;
}

const EMQ_TARGET_PURCHASE = 9.3;
const EMQ_TARGET_LEAD = 8.0;
const LEAD_SENTINEL_MISSING = -1;

function formatRupiah(n: number): string {
  return `Rp${Math.round(n).toLocaleString('id-ID')}`;
}

function EmqBadge({ score, target }: { score: number; target: number }) {
  if (score === LEAD_SENTINEL_MISSING) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-500">
        <ShieldQuestion className="w-3 h-3" /> N/A
      </span>
    );
  }
  const ok = score >= target;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${
        ok ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
      }`}
    >
      {score.toFixed(1)} <span className="opacity-60 font-normal">/ {target}</span>
    </span>
  );
}

export default function BudgetWasteEmqCard() {
  const [items, setItems] = useState<BudgetWasteAuditItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ items: BudgetWasteAuditItem[]; count: number }>('/business/budget-waste-audits');
      setItems(res.items);
    } catch (e) {
      setError((e as Error).message || 'Gagal memuat data Budget Waste & CAPI EMQ.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const totalWaste = (items ?? []).reduce((sum, it) => sum + (parseFloat(it.estimatedWaste) || 0), 0);

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-xs overflow-hidden">
      <div className="border-b border-gray-100 px-4 py-3 flex items-center justify-between bg-white flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-rose-50 flex items-center justify-center text-rose-600">
            <Gauge className="w-3.5 h-3.5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-900">Budget Waste &amp; CAPI EMQ 9.3+</h2>
            <p className="text-[10px] text-gray-400">
              Estimasi rupiah waste dari exclusion leakage + skor Event Match Quality per akun (Sentinel Layer 16 &amp; 17)
            </p>
          </div>
        </div>
        <button
          onClick={load}
          className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
        >
          <RefreshCw className="w-3 h-3" /> Muat ulang
        </button>
      </div>

      <div className="p-4 space-y-3">
        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2 text-xs flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {error}
          </div>
        )}

        {loading ? (
          <div className="text-sm text-gray-400 flex items-center gap-2 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Memuat…
          </div>
        ) : !items || items.length === 0 ? (
          <div className="text-sm text-gray-400 text-center py-6 bg-gray-50 rounded-xl border border-gray-100">
            Belum ada data Budget Waste/EMQ -- akun belum terdaftar di sentinel_scan, atau belum ada tick yang jalan.
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
              <DollarSign className="w-3.5 h-3.5 text-rose-500" />
              Total estimasi waste ({items.length} akun): <span className="font-bold text-gray-800">{formatRupiah(totalWaste)}</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-100">
                    <th className="py-1.5 pr-3 font-medium">Ad Account</th>
                    <th className="py-1.5 pr-3 font-medium">Estimasi Waste</th>
                    <th className="py-1.5 pr-3 font-medium">EMQ Purchase</th>
                    <th className="py-1.5 pr-3 font-medium">EMQ Lead</th>
                    <th className="py-1.5 pr-3 font-medium">Update Terakhir</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} className="border-b border-gray-50 last:border-0">
                      <td className="py-2 pr-3 font-mono text-gray-700">{it.adAccountId}</td>
                      <td className="py-2 pr-3 font-semibold text-gray-900">{formatRupiah(parseFloat(it.estimatedWaste) || 0)}</td>
                      <td className="py-2 pr-3">
                        <EmqBadge score={parseFloat(it.emqScorePurchase)} target={EMQ_TARGET_PURCHASE} />
                      </td>
                      <td className="py-2 pr-3">
                        <EmqBadge score={parseFloat(it.emqScoreLead)} target={EMQ_TARGET_LEAD} />
                      </td>
                      <td className="py-2 pr-3 text-gray-400">
                        {new Date(it.createdAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
