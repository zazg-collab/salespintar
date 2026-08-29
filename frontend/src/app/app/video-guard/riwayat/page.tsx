'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  AlertOctagon,
  Clock,
  History,
  FileText,
  Image as ImageIcon,
  Video,
  Link as LinkIcon,
  Eye,
} from 'lucide-react';
import { apiGet } from '../../../../lib/api';

interface AuditRow {
  id: string;
  adTitle: string;
  adName: string | null;
  description: string | null;
  channels: string[];
  overallScore: number | null;
  verdict: string | null;
  // [2026-08-27] fix (feedback Bossfren): kondisi PROSES audit (diproses/gagal teknis/berhasil)
  // sekarang field terpisah dari `verdict` (yang HANYA berarti kalau processingStatus === 'SUCCESS').
  // Lihat persistAuditReport() & TECHNICAL_ERROR di metaguard_service/engine.py.
  processingStatus: string;
  channelsCompleted: number;
  channelsTotal: number;
  createdAt: string;
  updatedAt: string;
}

// Status AI -- HANYA verdict konten yang valid (audit-nya beneran sukses diproses). 3 nilai bersih
// sesuai permintaan Bossfren: approved/rejected/need review -- MANUAL_REVIEW/TECHNICAL_ERROR TIDAK
// lagi masuk di sini, itu sekarang murni soal "Status Audit" (lihat AUDIT_STATUS_STYLE di bawah).
const VERDICT_STYLE: Record<string, { label: string; className: string; icon: React.ElementType }> = {
  APPROVED: { label: 'Disetujui', className: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2 },
  NEEDS_MINOR_TWEAK: { label: 'Perlu Review', className: 'bg-amber-100 text-amber-700', icon: AlertTriangle },
  HIGH_RISK_REJECT: { label: 'Ditolak', className: 'bg-rose-100 text-rose-700', icon: XCircle },
};

// [2026-08-27] fix kolom "Status Audit" terpisah dari "Status AI" (feedback Bossfren): dulu badge
// "Perlu Review Manual, skor 0/100" bikin kegagalan TEKNIS (timeout agy, JSON gagal diparse) keliatan
// kayak hasil audit konten yang beneran -- misleading. Sekarang kondisi PROSES (diproses/gagal
// teknis/berhasil) dan penilaian AI (approved/rejected/need review) dua kolom yang benar-benar
// terpisah, gak lagi dicampur jadi satu badge.
const AUDIT_STATUS_STYLE: Record<string, { label: string; className: string; icon: React.ElementType }> = {
  PROCESSING: { label: 'Diproses', className: 'bg-indigo-100 text-indigo-700', icon: Clock },
  TECHNICAL_ERROR: { label: 'Gagal Teknis', className: 'bg-orange-100 text-orange-700', icon: AlertOctagon },
  SUCCESS: { label: 'Berhasil', className: 'bg-gray-100 text-gray-600', icon: CheckCircle2 },
};

function AuditStatusBadge({ status }: { status: string }) {
  const style = AUDIT_STATUS_STYLE[status] ?? AUDIT_STATUS_STYLE.SUCCESS;
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${style.className}`}>
      <Icon className="w-3.5 h-3.5" /> {style.label}
    </span>
  );
}

function VerdictBadge({ verdict, processingStatus }: { verdict: string | null; processingStatus: string }) {
  // Verdict AI cuma valid ditampilkan kalau proses auditnya BERHASIL -- baris yang masih diproses
  // atau gagal teknis cukup ditampilin "—" di sini, statusnya sendiri sudah kebaca dari kolom
  // "Status Audit" di sebelah kiri, gak perlu diulang/dicampur di sini.
  if (processingStatus !== 'SUCCESS' || !verdict) {
    return <span className="text-gray-300 text-xs">—</span>;
  }
  const style = VERDICT_STYLE[verdict];
  if (!style) return <span className="text-gray-300 text-xs">—</span>;
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${style.className}`}>
      <Icon className="w-3.5 h-3.5" /> {style.label}
    </span>
  );
}

/** Risk tag di kolom "Skor Risiko" -- threshold PERSIS sama dgn score_to_verdict() Python
 * (engine.py): >=80 Low, 60-79 Medium, <60 High. Ini murni presentasi skor yg sudah dihitung
 * backend, bukan skor baru. Cuma dipanggil kalau processingStatus === 'SUCCESS' (lihat body tabel) --
 * baris diproses/gagal teknis tidak punya skor yang valid buat ditag. */
function riskTag(score: number | null): { label: string; className: string } {
  if (score === null) return { label: '—', className: 'bg-gray-100 text-gray-400' };
  if (score >= 80) return { label: 'Risiko Rendah', className: 'bg-emerald-50 text-emerald-700 border border-emerald-200' };
  if (score >= 60) return { label: 'Risiko Sedang', className: 'bg-amber-50 text-amber-700 border border-amber-200' };
  return { label: 'Risiko Tinggi', className: 'bg-rose-50 text-rose-700 border border-rose-200' };
}

/** Baris icon Text/Image/Video/Link (feedback Bossfren 2026-08-25, referensi AdGuardAI): 5 channel
 * mentah backend (visual_motion/audio_speech/text_copy/thumbnail_image/landing_page) dipetakan ke 4
 * tipe konten yg dilihat user. Video HIDUP kalau visual_motion ATAU audio_speech ada -- gabungan
 * sengaja, krn dari sisi user "video dianalisis" itu satu konsep, bukan 2 baris terpisah. Icon abu +
 * tooltip kalau channel itu TIDAK ada di rawReportJson (bukan sekadar "tidak ada asset" tapi juga
 * mencakup video yg gagal diambil dari Meta -- root cause investigasi hari ini) -- ini pengganti
 * kolom "Status" terpisah dari lanjutan #14, sekarang melebur ke baris icon ini sesuai referensi.
 */
function ContentTypeIcons({ channels }: { channels: string[] }) {
  const has = (k: string) => channels.includes(k);
  const items: { key: string; label: string; active: boolean; Icon: React.ElementType }[] = [
    { key: 'text', label: 'Teks/Caption', active: has('text_copy_score'), Icon: FileText },
    { key: 'image', label: 'Thumbnail/Gambar', active: has('thumbnail_image_score'), Icon: ImageIcon },
    {
      key: 'video',
      label: 'Video (visual + audio)',
      active: has('visual_motion_score') || has('audio_speech_score'),
      Icon: Video,
    },
    { key: 'link', label: 'Landing Page', active: has('landing_page_score'), Icon: LinkIcon },
  ];
  return (
    <div className="flex items-center gap-1.5 mt-1.5">
      {items.map(({ key, label, active, Icon }) => (
        <span
          key={key}
          title={active ? `${label} -- berhasil dianalisis` : `${label} -- TIDAK dianalisis (asset gagal diambil/tidak dilampirkan)`}
          className={`inline-flex items-center justify-center w-5 h-5 rounded ${
            active ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-100 text-gray-300'
          }`}
        >
          <Icon className="w-3 h-3" />
        </span>
      ))}
    </div>
  );
}

export default function RiwayatAuditPage() {
  const [audits, setAudits] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('ALL');

  useEffect(() => {
    apiGet<{ audits: AuditRow[] }>('/video-guard/history?take=200')
      .then((res) => setAudits(res.audits))
      .catch((e) => setError(e.message || 'Gagal memuat riwayat audit'));
  }, []);

  const stats = useMemo(() => {
    if (!audits) return null;
    const byKey: Record<string, number> = {};
    for (const a of audits) {
      // [2026-08-27] fix (feedback Bossfren): hitungan tab sekarang berbasis processingStatus dulu
      // (diproses/gagal teknis dihitung di situ), verdict AI cuma dihitung utk baris yang BERHASIL --
      // supaya baris gagal-teknis (dulu nyasar ke "MANUAL_REVIEW") tidak lagi bikin total tab meleset
      // dari jumlah "Semua" (lihat screenshot Bossfren 27/8: Ditolak 2 + Diproses 3 != Semua 6, krn 1
      // baris ADS PAR gagal-teknis tidak kehitung tab manapun).
      if (a.processingStatus === 'PROCESSING') {
        byKey.PROCESSING = (byKey.PROCESSING ?? 0) + 1;
      } else if (a.processingStatus === 'TECHNICAL_ERROR') {
        byKey.TECHNICAL_ERROR = (byKey.TECHNICAL_ERROR ?? 0) + 1;
      } else if (a.verdict) {
        byKey[a.verdict] = (byKey[a.verdict] ?? 0) + 1;
      }
    }
    return byKey;
  }, [audits]);

  const filtered = useMemo(() => {
    if (!audits) return [];
    if (filter === 'ALL') return audits;
    if (filter === 'PROCESSING') return audits.filter((a) => a.processingStatus === 'PROCESSING');
    if (filter === 'TECHNICAL_ERROR') return audits.filter((a) => a.processingStatus === 'TECHNICAL_ERROR');
    return audits.filter((a) => a.processingStatus === 'SUCCESS' && a.verdict === filter);
  }, [audits, filter]);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <Link href="/app/video-guard" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="w-4 h-4" /> Kembali ke Dashboard
      </Link>

      <div>
        <h1 className="text-lg md:text-xl font-bold text-gray-900 flex items-center gap-2">
          <History className="w-6 h-6 text-indigo-600" /> Riwayat Audit
        </h1>
        <p className="text-xs text-gray-500 mt-1">Semua audit video yang pernah dijalankan untuk business ini.</p>
      </div>

      {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm">{error}</div>}

      {stats && (
        <div className="flex flex-wrap gap-2">
          {[
            { key: 'ALL', label: `Semua (${audits?.length ?? 0})` },
            { key: 'APPROVED', label: `Disetujui (${stats.APPROVED ?? 0})` },
            { key: 'NEEDS_MINOR_TWEAK', label: `Perlu Review (${stats.NEEDS_MINOR_TWEAK ?? 0})` },
            { key: 'HIGH_RISK_REJECT', label: `Ditolak (${stats.HIGH_RISK_REJECT ?? 0})` },
            { key: 'PROCESSING', label: `Diproses (${stats.PROCESSING ?? 0})` },
            { key: 'TECHNICAL_ERROR', label: `Gagal Teknis (${stats.TECHNICAL_ERROR ?? 0})` },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                filter === f.key ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {audits === null && !error && (
        <div className="flex items-center gap-2 text-gray-500 text-sm py-12 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Memuat riwayat…
        </div>
      )}

      {audits !== null && (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-10">Tidak ada audit pada kategori ini.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Iklan</th>
                    <th className="text-left px-4 py-3 font-medium">Status Audit</th>
                    <th className="text-left px-4 py-3 font-medium">Status AI</th>
                    <th className="text-left px-4 py-3 font-medium">Skor Risiko</th>
                    <th className="text-left px-4 py-3 font-medium">Dibuat</th>
                    <th className="text-left px-4 py-3 font-medium">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((a) => {
                    // Skor/risk tag CUMA valid kalau audit-nya beneran berhasil -- baris diproses atau
                    // gagal teknis tidak punya skor yang bisa dipercaya (0/100 bukan skor asli, lihat
                    // compute_final_assessment() di metaguard_service/engine.py).
                    const risk = a.processingStatus === 'SUCCESS' ? riskTag(a.overallScore) : null;
                    return (
                      <tr key={a.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 max-w-sm">
                          <Link
                            href={`/app/video-guard/audit/${a.id}`}
                            className="block font-medium text-gray-800 hover:text-emerald-600 transition-colors truncate"
                          >
                            {a.adName || a.adTitle}
                          </Link>
                          {a.description && (
                            <p className="text-xs text-gray-400 mt-0.5 truncate">{a.description}</p>
                          )}
                          <ContentTypeIcons channels={a.channels} />
                        </td>
                        <td className="px-4 py-3"><AuditStatusBadge status={a.processingStatus} /></td>
                        <td className="px-4 py-3"><VerdictBadge verdict={a.verdict} processingStatus={a.processingStatus} /></td>
                        <td className="px-4 py-3">
                          {risk ? (
                            <div className="flex items-center gap-2">
                              <span className="text-gray-700 font-semibold">{a.overallScore ?? '—'}</span>
                              <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${risk.className}`}>
                                {risk.label}
                              </span>
                            </div>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-400 text-xs">{new Date(a.createdAt).toLocaleString('id-ID')}</td>
                        <td className="px-4 py-3">
                          <Link
                            href={`/app/video-guard/audit/${a.id}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors"
                          >
                            <Eye className="w-3.5 h-3.5" /> Lihat
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
