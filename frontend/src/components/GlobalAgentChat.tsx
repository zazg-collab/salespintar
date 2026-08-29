'use client';

/**
 * GlobalAgentChat -- inti UI+logic chat "Agent Workspace" (Global Agent Workspace), dipakai
 * BERSAMA oleh 2 tempat: widget floating (GlobalAgentWidget.tsx, dipasang sekali di layout.tsx,
 * nempel di semua halaman /app/*) dan halaman fallback penuh (/app/ai-ads/chat/page.tsx, dipakai
 * kalau widget floating entah kenapa tidak muncul/diakses via URL langsung).
 *
 * [2026-08-25] Langkah B (redesign UX Global Agent Workspace, blueprint "Ekstensi Fase 3: Global
 * Agent Workspace & Multi-BM Token Vault" v1.3). Perubahan dari versi sebelumnya (Langkah A):
 *  - Chat sekarang per-PIC (bukan 1 percakapan global per business) -- PIC di-derive OTOMATIS dari
 *    `pic_name` unik di BM aktif (GET /ai-ads/global-chat/pics), BUKAN tabel/form kelola terpisah.
 *  - conversationId TIDAK lagi dikelola di React state sama sekali -- backend yang menyimpannya
 *    (tabel AiAdsGlobalChatSession, key businessId+picName) dan otomatis dipakai ulang server-side
 *    tiap kali komponen ini kirim {picName, message}. Jadi percakapan TETAP INGAT walau halaman
 *    di-refresh atau widget ditutup-buka lagi -- beda dari Langkah A yang cuma inget di 1 sesi
 *    React (hilang kalau refresh).
 *  - Riwayat pesan (transcript) dimuat dari server saat PIC dipilih (GET .../session?picName=X),
 *    bukan mulai kosong tiap kali.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { apiGet, apiPost, apiPostStream } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import { Bot, Send, Loader2, User, AlertCircle, Users, ChevronLeft, RefreshCw, Lock, ShieldAlert, Eye, EyeOff } from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
}

// ── Markdown-lite: heading ###, **bold**, list -/1., pemisah --- ──────────

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let listBuffer: string[] = [];
  let listKey = 0;

  const flushList = () => {
    if (listBuffer.length === 0) return;
    elements.push(
      <ul key={`list-${listKey++}`} className="list-disc list-inside space-y-0.5 my-1">
        {listBuffer.map((item, i) => (
          <li key={i}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>
    );
    listBuffer = [];
  };

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed === '---') {
      flushList();
      elements.push(<hr key={`hr-${idx}`} className="my-2 border-gray-200" />);
      return;
    }
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const sizeClass = level <= 2 ? 'text-base font-bold' : 'text-sm font-semibold';
      elements.push(
        <div key={`h-${idx}`} className={`${sizeClass} mt-2 mb-1`}>
          {renderInlineMarkdown(headingMatch[2])}
        </div>
      );
      return;
    }
    const listMatch = trimmed.match(/^(?:-|\d+\.)\s+(.*)$/);
    if (listMatch) {
      listBuffer.push(listMatch[1]);
      return;
    }
    flushList();
    if (trimmed.length === 0) {
      elements.push(<div key={`sp-${idx}`} className="h-2" />);
    } else {
      elements.push(
        <p key={`p-${idx}`} className="leading-relaxed">
          {renderInlineMarkdown(line)}
        </p>
      );
    }
  });
  flushList();

  return <div className="text-sm text-gray-800 space-y-0.5">{elements}</div>;
}

// ── Parsing SSE (event conversation_id/delta/done/error) ──────────────────

async function consumeGlobalChatStream(
  res: Response,
  handlers: {
    onDelta: (text: string) => void;
    onDone: (reply: string, active: boolean) => void;
    onError: (message: string) => void;
  }
) {
  if (!res.body) {
    handlers.onError('Respons server tidak mendukung streaming di browser ini.');
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const rawEvent = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      let evt: any;
      try {
        evt = JSON.parse(dataLine.slice(6));
      } catch {
        continue;
      }
      if (evt.type === 'delta' && typeof evt.text === 'string') {
        handlers.onDelta(evt.text);
      } else if (evt.type === 'done') {
        handlers.onDone(typeof evt.reply === 'string' ? evt.reply : '', !!evt.active);
      } else if (evt.type === 'error') {
        handlers.onError(typeof evt.message === 'string' ? evt.message : 'Terjadi kesalahan.');
      }
    }
  }
}

// ── Sub-komponen: picker PIC ────────────────────────────────────────────

function PicPicker({
  pics,
  loading,
  error,
  onSelect,
  onRetry,
}: {
  pics: string[];
  loading: boolean;
  error: string | null;
  onSelect: (pic: string) => void;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-8 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Memuat daftar PIC...
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 px-4 text-center">
        <div className="flex items-center gap-2 text-sm text-red-600">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
        <button
          onClick={onRetry}
          className="flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800 mt-1"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Coba lagi
        </button>
      </div>
    );
  }
  if (pics.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
        <p className="text-sm text-gray-500">
          Belum ada PIC Marketing terdaftar. Isi nama PIC saat menambah/mengedit Business Manager di
          halaman Pengaturan Meta Ads, nanti otomatis muncul di sini.
        </p>
        <div className="flex items-center gap-3">
          <Link
            href="/app/meta-capi"
            className="text-xs font-medium text-indigo-600 hover:text-indigo-800 underline"
          >
            Buka Pengaturan Meta Ads
          </Link>
          <button
            onClick={onRetry}
            className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700"
            title="Muat ulang daftar PIC (mis. setelah menambah PIC baru)"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Muat ulang
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="py-6 px-4">
      <div className="flex items-center gap-1.5 text-sm text-gray-500 mb-3 justify-center">
        <Users className="w-4 h-4" />
        Chat sebagai siapa?
      </div>
      <div className="flex flex-wrap gap-2 justify-center">
        {pics.map((pic) => (
          <button
            key={pic}
            onClick={() => onSelect(pic)}
            className="rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 px-4 py-1.5 text-sm font-medium hover:bg-indigo-100"
          >
            {pic}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Sub-komponen: gerbang PIN per-PIC (buat baru / verifikasi) ───────────
// [2026-08-27] Lapisan konfidensialitas RINGAN: siapa pun yg pegang browser/akun bisnis yg
// sama TIDAK otomatis bisa buka riwayat chat AI PIC lain -- harus tau PIN 4-digit PIC itu.
// Ini BUKAN pengganti auth per-user (semua tetap 1 akun bisnis, 1 token API) -- cuma
// penghalang biar gak sembarang klik nama orang lain.
// ── Sub-komponen: 4 kotak digit PIN (gaya OTP) ────────────────────────────
// [2026-08-27] Ganti dari 1 input polos ke kotak per-digit -- auto-lompat fokus pas
// ngetik, backspace mundur, dukung paste (tempel 4 digit sekaligus langsung keisi).
// `data-1p-ignore`/`data-lpignore` biar ikon password-manager browser (1Password/
// LastPass/dll) yang norak gak nongol di atas kotak PIN.
function OtpBoxes({
  reveal,
  error,
  disabled,
  autoFocus,
  onChange,
  onComplete,
  resetToken,
}: {
  reveal: boolean;
  error?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  resetToken: number;
}) {
  const [digits, setDigits] = useState<string[]>(['', '', '', '']);
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    setDigits(['', '', '', '']);
    if (autoFocus) refs.current[0]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);

  function commit(next: string[]) {
    setDigits(next);
    const joined = next.join('');
    onChange(joined);
    if (next.every((d) => d !== '')) onComplete?.(joined);
  }

  function handleInput(i: number, raw: string) {
    const d = raw.replace(/\D/g, '');
    if (!d) return;
    const next = [...digits];
    next[i] = d[d.length - 1];
    commit(next);
    if (i < 3) refs.current[i + 1]?.focus();
  }

  function handleKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      if (digits[i]) {
        const next = [...digits];
        next[i] = '';
        commit(next);
      } else if (i > 0) {
        const next = [...digits];
        next[i - 1] = '';
        commit(next);
        refs.current[i - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowRight' && i < 3) {
      refs.current[i + 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4);
    if (!text) return;
    e.preventDefault();
    const next = ['', '', '', ''];
    text.split('').forEach((c, idx) => { next[idx] = c; });
    commit(next);
    refs.current[Math.min(text.length, 3)]?.focus();
  }

  return (
    <div className="flex items-center gap-2.5">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          type={reveal ? 'text' : 'password'}
          inputMode="numeric"
          maxLength={1}
          autoComplete="off"
          data-1p-ignore=""
          data-lpignore="true"
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          value={d}
          onChange={(e) => handleInput(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          className={`w-12 h-14 text-center text-xl font-bold rounded-xl border-2 shadow-sm transition-all duration-150 focus:outline-none focus:ring-4 disabled:opacity-50 ${
            error
              ? 'border-red-300 bg-red-50 text-red-600 focus:border-red-500 focus:ring-red-100'
              : d
                ? 'border-indigo-300 bg-indigo-50/60 focus:border-indigo-500 focus:ring-indigo-100'
                : 'border-gray-200 bg-gray-50 focus:border-indigo-500 focus:ring-indigo-100 focus:bg-white'
          }`}
        />
      ))}
    </div>
  );
}

function PinGate({
  picName,
  mode,
  isAdmin,
  onSuccess,
  onCancel,
}: {
  picName: string;
  mode: 'set' | 'verify';
  isAdmin: boolean;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [gateMode, setGateMode] = useState(mode);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [resetToken, setResetToken] = useState(0);

  function clearBoxes() {
    setPin('');
    setConfirmPin('');
    setResetToken((t) => t + 1);
  }

  async function submit(pinValue: string, confirmValue: string) {
    if (!/^\d{4}$/.test(pinValue)) {
      setErr('PIN harus 4 digit angka.');
      return;
    }
    if (gateMode === 'set' && pinValue !== confirmValue) {
      setErr('Konfirmasi PIN tidak cocok. Coba lagi.');
      clearBoxes();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (gateMode === 'set') {
        await apiPost('/ai-ads/global-chat/pin/set', { picName, pin: pinValue });
      } else {
        const res = await apiPost<{ ok: boolean }>('/ai-ads/global-chat/pin/verify', { picName, pin: pinValue });
        if (!res.ok) {
          setErr('PIN salah. Coba lagi.');
          setBusy(false);
          clearBoxes();
          return;
        }
      }
      onSuccess();
    } catch (e: any) {
      setErr(e?.message || 'Gagal memproses PIN.');
    } finally {
      setBusy(false);
    }
  }

  async function resetPin() {
    setResetting(true);
    setErr(null);
    try {
      await apiPost('/ai-ads/global-chat/pin/reset', { picName });
      setGateMode('set');
      clearBoxes();
    } catch (e: any) {
      setErr(e?.message || 'Gagal reset PIN.');
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-4 py-9 px-4 text-center">
      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 shadow-lg shadow-indigo-200 flex items-center justify-center">
        <Lock className="w-5 h-5 text-white" />
      </div>
      <div className="space-y-1">
        <p className="text-base font-semibold text-gray-900">
          {gateMode === 'set' ? `Buat PIN untuk ${picName}` : `Masukkan PIN ${picName}`}
        </p>
        <p className="text-xs text-gray-400 max-w-[260px] leading-relaxed">
          {gateMode === 'set'
            ? 'PIN 4 digit ini menjaga riwayat obrolanmu supaya tidak sembarangan dibuka orang lain.'
            : 'Riwayat obrolan PIC ini terkunci PIN. Masukkan 4 digit untuk melanjutkan.'}
        </p>
      </div>

      <div className="space-y-1.5">
        {gateMode === 'set' && (
          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-400">PIN Baru</p>
        )}
        <OtpBoxes
          reveal={reveal}
          error={!!err}
          disabled={busy}
          autoFocus
          resetToken={resetToken}
          onChange={setPin}
          onComplete={(v) => {
            if (gateMode === 'verify') void submit(v, confirmPin);
          }}
        />
      </div>

      {gateMode === 'set' && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-400">Ulangi PIN</p>
          <OtpBoxes
            reveal={reveal}
            error={!!err}
            disabled={busy}
            resetToken={resetToken}
            onChange={setConfirmPin}
            onComplete={(v) => void submit(pin, v)}
          />
        </div>
      )}

      <button
        onClick={() => setReveal((r) => !r)}
        className="flex items-center gap-1 text-[11px] font-medium text-gray-400 hover:text-gray-600"
      >
        {reveal ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
        {reveal ? 'Sembunyikan PIN' : 'Tampilkan PIN'}
      </button>

      {err && (
        <div className="flex items-center gap-1.5 text-xs text-red-600">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {err}
        </div>
      )}

      <div className="flex items-center gap-3 mt-1">
        <button
          onClick={onCancel}
          className="text-xs font-medium text-gray-400 hover:text-gray-600"
        >
          Batal
        </button>
        <button
          onClick={() => submit(pin, confirmPin)}
          disabled={busy}
          className="rounded-xl bg-gradient-to-br from-indigo-600 to-indigo-700 text-white px-5 py-2 text-sm font-semibold shadow-md shadow-indigo-200 disabled:opacity-50 hover:shadow-lg hover:shadow-indigo-300 transition-all"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : gateMode === 'set' ? 'Simpan PIN' : 'Buka'}
        </button>
      </div>

      {gateMode === 'verify' && isAdmin && (
        <button
          onClick={resetPin}
          disabled={resetting}
          className="flex items-center gap-1 text-[11px] font-medium text-amber-600 hover:text-amber-800 mt-1 disabled:opacity-50"
        >
          <ShieldAlert className="w-3 h-3" />
          {resetting ? 'Mereset...' : `Lupa PIN? Reset (Admin)`}
        </button>
      )}
    </div>
  );
}


// ── Komponen utama ──────────────────────────────────────────────────────

export interface GlobalAgentChatProps {
  /** 'floating' dipakai widget (panel lebih ringkas), 'page' dipakai halaman penuh /app/ai-ads/chat. */
  mode?: 'floating' | 'page';
  /**
   * [Langkah C] Teks yang otomatis DIKIRIM (bukan cuma diisi ke input) begitu PIC aktif
   * tersedia -- dipakai untuk inject konteks dari luar (mis. tombol "lanjut ngobrol" di modal
   * Audit AI campaign, lewat globalAgentBus). Kalau belum ada PIC terpilih, ditahan dulu sampai
   * user memilih PIC, baru otomatis terkirim. Sekali terkirim, `onPrefillConsumed` dipanggil
   * supaya pemanggil bisa membersihkan state-nya dan tidak terkirim dobel.
   */
  prefillMessage?: string | null;
  onPrefillConsumed?: () => void;
}

export default function GlobalAgentChat({ mode = 'page', prefillMessage, onPrefillConsumed }: GlobalAgentChatProps) {
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'ADMIN';

  const [pics, setPics] = useState<string[]>([]);
  const [picsLoading, setPicsLoading] = useState(true);
  const [picsError, setPicsError] = useState<string | null>(null);
  const [selectedPic, setSelectedPic] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);

  // [2026-08-27] Gerbang PIN per-PIC -- `unlockedPic` cuma boleh sama dgn `selectedPic` SETELAH
  // PIN sukses di-set/verifikasi. `pinGate` null == belum tau/gak perlu gerbang; diisi begitu
  // effect di bawah selesai cek GET pin-status. Reset penuh tiap kali komponen remount (buka
  // widget baru) -- SENGAJA, biar PIN selalu ditanya ulang tiap sesi browser baru.
  const [unlockedPic, setUnlockedPic] = useState<string | null>(null);
  const [pinGate, setPinGate] = useState<{ picName: string; mode: 'set' | 'verify' } | null>(null);
  const [pinCheckError, setPinCheckError] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // Muat daftar PIC -- dibungkus useCallback supaya bisa dipanggil ulang dari tombol
  // "Coba lagi" / "Muat ulang" di PicPicker (mis. kalau fetch pertama gagal, atau user baru
  // saja menambah PIC baru di halaman Pengaturan Meta Ads dan balik ke widget ini).
  const loadPics = useCallback(() => {
    setPicsLoading(true);
    setPicsError(null);
    apiGet<{ pics: string[] }>('/ai-ads/global-chat/pics')
      .then((res) => {
        const list = Array.isArray(res.pics) ? res.pics : [];
        setPics(list);
        // [2026-08-27] Auto-select HANYA kalau memang cuma ada 1 PIC (gak ada pilihan
        // lain, gak perlu nanya). Dulu di sini juga ada auto-restore "PIC terakhir" dari
        // localStorage kalau PIC > 1 -- DIHAPUS krn kontradiktif sama gerbang PIN: begitu
        // PIN aktif, user WAJIB milih PIC eksplisit dulu di PicPicker, gak boleh nyelonong
        // otomatis ke orang yg kepake terakhir di browser itu.
        if (list.length === 1) {
          setSelectedPic(list[0]);
        }
      })
      .catch((err) => {
        setPicsError(err?.message || 'Gagal memuat daftar PIC.');
      })
      .finally(() => {
        setPicsLoading(false);
      });
  }, []);

  useEffect(() => {
    loadPics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cek gerbang PIN begitu PIC dipilih (manual klik ATAU auto-select 1-PIC/remembered-PIC --
  // makanya effect ini bereaksi ke `selectedPic`, BUKAN cuma dipasang di handler klik).
  useEffect(() => {
    if (!selectedPic || unlockedPic === selectedPic) {
      setPinGate(null);
      return;
    }
    let cancelled = false;
    setPinCheckError(null);
    apiGet<{ hasPin: boolean }>(`/ai-ads/global-chat/pin-status?picName=${encodeURIComponent(selectedPic)}`)
      .then((res) => {
        if (cancelled) return;
        setPinGate({ picName: selectedPic, mode: res.hasPin ? 'verify' : 'set' });
      })
      .catch((err) => {
        if (!cancelled) setPinCheckError(err?.message || 'Gagal memeriksa status PIN.');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPic, unlockedPic]);

  // Muat histori percakapan begitu PIC dipilih/berubah DAN gerbang PIN-nya sudah kebuka.
  useEffect(() => {
    if (!selectedPic || unlockedPic !== selectedPic) return;
    let cancelled = false;
    setSessionLoading(true);
    setError(null);
    setMessages([]);
    apiGet<{ conversationId: string | null; transcript: Array<{ role: string; text: string }> }>(
      `/ai-ads/global-chat/session?picName=${encodeURIComponent(selectedPic)}`
    )
      .then((res) => {
        if (cancelled) return;
        const loaded = Array.isArray(res.transcript)
          ? res.transcript.map((m, i) => ({
              id: `h-${i}-${m.role}`,
              role: (m.role === 'user' || m.role === 'system' ? m.role : 'assistant') as ChatMessage['role'],
              text: m.text,
            }))
          : [];
        setMessages(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Gagal memuat riwayat percakapan.');
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPic, unlockedPic]);

  // [Langkah C] Begitu ada prefillMessage DAN PIC aktif sudah ada, kirim otomatis sebagai pesan
  // pertama -- ref-guard supaya tidak terkirim dobel walau effect ini re-run.
  const consumedPrefillRef = useRef<string | null>(null);
  useEffect(() => {
    // [2026-08-27] WAJIB tunggu unlockedPic === selectedPic (gerbang PIN sudah kebuka) sebelum
    // auto-kirim prefillMessage dari fitur "lanjut ngobrol" (Audit AI, via globalAgentBus).
    // Sebelumnya cuma cek selectedPic -- itu celah: pesan bisa ke-auto-send DAN ke-mark consumed
    // walau PinGate (verify/set) masih terbuka di layar, jadi PIN kebobolan khusus jalur ini.
    if (!prefillMessage || !selectedPic || unlockedPic !== selectedPic) return;
    if (consumedPrefillRef.current === prefillMessage) return;
    consumedPrefillRef.current = prefillMessage;
    void handleSend(prefillMessage);
    onPrefillConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillMessage, selectedPic, unlockedPic]);

  const handleSelectPic = useCallback((pic: string) => {
    setSelectedPic(pic);
  }, []);

  const handlePinCancel = useCallback(() => {
    setPinGate(null);
    setSelectedPic(null);
  }, []);

  async function handleSend(overrideText?: string) {
    const trimmed = (overrideText ?? input).trim();
    if (!trimmed || sending || !selectedPic) return;
    setError(null);
    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', text: trimmed };
    const assistantId = `a-${Date.now()}`;
    setMessages((prev) => [...prev, userMsg, { id: assistantId, role: 'assistant', text: '' }]);
    setInput('');
    setSending(true);

    try {
      const res = await apiPostStream('/ai-ads/global-chat', { message: trimmed, picName: selectedPic });
      await consumeGlobalChatStream(res, {
        onDelta: (text) => {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + text } : m)));
        },
        onDone: (reply, active) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: reply, role: active ? 'assistant' : 'system' } : m))
          );
        },
        onError: (message) => {
          setError(message);
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        },
      });
    } catch (err: any) {
      setError(err?.message || 'Gagal menghubungi Agent Workspace.');
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const lastMessage = messages[messages.length - 1];
  const showThinkingIndicator = sending && lastMessage?.role !== 'user' && lastMessage?.text === '';
  const bubblePad = mode === 'floating' ? 'p-3' : 'p-4';

  return (
    <div className="flex flex-col h-full">
      {!selectedPic ? (
        <PicPicker pics={pics} loading={picsLoading} error={picsError} onSelect={handleSelectPic} onRetry={loadPics} />
      ) : pinGate ? (
        <PinGate
          picName={pinGate.picName}
          mode={pinGate.mode}
          isAdmin={isAdmin}
          onSuccess={() => setUnlockedPic(pinGate.picName)}
          onCancel={handlePinCancel}
        />
      ) : pinCheckError ? (
        <div className="flex flex-col items-center gap-2 py-8 px-4 text-center text-sm text-red-600">
          <AlertCircle className="w-4 h-4" />
          {pinCheckError}
        </div>
      ) : unlockedPic !== selectedPic ? (
        <div className="flex items-center gap-2 text-sm text-gray-400 justify-center py-8">
          <Loader2 className="w-4 h-4 animate-spin" />
          Memeriksa PIN...
        </div>
      ) : (
        <>
          {pics.length > 1 && (
            <button
              onClick={() => setSelectedPic(null)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 mb-2 shrink-0"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Chat sbg <span className="font-medium">{selectedPic}</span> — ganti orang
            </button>
          )}
          <div className={`flex-1 overflow-y-auto bg-white rounded-lg border border-gray-100 ${bubblePad} space-y-3 min-h-0`}>
            {sessionLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-400 justify-center py-8">
                <Loader2 className="w-4 h-4 animate-spin" />
                Memuat riwayat...
              </div>
            ) : messages.length === 0 ? (
              <div className="text-sm text-gray-400 text-center py-8">
                Mulai percakapan dengan mengetik pesan di bawah.
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 ${
                      m.role === 'user'
                        ? 'bg-indigo-600 text-white'
                        : m.role === 'system'
                          ? 'bg-amber-50 border border-amber-200'
                          : 'bg-gray-100'
                    }`}
                  >
                    {m.role === 'user' ? (
                      <div className="flex items-start gap-2">
                        <User className="w-4 h-4 mt-0.5 shrink-0" />
                        <span className="text-sm">{m.text}</span>
                      </div>
                    ) : m.text ? (
                      <MarkdownLite text={m.text} />
                    ) : (
                      <span className="text-sm text-gray-400">&nbsp;</span>
                    )}
                  </div>
                </div>
              ))
            )}
            {showThinkingIndicator && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                Agent sedang mikir...
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {error && (
            <div className="mt-2 flex items-center gap-2 text-sm text-red-600 shrink-0">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="mt-3 flex items-end gap-2 shrink-0">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tulis pesan ke Agent Workspace..."
              rows={mode === 'floating' ? 1 : 2}
              className="flex-1 resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              disabled={sending}
            />
            <button
              onClick={() => handleSend()}
              disabled={sending || !input.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-indigo-700"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {mode === 'page' && 'Kirim'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
