'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, SlidersHorizontal, Loader2, Save, CheckCircle2, KeyRound, Info, Sparkles } from 'lucide-react';
import { apiGet, apiPut } from '../../../../../lib/api';

type Provider = 'agy' | 'google' | 'openai' | 'openrouter';

interface SettingsResponse {
  provider: Provider;
  apiKeyConfigured: boolean;
  apiKeyPreview: string | null;
  model: string | null;
  usingLegacyGeminiKeyFallback: boolean;
}

const PROVIDERS: { key: Provider; label: string; defaultModel: string; keyHint: string; noApiKey?: boolean }[] = [
  {
    key: 'agy',
    label: 'Agy (default, tanpa API key)',
    defaultModel: 'Otomatis — ditentukan agy/Antigravity CLI sendiri',
    keyHint: 'Tidak butuh API key sama sekali. Pakai mekanisme yang sama dengan audit video Video Guard (sesi Google AI Pro via agy), lewat antrean/pool sendiri ("copywriting-ads") supaya tidak berebut dengan audit video atau fitur lain.',
    noApiKey: true,
  },
  {
    key: 'google',
    label: 'Google AI Studio (Gemini)',
    defaultModel: 'gemini-2.5-flash',
    keyHint: 'Kosongkan untuk pakai key Video Guard yang sudah diisi (kalau ada) — satu key Gemini bisa dipakai bersama. Perhatian: key Gemini API gratis dibatasi 20 request/hari, gunakan hanya kalau paham risikonya.',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    keyHint: 'Wajib diisi sendiri — tidak ada key bersama/fallback untuk provider ini.',
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'openai/gpt-4o-mini',
    keyHint: 'Wajib diisi sendiri. Nama model pakai format OpenRouter, mis. "openai/gpt-4o-mini" atau "anthropic/claude-3.5-sonnet".',
  },
];

export default function CopywritingAdsSettingsPage() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [provider, setProvider] = useState<Provider>('agy');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<SettingsResponse>('/copywriting-ads/settings')
      .then((res) => {
        setSettings(res);
        setProvider(res.provider);
        setModelInput(res.model ?? '');
      })
      .catch((e) => setError(e.message || 'Gagal memuat pengaturan.'));
  }, []);

  const providerMeta = PROVIDERS.find((p) => p.key === provider) ?? PROVIDERS[0];
  const isAgy = provider === 'agy';

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const body: { provider: Provider; apiKey?: string; model?: string } = { provider };
      if (!isAgy && apiKeyInput.trim()) body.apiKey = apiKeyInput.trim();
      body.model = isAgy ? '' : modelInput.trim(); // "" = hapus/pakai default provider
      await apiPut('/copywriting-ads/settings', body);
      const fresh = await apiGet<SettingsResponse>('/copywriting-ads/settings');
      setSettings(fresh);
      setProvider(fresh.provider);
      setModelInput(fresh.model ?? '');
      setApiKeyInput('');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError((e as Error).message || 'Gagal menyimpan pengaturan.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link href="/app/video-guard/copywriting-ads" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="w-4 h-4" /> Kembali ke Copywriting Ads
      </Link>

      <div>
        <h1 className="text-lg md:text-xl font-bold text-gray-900 flex items-center gap-2">
          <SlidersHorizontal className="w-6 h-6 text-fuchsia-600" /> Pengaturan Copywriting Ads
        </h1>
        <p className="text-xs text-gray-500 mt-1">
          Pilih provider LLM untuk Check Ads &amp; Generate Ads. Defaultnya adalah <strong>Agy</strong> — tidak
          butuh API key dan tidak memakai kuota Gemini API yang sama dengan audit video. Provider lain
          (Google AI Studio, OpenAI, OpenRouter) tersedia sebagai pilihan manual kalau kamu ingin pakai key
          sendiri.
        </p>
      </div>

      {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm">{error}</div>}

      {!settings && !error && (
        <div className="flex items-center gap-2 text-gray-500 text-sm py-12 justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-fuchsia-600" /> Memuat…
        </div>
      )}

      {settings && (
        <form onSubmit={handleSave} className="bg-white rounded-2xl border border-gray-200 p-6 space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Provider LLM</label>
            <div className="flex flex-wrap gap-2">
              {PROVIDERS.map((p) => (
                <button
                  type="button"
                  key={p.key}
                  onClick={() => setProvider(p.key)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                    provider === p.key ? 'bg-fuchsia-600 border-fuchsia-600 text-white' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {provider === 'google' && settings.usingLegacyGeminiKeyFallback && (
              <p className="text-xs text-indigo-600 mt-2 flex items-center gap-1">
                <Info className="w-3.5 h-3.5" /> Saat ini memakai key Gemini dari pengaturan Video Guard.
              </p>
            )}
          </div>

          {isAgy ? (
            <div className="bg-fuchsia-50 border border-fuchsia-200 rounded-xl px-4 py-3 flex items-start gap-2.5">
              <Sparkles className="w-4 h-4 text-fuchsia-600 shrink-0 mt-0.5" />
              <p className="text-xs text-fuchsia-800">
                {providerMeta.keyHint}
              </p>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                  <KeyRound className="w-4 h-4 text-fuchsia-600" /> API Key ({providerMeta.label})
                </label>
                <p className="text-xs text-gray-500 mb-2">
                  {settings.apiKeyConfigured
                    ? `Sudah diisi (${settings.apiKeyPreview}). Isi kolom di bawah untuk mengganti, kosongkan untuk menghapus.`
                    : providerMeta.keyHint}
                </p>
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={settings.apiKeyConfigured ? 'Ganti key (opsional)…' : `Masukkan ${providerMeta.label} API Key…`}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-fuchsia-500 focus:border-fuchsia-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Model (opsional)</label>
                <p className="text-xs text-gray-500 mb-2">
                  Kosongkan untuk pakai default: <code className="bg-gray-100 px-1 rounded">{providerMeta.defaultModel}</code>
                </p>
                <input
                  type="text"
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                  placeholder={providerMeta.defaultModel}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-fuchsia-500 focus:border-fuchsia-500"
                />
              </div>
            </>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full flex items-center justify-center gap-2 bg-fuchsia-600 hover:bg-fuchsia-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saving ? 'Menyimpan…' : saved ? 'Tersimpan' : 'Simpan Pengaturan'}
          </button>
        </form>
      )}
    </div>
  );
}
