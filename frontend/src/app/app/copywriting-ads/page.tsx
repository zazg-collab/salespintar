'use client';

import React, { useEffect, useState } from 'react';
import {
  PenSquare,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  ShieldAlert,
  Sparkles,
  Quote,
  Link2,
  Flame,
  RefreshCw,
  Check,
  X as XIcon,
  Clock,
} from 'lucide-react';
import { apiPost, apiGet, apiPatch } from '../../../lib/api';

// ══════════════════════════════════════════════════════════════════════════
// Tipe hasil -- HARUS sinkron dengan Pydantic schema di metaguard_service/copywriting.py
// (CopywritingCheckResult / CopywritingGenerateResult), diteruskan apa adanya oleh Node proxy
// (backend/src/routes/copywriting.routes.ts). Lihat blueprint
// 20260826-blueprint-videoguard-media-analysis-copywriting.md Bagian 5.
// ══════════════════════════════════════════════════════════════════════════

type Platform = 'Meta' | 'TikTok' | 'Umum';
type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

interface CopyFlag {
  quoted_phrase: string;
  platform: Platform;
  severity: RiskLevel;
  reason: string;
  reference: string;
  safe_rewrite: string;
}

interface CopywritingCheckResult {
  overall_verdict: 'AMAN' | 'PERLU_REVISI' | 'BERISIKO_TINGGI';
  summary: string;
  flags: CopyFlag[];
  safe_rewrite_headline?: string | null;
  safe_rewrite_primary_text?: string | null;
  disclaimer: string;
}

interface AdCopyVariant {
  angle: string;
  platform: 'Meta' | 'TikTok';
  headline: string;
  primary_text: string;
  cta_suggestion: string;
  audience_idea: string;
  disapproval_risk: RiskLevel;
  risk_note?: string | null;
}

interface CopywritingGenerateResult {
  product_or_keyword: string;
  variants: AdCopyVariant[];
  grounding_note: string;
  disclaimer: string;
}

// ══════════════════════════════════════════════════════════════════════════
// Tipe hasil "LP Matcher & Hook Generator" (Chunk (g) bagian 2, Fase 4, 2026-08-28) -- HARUS
// sinkron dgn model Prisma LandingPageAuditRecord/AdFatigueRecord (backend/prisma/schema.prisma)
// yang diisi landing_page_sentinel.py/ad_fatigue_radar.py (VPS45) lewat /automation-sync/findings.
// Field Decimal Prisma (loadTimeSeconds/frequency7d/ctrDecayPct/cpmCreepPct) serialize sbg STRING
// di JSON (perilaku default decimal.js) -- makanya tipenya string di sini, bukan number.
// ══════════════════════════════════════════════════════════════════════════

type DropoffRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type FatigueSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

interface LandingPageAuditItem {
  id: string;
  adId: string;
  landingPageUrl: string;
  messageMatchScore: number;
  loadTimeSeconds: string;
  httpStatus: number;
  dropoffRisk: DropoffRisk;
  rewriteH1?: string | null;
  rewriteSubhead?: string | null;
  rewriteBullets?: string[] | null;
  rewriteCta?: string | null;
  createdAt: string;
}

interface AdFatigueItem {
  id: string;
  adAccountId: string;
  campaignId: string;
  adSetId: string;
  adId: string;
  adName: string;
  frequency7d: string;
  ctrDecayPct: string;
  cpmCreepPct: string;
  fatigueSeverity: FatigueSeverity;
  status: 'DETECTED' | 'REFRESHED' | 'DISMISSED';
  createdAt: string;
}

/** Prefill dikirim dari kartu fatigue -> tab Generate Ads, biar user tinggal klik "Generate" lagi
 *  di sana tanpa perlu ngetik ulang konteksnya. */
interface GeneratePrefill {
  productOrKeyword: string;
  extraContext: string;
}

// ══════════════════════════════════════════════════════════════════════════
// Badge helpers
// ══════════════════════════════════════════════════════════════════════════

function VerdictBadge({ verdict }: { verdict: CopywritingCheckResult['overall_verdict'] }) {
  const config = {
    AMAN: { icon: ShieldCheck, className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    PERLU_REVISI: { icon: AlertTriangle, className: 'bg-amber-50 text-amber-700 border-amber-200' },
    BERISIKO_TINGGI: { icon: ShieldAlert, className: 'bg-rose-50 text-rose-700 border-rose-200' },
  }[verdict];
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold border ${config.className}`}>
      <Icon className="w-4 h-4" />
      {verdict.replace('_', ' ')}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: RiskLevel }) {
  const className = {
    LOW: 'bg-gray-100 text-gray-600',
    MEDIUM: 'bg-amber-100 text-amber-700',
    HIGH: 'bg-rose-100 text-rose-700',
  }[severity];
  return <span className={`px-2 py-0.5 rounded text-xs font-semibold ${className}`}>{severity}</span>;
}

function PlatformBadge({ platform }: { platform: string }) {
  const className = platform === 'Meta'
    ? 'bg-indigo-100 text-indigo-700'
    : platform === 'TikTok'
      ? 'bg-slate-800 text-white'
      : 'bg-gray-100 text-gray-600';
  return <span className={`px-2 py-0.5 rounded text-xs font-semibold ${className}`}>{platform}</span>;
}

// Beda dari `SeverityBadge` (cuma LOW/MEDIUM/HIGH, dipakai Check/Generate Ads) -- dropoff risk &
// fatigue severity punya level CRITICAL juga, jadi badge terpisah biar `SeverityBadge`/`RiskLevel`
// yang sudah ada (dan tipenya dipakai di banyak tempat lain di file ini) tidak perlu diubah.
function FourLevelRiskBadge({ level }: { level: DropoffRisk | FatigueSeverity }) {
  const className = {
    LOW: 'bg-gray-100 text-gray-600',
    MEDIUM: 'bg-amber-100 text-amber-700',
    HIGH: 'bg-orange-100 text-orange-700',
    CRITICAL: 'bg-rose-100 text-rose-700',
  }[level];
  return <span className={`px-2 py-0.5 rounded text-xs font-semibold ${className}`}>{level}</span>;
}

function DisclaimerFooter({ text }: { text: string }) {
  return (
    <p className="text-xs text-gray-400 italic border-t border-gray-100 pt-3 mt-1">{text}</p>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Tab "Check Ads"
// ══════════════════════════════════════════════════════════════════════════

function CheckAdsTab() {
  const [headline, setHeadline] = useState('');
  const [primaryText, setPrimaryText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CopywritingCheckResult | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!headline.trim() && !primaryText.trim()) {
      setError('Minimal salah satu dari headline/primary text wajib diisi.');
      return;
    }

    setSubmitting(true);
    setResult(null);
    try {
      const res = await apiPost<CopywritingCheckResult>('/copywriting-ads/check', {
        headline: headline.trim() || undefined,
        primary_text: primaryText.trim() || undefined,
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message || 'Gagal mengecek copy.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm">{error}</div>}

      <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Headline</label>
          <input
            type="text"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder="mis. Turunkan Berat Badan 10kg Dalam 3 Hari!"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Primary Text</label>
          <textarea
            value={primaryText}
            onChange={(e) => setPrimaryText(e.target.value)}
            rows={5}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder="Tempel isi primary text/body copy iklan di sini..."
          />
          <p className="text-xs text-gray-400 mt-1">Isi minimal salah satu dari Headline atau Primary Text.</p>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
          {submitting ? 'Mengecek…' : 'Cek Copy Ini'}
        </button>
      </form>

      {result && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-base font-bold text-gray-900">Hasil Pemeriksaan</h2>
            <VerdictBadge verdict={result.overall_verdict} />
          </div>

          <p className="text-sm text-gray-700 leading-relaxed">{result.summary}</p>

          {result.flags.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-700">Frasa yang Ditandai ({result.flags.length})</h3>
              {result.flags.map((flag, i) => (
                <div key={i} className="border border-gray-200 rounded-xl p-4 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <PlatformBadge platform={flag.platform} />
                    <SeverityBadge severity={flag.severity} />
                    <span className="text-xs text-gray-400">{flag.reference}</span>
                  </div>
                  <blockquote className="flex items-start gap-2 bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-800 italic">
                    <Quote className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-gray-400" />
                    &ldquo;{flag.quoted_phrase}&rdquo;
                  </blockquote>
                  <p className="text-sm text-gray-600">{flag.reason}</p>
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm text-emerald-800">
                    <span className="font-semibold">Saran aman: </span>{flag.safe_rewrite}
                  </div>
                </div>
              ))}
            </div>
          )}

          {(result.safe_rewrite_headline || result.safe_rewrite_primary_text) && (
            <div className="space-y-2 bg-indigo-50 border border-indigo-200 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-indigo-800">Versi Rewrite yang Disarankan</h3>
              {result.safe_rewrite_headline && (
                <div>
                  <p className="text-xs text-indigo-500 font-medium">Headline</p>
                  <p className="text-sm text-indigo-900">{result.safe_rewrite_headline}</p>
                </div>
              )}
              {result.safe_rewrite_primary_text && (
                <div>
                  <p className="text-xs text-indigo-500 font-medium">Primary Text</p>
                  <p className="text-sm text-indigo-900 whitespace-pre-wrap">{result.safe_rewrite_primary_text}</p>
                </div>
              )}
            </div>
          )}

          <DisclaimerFooter text={result.disclaimer} />
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Tab "Generate Ads"
// ══════════════════════════════════════════════════════════════════════════

function GenerateAdsTab({ initialPrefill }: { initialPrefill?: GeneratePrefill }) {
  // [Chunk (g) bagian 2] `initialPrefill` cuma dipakai sbg SEED nilai awal -- komponen ini
  // di-remount (lihat `key` di CopywritingAdsPage) tiap kali user klik "Generate Hook Baru" dari
  // tab LP Matcher & Hook Generator, supaya state form-nya fresh per record yang diklik.
  const [productOrKeyword, setProductOrKeyword] = useState(initialPrefill?.productOrKeyword ?? '');
  const [competitorUrl, setCompetitorUrl] = useState('');
  const [extraContext, setExtraContext] = useState(initialPrefill?.extraContext ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CopywritingGenerateResult | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!productOrKeyword.trim()) {
      setError('Produk/keyword wajib diisi.');
      return;
    }

    setSubmitting(true);
    setResult(null);
    try {
      const res = await apiPost<CopywritingGenerateResult>('/copywriting-ads/generate', {
        product_or_keyword: productOrKeyword.trim(),
        competitor_url: competitorUrl.trim() || undefined,
        extra_context: extraContext.trim() || undefined,
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message || 'Gagal membuat variasi copy.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {initialPrefill && (
        <div className="bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-xl px-4 py-3 text-sm flex items-center gap-2">
          <Flame className="w-4 h-4 flex-shrink-0" />
          Form ini sudah diisi otomatis dari ad yang fatigue di tab &ldquo;LP Matcher &amp; Hook Generator&rdquo; -- boleh diedit dulu sebelum generate.
        </div>
      )}
      {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm">{error}</div>}

      <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Produk / Keyword *</label>
          <input
            type="text"
            value={productOrKeyword}
            onChange={(e) => setProductOrKeyword(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder="mis. Serum wajah anti-aging"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">URL Kompetitor (opsional)</label>
          <input
            type="text"
            value={competitorUrl}
            onChange={(e) => setCompetitorUrl(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder="https://…"
          />
          <p className="text-xs text-gray-400 mt-1">Kalau diisi, halaman ini akan di-scrape sebagai konteks pasar (bukan untuk ditiru).</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Konteks Tambahan (opsional)</label>
          <textarea
            value={extraContext}
            onChange={(e) => setExtraContext(e.target.value)}
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder="mis. target audience ibu muda, harga promo 99rb"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {submitting ? 'Membuat variasi…' : 'Generate Ads'}
        </button>
      </form>

      {result && (
        <div className="space-y-4">
          <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-600">
            {result.grounding_note}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {result.variants.map((v, i) => (
              <div key={i} className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-sm font-bold text-gray-900">{v.angle}</span>
                  <div className="flex items-center gap-1.5">
                    <PlatformBadge platform={v.platform} />
                    <SeverityBadge severity={v.disapproval_risk} />
                  </div>
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium">Headline</p>
                  <p className="text-sm font-semibold text-gray-900">{v.headline}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium">Primary Text</p>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{v.primary_text}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium">CTA</p>
                  <p className="text-sm text-gray-700">{v.cta_suggestion}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium">Ide Audience</p>
                  <p className="text-sm text-gray-700">{v.audience_idea}</p>
                </div>
                {v.risk_note && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
                    {v.risk_note}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-4">
            <DisclaimerFooter text={result.disclaimer} />
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Tab "LP Matcher & Hook Generator" (Chunk (g) bagian 2, Fase 4, 2026-08-28)
// ══════════════════════════════════════════════════════════════════════════

function LpHookTab({ onGenerateHook }: { onGenerateHook: (prefill: GeneratePrefill) => void }) {
  const [lpItems, setLpItems] = useState<LandingPageAuditItem[] | null>(null);
  const [lpError, setLpError] = useState<string | null>(null);
  const [lpLoading, setLpLoading] = useState(true);

  const [fatigueItems, setFatigueItems] = useState<AdFatigueItem[] | null>(null);
  const [fatigueError, setFatigueError] = useState<string | null>(null);
  const [fatigueLoading, setFatigueLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);

  async function loadLp() {
    setLpLoading(true);
    setLpError(null);
    try {
      const res = await apiGet<{ items: LandingPageAuditItem[]; count: number }>('/copywriting-ads/landing-page-audits');
      setLpItems(res.items);
    } catch (e) {
      setLpError((e as Error).message || 'Gagal memuat data LP Matcher.');
    } finally {
      setLpLoading(false);
    }
  }

  async function loadFatigue() {
    setFatigueLoading(true);
    setFatigueError(null);
    try {
      const res = await apiGet<{ items: AdFatigueItem[]; count: number }>('/copywriting-ads/hook-refresh-candidates');
      setFatigueItems(res.items);
    } catch (e) {
      setFatigueError((e as Error).message || 'Gagal memuat antrean Hook Generator.');
    } finally {
      setFatigueLoading(false);
    }
  }

  useEffect(() => {
    loadLp();
    loadFatigue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAction(item: AdFatigueItem, status: 'REFRESHED' | 'DISMISSED') {
    setActingId(item.id);
    try {
      await apiPatch(`/copywriting-ads/hook-refresh-candidates/${item.id}`, { status });
      setFatigueItems((prev) => (prev ?? []).filter((x) => x.id !== item.id));
    } catch (e) {
      setFatigueError((e as Error).message || 'Gagal update status.');
    } finally {
      setActingId(null);
    }
  }

  function handleGenerateHook(item: AdFatigueItem) {
    onGenerateHook({
      productOrKeyword: item.adName,
      extraContext: `Ad "${item.adName}" mengalami fatigue (${item.fatigueSeverity}): frequency 7 hari ${item.frequency7d}x, CTR turun ${item.ctrDecayPct}%, CPM naik ${item.cpmCreepPct}%. Butuh hook/angle baru yang segar, jangan mengulang sudut pandang yang sama dgn ad ini.`,
    });
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-900 flex items-center gap-2">
            <Link2 className="w-4 h-4 text-indigo-600" />
            LP Matcher
          </h2>
          <button onClick={loadLp} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> Muat ulang
          </button>
        </div>
        <p className="text-xs text-gray-500 -mt-2">
          Kecocokan pesan iklan vs landing page, dihitung otomatis oleh Landing Page Sentinel (VPS45).
        </p>

        {lpError && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm">{lpError}</div>}
        {lpLoading ? (
          <div className="text-sm text-gray-400 flex items-center gap-2 py-6 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Memuat…</div>
        ) : !lpItems || lpItems.length === 0 ? (
          <div className="text-sm text-gray-400 text-center py-6 bg-gray-50 rounded-xl border border-gray-100">Belum ada data audit landing page.</div>
        ) : (
          <div className="space-y-3">
            {lpItems.map((item) => (
              <div key={item.id} className="bg-white rounded-2xl border border-gray-200 p-4 space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-xs font-mono text-gray-500 truncate max-w-[220px]" title={item.landingPageUrl}>{item.landingPageUrl}</span>
                  <div className="flex items-center gap-1.5">
                    <FourLevelRiskBadge level={item.dropoffRisk} />
                    <span className="text-xs text-gray-400">Match {item.messageMatchScore}/10</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-400">
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {item.loadTimeSeconds}s</span>
                  <span>HTTP {item.httpStatus}</span>
                </div>
                {(item.rewriteH1 || item.rewriteSubhead || item.rewriteCta) && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm text-emerald-800 space-y-1">
                    {item.rewriteH1 && <p><span className="font-semibold">H1: </span>{item.rewriteH1}</p>}
                    {item.rewriteSubhead && <p><span className="font-semibold">Subhead: </span>{item.rewriteSubhead}</p>}
                    {item.rewriteCta && <p><span className="font-semibold">CTA: </span>{item.rewriteCta}</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-900 flex items-center gap-2">
            <Flame className="w-4 h-4 text-rose-600" />
            Hook Generator — Antrean Fatigue
          </h2>
          <button onClick={loadFatigue} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> Muat ulang
          </button>
        </div>
        <p className="text-xs text-gray-500 -mt-2">
          Ad yang frequency/CTR/CPM-nya sudah menandakan fatigue, dideteksi Ad Fatigue Radar (VPS45).
          Klik &ldquo;Generate Hook Baru&rdquo; utk lompat ke tab Generate Ads dgn konteks sudah terisi.
        </p>

        {fatigueError && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm">{fatigueError}</div>}
        {fatigueLoading ? (
          <div className="text-sm text-gray-400 flex items-center gap-2 py-6 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Memuat…</div>
        ) : !fatigueItems || fatigueItems.length === 0 ? (
          <div className="text-sm text-gray-400 text-center py-6 bg-gray-50 rounded-xl border border-gray-100">Tidak ada ad yang fatigue saat ini.</div>
        ) : (
          <div className="space-y-3">
            {fatigueItems.map((item) => (
              <div key={item.id} className="bg-white rounded-2xl border border-gray-200 p-4 space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-sm font-semibold text-gray-900 truncate max-w-[220px]" title={item.adName}>{item.adName}</span>
                  <FourLevelRiskBadge level={item.fatigueSeverity} />
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <span>Frequency {item.frequency7d}x/7d</span>
                  <span>CTR ↓{item.ctrDecayPct}%</span>
                  <span>CPM ↑{item.cpmCreepPct}%</span>
                </div>
                <div className="flex items-center gap-2 pt-1 flex-wrap">
                  <button
                    onClick={() => handleGenerateHook(item)}
                    className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5" /> Generate Hook Baru
                  </button>
                  <button
                    disabled={actingId === item.id}
                    onClick={() => handleAction(item, 'REFRESHED')}
                    className="flex items-center gap-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" /> Tandai Selesai
                  </button>
                  <button
                    disabled={actingId === item.id}
                    onClick={() => handleAction(item, 'DISMISSED')}
                    className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-500 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    <XIcon className="w-3.5 h-3.5" /> Abaikan
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Halaman utama -- 3 tab (2 lama dari blueprint Bagian 5.1 + 1 baru Chunk (g) bagian 2)
// ══════════════════════════════════════════════════════════════════════════

export default function CopywritingAdsPage() {
  const [activeTab, setActiveTab] = useState<'check' | 'generate' | 'lp-hook'>('check');
  const [generatePrefill, setGeneratePrefill] = useState<GeneratePrefill | null>(null);
  // Dipakai sbg React `key` utk GenerateAdsTab -- tiap prefill baru (klik "Generate Hook Baru"
  // dari record fatigue yang beda) harus bikin komponen itu REMOUNT dgn state form fresh, bukan
  // numpuk di atas state form yang sebelumnya mungkin sudah user edit.
  const [prefillNonce, setPrefillNonce] = useState(0);

  function handleGenerateHook(prefill: GeneratePrefill) {
    setGeneratePrefill(prefill);
    setPrefillNonce((n) => n + 1);
    setActiveTab('generate');
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg md:text-xl font-bold text-gray-900 flex items-center gap-2">
          <PenSquare className="w-5 h-5 text-fuchsia-600" />
          Copywriting Ads
        </h1>
        <p className="text-xs text-gray-500 mt-1">
          Cek copy iklan terhadap kebijakan Meta/TikTok &amp; risiko regulasi Indonesia, bikin
          variasi copy baru dari keyword/produk, atau pantau kecocokan landing page &amp; ad yang
          butuh hook baru.
        </p>
      </div>

      <div className="flex gap-2 border-b border-gray-200 flex-wrap">
        <button
          onClick={() => setActiveTab('check')}
          className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
            activeTab === 'check'
              ? 'border-indigo-600 text-indigo-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Check Ads
        </button>
        <button
          onClick={() => setActiveTab('generate')}
          className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
            activeTab === 'generate'
              ? 'border-indigo-600 text-indigo-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Generate Ads
        </button>
        <button
          onClick={() => setActiveTab('lp-hook')}
          className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
            activeTab === 'lp-hook'
              ? 'border-indigo-600 text-indigo-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          LP Matcher &amp; Hook Generator
        </button>
      </div>

      {activeTab === 'check' && <CheckAdsTab />}
      {activeTab === 'generate' && (
        <GenerateAdsTab key={prefillNonce} initialPrefill={generatePrefill ?? undefined} />
      )}
      {activeTab === 'lp-hook' && <LpHookTab onGenerateHook={handleGenerateHook} />}
    </div>
  );
}
