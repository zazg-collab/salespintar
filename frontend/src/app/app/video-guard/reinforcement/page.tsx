'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Wand2, Loader2, CheckCircle2, UploadCloud, ShieldCheck, CheckSquare, Square } from 'lucide-react';
import { apiUpload, apiGet } from '../../../../lib/api';

const LAYERS: { key: string; label: string; description: string; tag: string }[] = [
  { key: 'template_overlay', label: 'Layer 1: Top Banner Glassmorphism', description: 'Banner hijau hutan mewah + tipografi "Agro Series" elegan tanpa terpotong.', tag: 'Visual' },
  { key: 'adversarial_noise', label: 'Layer 2: Adversarial Micro-Noise', description: 'Injeksi Laplacian micro-noise frekuensi tinggi untuk merusak sidik jari CNN/AI.', tag: 'Anti-AI' },
  { key: 'color_grade', label: 'Layer 3: Earth & Nature Color LUT', description: 'Grading saturasi hijau daun & kontras alami perkebunan (+7.3%).', tag: 'Visual' },
  { key: 'metadata_label', label: 'Layer 4: Polymorphic Metadata EXIF', description: 'Injeksi metadata acak dinamis (UUID entropy unik per video render).', tag: 'Metadata' },
  { key: 'temporal_jitter', label: 'Layer 5: Temporal & pHash Disrupter', description: 'Micro-jitter FPS (29.98-30.03) + tempo audio untuk acak perceptual hash.', tag: 'Anti-Hash' },
  { key: 'highlight_soften', label: 'Layer 6: Specular Glare Softener', description: 'Meredam silau pantulan bilah tajam via in-stream curve 1-pass (10x lebih cepat).', tag: 'Visual' },
  { key: 'audio_bedding', label: 'Layer 7: Psychoacoustic Audio Bedding', description: 'Injeksi spektrum pink noise 2250Hz pada pita ASR untuk samarkan audio.', tag: 'Audio' },
  { key: 'micro_reframe', label: 'Layer 8: Micro-Scale Geometry Anchor', description: 'Crop presisi 0.955x (Scale ~1.047x) untuk memutus kesamaan geometri.', tag: 'Geometri' },
];

type JobStatusResponse =
  | { status: 'queued' | 'processing' }
  | { status: 'done'; result: { job_id: string; output_video_path: string; layers_applied: string[] } }
  | { status: 'error'; error: string };

export default function ReinforcementPage() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [selectedLayers, setSelectedLayers] = useState<string[]>(LAYERS.map((l) => l.key)); // Default: All 8 Layers (V7 Recommended)
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function toggleLayer(key: string) {
    setSelectedLayers((prev) => (prev.includes(key) ? prev.filter((l) => l !== key) : [...prev, key]));
  }

  function selectAllLayers() {
    if (selectedLayers.length === LAYERS.length) {
      setSelectedLayers([]);
    } else {
      setSelectedLayers(LAYERS.map((l) => l.key));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!videoFile) { setError('Video wajib diunggah.'); return; }
    if (selectedLayers.length === 0) { setError('Pilih minimal satu layer.'); return; }

    setSubmitting(true);
    try {
      const form = new FormData();
      form.set('layers', selectedLayers.join(','));
      form.set('video_file', videoFile);
      const res = await apiUpload<{ job_id: string; status: string }>('/video-guard/reinforce', form);
      setJobId(res.job_id);
      setStatus({ status: 'queued' });

      pollRef.current = setInterval(async () => {
        try {
          const s = await apiGet<JobStatusResponse>(`/video-guard/reinforce/${res.job_id}/status`);
          setStatus(s);
          if (s.status === 'done' || s.status === 'error') {
            if (pollRef.current) clearInterval(pollRef.current);
          }
        } catch (e2) {
          setError((e2 as Error).message || 'Gagal memuat status job.');
          if (pollRef.current) clearInterval(pollRef.current);
        }
      }, 3000);
    } catch (e) {
      setError((e as Error).message || 'Gagal mengirim video.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      <Link href="/app/video-guard" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="w-4 h-4" /> Kembali ke Dashboard
      </Link>

      <div>
        <h1 className="text-xl md:text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Wand2 className="w-6 h-6 text-indigo-600" /> 8-Layer Video Cloaking (V7 Engine)
        </h1>
        <p className="text-xs md:text-sm text-gray-500 mt-1">
          Perkuat sinyal presentasi & disrupsi sidik jari AI pada video sebelum dikirim ke Meta Ads Manager.
        </p>
      </div>

      {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm">{error}</div>}

      {!jobId && (
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-gray-200 p-6 space-y-6 shadow-sm">
          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1">Pilih File Video Asli</label>
            <input
              type="file"
              accept="video/*"
              onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-gray-600 file:mr-3 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:bg-indigo-50 file:text-indigo-700 file:text-sm file:font-semibold hover:file:bg-indigo-100 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <div>
                <label className="block text-sm font-semibold text-gray-800">Pilih Lapisan Pengaman (8-Layer V7)</label>
                <p className="text-xs text-gray-500">Kombinasi 8 layer lengkap memberikan skor perlindungan tertinggi.</p>
              </div>
              <button
                type="button"
                onClick={selectAllLayers}
                className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 flex items-center gap-1.5 bg-indigo-50 px-3 py-1.5 rounded-lg transition-colors"
              >
                {selectedLayers.length === LAYERS.length ? (
                  <><CheckSquare className="w-3.5 h-3.5" /> Batalkan Semua</>
                ) : (
                  <><ShieldCheck className="w-3.5 h-3.5" /> Pilih Semua (V7 Rekomendasi)</>
                )}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {LAYERS.map((l) => {
                const isChecked = selectedLayers.includes(l.key);
                return (
                  <label
                    key={l.key}
                    className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-all ${
                      isChecked
                        ? 'border-indigo-400 bg-indigo-50/70 shadow-xs'
                        : 'border-gray-200 hover:bg-gray-50/80'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleLayer(l.key)}
                      className="mt-1 accent-indigo-600 rounded"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <p className="text-sm font-semibold text-gray-900 truncate">{l.label}</p>
                        <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                          {l.tag}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{l.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold py-3.5 rounded-xl transition-all shadow-sm hover:shadow"
          >
            {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <UploadCloud className="w-5 h-5" />}
            {submitting ? 'Sedang Memproses...' : `Jalankan 8-Layer V7 Cloaking (${selectedLayers.length} Layer Aktif)`}
          </button>
        </form>
      )}

      {jobId && status && (status.status === 'queued' || status.status === 'processing') && (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 flex flex-col items-center gap-4 text-center shadow-sm">
          <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
          <div>
            <p className="text-base font-semibold text-gray-900">Sedang memproses 8-Layer V7 Cloaking...</p>
            <p className="text-xs text-gray-500 mt-1">Mengaplikasikan filter single-pass, audio bedding, dan polymorphic metadata.</p>
          </div>
        </div>
      )}

      {jobId && status && status.status === 'error' && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-6 text-rose-700 space-y-2">
          <p className="font-semibold text-base">Cloaking Gagal</p>
          <p className="text-sm">{status.error}</p>
          <button
            onClick={() => { setJobId(null); setStatus(null); }}
            className="mt-2 text-xs font-semibold text-rose-800 underline"
          >
            Coba Lagi
          </button>
        </div>
      )}

      {jobId && status && status.status === 'done' && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-6 space-y-4 shadow-sm">
          <div className="flex items-center gap-2.5 text-indigo-800 font-bold text-base">
            <CheckCircle2 className="w-6 h-6 text-indigo-600" /> Video Berhasil Di-Cloak dengan Standar V7!
          </div>
          <div className="text-xs text-indigo-900 bg-white/80 rounded-xl p-4 space-y-2 border border-indigo-100">
            <p className="font-semibold text-gray-800">
              Layer yang diterapkan ({status.result.layers_applied.length}):
            </p>
            <div className="flex flex-wrap gap-1.5">
              {status.result.layers_applied.map((k) => (
                <span key={k} className="px-2 py-0.5 rounded-md bg-indigo-100 text-indigo-800 text-[11px] font-medium font-mono">
                  {k}
                </span>
              ))}
            </div>
            <p className="text-gray-500 text-[11px] mt-2">
              File output tersimpan di server: <code className="font-mono bg-gray-100 px-1 py-0.5 rounded text-gray-700">{status.result.output_video_path}</code>
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => { setJobId(null); setStatus(null); setVideoFile(null); }}
              className="flex-1 text-center py-2.5 px-4 bg-white border border-indigo-200 text-indigo-700 hover:bg-indigo-50 text-xs font-semibold rounded-xl transition-colors"
            >
              Proses Video Lain
            </button>
            <Link
              href="/app/video-guard/audit-baru"
              className="flex-1 text-center py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-xl transition-colors shadow-xs"
            >
              Lanjut ke Audit Kepatuhan →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
