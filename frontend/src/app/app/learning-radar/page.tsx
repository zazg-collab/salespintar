'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { apiGet } from '../../../lib/api';
import { getJakartaTodayStr, getJakartaOffsetStr, getJakartaFirstDayOfMonthStr } from '../../../lib/date';
import {
  Brain,
  BookOpen,
  HelpCircle,
  Clock,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Sparkles,
  Layers,
  Calendar,
  MessageSquareText,
  FileText,
  Smartphone,
  Activity,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

const compactTooltipStyle = {
  backgroundColor: '#ffffff',
  borderColor: '#e5e7eb',
  borderRadius: '0.5rem',
  fontSize: '11px',
  padding: '4px 8px',
  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
};

const compactItemStyle = {
  paddingTop: '1px',
  paddingBottom: '1px',
  fontSize: '11px',
};

const compactLabelStyle = {
  fontWeight: 600,
  color: '#374151',
  marginBottom: '2px',
  fontSize: '11px',
};

export default function LearningRadarPage() {
  const [questionTab, setQuestionTab] = useState<'all' | 'uncovered' | 'covered'>('all');
  const [datePreset, setDatePreset] = useState<'today' | 'yesterday' | '7d' | '30d' | 'this_month' | 'custom'>('7d');
  const [customStart, setCustomStart] = useState(() => getJakartaOffsetStr(-6));
  const [customEnd, setCustomEnd] = useState(() => getJakartaTodayStr());

  const { startDate, endDate, dateRangeLabel } = useMemo(() => {
    const todayStr = getJakartaTodayStr();

    if (datePreset === 'today') {
      return { startDate: todayStr, endDate: todayStr, dateRangeLabel: 'Hari Ini' };
    }
    if (datePreset === 'yesterday') {
      const yesterdayStr = getJakartaOffsetStr(-1);
      return { startDate: yesterdayStr, endDate: yesterdayStr, dateRangeLabel: 'Kemarin' };
    }
    if (datePreset === '7d') {
      return { startDate: getJakartaOffsetStr(-6), endDate: todayStr, dateRangeLabel: '7 Hari Terakhir' };
    }
    if (datePreset === '30d') {
      return { startDate: getJakartaOffsetStr(-29), endDate: todayStr, dateRangeLabel: '30 Hari Terakhir' };
    }
    if (datePreset === 'this_month') {
      return { startDate: getJakartaFirstDayOfMonthStr(), endDate: todayStr, dateRangeLabel: 'Bulan Ini' };
    }
    return {
      startDate: customStart || todayStr,
      endDate: customEnd || todayStr,
      dateRangeLabel: `${customStart} s/d ${customEnd}`,
    };
  }, [datePreset, customStart, customEnd]);

  const { data: stats } = useQuery({
    queryKey: ['dashboard', 'v2', 'stats'],
    queryFn: () => apiGet<any>('/dashboard/stats'),
    refetchInterval: 15000,
  });

  const { data: hlData } = useQuery({
    queryKey: ['dashboard', 'v2', 'human-learning', startDate, endDate],
    queryFn: () => apiGet<any>(`/dashboard/human-learning?startDate=${startDate}&endDate=${endDate}`),
    refetchInterval: 20000,
  });

  const { data: fqData } = useQuery({
    queryKey: ['dashboard', 'v2', 'frequent-questions'],
    queryFn: () => apiGet<any>('/dashboard/frequent-questions?limit=5'),
    refetchInterval: 30000,
  });

  const { data: recentDrafts } = useQuery({
    queryKey: ['dashboard', 'v2', 'recent-drafts'],
    queryFn: () => apiGet<any>('/dashboard/recent-drafts'),
    refetchInterval: 30000,
  });

  const { data: kbDist } = useQuery({
    queryKey: ['dashboard', 'v2', 'knowledge-distribution'],
    queryFn: () => apiGet<any>('/dashboard/knowledge-distribution'),
    refetchInterval: 60000,
  });

  const summaryCards = [
    {
      label: 'Pustaka Terbit (Sentinel)',
      value: stats?.totalKnowledgeCount ?? 0,
      sub: 'Dokumen di Vault RAG',
      icon: BookOpen,
      color: 'text-indigo-600',
      bg: 'bg-indigo-50',
      link: '/app/knowledge',
    },
    {
      label: 'Draft Menunggu Kurasi',
      value: stats?.pendingDraftsCount ?? 0,
      sub: 'Siap dikurasi ke SOP/Produk',
      icon: Brain,
      color: (stats?.pendingDraftsCount ?? 0) > 0 ? 'text-amber-600' : 'text-gray-500',
      bg: (stats?.pendingDraftsCount ?? 0) > 0 ? 'bg-amber-50' : 'bg-gray-100',
      link: '/app/auto-learning',
      highlight: (stats?.pendingDraftsCount ?? 0) > 0,
    },
    {
      label: 'Knowledge Gap (Butuh SOP)',
      value: stats?.knowledgeGapCount ?? 0,
      sub: 'Pertanyaan belum terjawab',
      icon: HelpCircle,
      color: (stats?.knowledgeGapCount ?? 0) > 0 ? 'text-rose-600' : 'text-emerald-600',
      bg: (stats?.knowledgeGapCount ?? 0) > 0 ? 'bg-rose-50' : 'bg-emerald-50',
      link: '/app/question-miner',
      highlight: (stats?.knowledgeGapCount ?? 0) > 0,
    },
    {
      label: 'Fakta Jualan Diserap',
      value: (stats?.totalFactsSaved ?? 0).toLocaleString(),
      sub: 'Diekstrak dari CS manusia',
      icon: Sparkles,
      color: 'text-emerald-600',
      bg: 'bg-emerald-50',
      link: '/app/human-learning',
    },
    {
      label: 'Pesan Disadap & Diproses',
      value: (stats?.totalLearnedMessages ?? 0).toLocaleString(),
      sub: `${stats?.totalBuyerMessages ?? 0} buyer • ${stats?.totalCsReplies ?? 0} CS`,
      icon: MessageSquareText,
      color: 'text-blue-600',
      bg: 'bg-blue-50',
      link: '/app/human-learning',
    },
  ];

  const filteredQuestions = (fqData?.items ?? []).filter((q: any) => {
    if (questionTab === 'uncovered') return !q.isCovered;
    if (questionTab === 'covered') return q.isCovered;
    return true;
  });

  return (
    <div className="space-y-6 pb-12 max-w-7xl mx-auto">
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-gray-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-md text-xs font-bold uppercase tracking-wider bg-indigo-100 text-indigo-800">
              Fokus: AI Curator, Product Owner, SOP
            </span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2 mt-1">
            <Brain className="w-6 h-6 text-indigo-600" />
            Dashboard Knowledge & AI Radar
          </h1>
          <p className="text-sm text-gray-500">
            Pusat pemantauan penyerapan fakta CS (Shadow Mining), draf pengetahuan menunggu kurasi, question miner, dan status RAG Sentinel.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/app/auto-learning"
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            Kurasi Draft AI
          </Link>
          <Link
            href="/app/question-miner"
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors shadow-sm"
          >
            <HelpCircle className="w-4 h-4 text-indigo-600" />
            Tambang Pertanyaan
          </Link>
        </div>
      </div>

      {/* ALERT DRAFT BARU */}
      {(stats?.pendingDraftsCount ?? 0) > 0 && (
        <div className="p-4 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500 text-white flex items-center justify-center flex-shrink-0">
              <Brain className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-amber-900">
                Ada {stats?.pendingDraftsCount} Draft Pengetahuan baru hasil Shadow Mining!
              </p>
              <p className="text-xs text-amber-700">
                Fakta baru berhasil diserap dari percakapan CS dan siap dikurasi menjadi dokumen SOP atau Produk resmi.
              </p>
            </div>
          </div>
          <Link
            href="/app/auto-learning"
            className="inline-flex items-center gap-1 text-xs font-bold text-amber-900 hover:text-amber-700 px-3 py-1.5 bg-amber-200/70 rounded-lg transition-colors flex-shrink-0"
          >
            Kurasi Sekarang <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      )}

      {/* 1. TOP SUMMARY CARDS */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {summaryCards.map((card) => (
          <Link
            key={card.label}
            href={card.link}
            className={`bg-white p-4 rounded-xl border transition-all hover:shadow-md hover:border-indigo-200 group ${
              card.highlight ? 'border-amber-300 ring-2 ring-amber-100' : 'border-gray-200'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <div className={`w-9 h-9 ${card.bg} rounded-lg flex items-center justify-center`}>
                <card.icon className={`w-5 h-5 ${card.color}`} />
              </div>
              <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-indigo-600 transition-colors" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{card.value}</p>
            <p className="text-xs font-semibold text-gray-700 mt-1">{card.label}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">{card.sub}</p>
          </Link>
        ))}
      </div>

      {/* 2. RADAR PENYERAPAN FAKTA CS (SHADOW MINING ENGINE) */}
      <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-gray-100 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-indigo-600" />
              <h2 className="text-lg font-bold text-gray-900">Radar Penyerapan Fakta CS (Shadow Mining)</h2>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              Pantau alur pesan CS yang disadap, buffer dialog in-memory, dan proses ekstraksi trik jualan ke dalam draf SOP ({dateRangeLabel}).
            </p>
          </div>
          <Link
            href="/app/human-learning"
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1"
          >
            Inspektur Sesi CS <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* TABEL PIPELINE HUMAN LEARNING */}
          <div className="lg:col-span-7 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-gray-600 text-xs uppercase font-semibold">
                <tr>
                  <th className="px-3 py-2.5 rounded-l-lg">CS Sumber</th>
                  <th className="px-3 py-2.5">Pesan Disadap</th>
                  <th className="px-3 py-2.5">Buffer Aktif</th>
                  <th className="px-3 py-2.5">🚀 Buffer Terkirim</th>
                  <th className="px-3 py-2.5">💡 Fakta Diserap</th>
                  <th className="px-3 py-2.5 rounded-r-lg">📄 Draf SOP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-xs">
                {(!hlData?.sessions || hlData.sessions.length === 0) && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-gray-400">
                      Belum ada sesi CS aktif yang disadap.
                    </td>
                  </tr>
                )}
                {hlData?.sessions?.map((s: any) => (
                  <tr key={s.id} className="hover:bg-gray-50/80 transition-colors">
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-gray-900">{s.csName}</div>
                      <div className="text-[11px] text-gray-400 font-mono">{s.csPhone}</div>
                    </td>
                    <td className="px-3 py-2.5 text-gray-700">
                      <span className="font-medium">{(s.totalActivity || 0).toLocaleString()}</span>
                      <span className="text-[10px] text-gray-400 block">
                        {s.totalBuyerMessages || 0} in / {s.totalCsReplies || 0} out
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-semibold text-[11px] ${
                          (s.activeBuffers || 0) > 0
                            ? 'bg-blue-50 text-blue-700 border border-blue-200'
                            : 'bg-gray-50 text-gray-500'
                        }`}
                      >
                        📥 {s.activeBuffers || 0} kontak
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-bold text-indigo-600">
                      {s.totalPairsCaptured || 0} buffer
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-50 px-2 py-0.5 rounded-md font-semibold text-[11px]">
                        💡 {s.totalFactsSaved || 0} fakta
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1 text-violet-700 bg-violet-50 px-2 py-0.5 rounded-md font-semibold text-[11px]">
                        📄 {s.totalDocsWritten || 0} draf
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* GRAFIK PENAMBANGAN & EKSTRAKSI */}
          <div className="lg:col-span-5">
            <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-indigo-600" />
              Aktivitas Penambangan & Ekstraksi ({dateRangeLabel})
            </h3>
            <div className="bg-gray-50/70 p-3 rounded-lg border border-gray-100">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={hlData?.trends ?? []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v) => v.slice(5)} />
                  <YAxis tick={{ fontSize: 10 }} width={20} />
                  <Tooltip
                    contentStyle={compactTooltipStyle}
                    itemStyle={compactItemStyle}
                    labelStyle={compactLabelStyle}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: '11px', paddingTop: '4px' }}
                    iconSize={8}
                  />
                  <Bar dataKey="extractions" fill="#6366f1" radius={[3, 3, 0, 0]} name="Ekstraksi Fakta" />
                  <Bar dataKey="minings" fill="#10b981" radius={[3, 3, 0, 0]} name="Penyusunan Draf" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      {/* 3. ANALISIS PERTANYAAN PELANGGAN (FREQUENT QUESTIONS & GAP RADAR) */}
      <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-gray-100 pb-4">
          <div>
            <Link
              href="/app/question-miner"
              className="group inline-flex items-center gap-2 hover:opacity-90 transition-opacity"
            >
              <HelpCircle className="w-5 h-5 text-indigo-600" />
              <h2 className="text-lg font-bold text-gray-900 group-hover:text-indigo-600 transition-colors">
                Tambang Pertanyaan & Knowledge Gap (Question Miner)
              </h2>
              <ArrowRight className="w-4 h-4 text-indigo-600 group-hover:translate-x-0.5 transition-transform" />
            </Link>
            <p className="text-xs text-gray-500 mt-0.5">
              Pertanyaan yang paling sering ditanyakan pembeli dan deteksi celah pengetahuan yang belum dicakup SOP bot.
            </p>
          </div>
          <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-lg">
            <button
              onClick={() => setQuestionTab('all')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                questionTab === 'all' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Semua ({fqData?.totalQuestions ?? 0})
            </button>
            <button
              onClick={() => setQuestionTab('uncovered')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                questionTab === 'uncovered'
                  ? 'bg-rose-500 text-white shadow-sm'
                  : 'text-rose-600 hover:bg-rose-50'
              }`}
            >
              Butuh SOP ({fqData?.uncoveredCount ?? 0})
            </button>
            <button
              onClick={() => setQuestionTab('covered')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                questionTab === 'covered'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-emerald-700 hover:bg-emerald-50'
              }`}
            >
              Sudah Terjawab ({fqData?.coveredCount ?? 0})
            </button>
          </div>
        </div>

        {/* LIST PERTANYAAN */}
        <div className="divide-y divide-gray-100">
          {filteredQuestions.length === 0 && (
            <div className="py-8 text-center text-gray-400 text-sm">
              Tidak ada pertanyaan di kategori ini.
            </div>
          )}
          {filteredQuestions.map((q: any, idx: number) => (
            <div key={q.id || idx} className="py-3.5 flex items-start justify-between gap-4 hover:bg-gray-50/50 px-2 rounded-lg transition-colors">
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-indigo-600 text-sm">#{idx + 1}</span>
                  <span className="font-semibold text-gray-900 text-sm">{q.question}</span>
                  <span className="text-[11px] px-2 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">
                    {q.category}
                  </span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-bold">
                    🔥 {q.occurrences}x ditanyakan
                  </span>
                </div>
                {q.sampleRaw && (
                  <p className="text-xs text-gray-500 italic truncate max-w-2xl">
                    &quot;{q.sampleRaw}&quot;
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {q.isCovered ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Terjawab di SOP
                  </span>
                ) : (
                  <Link
                    href={`/app/question-miner?id=${q.id}`}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 px-2.5 py-1 rounded-full border border-rose-200 transition-colors"
                  >
                    <AlertCircle className="w-3.5 h-3.5" />
                    Buat SOP Sekarang
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 4. DRAFT MENUNGGU REVIEW & DISTRIBUSI PUSTAKA SENTINEL */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* DRAFT AI TERBARU */}
        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm space-y-4">
          <div className="flex items-center justify-between border-b border-gray-100 pb-3">
            <div className="flex items-center gap-2">
              <Brain className="w-5 h-5 text-amber-600" />
              <h3 className="font-bold text-gray-900">Draft Pengetahuan Siap Review (Draft_AI)</h3>
            </div>
            <Link
              href="/app/auto-learning"
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1"
            >
              Lihat Semua ({recentDrafts?.drafts?.length ?? 0}) <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {(!recentDrafts?.drafts || recentDrafts.drafts.length === 0) && (
            <p className="text-sm text-gray-400 py-6 text-center">
              Belum ada draft baru. Draft akan tersusun otomatis saat CS sedang melayani chat.
            </p>
          )}

          <div className="space-y-3">
            {recentDrafts?.drafts?.map((d: any) => (
              <div key={d.filename} className="p-3 bg-gray-50 hover:bg-amber-50/40 rounded-lg border border-gray-100 transition-colors space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm text-gray-900 truncate max-w-[280px]">
                    {d.title}
                  </span>
                  <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-indigo-100 text-indigo-700">
                    {d.category}
                  </span>
                </div>
                {d.preview && (
                  <p className="text-xs text-gray-500 line-clamp-2">{d.preview}</p>
                )}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[10px] text-gray-400">
                    Sumber: {d.source}
                  </span>
                  <Link
                    href="/app/auto-learning"
                    className="text-xs font-semibold text-amber-700 hover:underline"
                  >
                    Kurasi Draf →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* DISTRIBUSI PUSTAKA SENTINEL */}
        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm space-y-4">
          <div className="flex items-center justify-between border-b border-gray-100 pb-3">
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-indigo-600" />
              <h3 className="font-bold text-gray-900">Distribusi Pustaka Sentinel (`cs-brain`)</h3>
            </div>
            <Link
              href="/app/knowledge"
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1"
            >
              Kelola Pustaka <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <div className="space-y-4 pt-1">
            {kbDist?.categories?.map((cat: any) => (
              <div key={cat.name} className="space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-gray-700 flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: cat.color }} />
                    {cat.name}
                  </span>
                  <span className="font-bold text-gray-900">{cat.count} Dokumen</span>
                </div>
                <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min(100, Math.round((cat.count / Math.max(1, kbDist?.totalActive + kbDist?.totalDraft)) * 100))}%`,
                      backgroundColor: cat.color,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 pt-4 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
            <span>Total Pustaka Aktif: <strong>{kbDist?.totalActive ?? 0} berkas</strong></span>
            <span>Draft Menunggu: <strong>{kbDist?.totalDraft ?? 0} berkas</strong></span>
          </div>
        </div>
      </div>
    </div>
  );
}
