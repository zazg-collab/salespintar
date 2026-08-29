'use client';

/**
 * Pengaturan Model — pilih model per pekerjaan.
 *
 * Kenapa halaman ini ada: sepuluh pekerjaan LLM di SalesPintar sifatnya sangat
 * berbeda (balasan pelanggan vs klasifikasi spam), tapi sebelum ini semuanya
 * berbagi dua tombol di `.env`. Menaikkan kualitas balasan otomatis menaikkan
 * biaya klasifikasi. Sekarang tiap pekerjaan bisa dipilih sendiri, dan
 * perubahannya berlaku tanpa restart backend — penting karena restart memutus
 * socket WhatsApp.
 */

import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPatch, apiPost } from '../../../lib/api';
import {
  SlidersHorizontal, Loader2, Save, AlertCircle, CheckCircle,
  RefreshCw, Eye, Zap, BarChart3, Info, PauseCircle, PlayCircle,
  Truck, ShieldCheck, KeyRound, ExternalLink, Sparkles,
} from 'lucide-react';

type SumberModel = 'bisnis' | 'env' | 'warisan';
type Beratnya = 'ringan' | 'sedang' | 'berat';

interface Pekerjaan {
  job: string;
  label: string;
  keterangan: string;
  beratnya: Beratnya;
  terlihatPelanggan: boolean;
  berlaku: string;
  sumber: SumberModel;
  /** Nilai yang berlaku kalau `pilihan` dikosongkan — ditampilkan di opsi bawaan. */
  nilaiEnv: string;
  sumberEnv: SumberModel;
  pilihan: string;
}

interface ModelTersedia {
  spec: string;
  provider: string;
  id: string;
  harga?: { masuk: number; keluar: number; masukCached?: number };
  /** Bisa menerima gambar. Dikirim backend dari `MODEL_BISA_GAMBAR` di llm.ts. */
  bisaGambar?: boolean;
}

interface BarisPemakaian {
  job: string;
  model: string;
  panggilan: number;
  tokenMasuk: number;
  tokenKeluar: number;
  tokenCached: number;
  latensiRata: number;
  gagal: number;
}

const LABEL_SUMBER: Record<SumberModel, { teks: string; kelas: string }> = {
  bisnis:  { teks: 'dipilih di sini',        kelas: 'text-blue-600 bg-blue-50 border-blue-200' },
  env:     { teks: '.env (LLM_MODEL_*)',     kelas: 'text-gray-500 bg-gray-50 border-gray-200' },
  warisan: { teks: '.env (GROQ_MODEL)',      kelas: 'text-gray-500 bg-gray-50 border-gray-200' },
};

const LABEL_BERAT: Record<Beratnya, { teks: string; kelas: string }> = {
  ringan: { teks: 'ringan', kelas: 'text-emerald-700 bg-emerald-50' },
  sedang: { teks: 'sedang', kelas: 'text-amber-700 bg-amber-50' },
  berat:  { teks: 'berat',  kelas: 'text-rose-700 bg-rose-50' },
};

function labelModel(m: ModelTersedia): string {
  // Penanda layanan di depan (mis. "openrouter: llama-3.3-70b") — diminta
  // Bossfren 2 Agustus 2026 supaya model yang sama boleh muncul di lebih dari
  // satu layanan tanpa ambigu mana yang benar-benar akan dipanggil, karena
  // `spec` (nilai yang disimpan) sudah membawa awalan provider juga.
  if (!m.harga) return `${m.provider}: ${m.id}`;
  const c = m.harga.masukCached ? ` · cache $${m.harga.masukCached}` : '';
  return `${m.provider}: ${m.id} — $${m.harga.masuk}/$${m.harga.keluar}${c}`;
}

/**
 * Bandingkan biaya dua model. Dipakai untuk memperingatkan sebelum pilihan
 * disimpan — bukan sesudah tagihan datang.
 *
 * Ada karena keluhan yang tepat: kalau dashboard boleh menimpa `.env`, orang
 * bisa memilih model yang jauh lebih mahal tanpa satu pun tanda. "Mahal
 * diam-diam" itu yang harus dihilangkan, bukan kemampuan memilihnya.
 */
function bandingkanBiaya(
  pilihanSpec: string,
  dasarSpec: string,
  daftar: ModelTersedia[],
): { arah: 'lebih-mahal' | 'lebih-murah' | 'sama' | 'tidak-diketahui'; teks: string } | null {
  if (!pilihanSpec || pilihanSpec === dasarSpec) return null;
  const a = daftar.find((m) => m.spec === pilihanSpec)?.harga;
  const b = daftar.find((m) => m.spec === dasarSpec)?.harga;
  if (!a || !b) {
    return {
      arah: 'tidak-diketahui',
      teks: 'Harga salah satu model tidak ada di tabel — dampak biayanya belum bisa dihitung.',
    };
  }
  const kaliMasuk = a.masuk / b.masuk;
  const kaliKeluar = a.keluar / b.keluar;
  const fmt = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, ''));
  // Ambang 1,05 supaya beda recehan tidak memunculkan peringatan.
  if (kaliMasuk > 1.05 || kaliKeluar > 1.05) {
    return {
      arah: 'lebih-mahal',
      teks: `Lebih mahal dari nilai .env — input ${fmt(kaliMasuk)}x, output ${fmt(kaliKeluar)}x ` +
            `($${a.masuk}/$${a.keluar} vs $${b.masuk}/$${b.keluar} per 1M token).`,
    };
  }
  if (kaliMasuk < 0.95 || kaliKeluar < 0.95) {
    return {
      arah: 'lebih-murah',
      teks: `Lebih murah dari nilai .env — input ${fmt(1 / kaliMasuk)}x, output ${fmt(1 / kaliKeluar)}x ` +
            `lebih hemat ($${a.masuk}/$${a.keluar} vs $${b.masuk}/$${b.keluar}).`,
    };
  }
  return { arah: 'sama', teks: 'Harganya setara dengan nilai .env.' };
}

function rapikanAngka(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Sisa waktu jeda dalam bahasa manusia — dipakai juga di spanduk `layout.tsx`. */
function sisaWaktuJeda(pausedUntilIso: string): string {
  const sisaMs = Date.parse(pausedUntilIso) - Date.now();
  if (!Number.isFinite(sisaMs) || sisaMs <= 0) return 'segera berakhir';
  const menit = Math.round(sisaMs / 60000);
  if (menit < 1) return 'segera berakhir';
  if (menit < 60) return `${menit} menit lagi`;
  const jam = Math.floor(menit / 60);
  const sisaMenit = menit % 60;
  return sisaMenit === 0 ? `${jam} jam lagi` : `${jam} jam ${sisaMenit} menit lagi`;
}

function PengaturanModelTab() {
  const [pekerjaan, setPekerjaan] = useState<Pekerjaan[]>([]);
  const [modelTersedia, setModelTersedia] = useState<ModelTersedia[]>([]);
  const [draf, setDraf] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [menyimpan, setMenyimpan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sukses, setSukses] = useState<string | null>(null);
  const [peringatan, setPeringatan] = useState<string[]>([]);

  const [pemakaian, setPemakaian] = useState<BarisPemakaian[] | null>(null);
  const [adaData, setAdaData] = useState(false);

  // ── Profil toko ────────────────────────────────────────────────────────────
  // Nama ini bukan label administratif: ia disuntikkan ke prompt sistem, jadi
  // dia yang diucapkan bot saat menyapa pelanggan. Sebelum 2 Agustus 2026
  // isinya `SalesPintar MVP` dan bot betulan menyapa "Selamat datang di
  // SalesPintar!" — nama internal produk, bukan nama toko.
  const [namaToko, setNamaToko] = useState('');
  const [namaTersimpan, setNamaTersimpan] = useState('');
  const [maksNama, setMaksNama] = useState(60);
  const [menyimpanNama, setMenyimpanNama] = useState(false);

  // ── Jeda Pilar 1 (CRM Intelligence) ─────────────────────────────────────────
  const [crmDijeda, setCrmDijeda] = useState(false);
  const [crmSampai, setCrmSampai] = useState<string | null>(null);
  const [crmJamJeda, setCrmJamJeda] = useState(4);
  const [memprosesCRM, setMemprosesCRM] = useState(false);
  const [errorCRM, setErrorCRM] = useState<string | null>(null);

  // ── Jeda Pilar 2 (Knowledge Base & Auto-Learning) ───────────────────────────
  const [hlDijeda, setHlDijeda] = useState(false);
  const [hlSampai, setHlSampai] = useState<string | null>(null);
  const [jamJeda, setJamJeda] = useState(4);
  const [memprosesHL, setMemprosesHL] = useState(false);
  const [errorHL, setErrorHL] = useState<string | null>(null);

  const jedaHLPermanen = useCallback(async () => {
    setMemprosesHL(true);
    setErrorHL(null);
    try {
      const r = await apiPatch<{ message?: string; humanLearningPaused?: boolean; humanLearningPausedUntil?: string | null }>(
        '/business/human-learning-jeda',
        { aksi: 'jeda', mode: 'permanen' },
      );
      setHlDijeda(typeof r?.humanLearningPaused === 'boolean' ? r.humanLearningPaused : true);
      setHlSampai(null);
      setSukses(r?.message ?? 'Knowledge Base Auto-Learning dijeda permanen.');
      setTimeout(() => setSukses(null), 5000);
    } catch (e: any) {
      setErrorHL(e?.message ?? 'Gagal menjeda Auto-Learning');
    } finally {
      setMemprosesHL(false);
    }
  }, []);

  const jedaHLDurasi = useCallback(async () => {
    setMemprosesHL(true);
    setErrorHL(null);
    try {
      const r = await apiPatch<{ message?: string; humanLearningPaused?: boolean; humanLearningPausedUntil?: string | null }>(
        '/business/human-learning-jeda',
        { aksi: 'jeda', mode: 'durasi', jam: jamJeda },
      );
      setHlDijeda(typeof r?.humanLearningPaused === 'boolean' ? r.humanLearningPaused : true);
      setHlSampai(typeof r?.humanLearningPausedUntil === 'string' ? r.humanLearningPausedUntil : null);
      setSukses(r?.message ?? 'Knowledge Base Auto-Learning dijeda.');
      setTimeout(() => setSukses(null), 5000);
    } catch (e: any) {
      setErrorHL(e?.message ?? 'Gagal menjeda Auto-Learning');
    } finally {
      setMemprosesHL(false);
    }
  }, [jamJeda]);

  const lanjutkanHL = useCallback(async () => {
    setMemprosesHL(true);
    setErrorHL(null);
    try {
      const r = await apiPatch<{ message?: string; humanLearningPaused?: boolean }>('/business/human-learning-jeda', { aksi: 'lanjut' });
      setHlDijeda(typeof r?.humanLearningPaused === 'boolean' ? r.humanLearningPaused : false);
      setHlSampai(null);
      setSukses(r?.message ?? 'Knowledge Base Auto-Learning diaktifkan.');
      setTimeout(() => setSukses(null), 5000);
    } catch (e: any) {
      setErrorHL(e?.message ?? 'Gagal mengaktifkan Auto-Learning');
    } finally {
      setMemprosesHL(false);
    }
  }, []);

  const jedaCRMPermanen = useCallback(async () => {
    setMemprosesCRM(true);
    setErrorCRM(null);
    try {
      const r = await apiPatch<{ message?: string; crmIntelligencePaused?: boolean; crmIntelligencePausedUntil?: string | null }>(
        '/business/crm-jeda',
        { aksi: 'jeda', mode: 'permanen' },
      );
      setCrmDijeda(typeof r?.crmIntelligencePaused === 'boolean' ? r.crmIntelligencePaused : true);
      setCrmSampai(null);
      setSukses(r?.message ?? 'AI Lead Profiler & CRM dijeda permanen.');
      setTimeout(() => setSukses(null), 5000);
    } catch (e: any) {
      setErrorCRM(e?.message ?? 'Gagal menjeda CRM Profiler');
    } finally {
      setMemprosesCRM(false);
    }
  }, []);

  const jedaCRMDurasi = useCallback(async () => {
    setMemprosesCRM(true);
    setErrorCRM(null);
    try {
      const r = await apiPatch<{ message?: string; crmIntelligencePaused?: boolean; crmIntelligencePausedUntil?: string | null }>(
        '/business/crm-jeda',
        { aksi: 'jeda', mode: 'durasi', jam: crmJamJeda },
      );
      setCrmDijeda(typeof r?.crmIntelligencePaused === 'boolean' ? r.crmIntelligencePaused : true);
      setCrmSampai(typeof r?.crmIntelligencePausedUntil === 'string' ? r.crmIntelligencePausedUntil : null);
      setSukses(r?.message ?? 'AI Lead Profiler & CRM dijeda.');
      setTimeout(() => setSukses(null), 5000);
    } catch (e: any) {
      setErrorCRM(e?.message ?? 'Gagal menjeda CRM Profiler');
    } finally {
      setMemprosesCRM(false);
    }
  }, [crmJamJeda]);

  const lanjutkanCRM = useCallback(async () => {
    setMemprosesCRM(true);
    setErrorCRM(null);
    try {
      const r = await apiPatch<{ message?: string; crmIntelligencePaused?: boolean }>('/business/crm-jeda', { aksi: 'lanjut' });
      setCrmDijeda(typeof r?.crmIntelligencePaused === 'boolean' ? r.crmIntelligencePaused : false);
      setCrmSampai(null);
      setSukses(r?.message ?? 'AI Lead Profiler & CRM diaktifkan.');
      setTimeout(() => setSukses(null), 5000);
    } catch (e: any) {
      setErrorCRM(e?.message ?? 'Gagal mengaktifkan CRM Profiler');
    } finally {
      setMemprosesCRM(false);
    }
  }, []);

  const simpanNama = useCallback(async () => {
    const bersih = namaToko.trim().replace(/\s+/g, ' ');
    if (!bersih) { setError('Nama toko tidak boleh kosong'); return; }
    if (bersih === namaTersimpan) return;
    setMenyimpanNama(true);
    setError(null);
    try {
      const r = await apiPatch<{ message?: string; name?: string }>('/business', { name: bersih });
      const tersimpan = typeof r?.name === 'string' ? r.name : bersih;
      setNamaTersimpan(tersimpan);
      setNamaToko(tersimpan);
      setSukses(r?.message ?? 'Nama toko disimpan.');
      setTimeout(() => setSukses(null), 4000);
    } catch (e: any) {
      setError(e?.message ?? 'Gagal menyimpan nama toko');
      setNamaToko(namaTersimpan);
    } finally {
      setMenyimpanNama(false);
    }
  }, [namaToko, namaTersimpan]);

  const [mengantarApiKey, setMengantarApiKey] = useState('');
  const [mengantarApiKeyTersimpan, setMengantarApiKeyTersimpan] = useState('');
  const [menyimpanMengantar, setMenyimpanMengantar] = useState(false);
  const [testingMengantar, setTestingMengantar] = useState(false);
  const [mengantarTestResult, setMengantarTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const simpanMengantarKey = useCallback(async () => {
    const bersih = mengantarApiKey.trim();
    if (bersih === mengantarApiKeyTersimpan) return;
    setMenyimpanMengantar(true);
    setMengantarTestResult(null);
    try {
      const r = await apiPatch<{ message?: string; mengantarApiKey?: string }>('/business', { mengantarApiKey: bersih });
      const tersimpan = typeof r?.mengantarApiKey === 'string' ? r.mengantarApiKey : bersih;
      setMengantarApiKeyTersimpan(tersimpan);
      setMengantarApiKey(tersimpan);
      setSukses('API Key Mengantar berhasil disimpan.');
      setTimeout(() => setSukses(null), 4000);
    } catch (e: any) {
      setError(e?.message ?? 'Gagal menyimpan API Key Mengantar');
      setMengantarApiKey(mengantarApiKeyTersimpan);
    } finally {
      setMenyimpanMengantar(false);
    }
  }, [mengantarApiKey, mengantarApiKeyTersimpan]);

  const tesKoneksiMengantar = useCallback(async () => {
    const apiKey = mengantarApiKey.trim() || mengantarApiKeyTersimpan;
    if (!apiKey) {
      setMengantarTestResult({ success: false, message: 'Harap masukkan API Key Mengantar terlebih dahulu.' });
      return;
    }
    setTestingMengantar(true);
    setMengantarTestResult(null);
    try {
      const r = await apiPost<{ success: boolean; message: string }>('/business/mengantar-test', { apiKey });
      setMengantarTestResult(r);
    } catch (e: any) {
      setMengantarTestResult({ success: false, message: e?.message ?? 'Gagal menghubungi server Mengantar' });
    } finally {
      setTestingMengantar(false);
    }
  }, [mengantarApiKey, mengantarApiKeyTersimpan]);

  const muat = useCallback(async () => {
    try {
      const d = await apiGet<{ pekerjaan: Pekerjaan[]; modelTersedia: ModelTersedia[] }>('/llm-settings');
      try {
        const b = await apiGet<{
          name?: string; maksNama?: number; mengantarApiKey?: string | null;
          humanLearningPaused?: boolean; humanLearningPausedUntil?: string | null;
          crmIntelligencePaused?: boolean; crmIntelligencePausedUntil?: string | null;
        }>('/business');
        const nama = typeof b?.name === 'string' ? b.name : '';
        setNamaToko(nama);
        setNamaTersimpan(nama);
        setMaksNama(typeof b?.maksNama === 'number' ? b.maksNama : 60);
        const mKey = typeof b?.mengantarApiKey === 'string' ? b.mengantarApiKey : '';
        setMengantarApiKey(mKey);
        setMengantarApiKeyTersimpan(mKey);
        setHlDijeda(typeof b?.humanLearningPaused === 'boolean' ? b.humanLearningPaused : false);
        setHlSampai(typeof b?.humanLearningPausedUntil === 'string' ? b.humanLearningPausedUntil : null);
        setCrmDijeda(typeof b?.crmIntelligencePaused === 'boolean' ? b.crmIntelligencePaused : false);
        setCrmSampai(typeof b?.crmIntelligencePausedUntil === 'string' ? b.crmIntelligencePausedUntil : null);
      } catch {
        // Profil toko gagal dimuat tidak boleh mengosongkan halaman Pengaturan
      }
      setPekerjaan(d.pekerjaan);
      setModelTersedia(d.modelTersedia);
      setDraf(Object.fromEntries(d.pekerjaan.map((p) => [p.job, p.pilihan])));
      setError(null);
    } catch (e: any) {
      setError((e?.message as string) || 'Gagal memuat pengaturan model');
    } finally {
      setLoading(false);
    }
  }, []);

  const muatPemakaian = useCallback(async () => {
    try {
      const d = await apiGet<{ adaData: boolean; baris: BarisPemakaian[] }>('/llm-settings/pemakaian?hari=7');
      setAdaData(d.adaData);
      setPemakaian(d.baris);
    } catch {
      setPemakaian([]);
    }
  }, []);

  useEffect(() => { void muat(); void muatPemakaian(); }, [muat, muatPemakaian]);

  const berubah = pekerjaan.some((p) => (draf[p.job] ?? '') !== p.pilihan);

  const simpan = async () => {
    setMenyimpan(true);
    setError(null);
    setSukses(null);
    setPeringatan([]);
    try {
      const r = await apiPatch<{ message: string; peringatan: string[] }>('/llm-settings', { pilihan: draf });
      setSukses(r.message);
      setPeringatan(r.peringatan ?? []);
      await muat();
    } catch (e: any) {
      setError((e?.message as string) || 'Gagal menyimpan');
    } finally {
      setMenyimpan(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <SlidersHorizontal className="w-5 h-5 text-blue-500" />
            Pengaturan Model
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Tiap pekerjaan bisa pakai model sendiri. Perubahan berlaku tanpa restart backend.
          </p>
        </div>
        <button
          onClick={() => { void muat(); void muatPemakaian(); }}
          className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
          title="Muat ulang"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Profil toko */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-900">Nama Toko</h2>
        <p className="text-xs text-gray-500 mt-1 mb-3">
          Nama ini yang disebut bot ke pelanggan saat menyapa dan memperkenalkan diri.
          Berlaku untuk balasan berikutnya, tanpa restart.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={namaToko}
            maxLength={maksNama}
            onChange={(e) => setNamaToko(e.target.value.replace(/[\r\n]/g, ''))}
            onBlur={() => { void simpanNama(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
            placeholder="mis. Juragan Pisau"
            className="flex-1 min-w-[220px] px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <span className={`text-xs font-mono tabular-nums ${namaToko.length >= maksNama ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
            {namaToko.length}/{maksNama}
          </span>
          {menyimpanNama ? (
            <span className="text-xs text-gray-500">menyimpan…</span>
          ) : namaToko.trim() !== namaTersimpan ? (
            <span className="text-xs text-amber-600">belum tersimpan</span>
          ) : (
            <span className="text-xs text-green-600">tersimpan</span>
          )}
        </div>
      </div>

      {/* Integrasi Mengantar API (2-Layer Anti-RTS Firewall) */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
        <div className="flex items-center justify-between gap-2 mb-1">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <Truck className="w-4 h-4 text-indigo-600" />
            Integrasi Mengantar API (Reputasi Logistik & Anti-RTS)
          </h2>
          <a
            href="https://app.mengantar.com/docs/#content-receiver-score"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 font-medium"
          >
            Dokumentasi API <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Digunakan sebagai referensi sekunder untuk memeriksa rekam jejak penerima COD di ekspedisi (JNE, J&T, SiCepat, dll). Jika kosong, sistem tetap berjalan normal menggunakan analisis Kualitas Chat AI.
        </p>

        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[260px]">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                <KeyRound className="w-4 h-4" />
              </div>
              <input
                type="password"
                value={mengantarApiKey}
                onChange={(e) => setMengantarApiKey(e.target.value)}
                onBlur={() => { void simpanMengantarKey(); }}
                placeholder="Masukkan API Key Mengantar Publik..."
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>

            <button
              onClick={() => void simpanMengantarKey()}
              disabled={menyimpanMengantar || mengantarApiKey.trim() === mengantarApiKeyTersimpan}
              className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg shadow-sm disabled:opacity-40 transition-colors"
            >
              {menyimpanMengantar ? 'Menyimpan...' : 'Simpan API Key'}
            </button>

            <button
              onClick={() => void tesKoneksiMengantar()}
              disabled={testingMengantar || !mengantarApiKey.trim()}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 text-xs font-semibold rounded-lg transition-colors disabled:opacity-40"
            >
              {testingMengantar ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />}
              Tes Koneksi API
            </button>
          </div>

          {mengantarTestResult && (
            <div className={`flex items-start gap-2 text-xs rounded-lg p-3 ${
              mengantarTestResult.success ? 'text-emerald-800 bg-emerald-50 border border-emerald-200' : 'text-rose-800 bg-rose-50 border border-rose-200'
            }`}>
              {mengantarTestResult.success ? (
                <CheckCircle className="w-4 h-4 flex-shrink-0 text-emerald-600 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 flex-shrink-0 text-rose-600 mt-0.5" />
              )}
              <span>{mengantarTestResult.message}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── KONTROL JEDA / SAKELAR AI PER PILAR ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Card Jeda Pilar 1: CRM Intelligence */}
        <div className={`bg-white border rounded-xl p-5 shadow-sm flex flex-col justify-between ${crmDijeda ? 'border-amber-300 ring-1 ring-amber-100' : 'border-gray-200'}`}>
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-indigo-600" />
                Jeda Pilar 1: CRM & Audit CS
              </h2>
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                crmDijeda ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
              }`}>
                {crmDijeda ? (crmSampai ? `Dijeda (${sisaWaktuJeda(crmSampai)})` : 'Dijeda Permanen') : '🟢 Berjalan Aktif'}
              </span>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed mb-4">
              Menjeda AI Lead Profiling & Audit Closing CS. Chat WhatsApp tetap diterima, namun AI tidak memprofilkan lead / minat pembeli.
            </p>

            {errorCRM && (
              <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5 mb-3">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span>{errorCRM}</span>
              </div>
            )}
          </div>

          <div>
            {crmDijeda ? (
              <button
                onClick={() => void lanjutkanCRM()}
                disabled={memprosesCRM}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg shadow-sm disabled:opacity-40 transition-colors"
              >
                {memprosesCRM ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
                Aktifkan CRM Kembali Sekarang
              </button>
            ) : (
              <div className="space-y-2.5 pt-1">
                <div className="flex items-center gap-2">
                  <select
                    value={crmJamJeda}
                    onChange={(e) => setCrmJamJeda(Number(e.target.value))}
                    disabled={memprosesCRM}
                    className="w-28 px-2.5 py-1.5 text-xs border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500"
                  >
                    {[1, 2, 4, 8, 12, 24].map((j) => (
                      <option key={j} value={j}>{j} jam</option>
                    ))}
                  </select>
                  <button
                    onClick={() => void jedaCRMDurasi()}
                    disabled={memprosesCRM}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 text-xs font-medium rounded-lg transition-colors disabled:opacity-40"
                  >
                    {memprosesCRM ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PauseCircle className="w-3.5 h-3.5 text-amber-600" />}
                    Jeda Berjangka
                  </button>
                </div>
                <button
                  onClick={() => void jedaCRMPermanen()}
                  disabled={memprosesCRM}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 text-xs font-medium rounded-lg transition-colors disabled:opacity-40"
                >
                  <PauseCircle className="w-3.5 h-3.5 text-gray-600" />
                  Jeda Permanen (Bebas On/Off)
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Card Jeda Pilar 2: Knowledge Base Auto-Learning */}
        <div className={`bg-white border rounded-xl p-5 shadow-sm flex flex-col justify-between ${hlDijeda ? 'border-amber-300 ring-1 ring-amber-100' : 'border-gray-200'}`}>
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-500" />
                Jeda Pilar 2: Auto-Learning KB
              </h2>
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                hlDijeda ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
              }`}>
                {hlDijeda ? (hlSampai ? `Dijeda (${sisaWaktuJeda(hlSampai)})` : 'Dijeda Permanen') : '🟢 Berjalan Aktif'}
              </span>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed mb-4">
              Menjeda penyerapan percakapan CS menjadi draf SOP Pustaka Pengetahuan (shadow mining). CS tetap melayani normal.
            </p>

            {errorHL && (
              <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5 mb-3">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span>{errorHL}</span>
              </div>
            )}
          </div>

          <div>
            {hlDijeda ? (
              <button
                onClick={() => void lanjutkanHL()}
                disabled={memprosesHL}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg shadow-sm disabled:opacity-40 transition-colors"
              >
                {memprosesHL ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
                Aktifkan Auto-Learning Kembali
              </button>
            ) : (
              <div className="space-y-2.5 pt-1">
                <div className="flex items-center gap-2">
                  <select
                    value={jamJeda}
                    onChange={(e) => setJamJeda(Number(e.target.value))}
                    disabled={memprosesHL}
                    className="w-28 px-2.5 py-1.5 text-xs border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500"
                  >
                    {[1, 2, 4, 8, 12, 24].map((j) => (
                      <option key={j} value={j}>{j} jam</option>
                    ))}
                  </select>
                  <button
                    onClick={() => void jedaHLDurasi()}
                    disabled={memprosesHL}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 text-xs font-medium rounded-lg transition-colors disabled:opacity-40"
                  >
                    {memprosesHL ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PauseCircle className="w-3.5 h-3.5 text-amber-600" />}
                    Jeda Berjangka
                  </button>
                </div>
                <button
                  onClick={() => void jedaHLPermanen()}
                  disabled={memprosesHL}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 text-xs font-medium rounded-lg transition-colors disabled:opacity-40"
                >
                  <PauseCircle className="w-3.5 h-3.5 text-gray-600" />
                  Jeda Permanen (Bebas On/Off)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Penjelasan cara kerja model */}
      <div className="flex gap-3 bg-indigo-50/70 border border-indigo-100 rounded-xl p-4 text-sm text-indigo-900">
        <Info className="w-4 h-4 flex-shrink-0 mt-0.5 text-indigo-600" />
        <div className="space-y-1.5 text-xs text-indigo-950">
          <p>
            <strong>Arsitektur Model Terpisah per Fungsi.</strong> Sistem kini berfokus pada 2 fungsi inti: <strong>Audit Performa CS & Profiling Prospek</strong> serta <strong>Knowledge Base AI & Auto-Learning</strong>. Seluruh percakapan WhatsApp kini dikelola langsung oleh CS manusia, sementara AI bekerja di balik layar menganalisis kualitas chat & membangun pustaka pengetahuan toko.
          </p>
          <p className="text-indigo-800">
            Dropdown menampilkan nilai <code className="text-[11px] bg-white px-1 py-0.5 rounded border border-indigo-200">.env</code> bawaan. Begitu kamu memilih model lain, pilihan di halaman inilah yang langsung berlaku seketika tanpa restart server.
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {sukses && (
        <div className="flex items-start gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-4">
          <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{sukses}</span>
        </div>
      )}
      {peringatan.length > 0 && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-1">
          {peringatan.map((p, i) => (
            <div key={i} className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{p}</span>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
        </div>
      ) : (
        <>
          {/* Daftar pekerjaan dikelompokkan berdasarkan 2 Pilar Utama */}
          <div className="space-y-6">
            {/* ── PILAR 1: CRM INTELLIGENCE & AUDIT PERFORMA CS ── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 border-b border-gray-200 pb-2">
                <ShieldCheck className="w-4 h-4 text-indigo-600" />
                <h3 className="text-xs font-bold text-gray-900 uppercase tracking-wider">
                  Pilar 1: CRM Intelligence & Audit Performa CS
                </h3>
              </div>

              {pekerjaan
                .filter((p) => p.job === 'classify')
                .map((p) => {
                  const sumber = LABEL_SUMBER[p.sumber];
                  const berat = LABEL_BERAT[p.beratnya];
                  const nilai = draf[p.job] ?? '';
                  const diubah = nilai !== p.pilihan;
                  return (
                    <div
                      key={p.job}
                      className={`bg-white border rounded-xl p-4 shadow-sm ${diubah ? 'border-blue-300 ring-1 ring-blue-100' : 'border-gray-100'}`}
                    >
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-gray-900 text-sm">{p.label}</span>
                            <code className="text-[10px] text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded">{p.job}</code>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${berat.kelas}`}>
                              {berat.teks}
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{p.keterangan}</p>
                        </div>
                      </div>

                      <div className="mt-3 flex items-center gap-3 flex-wrap">
                        <select
                          value={nilai}
                          onChange={(e) => setDraf((d) => ({ ...d, [p.job]: e.target.value }))}
                          className="flex-1 min-w-[20rem] px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                        >
                          <option value="">
                            — ikut .env: {p.nilaiEnv.replace(/^groq:/, '')} —
                          </option>
                          {modelTersedia.map((m) => (
                            <option key={m.spec} value={m.spec}>
                              {labelModel(m)}
                            </option>
                          ))}
                          {nilai && !modelTersedia.some((m) => m.spec === nilai) && (
                            <option value={nilai}>
                              {nilai} (tidak ada di daftar yang terbaca)
                            </option>
                          )}
                        </select>

                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-gray-400">berlaku:</span>
                          <code className="text-gray-700">{p.berlaku.replace(/^groq:/, '')}</code>
                          <span className={`px-1.5 py-0.5 rounded border text-[10px] ${sumber.kelas}`}>
                            {sumber.teks}
                          </span>
                        </div>
                      </div>

                      {/* Dampak biaya */}
                      {(() => {
                        const b = bandingkanBiaya(nilai, p.nilaiEnv, modelTersedia);
                        if (!b) return null;
                        const kelas =
                          b.arah === 'lebih-mahal'
                            ? 'text-rose-700 bg-rose-50 border-rose-200'
                            : b.arah === 'lebih-murah'
                            ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                            : 'text-gray-600 bg-gray-50 border-gray-200';
                        const Ikon = b.arah === 'lebih-mahal' ? AlertCircle : Info;
                        return (
                          <div className={`mt-2 flex items-start gap-2 text-xs px-3 py-2 rounded-lg border ${kelas}`}>
                            <Ikon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                            <span>{b.teks}</span>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
            </div>

            {/* ── PILAR 2: KNOWLEDGE BASE AI & AUTO-LEARNING ── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 border-b border-gray-200 pb-2">
                <Sparkles className="w-4 h-4 text-amber-500" />
                <h3 className="text-xs font-bold text-gray-900 uppercase tracking-wider">
                  Pilar 2: Knowledge Base AI & Auto-Learning
                </h3>
              </div>

              {pekerjaan
                .filter((p) => p.job !== 'classify')
                .map((p) => {
                  const sumber = LABEL_SUMBER[p.sumber];
                  const berat = LABEL_BERAT[p.beratnya];
                  const nilai = draf[p.job] ?? '';
                  const diubah = nilai !== p.pilihan;
                  return (
                    <div
                      key={p.job}
                      className={`bg-white border rounded-xl p-4 shadow-sm ${diubah ? 'border-blue-300 ring-1 ring-blue-100' : 'border-gray-100'}`}
                    >
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-gray-900 text-sm">{p.label}</span>
                            <code className="text-[10px] text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded">{p.job}</code>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${berat.kelas}`}>
                              {berat.teks}
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{p.keterangan}</p>
                        </div>
                      </div>

                      <div className="mt-3 flex items-center gap-3 flex-wrap">
                        <select
                          value={nilai}
                          onChange={(e) => setDraf((d) => ({ ...d, [p.job]: e.target.value }))}
                          className="flex-1 min-w-[20rem] px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                        >
                          <option value="">
                            — ikut .env: {p.nilaiEnv.replace(/^groq:/, '')} —
                          </option>
                          {modelTersedia.map((m) => (
                            <option key={m.spec} value={m.spec}>
                              {labelModel(m)}
                            </option>
                          ))}
                          {nilai && !modelTersedia.some((m) => m.spec === nilai) && (
                            <option value={nilai}>
                              {nilai} (tidak ada di daftar yang terbaca)
                            </option>
                          )}
                        </select>

                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-gray-400">berlaku:</span>
                          <code className="text-gray-700">{p.berlaku.replace(/^groq:/, '')}</code>
                          <span className={`px-1.5 py-0.5 rounded border text-[10px] ${sumber.kelas}`}>
                            {sumber.teks}
                          </span>
                        </div>
                      </div>

                      {/* Dampak biaya */}
                      {(() => {
                        const b = bandingkanBiaya(nilai, p.nilaiEnv, modelTersedia);
                        if (!b) return null;
                        const kelas =
                          b.arah === 'lebih-mahal'
                            ? 'text-rose-700 bg-rose-50 border-rose-200'
                            : b.arah === 'lebih-murah'
                            ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                            : 'text-gray-600 bg-gray-50 border-gray-200';
                        const Ikon = b.arah === 'lebih-mahal' ? AlertCircle : Info;
                        return (
                          <div className={`mt-2 flex items-start gap-2 text-xs px-3 py-2 rounded-lg border ${kelas}`}>
                            <Ikon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                            <span>{b.teks}</span>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
            </div>
          </div>

          {/* Simpan (Inline Non-Sticky) */}
          <div className="mt-6 flex items-center gap-3 pt-2 border-t border-gray-100">
            <button
              onClick={() => void simpan()}
              disabled={!berubah || menyimpan}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {menyimpan ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Simpan Pengaturan Model
            </button>
            {berubah && !menyimpan && (
              <span className="text-xs text-blue-600 font-medium">Ada pilihan model yang belum disimpan</span>
            )}
            {!berubah && !menyimpan && (
              <span className="text-xs text-gray-400">Tidak ada perubahan model</span>
            )}
          </div>

          {/* Pemakaian nyata */}
          <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
              <span className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-blue-400" />
                Pemakaian token — 7 hari terakhir
              </span>
              <span className="text-[10px] text-gray-400">dari tabel llm_calls</span>
            </div>

            {pemakaian === null ? (
              <p className="px-4 py-6 text-xs text-gray-400 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Memuat...
              </p>
            ) : !adaData ? (
              <div className="px-4 py-6 text-xs text-gray-500 space-y-1.5">
                <p className="font-medium text-gray-600">Belum ada satu pun panggilan tercatat.</p>
                <p className="text-gray-400 leading-relaxed">
                  Kalau backend sudah menyala dan bot sudah membalas pesan tapi di sini tetap kosong,
                  periksa <code className="bg-gray-100 px-1 rounded">LLM_LOG_CALLS</code> dan pastikan
                  <code className="bg-gray-100 px-1 rounded mx-1">npx prisma migrate deploy</code>
                  sudah dijalankan.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-gray-400 border-b border-gray-100">
                    <tr>
                      <th className="text-left font-medium px-4 py-2">Pekerjaan</th>
                      <th className="text-left font-medium px-3 py-2">Model</th>
                      <th className="text-right font-medium px-3 py-2">Panggilan</th>
                      <th className="text-right font-medium px-3 py-2">Token masuk</th>
                      <th className="text-right font-medium px-3 py-2">Token keluar</th>
                      <th className="text-right font-medium px-3 py-2">Latensi</th>
                      <th className="text-right font-medium px-4 py-2">Gagal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {pemakaian.map((r, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2 font-medium text-gray-700">{r.job}</td>
                        <td className="px-3 py-2 text-gray-500">{r.model.replace(/^groq:/, '')}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-700">{r.panggilan}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-700">{rapikanAngka(r.tokenMasuk)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-700">{rapikanAngka(r.tokenKeluar)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-400">{r.latensiRata}ms</td>
                        <td className={`px-4 py-2 text-right tabular-nums ${r.gagal > 0 ? 'text-red-600 font-medium' : 'text-gray-300'}`}>
                          {r.gagal}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="text-[11px] text-gray-400 flex gap-1.5 leading-relaxed">
            <Zap className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            Sebelum menggeser model, jalankan <code className="bg-gray-100 px-1 rounded">npx tsx audit-ai.ts --model=a,b</code>
            {' '}di folder <code className="bg-gray-100 px-1 rounded">backend/</code> untuk membandingkan kandidat pada
            pertanyaan sungguhan. Tabel harga di atas menjawab &quot;berapa biayanya&quot;; hanya audit yang
            menjawab &quot;apakah jawabannya masih benar&quot;.
          </p>
        </>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<'model' | 'ai-ads' | 'emergency-brake'>('model');

  const tabs: { key: 'model' | 'ai-ads' | 'emergency-brake'; label: string }[] = [
    { key: 'model', label: 'Pengaturan Model' },
          ];

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex gap-1 border-b border-gray-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'model' && <PengaturanModelTab />}
      {tab === 'ai-ads' && <AiAdsThresholdShiftTab />}
      {tab === 'emergency-brake' && <EmergencyBrakeTab />}
    </div>
  );
}
