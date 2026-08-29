'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { apiGet, apiPatch, apiPost, apiUpload } from '../../../lib/api';
import {
  HelpCircle, Upload, Loader2, RefreshCw, FileText, MessageSquareQuote,
  CheckCircle, AlertTriangle, Search, Filter, PlusCircle, Check, X,
  ChevronDown, ChevronUp, ArrowUpRight, Flame, BookOpen, Layers
} from 'lucide-react';

interface NameEntry { name: string; filesSeen: number; }

interface ImportAnalysis {
  totalFiles: number;
  usableFiles: number;
  totalMessages: number;
  suggestedCsNames: string[];
  allNames: NameEntry[];
}

interface MiningSession {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  totalFiles: number;
  processedFiles: number;
  failedFiles: number;
  totalMessages: number;
  questionCount: number;
  answeredCount: number;
}

interface MinedQuestion {
  id: string;
  question: string;
  sampleRaw: string;
  occurrences: number;
  answer: string | null;
  category: string;
  status: 'open' | 'answered' | 'dismissed' | 'published';
  vaultPath: string | null;
  coveredTitle: string | null;
  coveredScore: number | null;
  createdAt?: string;
}

const COVERED = 0.78;
const PARTIAL = 0.55;

function coverageOf(q: MinedQuestion): 'covered' | 'partial' | 'gap' {
  const s = q.coveredScore ?? 0;
  if (s >= COVERED) return 'covered';
  if (s >= PARTIAL) return 'partial';
  return 'gap';
}

const CATEGORIES = ['Semua', 'Produk', 'SOP', 'FAQ'] as const;

export default function QuestionMinerPage() {
  const [sessions, setSessions] = useState<MiningSession[]>([]);
  const [questions, setQuestions] = useState<MinedQuestion[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'gap' | 'covered'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('Semua');
  const [sortBy, setSortBy] = useState<'frequency' | 'newest' | 'alphabetical'>('frequency');

  // Upload Drawer
  const [showUpload, setShowUpload] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [csFlags, setCsFlags] = useState<Record<string, boolean>>({});
  const [starting, setStarting] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // Answering & Expanded
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [toastMsg, setToastMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const toast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMsg({ text, type });
    setTimeout(() => setToastMsg(null), 3500);
  };

  const fetchAll = useCallback(async () => {
    try {
      const [sRes, qRes] = await Promise.all([
        apiGet<any>('/question-miner/sessions'),
        apiGet<any>('/question-miner/questions'),
      ]);
      setSessions(sRes?.data?.sessions || []);
      setQuestions(qRes?.data?.questions || []);
    } catch {
      toast('Gagal memuat data', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const activeSessions = sessions.filter(s => s.status === 'running' || s.status === 'pending');
  const pendingFiles = activeSessions.reduce((sum, s) => sum + Math.max(s.totalFiles - s.processedFiles, 0), 0);

  useEffect(() => {
    const id = setInterval(() => { fetchAll(); }, pendingFiles > 0 ? 3000 : 25000);
    return () => clearInterval(id);
  }, [fetchAll, pendingFiles]);

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

  const startMining = async () => {
    if (!importFile || !analysis) return;
    const csNames = Object.entries(csFlags).filter(([, v]) => v).map(([n]) => n);
    if (csNames.length === 0) {
      toast('Tandai minimal satu nama sebagai CS dulu', 'error');
      return;
    }
    setStarting(true);
    try {
      const form = new FormData();
      form.append('file', importFile);
      form.append('csNames', JSON.stringify(csNames));
      const res = await apiUpload<any>('/question-miner/start', form);
      toast(res.message || 'Penambangan dimulai');
      setAnalysis(null);
      setImportFile(null);
      setShowUpload(false);
      fetchAll();
    } catch (err: any) {
      toast(err?.message || 'Gagal memulai penambangan', 'error');
    } finally {
      setStarting(false);
    }
  };

  const saveAnswer = async (q: MinedQuestion) => {
    const answer = drafts[q.id] ?? q.answer ?? '';
    setSavingId(q.id);
    try {
      await apiPatch(`/question-miner/questions/${q.id}`, { answer });
      setQuestions(prev => prev.map(x => x.id === q.id
        ? { ...x, answer, status: answer.trim() ? 'answered' : 'open' }
        : x));
      setDrafts(prev => { const n = { ...prev }; delete n[q.id]; return n; });
      toast('Jawaban tersimpan');
    } catch {
      toast('Gagal menyimpan jawaban', 'error');
    } finally {
      setSavingId(null);
    }
  };

  const changeCategory = async (q: MinedQuestion, category: string) => {
    setQuestions(prev => prev.map(x => x.id === q.id ? { ...x, category } : x));
    try {
      await apiPatch(`/question-miner/questions/${q.id}`, { category });
      toast(`Kategori diubah ke ${category}`);
    } catch {
      toast('Gagal mengubah kategori', 'error');
      fetchAll();
    }
  };

  const dismiss = async (q: MinedQuestion) => {
    setQuestions(prev => prev.filter(x => x.id !== q.id));
    try {
      await apiPatch(`/question-miner/questions/${q.id}`, { status: 'dismissed' });
      toast('Pertanyaan diabaikan');
    } catch {
      toast('Gagal mengabaikan pertanyaan', 'error');
      fetchAll();
    }
  };

  const publish = async () => {
    setPublishing(true);
    try {
      const res = await apiPost<any>('/question-miner/publish', {});
      toast(res.message || 'Dokumen tersusun ke Vault');
      fetchAll();
    } catch (err: any) {
      toast(err?.message || 'Gagal menyusun dokumen', 'error');
    } finally {
      setPublishing(false);
    }
  };

  const openQuestions = questions.filter(q => q.status === 'open' || q.status === 'answered');
  const totalClusters = openQuestions.length;
  const gapCount = openQuestions.filter(q => coverageOf(q) === 'gap').length;
  const coveredCount = openQuestions.filter(q => coverageOf(q) === 'covered' || coverageOf(q) === 'partial').length;
  const answeredCount = openQuestions.filter(q => q.answer && q.answer.trim()).length;

  // Filtered & Sorted Questions
  const filteredQuestions = useMemo(() => {
    return openQuestions
      .filter(q => {
        // Status filter
        const cov = coverageOf(q);
        if (statusFilter === 'gap' && cov !== 'gap') return false;
        if (statusFilter === 'covered' && cov === 'gap') return false;

        // Category filter
        if (categoryFilter !== 'Semua' && q.category !== categoryFilter) return false;

        // Search query
        if (searchQuery.trim()) {
          const qText = q.question.toLowerCase();
          const sText = (q.sampleRaw || '').toLowerCase();
          const query = searchQuery.toLowerCase();
          return qText.includes(query) || sText.includes(query);
        }

        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'frequency') return b.occurrences - a.occurrences;
        if (sortBy === 'alphabetical') return a.question.localeCompare(b.question);
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
  }, [openQuestions, statusFilter, categoryFilter, searchQuery, sortBy]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-80">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      {/* Toast Notification */}
      {toastMsg && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-xl text-white text-sm font-medium flex items-center gap-2 animate-in fade-in slide-in-from-top-2 ${
          toastMsg.type === 'success' ? 'bg-emerald-600' : 'bg-rose-600'
        }`}>
          {toastMsg.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {toastMsg.text}
        </div>
      )}

      {/* HEADER UTAMA */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-indigo-50 border border-indigo-100 rounded-2xl">
            <HelpCircle className="w-7 h-7 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Klaster Pertanyaan Unik Pelanggan</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Peta pertanyaan nyata pembeli yang diekstrak & di-cluster semantik dari chat CS untuk melengkapi SOP bot Sentinel.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowUpload(!showUpload)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 shadow-sm transition-colors"
          >
            <Upload className="w-3.5 h-3.5 text-indigo-600" />
            {showUpload ? 'Tutup Unggahan' : 'Unggah Ekspor Chat'}
          </button>
          <button
            onClick={fetchAll}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 shadow-sm transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5 text-gray-500" />
            Segarkan
          </button>
          {answeredCount > 0 && (
            <button
              onClick={publish}
              disabled={publishing}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-sm disabled:opacity-60 transition-colors"
            >
              {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
              Terbitkan {answeredCount} Jawaban ke Vault
            </button>
          )}
        </div>
      </div>

      {/* 4 KARTU METRIK CEPAT */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
          <div className="flex items-center justify-between text-gray-400">
            <span className="text-xs font-medium">Total Klaster Unik</span>
            <Layers className="w-4 h-4 text-indigo-500" />
          </div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{totalClusters}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">Topik pertanyaan terpisah</div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-rose-200 shadow-sm bg-rose-50/20">
          <div className="flex items-center justify-between text-rose-500">
            <span className="text-xs font-medium">Butuh SOP (Gap)</span>
            <AlertTriangle className="w-4 h-4 text-rose-500" />
          </div>
          <div className="text-2xl font-bold text-rose-600 mt-1">{gapCount}</div>
          <div className="text-[11px] text-rose-700 mt-0.5">Belum ada dokumen di RAG</div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-emerald-200 shadow-sm bg-emerald-50/20">
          <div className="flex items-center justify-between text-emerald-600">
            <span className="text-xs font-medium">Sudah Terjawab di SOP</span>
            <CheckCircle className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="text-2xl font-bold text-emerald-700 mt-1">{coveredCount}</div>
          <div className="text-[11px] text-emerald-700 mt-0.5">Tercakup di Pustaka Vault</div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-indigo-200 shadow-sm bg-indigo-50/20">
          <div className="flex items-center justify-between text-indigo-600">
            <span className="text-xs font-medium">Jawaban Tersimpan</span>
            <BookOpen className="w-4 h-4 text-indigo-600" />
          </div>
          <div className="text-2xl font-bold text-indigo-700 mt-1">{answeredCount}</div>
          <div className="text-[11px] text-indigo-700 mt-0.5">Siap disusun jadi SOP</div>
        </div>
      </div>

      {/* DRAWER UNGGAH EKSPOR CHAT (JIKA DIBUKA) */}
      {showUpload && (
        <div className="bg-white p-6 rounded-2xl border-2 border-dashed border-indigo-200 shadow-sm space-y-4 animate-in fade-in">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-gray-900 flex items-center gap-2">
                <Upload className="w-4 h-4 text-indigo-600" />
                Unggah File Ekspor Chat WhatsApp (.zip)
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Pilih file zip ekspor chat WhatsApp untuk menambang pertanyaan pembeli dan menghitung frekuensinya secara otomatis.
              </p>
            </div>
            <button onClick={() => setShowUpload(false)} className="text-gray-400 hover:text-gray-600">
              <X className="w-4 h-4" />
            </button>
          </div>

          {!analysis ? (
            <label className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-gray-200 rounded-xl hover:bg-gray-50/80 cursor-pointer transition-colors">
              {analyzing ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
                  <span className="text-xs font-semibold text-gray-700">Menganalisis file chat...</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-center">
                  <Upload className="w-8 h-8 text-indigo-500" />
                  <span className="text-sm font-semibold text-gray-800">Klik untuk memilih file zip ekspor chat</span>
                  <span className="text-xs text-gray-400">Format .zip (maksimal 50 MB, tanpa media)</span>
                </div>
              )}
              <input
                type="file" accept=".zip" className="hidden" disabled={analyzing}
                onChange={e => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) analyzeImport(f);
                }}
              />
            </label>
          ) : (
            <div className="p-4 bg-indigo-50/50 rounded-xl border border-indigo-100 space-y-3">
              <div className="text-xs font-bold text-gray-800">
                Terdeteksi {analysis.usableFiles} file chat ({analysis.totalMessages} pesan). Tandai nama CS:
              </div>
              <div className="flex flex-wrap gap-2">
                {analysis.allNames.map(n => (
                  <button
                    key={n.name}
                    type="button"
                    onClick={() => setCsFlags(prev => ({ ...prev, [n.name]: !prev[n.name] }))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                      csFlags[n.name]
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                        : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {csFlags[n.name] ? '✓ ' : ''}{n.name} ({n.filesSeen} chat)
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={startMining}
                  disabled={starting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg shadow-sm disabled:opacity-60"
                >
                  {starting ? 'Memulai penambangan...' : 'Mulai Ekstraksi Pertanyaan'}
                </button>
                <button
                  onClick={() => { setAnalysis(null); setImportFile(null); }}
                  className="px-3 py-2 text-xs font-semibold text-gray-600 hover:text-gray-900"
                >
                  Batal
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* FILTER & PENCARIAN */}
      <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          {/* Search Bar */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Cari pertanyaan atau kalimat pembeli (misal: cod, ongkir, rekening)..."
              className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-200 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Sort Dropdown */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 whitespace-nowrap">Urutkan:</span>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as any)}
              className="px-3 py-2 rounded-lg border border-gray-200 text-xs bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="frequency">🔥 Frekuensi Tertinggi</option>
              <option value="newest">🕒 Terbaru Masuk</option>
              <option value="alphabetical">🔤 Abjad (A-Z)</option>
            </select>
          </div>
        </div>

        {/* Tab Filters */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-gray-100">
          {/* Status Tabs */}
          <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-lg">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                statusFilter === 'all' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Semua ({totalClusters})
            </button>
            <button
              onClick={() => setStatusFilter('gap')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                statusFilter === 'gap' ? 'bg-rose-600 text-white shadow-sm' : 'text-rose-600 hover:bg-rose-50'
              }`}
            >
              Butuh SOP ({gapCount})
            </button>
            <button
              onClick={() => setStatusFilter('covered')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                statusFilter === 'covered' ? 'bg-emerald-600 text-white shadow-sm' : 'text-emerald-700 hover:bg-emerald-50'
              }`}
            >
              Sudah Terjawab ({coveredCount})
            </button>
          </div>

          {/* Category Tabs */}
          <div className="flex items-center gap-1">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors ${
                  categoryFilter === cat
                    ? 'bg-indigo-50 text-indigo-700 font-bold border border-indigo-200'
                    : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* LIST KLASTER PERTANYAAN */}
      <div className="space-y-3">
        {filteredQuestions.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-2xl border border-gray-200 shadow-sm">
            <HelpCircle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="font-semibold text-gray-700">Tidak ada pertanyaan yang cocok</p>
            <p className="text-xs text-gray-400 mt-1">
              Coba sesuaikan kata kunci pencarian atau tab filter di atas.
            </p>
          </div>
        ) : (
          filteredQuestions.map((q, idx) => {
            const draft = drafts[q.id];
            const value = draft ?? q.answer ?? '';
            const dirty = draft !== undefined && draft !== (q.answer ?? '');
            const cov = coverageOf(q);
            const isExpanded = expanded[q.id] || Boolean(q.answer && q.answer.trim());

            return (
              <div
                key={q.id}
                className={`bg-white rounded-xl border transition-all ${
                  cov === 'gap' ? 'border-gray-200 hover:border-indigo-300' : 'border-emerald-200/80 bg-emerald-50/5'
                } p-5 shadow-sm space-y-3`}
              >
                {/* Baris Atas: Nomor, Pertanyaan, Badge, dan Aksi */}
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-extrabold text-indigo-600 text-xs bg-indigo-50 px-2 py-0.5 rounded-md">
                        #{idx + 1}
                      </span>
                      <h3 className="font-bold text-gray-900 text-base">
                        {q.question}
                      </h3>
                      <span className="text-[11px] px-2 py-0.5 rounded-md font-semibold bg-gray-100 text-gray-700">
                        {q.category}
                      </span>
                      <span className="text-[11px] px-2.5 py-0.5 rounded-full font-bold bg-orange-100 text-orange-800 flex items-center gap-1">
                        <Flame className="w-3 h-3 fill-orange-500 text-orange-500" />
                        {q.occurrences}x ditanyakan
                      </span>
                    </div>

                    {/* Sampel ucapan asli */}
                    <div className="text-xs text-gray-500 italic bg-gray-50 p-2.5 rounded-lg border border-gray-100 flex items-start gap-2">
                      <MessageSquareQuote className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                      <span>
                        <strong className="font-semibold not-italic text-gray-700">Contoh ucapan pembeli: </strong>
                        &ldquo;{q.sampleRaw || q.question}&rdquo;
                      </span>
                    </div>
                  </div>

                  {/* Indikator Status & Tombol Aksi */}
                  <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
                    {cov === 'gap' ? (
                      <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 text-rose-500" />
                        Butuh SOP
                      </span>
                    ) : (
                      <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
                        <CheckCircle className="w-3 h-3 text-emerald-600" />
                        Terjawab di SOP
                      </span>
                    )}

                    {/* Tombol Buat SOP ke Knowledge */}
                    <Link
                      href={`/app/knowledge?create=true&category=${q.category}&title=${encodeURIComponent(q.question)}`}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 inline-flex items-center gap-1 transition-colors"
                    >
                      <BookOpen className="w-3.5 h-3.5" />
                      Buat SOP
                    </Link>

                    {/* Tombol Toggle Jawab Singkat */}
                    <button
                      onClick={() => setExpanded(prev => ({ ...prev, [q.id]: !prev[q.id] }))}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-100 hover:bg-gray-200 text-gray-700 inline-flex items-center gap-1 transition-colors"
                    >
                      {isExpanded ? 'Tutup Jawaban' : 'Tulis Jawaban'}
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>

                    {/* Tombol Abaikan */}
                    <button
                      onClick={() => dismiss(q)}
                      title="Abaikan pertanyaan ini"
                      className="p-1.5 text-gray-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Keterangan dokumen penutup (jika ada kemiripan di RAG) */}
                {q.coveredTitle && (
                  <div className="text-xs text-gray-600 bg-emerald-50/50 border border-emerald-100 rounded-lg p-2.5 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                      <span>
                        Dokumen RAG paling mirip: <strong>{q.coveredTitle}</strong>
                      </span>
                    </div>
                    {q.coveredScore !== null && (
                      <span className="text-[11px] text-emerald-700 font-bold bg-emerald-100/70 px-2 py-0.5 rounded-md">
                        Kemiripan: {Math.round(q.coveredScore * 100)}%
                      </span>
                    )}
                  </div>
                )}

                {/* Kotak Jawaban Singkat Inline (Jika Dibuka) */}
                {isExpanded && (
                  <div className="pt-2 border-t border-gray-100 space-y-2">
                    <label className="text-xs font-semibold text-gray-700">
                      Jawaban Resmi untuk Pertanyaan Ini:
                    </label>
                    <textarea
                      rows={3}
                      value={value}
                      placeholder="Ketik jawaban baku yang akan dijadikan rujukan bot Sentinel..."
                      onChange={e => setDrafts(prev => ({ ...prev, [q.id]: e.target.value }))}
                      className="w-full p-3 rounded-lg border border-gray-200 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-sans"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400">Ubah Kategori:</span>
                        {['Produk', 'SOP', 'FAQ'].map(cat => (
                          <button
                            key={cat}
                            type="button"
                            onClick={() => changeCategory(q, cat)}
                            className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                              q.category === cat
                                ? 'bg-indigo-600 text-white border-indigo-600'
                                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                            }`}
                          >
                            {cat}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        {dirty && (
                          <button
                            onClick={() => setDrafts(prev => { const n = { ...prev }; delete n[q.id]; return n; })}
                            className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-800"
                          >
                            Batal
                          </button>
                        )}
                        <button
                          onClick={() => saveAnswer(q)}
                          disabled={savingId === q.id || !dirty}
                          className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold disabled:opacity-50 inline-flex items-center gap-1.5 transition-colors"
                        >
                          {savingId === q.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                          Simpan Jawaban
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
