'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { UploadCloud, Loader2, ArrowLeft, Wand2, ChevronDown, ChevronUp } from 'lucide-react';
import { apiUpload } from '../../../../lib/api';

export default function AuditBaruPage() {
  const router = useRouter();
  const [adTitle, setAdTitle] = useState('');
  const [primaryText, setPrimaryText] = useState('');
  const [headline, setHeadline] = useState('');
  const [landingPageUrl, setLandingPageUrl] = useState('');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [layersApplied, setLayersApplied] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!adTitle.trim()) {
      setError('Judul iklan wajib diisi.');
      return;
    }
    if (!videoFile && !thumbnailFile && !landingPageUrl.trim()) {
      setError('Minimal satu dari video, thumbnail, atau landing page URL wajib diisi.');
      return;
    }

    setSubmitting(true);
    try {
      const form = new FormData();
      form.set('ad_title', adTitle.trim());
      if (primaryText.trim()) form.set('primary_text', primaryText.trim());
      if (headline.trim()) form.set('headline', headline.trim());
      if (landingPageUrl.trim()) form.set('landing_page_url', landingPageUrl.trim());
      if (layersApplied.trim()) form.set('presentation_layers_applied', layersApplied.trim());
      if (videoFile) form.set('video_file', videoFile);
      if (thumbnailFile) form.set('thumbnail_file', thumbnailFile);

      const res = await apiUpload<{ audit_id: string }>('/video-guard/audit', form);
      router.push(`/app/video-guard/audit/${res.audit_id}`);
    } catch (e) {
      setError((e as Error).message || 'Gagal mengirim audit.');
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link href="/app/video-guard" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="w-4 h-4" /> Kembali ke Dashboard
      </Link>

      <div>
        <h1 className="text-lg md:text-xl font-bold text-gray-900">Audit Baru</h1>
        <p className="text-xs text-gray-500 mt-1">Kirim aset iklan video untuk dicek kepatuhannya terhadap kebijakan Meta Ads.</p>
      </div>

      <div className="bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 text-sm text-indigo-800 flex items-start gap-2">
        <Wand2 className="w-4 h-4 flex-shrink-0 mt-0.5 text-indigo-600" />
        <span>
          Sudah menjalankan Video Cloaking dulu? Unggah video hasilnya di sini, lalu isi kolom
          landing page dan teks iklan jika ada.{' '}
          <Link href="/app/video-guard/reinforcement" className="underline font-medium">Buka Video Cloaking →</Link>
        </span>
      </div>

      {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm">{error}</div>}

      <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Judul Iklan *</label>
          <input
            type="text"
            value={adTitle}
            onChange={(e) => setAdTitle(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder="mis. Golok Serbaguna Promo Agustus"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Video Iklan</label>
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
            className="w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:text-indigo-700 file:text-sm file:font-medium"
          />
          <p className="text-xs text-gray-400 mt-1">
            Cukup Judul + Video buat audit cepat (fokus kepatuhan visual/audio). Butuh cek thumbnail,
            copy iklan, atau landing page juga? Buka "Tambahkan aset lain" di bawah.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          className="w-full flex items-center justify-between text-sm font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg px-4 py-2.5 transition-colors"
        >
          <span>Tambahkan aset lain (opsional): thumbnail, headline, text, landing page</span>
          {showMore ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        {showMore && (
          <div className="space-y-5 border-t border-gray-100 pt-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Thumbnail</label>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setThumbnailFile(e.target.files?.[0] ?? null)}
                className="w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:text-indigo-700 file:text-sm file:font-medium"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Headline</label>
              <input
                type="text"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Primary Text / Caption</label>
              <textarea
                value={primaryText}
                onChange={(e) => setPrimaryText(e.target.value)}
                rows={3}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Landing Page URL</label>
              <input
                type="url"
                value={landingPageUrl}
                onChange={(e) => setLandingPageUrl(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="https://…"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Layer Reinforcement yang sudah diterapkan (opsional)</label>
              <input
                type="text"
                value={layersApplied}
                onChange={(e) => setLayersApplied(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="mis. template_overlay,color_grade"
              />
              <p className="text-xs text-gray-400 mt-1">Comma-separated. Hanya untuk pencatatan di laporan, bukan menjalankan reinforcement.</p>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
          {submitting ? 'Mengirim…' : 'Kirim untuk Diaudit'}
        </button>
      </form>
    </div>
  );
}
