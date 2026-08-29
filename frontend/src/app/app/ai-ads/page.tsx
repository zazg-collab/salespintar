'use client';

// === KETERANGAN PENGERJAAN ===
// File ini ditulis ulang (ROMBAK TOTAL & UI/UX ENHANCEMENT) oleh: Antigravity (Gemini), 2026-08-29
// Penyelarasan Presisi Blueprint Bagian 9 (UI/UX AI Command Center):
//   1. Tab Dashboard (Urutan Atas ke Bawah):
//      - 1. Kartu Antrian Approval (PALING ATAS)
//      - 2. Kartu Status Modul (Tabel bersih + Popup Modal Aturan Detail Interaktif)
//      - 3. 7 Kartu per Modul (Grid 7.1 s/d 7.7 + Scan Sekarang inline)
//   2. Tab Pengaturan: Parameter Bagian 8 untuk 7 modul + toggle switch per modul
// ============================

import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '../../../lib/api';
import {
  LayoutDashboard,
  ListChecks,
  Activity,
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronUp,
  Zap,
  Layers,
  Info,
  X,
  Sliders,
  ShieldCheck,
  Target,
  FileCode2,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// TIPE DATA
// ─────────────────────────────────────────────────────────────────────────────

type RecStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'EXECUTION_FAILED';
type RoutingType = 'mutation' | 'content_review' | 'report_only' | 'emergency_auto';

interface AiAdsRecommendation {
  id: string;
  layerKey: string | null;
  routingType: RoutingType | null;
  isUrgent: boolean;
  status: RecStatus;
  planSummary: Record<string, unknown> | null;
  contentData: Record<string, unknown> | null;
  planPath: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  executedAt: string | null;
}

interface ModuleStatus {
  moduleId: string;
  label: string;
  layerPrefix: string;
  pendingApprovalCount: number;
  hasUrgent: boolean;
  lastRunAt: string | null;
}

interface ModuleDetailRule {
  moduleId: string;
  title: string;
  tagline: string;
  layers: string[];
  triggers: string[];
  parameters: Array<{ label: string; value: string; desc: string }>;
  actions: string[];
  theme: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// KONSTANTA & DATA DETAIL ATURAN (UNTUK POPUP MODAL)
// ─────────────────────────────────────────────────────────────────────────────

const MODULE_ICONS: Record<string, string> = {
  '7.1': '📉',
  '7.2': '🕘',
  '7.3': '🚨',
  '7.4': '🧠',
  '7.5': '🛡️',
  '7.6': '🧪',
  '7.7': '⚡',
};

const MODULE_COLOR: Record<string, string> = {
  '7.1': 'from-blue-50 to-blue-100 border-blue-200',
  '7.2': 'from-rose-50 to-rose-100 border-rose-200',
  '7.3': 'from-purple-50 to-purple-100 border-purple-200',
  '7.4': 'from-amber-50 to-amber-100 border-amber-200',
  '7.5': 'from-emerald-50 to-emerald-100 border-emerald-200',
  '7.6': 'from-cyan-50 to-cyan-100 border-cyan-200',
  '7.7': 'from-indigo-50 to-indigo-100 border-indigo-200',
};

const MODULE_RULES_DETAIL: Record<string, ModuleDetailRule> = {
  '7.1': {
    moduleId: '7.1',
    title: 'Tiga Aturan Budget & Badging',
    tagline: 'Manajemen alokasi budget otomatis, mitigasi penurunan performa, dan proteksi kelelahan audiens.',
    layers: ['Layer 01 (Scale Up)', 'Layer 02 (Reduce Soft & Hard)', 'Layer 03 (Hard Kill)', 'Layer 10 (Ad Fatigue)'],
    triggers: ['Evaluasi rasio ROAS harian/mingguan terhadap Target ROAS', 'Kenaikan frekuensi tayang iklan per user'],
    parameters: [
      { label: 'Lock Period', value: '48 Jam', desc: 'Jeda waktu wajib setelah adset di-scale/reduce sebelum boleh diubah lagi.' },
      { label: 'Reduce Soft', value: '-30% Budget', desc: 'Diterapkan jika ROAS berada di rentang 70% – 85% dari target.' },
      { label: 'Reduce Hard', value: '-50% Budget', desc: 'Diterapkan jika ROAS berada di rentang 50% – 70% dari target.' },
      { label: 'Hard Kill', value: '> 3.0× CPA', desc: 'Matikan adset jika CPA > 3× target selama 7 hari berturut-turut.' },
      { label: 'Ad Fatigue Guard', value: 'Freq > 3.5 & CTR -25%', desc: 'Peringatan kelelahan kreatif iklan jika frekuensi naik dan CTR drop.' },
    ],
    actions: ['Draft Mutasi Budget (Scale Up / Scale Down)', 'Draft Matikan Adset (Hard Kill)', 'Notifikasi Fatigue ke media buyer'],
    theme: 'border-blue-200 bg-blue-50 text-blue-800',
  },
  '7.2': {
    moduleId: '7.2',
    title: 'Shift Automation & Morning Briefing',
    tagline: 'Siklus otomatisasi patroli 3 shift harian dan pengiriman laporan eksekutif pagi.',
    layers: ['Layer 04 (Shift Evaluator)', 'Layer 10 (Pacing Sentinel)', 'Morning Briefing Engine'],
    triggers: ['Trigger berbasis jadwal waktu WIB (Pagi, Siang, Sore, dan Subuh)'],
    parameters: [
      { label: 'Shift Pagi (Early-Kill)', value: '09:00 WIB', desc: 'Pembersihan adset yang bocor/underperforming sebelum spend membengkak.' },
      { label: 'Shift Siang (Mid-Day)', value: '13:00 WIB', desc: 'Evaluasi kecepatan spend tengah hari dan perataan distribusi pacing.' },
      { label: 'Shift Sore (Golden Hour)', value: '16:00 WIB', desc: 'Injeksi budget untuk adset pemenang menjelang prime time konversi malam.' },
      { label: 'Morning Briefing', value: '07:30 WIB', desc: 'Rekap otomatis 5 Pertanyaan Harian dikirim langsung ke Telegram.' },
    ],
    actions: ['Eksekusi sinkronisasi shift terjadwal', 'Pengiriman laporan status akun & rekomendasi harian ke Telegram'],
    theme: 'border-rose-200 bg-rose-50 text-rose-800',
  },
  '7.3': {
    moduleId: '7.3',
    title: 'Spend Anomaly & Circuit Breaker',
    tagline: 'Sistem rem darurat untuk menghentikan pembakaran uang tak wajar & link rusak.',
    layers: ['Layer 06 (LP Check)', 'Layer 07 (Velocity Spike)', 'Layer 08 (Zero-Conv Emergency Stop)'],
    triggers: ['Lonjakan kecepatan spend abnormal dalam window 2 jam', 'Spend tinggi tanpa satupun konversi', 'Halaman LP tidak bisa diakses'],
    parameters: [
      { label: 'Velocity Spike', value: '> 50% Daily Budget / 2 Jam', desc: 'Alarm darurat saat algoritma Meta menghabiskan >50% budget dalam 2 jam.' },
      { label: 'Zero-Conv Warning', value: '> 1.5× CPA', desc: 'Peringatan dini saat spend sudah melebihi 1.5× CPA tanpa konversi.' },
      { label: 'Zero-Conv Hard Stop', value: '> 2.5× CPA', desc: 'Auto-pause adset jika spend mencapai 2.5× target CPA dan 0 konversi.' },
      { label: 'Circuit Breaker Akun', value: '> 110% Plafon', desc: 'Rem darurat global: pause seluruh akun jika spend harian menembus 110% plafon.' },
      { label: 'Dead-Link Timeout', value: '10 Detik / 2× Gagal', desc: 'Auto-pause iklan jika URL landing page gagal diakses (HTTP 5xx / 404).' },
    ],
    actions: ['Auto-Pause Adset Darurat (Prioritas Tinggi)', 'Notifikasi Darurat WhatsApp/Telegram', 'Proteksi Saldo Akun'],
    theme: 'border-purple-200 bg-purple-50 text-purple-800',
  },
  '7.4': {
    moduleId: '7.4',
    title: 'Tiga Bot Otonom Spesialis',
    tagline: 'Spesialis deteksi dinamika lelang, audit hook video iklan, dan penyelarasan landing page.',
    layers: ['Layer 09 (Auction CPC Surge)', 'Layer 11 (CTR Hook Diagnostician)', 'Layer 12 (LP Dead Link)', 'Layer 13 (LP Message-Match)'],
    triggers: ['Lonjakan biaya lelang (CPC/CPM)', 'CTR video rendah (<0.60%)', 'CVR landing page drop (<0.80%)'],
    parameters: [
      { label: 'CPC Surge Warning', value: '+50% dari 7d Avg', desc: 'Peringatan kenaikan biaya klik akibat persaingan lelang ketat.' },
      { label: 'CPC Surge Critical', value: '+100% dari 7d Avg', desc: 'Status kritis saat CPC melonjak 2x lipat dari rata-rata 7 hari.' },
      { label: 'Hook Diagnostician', value: 'Min 1.000 Impresi & CTR < 0.60%', desc: 'AI mendiagnosa 3 detik pertama video dan buatkan 3 sudut pandang hook baru.' },
      { label: 'LP Message-Match', value: 'Min 50 Klik & CVR < 0.80%', desc: 'AI mendiagnosa keselarasan pesan iklan vs LP, buatkan rewrite H1, Subhead, CTA.' },
    ],
    actions: ['Rekomendasi Hook Baru (Review Konten)', 'Rekomendasi Rewrite Copy Landing Page', 'Peringatan Anomali Lelang'],
    theme: 'border-amber-200 bg-amber-50 text-amber-800',
  },
  '7.5': {
    moduleId: '7.5',
    title: 'Budget Waste & CAPI EMQ Defense',
    tagline: 'Pencegahan kebocoran audiens pembeli lama dan penjaga kualitas data Conversions API.',
    layers: ['Layer 16 (CAPI Audience Exclusion Leakage)', 'Layer 17 (Event Match Quality EMQ Score)'],
    triggers: ['Pembeli 180 hari terakhir tidak tereksklusi dari campaign prospek', 'Skor EMQ CAPI di bawah target'],
    parameters: [
      { label: 'Waste Threshold', value: '> 10% Spend 7 Hari', desc: 'Kategori pemborosan budget jika terbuang ke audiens pembeli lama.' },
      { label: 'Exclude Window', value: '180 Hari', desc: 'Rentang waktu pembeli yang wajib dieksklusi dari kampanye akuisisi baru.' },
      { label: 'EMQ Target Purchase', value: 'Min 9.3 / 10', desc: 'Standar emas kualitas pencocokan data server Meta untuk event Purchase.' },
      { label: 'EMQ Target Lead', value: 'Min 8.0 / 10', desc: 'Standar minimum kualitas pencocokan data server Meta untuk event Lead.' },
    ],
    actions: ['Rekomendasi Perbaikan Custom Audience Exclusion', 'Audit & Notifikasi Perbaikan Sinyal CAPI Server'],
    theme: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  },
  '7.6': {
    moduleId: '7.6',
    title: 'A/B Test Significance Engine',
    tagline: 'Kalkulasi saintifik pengujian kreatif dan copy iklan berbasis Two-Proportion Z-Test.',
    layers: ['Layer 14 (Early Loser Kill)', 'Layer 15 (Winner Declaration Z-Test)'],
    triggers: ['Pengujian adset dalam campaign A/B testing aktif'],
    parameters: [
      { label: 'Min Sampel Uji', value: '20 Klik per Varian', desc: 'Batas sampel data minimum sebelum uji statistik valid dihitung.' },
      { label: 'Early Loser Kill', value: 'Spend > 2.0× CPA & 0 Conv', desc: 'Matikan varian yang kalah lebih cepat untuk menghemat anggaran tes.' },
      { label: 'Confidence Level', value: '95% (p-value < 0.05)', desc: 'Tingkat keyakinan statistik sebelum varian resmi dideklarasikan sebagai pemenang.' },
      { label: 'Maksimal Durasi', value: '14 Hari', desc: 'Batas waktu tes. Jika tidak ada pemenang signifikan, status jadi Inconclusive.' },
    ],
    actions: ['Draft Matikan Varian Kalah (Mutasi)', 'Laporan Deklarasi Varian Pemenang (Informatif)'],
    theme: 'border-cyan-200 bg-cyan-50 text-cyan-800',
  },
  '7.7': {
    moduleId: '7.7',
    title: 'Kuota Meta API Rate Limit Guard',
    tagline: 'Pelindung kuota panggilan API Meta Graph agar sistem tidak terkena blokir sementara.',
    layers: ['Layer 17B (Token Bucket & Adaptive Backoff)'],
    triggers: ['Panggilan Meta Graph API harian oleh bot'],
    parameters: [
      { label: 'Kapasitas Bucket', value: '180 Calls / Jam', desc: 'Batas kuota aman panggilan API per token Business Manager.' },
      { label: 'Adaptive Backoff', value: 'Utilisasi > 80%', desc: 'Otomatis memperlambat request jika header Meta mendekati batas limit.' },
      { label: 'Cooldown Throttle', value: '15 Menit', desc: 'Jeda wajib jika menerima response HTTP 429 sebelum request diulang.' },
    ],
    actions: ['Pengaturan antrian request API otomatis', 'Pencegahan error rate limit Meta Graph API'],
    theme: 'border-indigo-200 bg-indigo-50 text-indigo-800',
  },
};

const STATUS_BADGE: Record<RecStatus, string> = {
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800 border border-amber-200',
  APPROVED: 'bg-blue-100 text-blue-800 border border-blue-200',
  REJECTED: 'bg-gray-100 text-gray-600 border border-gray-200',
  EXECUTED: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
  EXECUTION_FAILED: 'bg-red-100 text-red-800 border border-red-200',
};

const STATUS_LABEL: Record<RecStatus, string> = {
  PENDING_APPROVAL: 'Menunggu',
  APPROVED: 'Disetujui',
  REJECTED: 'Ditolak',
  EXECUTED: 'Tereksekusi',
  EXECUTION_FAILED: 'Gagal',
};

function formatWaktu(iso: string | null): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function ringkasLayerKey(key: string | null): string {
  if (!key) return '-';
  const parts = key.split('_').slice(1);
  return parts.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || key;
}

function UrgentBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 border border-red-200 animate-pulse">
      ⚠️ PRIORITAS
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POPUP MODAL ATURAN DETAIL MODUL (UI/UX BARU)
// ─────────────────────────────────────────────────────────────────────────────

interface ModuleRulesModalProps {
  rule: ModuleDetailRule | null;
  onClose: () => void;
  onGoToSettings?: () => void;
}

function ModuleRulesModal({ rule, onClose, onGoToSettings }: ModuleRulesModalProps) {
  if (!rule) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fadeIn">
      <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden animate-scaleUp">
        
        {/* Header Modal */}
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{MODULE_ICONS[rule.moduleId] ?? '⚙️'}</span>
            <div>
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded-md bg-blue-100 text-blue-800 font-bold text-xs">
                  Modul {rule.moduleId}
                </span>
                <h3 className="font-bold text-gray-900 text-base">{rule.title}</h3>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">{rule.tagline}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Isi Body Modal */}
        <div className="p-6 overflow-y-auto space-y-5 text-xs text-gray-700">
          
          {/* Lapisan / Layer Terkait */}
          <div>
            <h4 className="font-bold text-gray-800 mb-2 flex items-center gap-1.5">
              <Layers size={14} className="text-blue-600" />
              Lapisan / Layer Terkait
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {rule.layers.map((l, idx) => (
                <span key={idx} className="px-2.5 py-1 bg-gray-100 text-gray-700 rounded-md font-medium">
                  {l}
                </span>
              ))}
            </div>
          </div>

          {/* Ambang Batas & Aturan Kunci (Bagian 8) */}
          <div>
            <h4 className="font-bold text-gray-800 mb-2.5 flex items-center gap-1.5">
              <Target size={14} className="text-blue-600" />
              Ambang Batas & Parameter Aturan (Bagian 8 Blueprint)
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {rule.parameters.map((p, idx) => (
                <div key={idx} className="p-3 bg-gray-50 border border-gray-200 rounded-xl space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-gray-800">{p.label}</span>
                    <span className="px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded text-[11px] font-bold">
                      {p.value}
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-500 leading-relaxed">{p.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Kondisi Trigger & Aksi */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-gray-100">
            <div>
              <h4 className="font-bold text-gray-800 mb-2 flex items-center gap-1.5">
                <Zap size={14} className="text-amber-500" />
                Pemicu / Trigger
              </h4>
              <ul className="space-y-1.5 list-disc list-inside text-gray-600 text-[11px]">
                {rule.triggers.map((t, idx) => (
                  <li key={idx}>{t}</li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="font-bold text-gray-800 mb-2 flex items-center gap-1.5">
                <ShieldCheck size={14} className="text-emerald-600" />
                Bentuk Aksi Sistem
              </h4>
              <ul className="space-y-1.5 list-disc list-inside text-gray-600 text-[11px]">
                {rule.actions.map((a, idx) => (
                  <li key={idx}>{a}</li>
                ))}
              </ul>
            </div>
          </div>

        </div>

        {/* Footer Modal */}
        <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
          <span className="text-[11px] text-gray-400">Parameter dapat diubah di Tab Pengaturan</span>
          <div className="flex items-center gap-2">
            {onGoToSettings && (
              <button
                onClick={() => { onClose(); onGoToSettings(); }}
                className="px-3 py-1.5 border border-gray-300 hover:bg-gray-100 text-gray-700 rounded-lg text-xs font-medium flex items-center gap-1"
              >
                <Sliders size={12} /> Buka Pengaturan
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold"
            >
              Tutup
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// KARTU MUTATION (Item Antrian)
// ─────────────────────────────────────────────────────────────────────────────

interface MutationCardProps {
  item: AiAdsRecommendation;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string, reason: string) => Promise<void>;
  processing: boolean;
}

function MutationCard({ item, onApprove, onReject, processing }: MutationCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const summary = item.planSummary as any;

  return (
    <div className={`border rounded-xl overflow-hidden ${item.isUrgent ? 'border-red-300 shadow-red-100 shadow-sm' : 'border-gray-200'}`}>
      <div className={`px-4 py-3 flex items-start justify-between gap-3 ${item.isUrgent ? 'bg-red-50' : 'bg-gray-50'}`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {item.isUrgent && <UrgentBadge />}
            <span className="text-xs font-mono text-gray-500">{item.layerKey ?? '-'}</span>
          </div>
          <p className="mt-1 font-medium text-gray-800 text-sm leading-tight">{ringkasLayerKey(item.layerKey)}</p>
          {summary?.reason && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{summary.reason}</p>}
        </div>
        <div className="flex-shrink-0 text-right">
          <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_BADGE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
          <p className="text-xs text-gray-400 mt-1">{formatWaktu(item.createdAt)}</p>
        </div>
      </div>

      {summary && (
        <div className="px-4 py-2 bg-white border-t border-gray-100 text-xs text-gray-600">
          <span className="font-medium">Objek:</span> {summary.objectId ?? '-'} ({summary.objectType ?? '-'})
          {summary.operation && <> · <span className="font-medium">Aksi:</span> {summary.operation}</>}
        </div>
      )}

      {item.planPath && (
        <button onClick={() => setExpanded(e => !e)} className="w-full flex items-center gap-1 px-4 py-1.5 text-xs text-gray-500 hover:text-gray-700 bg-white border-t border-gray-100">
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? 'Sembunyikan path' : 'Lihat plan path'}
        </button>
      )}
      {expanded && item.planPath && (
        <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 font-mono text-xs text-gray-500 break-all">{item.planPath}</div>
      )}

      {item.status === 'PENDING_APPROVAL' && (
        <div className="px-4 py-3 bg-white border-t border-gray-100 flex items-center gap-2 flex-wrap">
          {!rejectMode ? (
            <>
              <button disabled={processing} onClick={() => onApprove(item.id)} className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {processing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                Approve & Eksekusi
              </button>
              <button disabled={processing} onClick={() => setRejectMode(true)} className="px-4 py-2 border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-lg text-sm disabled:opacity-50">
                Tolak
              </button>
            </>
          ) : (
            <div className="flex-1 space-y-2">
              <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="Alasan penolakan..." className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none" rows={2} />
              <div className="flex gap-2">
                <button disabled={processing} onClick={() => onReject(item.id, rejectReason)} className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium disabled:opacity-50">Konfirmasi Tolak</button>
                <button onClick={() => { setRejectMode(false); setRejectReason(''); }} className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">Batal</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// KARTU CONTENT REVIEW (Item Antrian)
// ─────────────────────────────────────────────────────────────────────────────

interface ContentReviewCardProps {
  item: AiAdsRecommendation;
  onApprove: (id: string, selectedOption?: number) => Promise<void>;
  onReject: (id: string, reason: string) => Promise<void>;
  processing: boolean;
}

function ContentReviewCard({ item, onApprove, onReject, processing }: ContentReviewCardProps) {
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [selectedHook, setSelectedHook] = useState<number | undefined>(undefined);
  const content = item.contentData as any;
  const hooks: Array<{ title: string; body: string }> = content?.hooks ?? [];
  const summary = item.planSummary as any;

  return (
    <div className="border border-purple-200 rounded-xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 bg-gradient-to-r from-purple-50 to-violet-50 flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-100 text-purple-700 border border-purple-200">
              📝 Review Konten
            </span>
            <span className="text-xs font-mono text-gray-500">{item.layerKey ?? '-'}</span>
          </div>
          <p className="mt-1 font-medium text-gray-800 text-sm leading-tight">{ringkasLayerKey(item.layerKey)}</p>
          {summary?.reason && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{summary.reason}</p>}
        </div>
        <div className="flex-shrink-0 text-right">
          <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_BADGE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
          <p className="text-xs text-gray-400 mt-1">{formatWaktu(item.createdAt)}</p>
        </div>
      </div>

      <div className="px-4 py-3 bg-white border-t border-purple-100 space-y-3">
        {hooks.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Pilih Hook yang Disetujui:</p>
            {hooks.map((hook, idx) => (
              <button key={idx} onClick={() => setSelectedHook(idx === selectedHook ? undefined : idx)}
                className={`w-full text-left p-3 rounded-lg border text-sm transition-all ${selectedHook === idx ? 'border-purple-400 bg-purple-50 ring-1 ring-purple-300' : 'border-gray-200 hover:border-purple-200'}`}>
                <p className="font-medium text-gray-800 mb-1">{hook.title}</p>
                <p className="text-gray-600 text-xs leading-relaxed">{hook.body}</p>
              </button>
            ))}
          </div>
        )}
        {hooks.length === 0 && content && (
          <div className="space-y-2 text-sm">
            {content.rewriteH1 && <div><span className="font-medium text-gray-600 text-xs">H1:</span> <span className="text-gray-800">{content.rewriteH1}</span></div>}
            {content.rewriteSubhead && <div><span className="font-medium text-gray-600 text-xs">Subheading:</span> <span className="text-gray-800">{content.rewriteSubhead}</span></div>}
            {content.rewriteCta && <div><span className="font-medium text-gray-600 text-xs">CTA:</span> <span className="text-gray-800">{content.rewriteCta}</span></div>}
          </div>
        )}
        <div className="flex items-start gap-2 p-2 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-700">
          <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
          <span>Approve hanya menandai persetujuan di sistem. Tim kreatif mengeksekusi perubahan copy secara manual.</span>
        </div>
      </div>

      {item.status === 'PENDING_APPROVAL' && (
        <div className="px-4 py-3 bg-white border-t border-purple-100 flex items-center gap-2 flex-wrap">
          {!rejectMode ? (
            <>
              <button disabled={processing} onClick={() => onApprove(item.id, selectedHook)} className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {processing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {selectedHook !== undefined ? `Approve Hook ${selectedHook + 1}` : 'Approve Konten'}
              </button>
              <button disabled={processing} onClick={() => setRejectMode(true)} className="px-4 py-2 border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-lg text-sm disabled:opacity-50">Tolak</button>
            </>
          ) : (
            <div className="flex-1 space-y-2">
              <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="Alasan penolakan..." className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none" rows={2} />
              <div className="flex gap-2">
                <button disabled={processing} onClick={() => onReject(item.id, rejectReason)} className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium disabled:opacity-50">Konfirmasi Tolak</button>
                <button onClick={() => { setRejectMode(false); setRejectReason(''); }} className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">Batal</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// KARTU STATUS MODUL (Summary Card - Poin 2 Blueprint)
// ─────────────────────────────────────────────────────────────────────────────

interface ModuleStatusSummaryProps {
  modules: ModuleStatus[];
  moduleConfig: Record<string, any> | null;
  onSelectModuleRule: (rule: ModuleDetailRule) => void;
}

function ModuleStatusSummary({ modules, moduleConfig, onSelectModuleRule }: ModuleStatusSummaryProps) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
      <div className="px-5 py-4 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-gray-800 flex items-center gap-2">
            <Activity size={16} className="text-blue-600" />
            Kartu Status Modul Automasi (7 Modul)
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">Klik pada nama modul untuk melihat penjelasan aturan detail & parameter aktif</p>
        </div>
        <span className="px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-full text-xs font-semibold">
          7 Modul Terdaftar
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-gray-50/50 text-gray-500 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 font-semibold">Modul (Klik untuk Aturan Detail)</th>
              <th className="px-4 py-3 font-semibold">Status Operasional</th>
              <th className="px-4 py-3 font-semibold text-center">Menunggu Approval</th>
              <th className="px-4 py-3 font-semibold text-right">Terakhir Jalan</th>
              <th className="px-4 py-3 font-semibold text-center">Aturan</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {modules.map((m) => {
              const cfgKey = `module_${m.moduleId.replace('.', '_')}`;
              const isEnabled = moduleConfig ? (moduleConfig[cfgKey]?.enabled ?? true) : true;
              const ruleDetail = MODULE_RULES_DETAIL[m.moduleId];

              return (
                <tr
                  key={m.moduleId}
                  onClick={() => ruleDetail && onSelectModuleRule(ruleDetail)}
                  className="hover:bg-blue-50/50 transition-colors cursor-pointer group"
                >
                  <td className="px-4 py-3.5 font-medium text-gray-900 flex items-center gap-2.5">
                    <span className="text-lg flex-shrink-0">{MODULE_ICONS[m.moduleId] ?? '⚙️'}</span>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-gray-800 group-hover:text-blue-600 transition-colors">
                          {m.moduleId} {m.label}
                        </span>
                      </div>
                      <span className="text-[11px] text-gray-400 group-hover:text-blue-500 flex items-center gap-1 mt-0.5">
                        <Info size={11} /> Klik untuk lihat detail aturan
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap">
                    {m.hasUrgent ? (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-red-100 text-red-700 border border-red-200">
                        🚨 Darurat
                      </span>
                    ) : isEnabled ? (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                        🟢 Aktif Memantau
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-gray-100 text-gray-600 border border-gray-200">
                        ⏸️ Dinonaktifkan
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-center">
                    {m.pendingApprovalCount > 0 ? (
                      <span className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full bg-amber-500 text-white font-bold text-[11px]">
                        {m.pendingApprovalCount} item
                      </span>
                    ) : (
                      <span className="text-gray-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-right text-gray-500 whitespace-nowrap">
                    {m.lastRunAt ? formatWaktu(m.lastRunAt) : 'Belum pernah'}
                  </td>
                  <td className="px-4 py-3.5 text-center">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (ruleDetail) onSelectModuleRule(ruleDetail);
                      }}
                      className="px-2.5 py-1 bg-white border border-gray-300 hover:border-blue-400 hover:bg-blue-50 text-gray-700 hover:text-blue-700 rounded-lg text-xs font-medium transition-all shadow-2xs inline-flex items-center gap-1"
                    >
                      <Info size={12} className="text-blue-500" /> Detail
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// KARTU MODUL (Grid 7 Modul - Poin 3 Blueprint)
// ─────────────────────────────────────────────────────────────────────────────

interface ModuleCardProps {
  module: ModuleStatus;
  onScan: (prefix: string) => Promise<void>;
  scanning: boolean;
  findings: AiAdsRecommendation[] | null;
  onViewRule: () => void;
}

function ModuleCard({ module, onScan, scanning, findings, onViewRule }: ModuleCardProps) {
  const [showFindings, setShowFindings] = useState(false);
  const colorClass = MODULE_COLOR[module.moduleId] ?? 'from-gray-50 to-gray-100 border-gray-200';

  return (
    <div className={`border rounded-xl overflow-hidden bg-gradient-to-br ${colorClass} shadow-sm`}>
      <div className="px-4 py-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <span className="text-xl flex-shrink-0">{MODULE_ICONS[module.moduleId] ?? '⚙️'}</span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Modul {module.moduleId}</p>
            <p className="text-sm font-semibold text-gray-800 leading-tight">{module.label}</p>
          </div>
        </div>
        <div className="flex-shrink-0 flex flex-col items-end gap-1">
          {module.hasUrgent && <UrgentBadge />}
          {module.pendingApprovalCount > 0 && (
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-500 text-white text-xs font-bold">
              {module.pendingApprovalCount}
            </span>
          )}
        </div>
      </div>

      <div className="px-4 pb-3 flex items-center justify-between text-xs text-gray-500 border-b border-black/5 pt-1">
        <span className="flex items-center gap-1">
          <Clock size={11} />
          {module.lastRunAt ? formatWaktu(module.lastRunAt) : 'Belum pernah'}
        </span>
        <button
          onClick={onViewRule}
          className="text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-0.5 text-[11px] font-medium"
        >
          <Info size={11} /> Aturan Detail
        </button>
      </div>

      <div className="px-4 py-3 flex items-center gap-2">
        <button disabled={scanning} onClick={() => { onScan(module.layerPrefix); setShowFindings(true); }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg text-sm font-medium text-gray-700 disabled:opacity-50 shadow-sm">
          {scanning ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} className="text-amber-500" />}
          Scan Sekarang
        </button>
        {findings !== null && (
          <button onClick={() => setShowFindings(s => !s)} className="flex items-center gap-1 px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700">
            {showFindings ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {findings.length} temuan
          </button>
        )}
      </div>

      {showFindings && findings !== null && findings.length > 0 && (
        <div className="border-t border-black/10 bg-white/60 px-4 py-3 space-y-2">
          {findings.slice(0, 5).map(f => (
            <div key={f.id} className="flex items-center justify-between gap-2 text-xs py-0.5">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {f.isUrgent && <span className="text-red-500">⚠️</span>}
                <span className="text-gray-700 font-mono truncate">{f.layerKey}</span>
              </div>
              <span className={`px-1.5 py-0.5 rounded text-xs ${STATUS_BADGE[f.status]}`}>{STATUS_LABEL[f.status]}</span>
            </div>
          ))}
          {findings.length > 5 && <p className="text-xs text-gray-400 text-center">+{findings.length - 5} lainnya</p>}
        </div>
      )}
      {showFindings && findings !== null && findings.length === 0 && (
        <div className="border-t border-black/10 bg-white/60 px-4 py-3 text-xs text-gray-400 text-center">Tidak ada temuan (24 jam).</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HALAMAN UTAMA (2 TAB RESMI: DASHBOARD & PENGATURAN)
// ─────────────────────────────────────────────────────────────────────────────

export default function AiAdsCommandCenter() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'settings'>('dashboard');

  const [modules, setModules] = useState<ModuleStatus[]>([]);
  const [modulesLoading, setModulesLoading] = useState(true);
  const [scanningPrefix, setScanningPrefix] = useState<string | null>(null);
  const [scanResults, setScanResults] = useState<Record<string, AiAdsRecommendation[]>>({});

  const [queueItems, setQueueItems] = useState<AiAdsRecommendation[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [queuePage, setQueuePage] = useState(1);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueFilter, setQueueFilter] = useState<'all' | 'mutation' | 'content_review'>('all');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // State Modal Detail Aturan
  const [selectedModalRule, setSelectedModalRule] = useState<ModuleDetailRule | null>(null);

  // State Tab Pengaturan
  const [moduleConfig, setModuleConfig] = useState<Record<string, any> | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configSource, setConfigSource] = useState<'bridge' | 'default'>('default');
  const [configSaving, setConfigSaving] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);

  const QUEUE_LIMIT = 20;

  const showToast = useCallback((msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const muatModules = useCallback(async () => {
    try {
      setModulesLoading(true);
      const resp = await apiGet<{ ok: boolean; modules: ModuleStatus[] }>('/ai-ads/modules/status');
      setModules(resp.modules);
    } catch {
      showToast('Gagal memuat status modul.', false);
    } finally {
      setModulesLoading(false);
    }
  }, [showToast]);

  const scanModul = useCallback(async (layerPrefix: string) => {
    setScanningPrefix(layerPrefix);
    try {
      const resp = await apiGet<{ ok: boolean; count: number; findings: AiAdsRecommendation[] }>(`/ai-ads/module/${layerPrefix}/findings?hours=24`);
      setScanResults(prev => ({ ...prev, [layerPrefix]: resp.findings }));
      showToast(`Scan selesai: ${resp.count} temuan (24 jam)`, true);
    } catch {
      showToast('Gagal menjalankan scan modul.', false);
    } finally {
      setScanningPrefix(null);
    }
  }, [showToast]);

  const muatQueue = useCallback(async (page: number, routingType: string) => {
    try {
      setQueueLoading(true);
      let url = `/ai-ads/approval-queue?page=${page}&limit=20&status=PENDING_APPROVAL`;
      if (routingType !== 'all') url += `&routingType=${routingType}`;
      const resp = await apiGet<{ ok: boolean; page: number; total: number; items: AiAdsRecommendation[] }>(url);
      setQueueItems(resp.items);
      setQueueTotal(resp.total);
      setQueuePage(resp.page);
    } catch {
      showToast('Gagal memuat antrian approval.', false);
    } finally {
      setQueueLoading(false);
    }
  }, [showToast]);

  const handleApprove = useCallback(async (id: string, selectedOption?: number) => {
    setProcessingId(id);
    try {
      const body: any = { id };
      if (selectedOption !== undefined) body.selected_option = selectedOption;
      await apiPost('/ai-ads/approve', body);
      showToast('Rekomendasi berhasil di-approve! ✅', true);
      muatQueue(queuePage, queueFilter);
      muatModules();
    } catch (e: any) {
      showToast(`Gagal approve: ${e?.message ?? 'Error'}`, false);
    } finally {
      setProcessingId(null);
    }
  }, [queuePage, queueFilter, muatQueue, muatModules, showToast]);

  const handleReject = useCallback(async (id: string, reason: string) => {
    setProcessingId(id);
    try {
      await apiPost('/ai-ads/reject', { id, reason });
      showToast('Rekomendasi ditolak.', true);
      muatQueue(queuePage, queueFilter);
      muatModules();
    } catch (e: any) {
      showToast(`Gagal menolak: ${e?.message ?? 'Error'}`, false);
    } finally {
      setProcessingId(null);
    }
  }, [queuePage, queueFilter, muatQueue, muatModules, showToast]);

  const muatConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const resp = await apiGet<{ ok: boolean; source: 'bridge' | 'default'; config: Record<string, any> }>('/ai-ads/module-config');
      setModuleConfig(resp.config);
      setConfigSource(resp.source);
      setConfigDirty(false);
    } catch {
      showToast('Gagal memuat konfigurasi modul.', false);
    } finally {
      setConfigLoading(false);
    }
  }, [showToast]);

  const simpanConfig = useCallback(async () => {
    if (!moduleConfig) return;
    setConfigSaving(true);
    try {
      await apiPost('/ai-ads/module-config', moduleConfig);
      showToast('Konfigurasi berhasil disimpan ke VPS45 ✅', true);
      setConfigDirty(false);
    } catch (e: any) {
      showToast(`Gagal menyimpan: ${e?.message ?? 'Error'}`, false);
    } finally {
      setConfigSaving(false);
    }
  }, [moduleConfig, showToast]);

  const updateConfigField = useCallback((moduleKey: string, field: string, value: any) => {
    setModuleConfig(prev => prev ? ({
      ...prev,
      [moduleKey]: { ...(prev[moduleKey] ?? {}), [field]: value }
    }) : prev);
    setConfigDirty(true);
  }, []);

  useEffect(() => {
    muatModules();
    muatConfig();
  }, [muatModules, muatConfig]);

  useEffect(() => {
    muatQueue(1, queueFilter);
  }, [queueFilter]);

  const totalUrgent = modules.filter(m => m.hasUrgent).length;
  const totalPending = modules.reduce((s, m) => s + m.pendingApprovalCount, 0);

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ${toast.ok ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          {toast.msg}
        </div>
      )}

      {/* Modal Popup Aturan Detail */}
      <ModuleRulesModal
        rule={selectedModalRule}
        onClose={() => setSelectedModalRule(null)}
        onGoToSettings={() => setActiveTab('settings')}
      />

      {/* Header Utama */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <LayoutDashboard className="text-blue-600" size={22} />
              AI Ads Command Center
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">Monitoring & approval sistem automasi Meta Ads 24/7 (7 Modul)</p>
          </div>
          <div className="flex items-center gap-3">
            {totalUrgent > 0 && (
              <span className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-700 border border-red-200 rounded-lg text-sm font-medium">
                <AlertTriangle size={14} /> {totalUrgent} modul darurat
              </span>
            )}
            {totalPending > 0 && (
              <span className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-lg text-sm font-medium">
                <ListChecks size={14} /> {totalPending} menunggu approval
              </span>
            )}
            <button onClick={() => { muatModules(); muatQueue(queuePage, queueFilter); }} className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg">
              <RefreshCw size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Navigation: 2 TAB RESMI (Blueprint Bagian 9) */}
      <div className="bg-white border-b border-gray-200 px-6">
        <div className="max-w-6xl mx-auto flex">
          {[
            { id: 'dashboard', label: `📊 Tab Dashboard${totalPending > 0 ? ` (${totalPending})` : ''}` },
            { id: 'settings', label: `⚙️ Tab Pengaturan${configDirty ? ' *' : ''}` },
          ].map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`px-6 py-3.5 text-sm font-semibold border-b-2 transition-colors ${activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6">

        {/* ═══════════════════════════════════════════════════════════════ */}
        {/* TAB 1: DASHBOARD (Antrian Paling Atas -> Summary -> 7 Modul) */}
        {/* ═══════════════════════════════════════════════════════════════ */}
        {activeTab === 'dashboard' && (
          <div className="space-y-8">

            {/* ── 1. KARTU ANTRIAN APPROVAL (PALING ATAS) ──────────────── */}
            <section className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between gap-4 flex-wrap border-b border-gray-100 pb-4">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-gray-800 flex items-center gap-2">
                    <ListChecks className="text-blue-600" size={18} />
                    Antrian Approval
                  </h2>
                  {queueTotal > 0 && (
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-200">
                      {queueTotal} item
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
                    {[
                      { val: 'all', label: 'Semua' },
                      { val: 'mutation', label: '⚙️ Mutasi' },
                      { val: 'content_review', label: '📝 Konten' },
                    ].map(f => (
                      <button key={f.val} onClick={() => setQueueFilter(f.val as typeof queueFilter)}
                        className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${queueFilter === f.val ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <button onClick={() => muatQueue(queuePage, queueFilter)} className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg">
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>

              {queueLoading ? (
                <div className="flex items-center justify-center py-12 text-gray-400">
                  <Loader2 size={24} className="animate-spin mr-2" /> Memuat antrian approval...
                </div>
              ) : queueItems.length === 0 ? (
                <div className="text-center py-8 bg-emerald-50/50 border border-emerald-100 rounded-xl">
                  <CheckCircle2 size={36} className="mx-auto mb-2 text-emerald-500" />
                  <p className="font-semibold text-emerald-900 text-sm">Antrian Approval Bersih 🎉</p>
                  <p className="text-xs text-emerald-700 mt-0.5">Tidak ada rekomendasi mutasi atau review konten yang menunggu tindakan.</p>
                </div>
              ) : (
                <>
                  <div className="space-y-3">
                    {queueItems.map(item =>
                      item.routingType === 'content_review' ? (
                        <ContentReviewCard key={item.id} item={item} onApprove={handleApprove} onReject={handleReject} processing={processingId === item.id} />
                      ) : (
                        <MutationCard key={item.id} item={item} onApprove={handleApprove} onReject={handleReject} processing={processingId === item.id} />
                      )
                    )}
                  </div>

                  {queueTotal > QUEUE_LIMIT && (
                    <div className="flex items-center justify-center gap-3 pt-3 text-xs">
                      <button disabled={queuePage <= 1} onClick={() => muatQueue(queuePage - 1, queueFilter)} className="px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40">← Sebelumnya</button>
                      <span className="text-gray-500">Hal. {queuePage} · Total {queueTotal}</span>
                      <button disabled={queuePage * QUEUE_LIMIT >= queueTotal} onClick={() => muatQueue(queuePage + 1, queueFilter)} className="px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40">Berikutnya →</button>
                    </div>
                  )}
                </>
              )}
            </section>

            {/* ── 2. KARTU STATUS MODUL (RINGKASAN SISTEM DENGAN POPUP) ── */}
            <section>
              {modulesLoading ? (
                <div className="flex items-center justify-center py-10 text-gray-400">
                  <Loader2 size={24} className="animate-spin mr-2" /> Memuat status modul...
                </div>
              ) : (
                <ModuleStatusSummary
                  modules={modules}
                  moduleConfig={moduleConfig}
                  onSelectModuleRule={(rule) => setSelectedModalRule(rule)}
                />
              )}
            </section>

            {/* ── 3. KARTU PER MODUL (GRID 7 MODUL) ────────────────────── */}
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                  <Layers size={16} className="text-blue-600" />
                  Detail Modul Automasi (7 Modul)
                </h2>
                <button onClick={muatModules} className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1">
                  <RefreshCw size={11} /> Refresh Status
                </button>
              </div>

              {modulesLoading ? (
                <div className="flex items-center justify-center py-12 text-gray-400">
                  <Loader2 size={24} className="animate-spin mr-2" /> Memuat kartu modul...
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {modules.map(m => (
                    <ModuleCard key={m.moduleId} module={m} onScan={scanModul}
                      scanning={scanningPrefix === m.layerPrefix}
                      findings={scanResults[m.layerPrefix] ?? null}
                      onViewRule={() => {
                        const rule = MODULE_RULES_DETAIL[m.moduleId];
                        if (rule) setSelectedModalRule(rule);
                      }}
                    />
                  ))}
                </div>
              )}
            </section>

          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════ */}
        {/* TAB 2: PENGATURAN (Parameter Bagian 8 Blueprint - 7 Modul)    */}
        {/* ═══════════════════════════════════════════════════════════════ */}
        {activeTab === 'settings' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-gray-800">Parameter Modul Automasi (Bagian 8)</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {configSource === 'bridge' ? '🟢 Terhubung ke VPS45 via Bridge' : '🟡 Menampilkan nilai default (Bridge belum dikonfigurasi)'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {configDirty && (
                  <span className="text-xs text-amber-600 font-semibold">● Perubahan belum disimpan</span>
                )}
                <button onClick={muatConfig} className="px-3 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50 flex items-center gap-1">
                  <RefreshCw size={12} /> Reset
                </button>
                <button
                  disabled={!configDirty || configSaving || configSource === 'default'}
                  onClick={simpanConfig}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold disabled:opacity-40 flex items-center gap-1.5"
                >
                  {configSaving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                  Simpan ke VPS45
                </button>
              </div>
            </div>

            {configSource === 'default' && (
              <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 flex items-start gap-2.5">
                <AlertTriangle size={16} className="flex-shrink-0 text-amber-600 mt-0.5" />
                <div>
                  <p className="font-semibold">Mode Hanya-Baca (Bridge belum tersedia)</p>
                  <p className="mt-0.5">Pengaturan tersimpan lokal di browser sebagai preview parameter Bagian 8. Sinkronisasi dua arah akan aktif otomatis setelah Bridge VPS45 siap.</p>
                </div>
              </div>
            )}

            {configLoading ? (
              <div className="flex items-center justify-center py-16 text-gray-400">
                <Loader2 size={24} className="animate-spin mr-2" /> Memuat konfigurasi...
              </div>
            ) : !moduleConfig ? (
              <div className="text-center py-16 text-gray-400">Gagal memuat. <button onClick={muatConfig} className="text-blue-500 underline">Coba lagi</button></div>
            ) : (
              <div className="space-y-4">

                {/* ── Modul 7.1 ─────────────────────────────────────────── */}
                <SettingsSection title="Modul 7.1 — Tiga Aturan Budget & Badging" emoji="📉"
                  enabled={moduleConfig.module_7_1?.enabled ?? true}
                  onToggle={v => updateConfigField('module_7_1', 'enabled', v)}>
                  <SettingsRow label="Lock Period (jam)" hint="Waktu jeda setelah scale/reduce sebelum bisa diubah lagi">
                    <NumInput value={moduleConfig.module_7_1?.lock_period_hours ?? 48} onChange={v => updateConfigField('module_7_1', 'lock_period_hours', v)} min={1} max={168} suffix="jam" />
                  </SettingsRow>
                  <SettingsRow label="Reduce Soft %" hint="Persentase pengurangan budget tier lunak (ROAS 70-85%)">
                    <NumInput value={Math.round((moduleConfig.module_7_1?.reduce_soft_pct ?? 0.30) * 100)} onChange={v => updateConfigField('module_7_1', 'reduce_soft_pct', v / 100)} min={1} max={99} suffix="%" />
                  </SettingsRow>
                  <SettingsRow label="Reduce Hard %" hint="Persentase pengurangan budget tier keras (ROAS 50-70%)">
                    <NumInput value={Math.round((moduleConfig.module_7_1?.reduce_hard_pct ?? 0.50) * 100)} onChange={v => updateConfigField('module_7_1', 'reduce_hard_pct', v / 100)} min={1} max={99} suffix="%" />
                  </SettingsRow>
                  <SettingsRow label="Hard Kill CPA Multiplier" hint="Matikan adset jika CPA > N × target">
                    <NumInput value={moduleConfig.module_7_1?.hard_kill_cpa_multiplier ?? 3.0} onChange={v => updateConfigField('module_7_1', 'hard_kill_cpa_multiplier', v)} min={1} max={10} step={0.1} suffix="×" />
                  </SettingsRow>
                  <SettingsRow label="Fatigue Frequency Threshold" hint="Frekuensi minimum sebelum dianggap audiens lelah">
                    <NumInput value={moduleConfig.module_7_1?.fatigue_frequency_threshold ?? 3.5} onChange={v => updateConfigField('module_7_1', 'fatigue_frequency_threshold', v)} min={1} max={10} step={0.1} suffix="×" />
                  </SettingsRow>
                </SettingsSection>

                {/* ── Modul 7.2 ─────────────────────────────────────────── */}
                <SettingsSection title="Modul 7.2 — Shift Automation & Morning Briefing" emoji="🕘"
                  enabled={moduleConfig.module_7_2?.enabled ?? true}
                  onToggle={v => updateConfigField('module_7_2', 'enabled', v)}>
                  <SettingsRow label="Shift Pagi Early-Kill (WIB)" hint="Pembersihan adset underperforming di pagi hari">
                    <NumInput value={moduleConfig.module_7_2?.shift_morning_early_kill_hour ?? 9} onChange={v => updateConfigField('module_7_2', 'shift_morning_early_kill_hour', v)} min={0} max={23} suffix=":00" />
                  </SettingsRow>
                  <SettingsRow label="Shift Siang Mid-Day Pacing (WIB)" hint="Evaluasi pacing spend tengah hari">
                    <NumInput value={moduleConfig.module_7_2?.shift_midday_pacing_hour ?? 13} onChange={v => updateConfigField('module_7_2', 'shift_midday_pacing_hour', v)} min={0} max={23} suffix=":00" />
                  </SettingsRow>
                  <SettingsRow label="Shift Sore Golden Hour Scaling (WIB)" hint="Injeksi budget untuk adset pemenang sore hari">
                    <NumInput value={moduleConfig.module_7_2?.shift_golden_hour_scaling_hour ?? 16} onChange={v => updateConfigField('module_7_2', 'shift_golden_hour_scaling_hour', v)} min={0} max={23} suffix=":00" />
                  </SettingsRow>
                  <SettingsRow label="Morning Briefing Telegram (WIB)" hint="Jadwal pengiriman ringkasan pagi ke Telegram">
                    <NumInput value={moduleConfig.module_7_2?.morning_briefing_hour ?? 7} onChange={v => updateConfigField('module_7_2', 'morning_briefing_hour', v)} min={0} max={23} suffix=":30" />
                  </SettingsRow>
                </SettingsSection>

                {/* ── Modul 7.3 ─────────────────────────────────────────── */}
                <SettingsSection title="Modul 7.3 — Spend Anomaly & Circuit Breaker" emoji="🚨"
                  enabled={moduleConfig.module_7_3?.enabled ?? true}
                  onToggle={v => updateConfigField('module_7_3', 'enabled', v)}>
                  <SettingsRow label="Velocity Spike % Daily Budget" hint="Ambang batas spend agresif dalam window 2 jam">
                    <NumInput value={Math.round((moduleConfig.module_7_3?.velocity_spike_pct_daily_budget ?? 0.50) * 100)} onChange={v => updateConfigField('module_7_3', 'velocity_spike_pct_daily_budget', v / 100)} min={1} max={200} suffix="%" />
                  </SettingsRow>
                  <SettingsRow label="Zero-Conv Warning CPA Multiplier" hint="Peringatan jika spend > N × target CPA tanpa konversi">
                    <NumInput value={moduleConfig.module_7_3?.zero_conv_warning_cpa_multiplier ?? 1.5} onChange={v => updateConfigField('module_7_3', 'zero_conv_warning_cpa_multiplier', v)} min={1} max={5} step={0.1} suffix="×" />
                  </SettingsRow>
                  <SettingsRow label="Zero-Conv Hard Stop CPA Multiplier" hint="Hentikan adset jika spend > N × target CPA tanpa konversi">
                    <NumInput value={moduleConfig.module_7_3?.zero_conv_hard_stop_cpa_multiplier ?? 2.5} onChange={v => updateConfigField('module_7_3', 'zero_conv_hard_stop_cpa_multiplier', v)} min={1} max={10} step={0.1} suffix="×" />
                  </SettingsRow>
                  <SettingsRow label="Circuit Breaker Plafon Multiplier" hint="Pause darurat seluruh akun jika spend harian > N × plafon">
                    <NumInput value={moduleConfig.module_7_3?.circuit_breaker_plafon_multiplier ?? 1.10} onChange={v => updateConfigField('module_7_3', 'circuit_breaker_plafon_multiplier', v)} min={1} max={2} step={0.01} suffix="×" />
                  </SettingsRow>
                </SettingsSection>

                {/* ── Modul 7.4 ─────────────────────────────────────────── */}
                <SettingsSection title="Modul 7.4 — Tiga Bot Otonom Spesialis" emoji="🧠"
                  enabled={moduleConfig.module_7_4?.enabled ?? true}
                  onToggle={v => updateConfigField('module_7_4', 'enabled', v)}>
                  <SettingsRow label="CPC Surge Warning %" hint="Peringatan jika CPC melonjak lebih dari N% dari 7d average">
                    <NumInput value={Math.round((moduleConfig.module_7_4?.cpc_surge_warning_pct ?? 0.50) * 100)} onChange={v => updateConfigField('module_7_4', 'cpc_surge_warning_pct', v / 100)} min={1} max={500} suffix="%" />
                  </SettingsRow>
                  <SettingsRow label="CPC Surge Critical %" hint="Kritis jika CPC melonjak lebih dari N% dari 7d average">
                    <NumInput value={Math.round((moduleConfig.module_7_4?.cpc_surge_critical_pct ?? 1.00) * 100)} onChange={v => updateConfigField('module_7_4', 'cpc_surge_critical_pct', v / 100)} min={1} max={1000} suffix="%" />
                  </SettingsRow>
                  <SettingsRow label="Hook Diagnostician Min Impresi" hint="Batas impresi sebelum performa video dianalisis">
                    <NumInput value={moduleConfig.module_7_4?.hook_diagnostician_min_impressions ?? 1000} onChange={v => updateConfigField('module_7_4', 'hook_diagnostician_min_impressions', v)} min={100} max={10000} suffix="impresi" />
                  </SettingsRow>
                  <SettingsRow label="Hook Diagnostician CTR Threshold" hint="CTR di bawah ambang ini memicu saran angle baru">
                    <NumInput value={parseFloat(((moduleConfig.module_7_4?.hook_diagnostician_ctr_threshold ?? 0.006) * 100).toFixed(2))} onChange={v => updateConfigField('module_7_4', 'hook_diagnostician_ctr_threshold', v / 100)} min={0.01} max={5} step={0.01} suffix="%" />
                  </SettingsRow>
                  <SettingsRow label="LP Message-Match CVR Threshold" hint="CVR di bawah ambang ini memicu saran rewrite landing page">
                    <NumInput value={parseFloat(((moduleConfig.module_7_4?.lp_message_match_cvr_threshold ?? 0.008) * 100).toFixed(2))} onChange={v => updateConfigField('module_7_4', 'lp_message_match_cvr_threshold', v / 100)} min={0.01} max={10} step={0.01} suffix="%" />
                  </SettingsRow>
                </SettingsSection>

                {/* ── Modul 7.5 ─────────────────────────────────────────── */}
                <SettingsSection title="Modul 7.5 — Budget Waste & CAPI EMQ" emoji="🛡️"
                  enabled={moduleConfig.module_7_5?.enabled ?? true}
                  onToggle={v => updateConfigField('module_7_5', 'enabled', v)}>
                  <SettingsRow label="Waste Threshold % Spend 7d" hint="Kategori pemborosan jika spend > N% dari total spend 7 hari">
                    <NumInput value={Math.round((moduleConfig.module_7_5?.waste_threshold_pct_spend7d ?? 0.10) * 100)} onChange={v => updateConfigField('module_7_5', 'waste_threshold_pct_spend7d', v / 100)} min={1} max={100} suffix="%" />
                  </SettingsRow>
                  <SettingsRow label="Target EMQ Purchase" hint="Skor kualitas kecocokan data minimum untuk Purchase">
                    <NumInput value={moduleConfig.module_7_5?.emq_target_purchase ?? 9.3} onChange={v => updateConfigField('module_7_5', 'emq_target_purchase', v)} min={1} max={10} step={0.1} suffix="/10" />
                  </SettingsRow>
                  <SettingsRow label="Target EMQ Lead" hint="Skor kualitas kecocokan data minimum untuk Lead">
                    <NumInput value={moduleConfig.module_7_5?.emq_target_lead ?? 8.0} onChange={v => updateConfigField('module_7_5', 'emq_target_lead', v)} min={1} max={10} step={0.1} suffix="/10" />
                  </SettingsRow>
                  <SettingsRow label="Window Exclude Pembeli" hint="Keluarkan pembeli dalam N hari terakhir dari audiens">
                    <NumInput value={moduleConfig.module_7_5?.exclude_window_days ?? 180} onChange={v => updateConfigField('module_7_5', 'exclude_window_days', v)} min={7} max={365} suffix="hari" />
                  </SettingsRow>
                </SettingsSection>

                {/* ── Modul 7.6 ─────────────────────────────────────────── */}
                <SettingsSection title="Modul 7.6 — A/B Test Significance Engine" emoji="🧪"
                  enabled={moduleConfig.module_7_6?.enabled ?? true}
                  onToggle={v => updateConfigField('module_7_6', 'enabled', v)}>
                  <SettingsRow label="Min Klik per Varian" hint="Jumlah klik minimum per varian sebelum pengujian Z-Test">
                    <NumInput value={moduleConfig.module_7_6?.min_trials_per_variant ?? 20} onChange={v => updateConfigField('module_7_6', 'min_trials_per_variant', v)} min={5} max={500} suffix="klik" />
                  </SettingsRow>
                  <SettingsRow label="Maksimal Durasi Tes" hint="Batas hari sebelum pengujian dinyatakan selesai">
                    <NumInput value={moduleConfig.module_7_6?.max_test_days ?? 14} onChange={v => updateConfigField('module_7_6', 'max_test_days', v)} min={3} max={90} suffix="hari" />
                  </SettingsRow>
                  <SettingsRow label="Early Loser Kill CPA Multiplier" hint="Hentikan varian kalah jika spend > N × CPA tanpa konversi">
                    <NumInput value={moduleConfig.module_7_6?.early_loser_kill_cpa_multiplier ?? 2.0} onChange={v => updateConfigField('module_7_6', 'early_loser_kill_cpa_multiplier', v)} min={1} max={5} step={0.1} suffix="×" />
                  </SettingsRow>
                </SettingsSection>

                {/* ── Modul 7.7 ─────────────────────────────────────────── */}
                <SettingsSection title="Modul 7.7 — Kuota Meta API Rate Limit Guard" emoji="⚡"
                  enabled={moduleConfig.module_7_7?.enabled ?? true}
                  onToggle={v => updateConfigField('module_7_7', 'enabled', v)}>
                  <SettingsRow label="Maksimal Call per Jam" hint="Kapasitas kuota token bucket per akun Meta Ads">
                    <NumInput value={moduleConfig.module_7_7?.max_calls_per_hour ?? 180} onChange={v => updateConfigField('module_7_7', 'max_calls_per_hour', v)} min={50} max={1000} suffix="calls/jam" />
                  </SettingsRow>
                  <SettingsRow label="Cooldown Penurunan Kuota" hint="Waktu jeda pemulihan kuota panggilan API">
                    <NumInput value={moduleConfig.module_7_7?.rate_limit_cooldown_minutes ?? 15} onChange={v => updateConfigField('module_7_7', 'rate_limit_cooldown_minutes', v)} min={1} max={60} suffix="menit" />
                  </SettingsRow>
                </SettingsSection>

              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER KOMPONEN SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

interface SettingsSectionProps {
  title: string;
  emoji: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children: React.ReactNode;
}

function SettingsSection({ title, emoji, enabled, onToggle, children }: SettingsSectionProps) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`border rounded-xl overflow-hidden bg-white ${enabled ? 'border-gray-200 shadow-sm' : 'border-gray-200 opacity-60'}`}>
      <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 flex-1 text-left">
          <span className="text-base">{emoji}</span>
          <span className="text-sm font-bold text-gray-800">{title}</span>
          {open ? <ChevronUp size={14} className="text-gray-400 ml-auto" /> : <ChevronDown size={14} className="text-gray-400 ml-auto" />}
        </button>
        <button
          onClick={() => onToggle(!enabled)}
          className={`ml-4 relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${enabled ? 'bg-blue-600' : 'bg-gray-300'}`}
          role="switch" aria-checked={enabled}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`} />
        </button>
      </div>
      {open && (
        <div className="divide-y divide-gray-100 bg-white">
          {children}
        </div>
      )}
    </div>
  );
}

interface SettingsRowProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function SettingsRow({ label, hint, children }: SettingsRowProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-gray-800">{label}</p>
        {hint && <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

interface NumInputProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}

function NumInput({ value, onChange, min, max, step = 1, suffix }: NumInputProps) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={value}
        onChange={e => {
          const n = parseFloat(e.target.value);
          if (!isNaN(n)) onChange(n);
        }}
        min={min} max={max} step={step}
        className="w-24 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-right font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-200"
      />
      {suffix && <span className="text-xs text-gray-500 font-medium">{suffix}</span>}
    </div>
  );
}
