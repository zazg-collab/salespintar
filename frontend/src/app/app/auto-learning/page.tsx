'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiPatch, apiDelete, apiUpload } from '../../../lib/api';
import { formatWibDateTime } from '../../../lib/date';
import {
  Brain, ToggleLeft, ToggleRight, CheckCircle, XCircle,
  Clock, Loader2, Eye, RefreshCw, AlertTriangle, Sparkles,
  FileText, Tag, Calendar, ChevronRight, Upload, Users, Download,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Draft {
  filename: string;
  title: string;
  category: 'Produk' | 'SOP' | 'FAQ';
  minedAt: string | null;
  conversationId: string | null;
  sizeBytes: number;
  /** Diisi kalau dokumen ini ditahan Lapis 2.5, bukan sekadar ikut setelan mode. */
  reviewReason: string | null;
  preview: string;
}

/** Kode alasan dari backend → kalimat yang bisa dibaca orang. */
const REVIEW_REASON_LABELS: Record<string, string> = {
  klaim_harga: 'menyebut harga',
  klaim_stok: 'mengklaim stok',
  klaim_timeline: 'menjanjikan waktu',
  klaim_komitmen: 'memberi jaminan',
  minim_fakta: 'minim fakta spesifik',
};

interface StatusData {
  mode: 'auto' | 'draft';
  /** Rem penambangan otomatis. Beda dari `mode`: ini menentukan apakah mining
   *  DIJALANKAN sama sekali, sedangkan `mode` cuma mengatur hasilnya ke mana. */
  autoTrigger: boolean;
  draftCount: number;
  /** `delayed` ikut dibawa karena impor massal menjadwalkan job dengan jeda
   *  bertingkat, jadi job yang baru diantrekan duduk di set `delayed`, bukan
   *  `waiting`. Opsional supaya UI lama tidak pecah kalau backend belum di-restart. */
  queue: { waiting: number; active: number; delayed?: number; completed: number; failed: number };
  config: { minMessages: number; similarityThreshold: number; extractorModel: string };
}

// Catatan: halaman ini dulu punya helper `apiFetch` sendiri yang mengambil token
// lewat `useAuthStore()`. Store itu tidak pernah punya field `token` — token
// sebenarnya dipegang lib/api — sehingga nilainya selalu undefined, `fetchAll()`
// berhenti di penjaga `if (!token) return` sebelum blok try, dan `setLoading(false)`
// di `finally` tidak pernah jalan: spinner berputar selamanya tanpa satu pun
// permintaan terkirim. Sekarang memakai helper bersama lib/api, yang sekaligus
// membawa penanganan refresh token 401 dan base URL relatif yang sama dengan
// halaman lain (dulu halaman ini menembak http://localhost:3000 secara literal).

// ─── Impor chat lama ──────────────────────────────────────────────────────────
interface NameEntry {
  name: string;
  /** Di berapa file nama ini muncul — dasar rekomendasi, bukan keputusan. */
  filesSeen: number;
}

interface ImportAnalysis {
  totalFiles: number;
  usableFiles: number;
  totalMessages: number;
  /** Rekomendasi sistem. SELALU perlu dikonfirmasi manusia sebelum diproses. */
  suggestedCsNames: string[];
  allNames: NameEntry[];
  files: { filename: string; participants: string[]; messageCount: number }[];
}

// ─── Category badge ───────────────────────────────────────────────────────────
const CATEGORY_COLORS: Record<string, string> = {
  Produk: 'bg-blue-100 text-blue-700',
  SOP: 'bg-purple-100 text-purple-700',
  FAQ: 'bg-green-100 text-green-700',
};

export default function AutoLearningPage() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [modeLoading, setModeLoading] = useState(false);
  const [triggerLoading, setTriggerLoading] = useState(false);
  /** Penanda satu gelombang impor, supaya progresnya bisa ditampilkan pasti
   *  (X dari Y) dan bukan sekadar spinner. `startedAt` jadi masa tenggang:
   *  tepat sesudah pengantrean, antrean masih terbaca 0 selama sesaat — tanpa
   *  tenggang, bannernya akan langsung dibersihkan sebelum sempat terlihat. */
  const [batch, setBatch] = useState<{ total: number; startedAt: number } | null>(null);
  /** Naik tiap polling selesai. Efek pembersih batch bersandar pada ini supaya
   *  tetap berjalan walau angka antreannya kebetulan tidak berubah. */
  const [tick, setTick] = useState(0);

  // ── Impor chat lama ──
  const [importFile, setImportFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  /** name → apakah dia CS. Sengaja dimulai dari rekomendasi, tapi tetap bisa diubah semua. */
  const [csFlags, setCsFlags] = useState<Record<string, boolean>>({});
  const [processing, setProcessing] = useState(false);
  const [previewDraft, setPreviewDraft] = useState<{ filename: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null); // filename being actioned
  const [toastMsg, setToastMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const toast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMsg({ text, type });
    setTimeout(() => setToastMsg(null), 3500);
  };

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, draftsRes] = await Promise.all([
        apiGet<any>('/auto-learning/status'),
        apiGet<any>('/auto-learning/drafts'),
      ]);
      setStatus(statusRes.data);
      setDrafts(draftsRes.data.drafts);
    } catch (err: any) {
      toast('Gagal memuat data', 'error');
    } finally {
      // Wajib di `finally`, bukan di jalur sukses saja — kalau tidak, satu
      // kegagalan permintaan akan meninggalkan spinner berputar selamanya.
      setLoading(false);
      setTick(t => t + 1);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  /** Job penambangan yang belum tuntas. `delayed` ikut dijumlah — kalau tidak,
   *  impor massal terlihat seperti tidak melakukan apa-apa di detik-detik awal. */
  const pending =
    (status?.queue.waiting ?? 0) + (status?.queue.active ?? 0) + (status?.queue.delayed ?? 0);

  // Polling adaptif: rapat (3 detik) saat ada pekerjaan berjalan supaya progresnya
  // terasa hidup, longgar (15 detik) saat menganggur supaya tidak membebani server
  // dengan permintaan yang jawabannya selalu sama.
  useEffect(() => {
    const interval = pending > 0 ? 3000 : 15000;
    const id = setInterval(() => { fetchAll(); }, interval);
    return () => clearInterval(id);
  }, [fetchAll, pending]);

  // Bersihkan penanda batch begitu antreannya habis, dengan tenggang 8 detik
  // untuk menghindari salah bersih saat job pertama belum sempat terbaca.
  useEffect(() => {
    if (!batch || pending > 0) return;
    if (Date.now() - batch.startedAt < 8000) return;
    setBatch(null);
    toast(`Penambangan selesai — ${batch.total} percakapan diproses. Cek daftar draft di bawah.`);
  }, [tick, pending, batch]);

  const toggleMode = async () => {
    if (!status) return;
    setModeLoading(true);
    try {
      const newMode = status.mode === 'auto' ? 'draft' : 'auto';
      await apiPatch('/auto-learning/mode', { mode: newMode });
      setStatus(prev => prev ? { ...prev, mode: newMode } : prev);
      toast(`Mode diubah ke "${newMode === 'auto' ? 'Otomatis' : 'Draft (Manual Approve)'}"`);
    } catch {
      toast('Gagal mengubah mode', 'error');
    } finally {
      setModeLoading(false);
    }
  };

  const toggleAutoTrigger = async () => {
    if (!status) return;
    setTriggerLoading(true);
    try {
      const enabled = !status.autoTrigger;
      await apiPatch('/auto-learning/auto-trigger', { enabled });
      setStatus(prev => prev ? { ...prev, autoTrigger: enabled } : prev);
      toast(enabled
        ? 'Penambangan otomatis dinyalakan'
        : 'Penambangan otomatis dimatikan — tidak ada token Groq terpakai untuk mining');
    } catch {
      toast('Gagal mengubah penambangan otomatis', 'error');
    } finally {
      setTriggerLoading(false);
    }
  };

  // ── Langkah 1: bongkar & analisis. Belum ada token Groq terpakai. ──────────
  const analyzeImport = async (file: File) => {
    setImportFile(file);
    setAnalyzing(true);
    setAnalysis(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiUpload<any>('/chat-import/analyze', form);
      const data: ImportAnalysis = res.data;
      setAnalysis(data);
      // Rekomendasi dipakai sebagai titik awal centang — bukan keputusan akhir.
      const flags: Record<string, boolean> = {};
      for (const n of data.allNames) flags[n.name] = data.suggestedCsNames.includes(n.name);
      setCsFlags(flags);
    } catch (err: any) {
      toast(err?.message || 'Gagal membaca file zip', 'error');
      setImportFile(null);
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Langkah 2: setelah peran dikonfirmasi, barulah ditambang. ──────────────
  const processImport = async () => {
    if (!importFile || !analysis) return;
    const csNames = Object.entries(csFlags).filter(([, isCs]) => isCs).map(([name]) => name);
    if (csNames.length === 0) {
      toast('Tandai minimal satu nama sebagai CS dulu', 'error');
      return;
    }
    setProcessing(true);
    try {
      const form = new FormData();
      form.append('file', importFile);
      form.append('csNames', JSON.stringify(csNames));
      const res = await apiUpload<any>('/chat-import/process', form);
      toast(res.message || 'Percakapan diantrekan');
      const queued: number = res?.data?.queued ?? 0;
      if (queued > 0) setBatch({ total: queued, startedAt: Date.now() });
      setAnalysis(null);
      setImportFile(null);
      fetchAll();
    } catch (err: any) {
      toast(err?.message || 'Gagal memproses impor', 'error');
    } finally {
      setProcessing(false);
    }
  };

  const openPreview = async (filename: string) => {
    setPreviewLoading(true);
    try {
      const res = await apiGet<any>(`/auto-learning/drafts/${encodeURIComponent(filename)}`);
      setPreviewDraft({ filename, content: res.data.content });
    } catch {
      toast('Gagal memuat preview', 'error');
    } finally {
      setPreviewLoading(false);
    }
  };

  const approveDraft = async (filename: string, category: string) => {
    setActionLoading(filename);
    try {
      await apiPost(`/auto-learning/drafts/${encodeURIComponent(filename)}/approve`, { category });
      setDrafts(prev => prev.filter(d => d.filename !== filename));
      setPreviewDraft(null);
      toast(`✅ Draft disetujui dan dipindahkan ke ${category}/`);
      if (status) setStatus(prev => prev ? { ...prev, draftCount: prev.draftCount - 1 } : prev);
    } catch {
      toast('Gagal approve draft', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const rejectDraft = async (filename: string) => {
    setActionLoading(filename);
    try {
      await apiDelete(`/auto-learning/drafts/${encodeURIComponent(filename)}`);
      setDrafts(prev => prev.filter(d => d.filename !== filename));
      setPreviewDraft(null);
      toast('🗑️ Draft dihapus');
      if (status) setStatus(prev => prev ? { ...prev, draftCount: prev.draftCount - 1 } : prev);
    } catch {
      toast('Gagal menghapus draft', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Toast */}
      {toastMsg && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-white text-sm font-medium flex items-center gap-2 transition-all ${
          toastMsg.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toastMsg.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {toastMsg.text}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-100 rounded-xl">
            <Brain className="w-6 h-6 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Auto-Learning AI</h1>
            <p className="text-sm text-gray-500">Manajemen pengetahuan otomatis dari percakapan CS</p>
          </div>
        </div>
        <button onClick={fetchAll} className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 px-3 py-2 rounded-lg hover:bg-gray-100">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* Mode Toggle Card */}
      {status && (
        <div className={`rounded-2xl p-5 border-2 transition-colors ${
          status.mode === 'auto'
            ? 'bg-emerald-50 border-emerald-200'
            : 'bg-amber-50 border-amber-200'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-4">
              <div className={`p-3 rounded-xl ${status.mode === 'auto' ? 'bg-emerald-100' : 'bg-amber-100'}`}>
                <Sparkles className={`w-5 h-5 ${status.mode === 'auto' ? 'text-emerald-600' : 'text-amber-600'}`} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-gray-900">Mode Shadow Mining</h2>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    status.mode === 'auto' ? 'bg-emerald-200 text-emerald-700' : 'bg-amber-200 text-amber-700'
                  }`}>
                    {status.mode === 'auto' ? '⚡ OTOMATIS' : '📋 DRAFT'}
                  </span>
                </div>
                <p className="text-sm text-gray-600 mt-1">
                  {status.mode === 'auto'
                    ? 'Hasil mining langsung aktif sebagai knowledge bot — kecuali dokumen yang menyebut harga, stok, janji waktu, atau yang isinya minim fakta: itu tetap ditahan untuk diperiksa.'
                    : 'Hasil mining masuk Draft_AI, menunggu persetujuan Anda sebelum bot mempelajarinya.'}
                </p>
              </div>
            </div>
            <button
              onClick={toggleMode}
              disabled={modeLoading}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl font-medium text-sm transition-all ${
                status.mode === 'auto'
                  ? 'bg-amber-500 hover:bg-amber-600 text-white'
                  : 'bg-emerald-500 hover:bg-emerald-600 text-white'
              } disabled:opacity-60`}
            >
              {modeLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : status.mode === 'auto' ? (
                <><ToggleRight className="w-4 h-4" /> Ganti ke Draft</>
              ) : (
                <><ToggleLeft className="w-4 h-4" /> Ganti ke Otomatis</>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── Rem penambangan otomatis ────────────────────────────────────────
          Sengaja dipisah dari kartu Mode karena keduanya sering tertukar:
          "Mode" mengatur hasil mining mau langsung aktif atau menunggu approve;
          yang ini mengatur apakah mining-nya BERJALAN sama sekali. Sebelum ada
          saklar ini, setiap percakapan yang ditandai Selesai langsung memakan
          token Groq tanpa bisa direm. */}
      {status && (
        <div className={`rounded-2xl p-5 border ${
          status.autoTrigger ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-300'
        }`}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-gray-900">Penambangan Otomatis</h2>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  status.autoTrigger ? 'bg-emerald-200 text-emerald-700' : 'bg-gray-300 text-gray-700'
                }`}>
                  {status.autoTrigger ? '🟢 AKTIF' : '⏸️ MATI'}
                </span>
              </div>
              <p className="text-sm text-gray-600 mt-1">
                {status.autoTrigger
                  ? 'Setiap percakapan yang ditandai Selesai otomatis ditambang jadi pengetahuan. Memakai token Groq tiap kali.'
                  : 'Percakapan selesai tidak ditambang. Tidak ada token Groq terpakai — mining hanya jalan kalau dipicu manual.'}
              </p>
            </div>
            <button
              onClick={toggleAutoTrigger}
              disabled={triggerLoading}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl font-medium text-sm transition-all ${
                status.autoTrigger
                  ? 'bg-gray-500 hover:bg-gray-600 text-white'
                  : 'bg-emerald-500 hover:bg-emerald-600 text-white'
              } disabled:opacity-60`}
            >
              {triggerLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : status.autoTrigger ? (
                <><ToggleRight className="w-4 h-4" /> Matikan</>
              ) : (
                <><ToggleLeft className="w-4 h-4" /> Nyalakan</>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── Impor chat lama ────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl p-5 border border-gray-200">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <Download className="w-4 h-4 text-indigo-600" />
              <h2 className="font-semibold text-gray-900">Impor Chat Lama</h2>
            </div>
            <p className="text-sm text-gray-600 mt-1">
              Unggah ekspor chat WhatsApp (.zip, maks 50 MB) untuk ditambang jadi pengetahuan.
              Ekspor tanpa media — media diabaikan.
            </p>
          </div>
          <label className={`flex items-center gap-2 px-4 py-2 rounded-xl font-medium text-sm cursor-pointer transition-all ${
            analyzing ? 'bg-gray-300 text-gray-600' : 'bg-indigo-600 hover:bg-indigo-700 text-white'
          }`}>
            {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {analyzing ? 'Membaca...' : 'Pilih File Zip'}
            <input
              type="file"
              accept=".zip"
              className="hidden"
              disabled={analyzing}
              onChange={e => {
                const f = e.target.files?.[0];
                // Reset value supaya file yang sama bisa dipilih lagi setelah dibatalkan.
                e.target.value = '';
                if (f) analyzeImport(f);
              }}
            />
          </label>
        </div>
      </div>

      {/* ── Modal: tentukan siapa CS ───────────────────────────────────────────
          Sistem HANYA memberi rekomendasi (centang awal); keputusan tetap di
          tangan pengguna. Tidak ada yang diproses sebelum tombol ditekan, jadi
          salah tebak tidak pernah membakar token Groq. */}
      {analysis && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
            <div className="p-5 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-indigo-600" />
                <h3 className="font-semibold text-gray-900">Siapa tim CS Anda?</h3>
              </div>
              <p className="text-sm text-gray-600 mt-1">
                {analysis.usableFiles} file terbaca · {analysis.totalMessages} pesan.
                Tandai nama yang merupakan tim sendiri — sisanya dianggap pelanggan.
              </p>
              {analysis.suggestedCsNames.length > 0 && (
                <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-3">
                  💡 Rekomendasi sistem sudah dicentang otomatis, tapi silakan ubah sesuai kenyataan.
                </p>
              )}
            </div>

            <div className="p-5 overflow-y-auto flex-1 space-y-2">
              {analysis.allNames.map(n => (
                <label
                  key={n.name}
                  className={`flex items-center justify-between gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                    csFlags[n.name] ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{n.name}</p>
                    <p className="text-xs text-gray-500">
                      muncul di {n.filesSeen} file
                      {analysis.suggestedCsNames.includes(n.name) && ' · direkomendasikan sebagai CS'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-xs font-medium ${csFlags[n.name] ? 'text-indigo-700' : 'text-gray-400'}`}>
                      {csFlags[n.name] ? 'Tim CS' : 'Pelanggan'}
                    </span>
                    <input
                      type="checkbox"
                      checked={!!csFlags[n.name]}
                      onChange={e => setCsFlags(prev => ({ ...prev, [n.name]: e.target.checked }))}
                      className="w-4 h-4 accent-indigo-600"
                    />
                  </div>
                </label>
              ))}
            </div>

            <div className="p-5 border-t border-gray-200 flex items-center justify-end gap-3">
              <button
                onClick={() => { setAnalysis(null); setImportFile(null); }}
                disabled={processing}
                className="px-4 py-2 text-sm rounded-xl text-gray-600 hover:bg-gray-100 disabled:opacity-60"
              >
                Batal
              </button>
              <button
                onClick={processImport}
                disabled={processing}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-60"
              >
                {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {processing ? 'Mengantrekan...' : 'Mulai Tambang'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Progres penambangan ──────────────────────────────────────────────
          Muncul hanya saat benar-benar ada pekerjaan. Untuk impor, totalnya
          diketahui di muka sehingga barnya bisa pasti; untuk mining otomatis,
          totalnya tidak pernah diketahui sehingga barnya sengaja dibuat bergerak
          tanpa persentase daripada menampilkan angka karangan. */}
      {pending > 0 && (
        <div className="bg-indigo-50 border-2 border-indigo-200 rounded-2xl p-5">
          <div className="flex items-start gap-4">
            <div className="p-3 bg-indigo-100 rounded-xl flex-shrink-0">
              <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="font-semibold text-gray-900">
                {batch ? 'Menambang chat impor...' : 'Menambang percakapan...'}
              </h2>
              <p className="text-sm text-gray-600 mt-1">
                {batch
                  ? `${Math.min(Math.max(batch.total - pending, 0), batch.total)} dari ${batch.total} percakapan selesai · ${pending} menunggu giliran`
                  : `${pending} percakapan dalam antrean`}
              </p>

              <div className="mt-3 h-2 w-full bg-indigo-100 rounded-full overflow-hidden">
                {batch ? (
                  <div
                    className="h-full bg-indigo-600 rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.round(
                        (Math.min(Math.max(batch.total - pending, 0), batch.total) / batch.total) * 100,
                      )}%`,
                    }}
                  />
                ) : (
                  <div className="h-full w-1/3 bg-indigo-600 rounded-full animate-pulse" />
                )}
              </div>

              <p className="text-xs text-gray-500 mt-2">
                Tiap percakapan melewati 3 lapis filter Groq — sekitar 10–30 detik per percakapan.
                Halaman ini menyegar sendiri, aman ditinggal.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stats Row */}
      {status && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Draft Menunggu', value: status.draftCount, color: 'text-amber-600', bg: 'bg-amber-50' },
            { label: 'Antrian Mining', value: pending, color: 'text-indigo-600', bg: 'bg-indigo-50' },
            { label: 'Total Berhasil', value: status.queue.completed, color: 'text-green-600', bg: 'bg-green-50' },
            { label: 'Gagal', value: status.queue.failed, color: 'text-red-600', bg: 'bg-red-50' },
          ].map(s => (
            <div key={s.label} className={`${s.bg} rounded-xl p-4`}>
              <p className="text-xs text-gray-500 mb-1">{s.label}</p>
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Draft List */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-500" />
            Draft Menunggu Approve
            {drafts.length > 0 && (
              <span className="bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full">{drafts.length}</span>
            )}
          </h2>
        </div>

        {drafts.length === 0 ? (
          <div className="text-center py-16 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200">
            <CheckCircle className="w-12 h-12 text-green-400 mx-auto mb-3" />
            <p className="font-medium text-gray-600">Semua bersih!</p>
            <p className="text-sm text-gray-400 mt-1">
              {status?.mode === 'auto'
                ? 'Mode Otomatis aktif — hasil mining langsung masuk ke vault.'
                : 'Belum ada draft baru dari shadow mining.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {drafts.map((draft) => (
              <div key={draft.filename} className="bg-white border border-gray-200 rounded-xl p-4 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CATEGORY_COLORS[draft.category] || 'bg-gray-100 text-gray-600'}`}>
                        <Tag className="w-3 h-3 inline mr-1" />{draft.category}
                      </span>
                      {draft.reviewReason && (
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-rose-100 text-rose-700">
                          <AlertTriangle className="w-3 h-3 inline mr-1" />
                          Wajib dicek:{' '}
                          {draft.reviewReason
                            .split(',')
                            .map(r => REVIEW_REASON_LABELS[r.trim()] || r.trim())
                            .join(', ')}
                        </span>
                      )}
                      {draft.minedAt && (
                        <span className="text-xs text-gray-400 flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {formatWibDateTime(draft.minedAt)}
                        </span>
                      )}
                    </div>
                    <h3 className="font-medium text-gray-900 break-words" title={draft.title}>{draft.title}</h3>
                    <p className="text-xs text-gray-400 font-mono break-all mt-0.5">{draft.filename}</p>
                    <p className="text-sm text-gray-500 mt-1 line-clamp-2">{draft.preview}...</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => openPreview(draft.filename)}
                      disabled={previewLoading}
                      className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-100 border border-gray-200"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Preview
                    </button>
                    <button
                      onClick={() => approveDraft(draft.filename, draft.category)}
                      disabled={actionLoading === draft.filename}
                      className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-green-500 hover:bg-green-600 text-white disabled:opacity-60"
                    >
                      {actionLoading === draft.filename ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                      Setujui
                    </button>
                    <button
                      onClick={() => rejectDraft(draft.filename)}
                      disabled={actionLoading === draft.filename}
                      className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 disabled:opacity-60"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Tolak
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Config Info */}
      {status && (
        <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Konfigurasi Mining</h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-gray-500">Model Ekstraktor</p>
              <p className="font-medium font-mono text-xs text-gray-700">{status.config.extractorModel}</p>
            </div>
            <div>
              <p className="text-gray-500">Min. Pesan</p>
              <p className="font-medium">{status.config.minMessages} pesan</p>
            </div>
            <div>
              <p className="text-gray-500">Anti-Duplikat</p>
              <p className="font-medium">{(status.config.similarityThreshold * 100).toFixed(0)}% similarity</p>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-indigo-500" />
                <h3 className="font-semibold break-all" title={previewDraft.filename}>{previewDraft.filename}</h3>
              </div>
              <button onClick={() => setPreviewDraft(null)} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="flex-1 overflow-auto p-6">
              <pre className="whitespace-pre-wrap text-sm font-mono text-gray-700 bg-gray-50 rounded-xl p-4 leading-relaxed">{previewDraft.content}</pre>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t bg-gray-50 rounded-b-2xl">
              <button
                onClick={() => {
                  const draft = drafts.find(d => d.filename === previewDraft.filename);
                  if (draft) rejectDraft(draft.filename);
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-50 text-red-600 hover:bg-red-100 text-sm font-medium"
              >
                <XCircle className="w-4 h-4" /> Tolak
              </button>
              <button
                onClick={() => {
                  const draft = drafts.find(d => d.filename === previewDraft.filename);
                  if (draft) approveDraft(draft.filename, draft.category);
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-500 text-white hover:bg-green-600 text-sm font-medium"
              >
                <CheckCircle className="w-4 h-4" /> Setujui & Aktifkan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
