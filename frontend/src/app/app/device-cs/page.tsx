'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiGet, apiPost, apiDelete } from '../../../lib/api';
import {
  Users, Plus, Wifi, WifiOff, Loader2, QrCode, Trash2,
  RefreshCw, Phone, CheckCircle, AlertCircle,
  Activity, X, ChevronDown, ChevronUp, ShieldAlert,
  Reply, MessageSquare, Target, UserCheck
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────
type SessionStatus = 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' | 'BANNED';

interface CsSession {
  id: string;
  csPhone: string;
  csName: string;
  status: SessionStatus;
  liveStatus: SessionStatus;
  linkedAt: string | null;
  lastSeenAt: string | null;
  totalPairsCaptured: number;
  csReplies: number;
  buyerMessages: number;
  totalClosingDetected: number;
  totalLostDetected: number;
  intentStats: Record<string, number> | null;
  qrCode: string | null;
  qrExpiresAt: string | null;
  createdAt: string;
  linkedPhone: string | null;
}

// ─── Status helpers ───────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<SessionStatus, { label: string; color: string; icon: React.ReactNode }> = {
  CONNECTED: {
    label: 'Terhubung',
    color: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    icon: <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />,
  },
  CONNECTING: {
    label: 'Menghubungkan...',
    color: 'text-amber-700 bg-amber-50 border-amber-200',
    icon: <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-600" />,
  },
  DISCONNECTED: {
    label: 'Terputus',
    color: 'text-gray-600 bg-gray-50 border-gray-200',
    icon: <WifiOff className="w-3.5 h-3.5 text-gray-500" />,
  },
  BANNED: {
    label: 'Diblokir WA',
    color: 'text-rose-700 bg-rose-50 border-rose-200',
    icon: <AlertCircle className="w-3.5 h-3.5 text-rose-600" />,
  },
};

function StatusBadge({ status }: { status: SessionStatus }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.DISCONNECTED;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full border ${cfg.color}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Baru saja';
  if (mins < 60) return `${mins} mnt lalu`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} jam lalu`;
  return `${Math.floor(hrs / 24)} hari lalu`;
}

// ─── QR Modal ─────────────────────────────────────────────────────────────────
type QrPhase = 'requesting' | 'waiting' | 'ready' | 'error';

function liveQr(qrCode?: string | null, qrExpiresAt?: string | null): string | null {
  if (!qrCode) return null;
  if (qrExpiresAt && new Date(qrExpiresAt).getTime() <= Date.now()) return null;
  return qrCode;
}

interface QrPayload {
  status?: string;
  liveStatus?: string;
  qrCode?: string | null;
  qrExpiresAt?: string | null;
}

function QrModal({
  session,
  onClose,
  onConnected,
}: {
  session: CsSession;
  onClose: () => void;
  onConnected: () => void;
}) {
  const seeded = liveQr(session.qrCode, session.qrExpiresAt);
  const [qrCode, setQrCode] = useState<string | null>(seeded);
  const [phase, setPhase] = useState<QrPhase>(seeded ? 'ready' : 'requesting');
  const [error, setError] = useState<string | null>(null);
  const [waitedSec, setWaitedSec] = useState(0);

  const onConnectedRef = useRef(onConnected);
  useEffect(() => { onConnectedRef.current = onConnected; }, [onConnected]);

  const requestQr = useCallback(async () => {
    setError(null);
    setWaitedSec(0);
    setPhase((prev) => (prev === 'ready' ? prev : 'requesting'));
    try {
      const data = await apiGet<QrPayload>(`/human-learning/sessions/${session.id}/qr`);
      if (data.status === 'CONNECTED') {
        onConnectedRef.current();
        return;
      }
      const fresh = liveQr(data.qrCode, data.qrExpiresAt);
      if (fresh) {
        setQrCode(fresh);
        setPhase('ready');
        return;
      }
      setPhase('waiting');
    } catch (e: any) {
      setError((e?.message as string) || 'Gagal meminta QR dari server');
      setPhase('error');
    }
  }, [session.id]);

  const askedRef = useRef(false);
  useEffect(() => {
    if (askedRef.current) return;
    askedRef.current = true;
    if (!seeded) void requestQr();
  }, [seeded, requestQr]);

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const data = await apiGet<QrPayload>(`/human-learning/sessions/${session.id}/status`);
        if (data.liveStatus === 'CONNECTED') {
          onConnectedRef.current();
          return;
        }
        const fresh = liveQr(data.qrCode, data.qrExpiresAt);
        if (fresh) {
          setQrCode((prev) => (prev === fresh ? prev : fresh));
          setPhase('ready');
          setError(null);
        }
      } catch {
        // ignore
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [session.id]);

  useEffect(() => {
    if (phase !== 'requesting' && phase !== 'waiting') return;
    const t = setInterval(() => setWaitedSec((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const stillWaiting = phase === 'requesting' || phase === 'waiting';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <h3 className="font-semibold text-gray-900">Hubungkan WhatsApp</h3>
            <p className="text-sm text-gray-500">{session.csName} · {session.csPhone}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 flex flex-col items-center justify-center gap-4 min-h-[300px]">
          {phase === 'error' ? (
            <div className="text-center py-4">
              <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-2" />
              <p className="text-sm text-red-600">{error || 'Terjadi galat yang tidak dikenali'}</p>
              <button
                onClick={() => void requestQr()}
                className="mt-3 text-sm text-indigo-600 hover:underline font-medium"
              >
                Coba lagi
              </button>
            </div>
          ) : phase === 'ready' && qrCode ? (
            <>
              <div className="p-3 bg-white border-2 border-gray-100 rounded-xl shadow-sm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrCode} alt="QR Code WhatsApp" className="w-52 h-52" />
              </div>
              <div className="text-center space-y-1">
                <p className="text-sm font-medium text-gray-700">Scan dengan WhatsApp</p>
                <p className="text-xs text-gray-400">
                  Buka WhatsApp → Setelan → Perangkat Tertaut → Tautkan Perangkat
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs text-indigo-700 bg-indigo-50 px-3 py-2 rounded-lg">
                <Activity className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Mode pemantauan — CS tetap balas dari HP normal</span>
              </div>
              <button
                onClick={() => void requestQr()}
                className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600"
              >
                <RefreshCw className="w-3 h-3" /> Muat ulang QR
              </button>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
              <p className="text-sm font-medium text-gray-600">
                {phase === 'requesting' ? 'Meminta QR Code...' : 'Menyiapkan sesi WhatsApp...'}
              </p>
              <p className="text-xs text-gray-400 max-w-[16rem] leading-relaxed">
                Sesi baru butuh <strong>10–15 detik</strong> untuk inisialisasi kunci enkripsi.
              </p>
              <p className="text-xs text-gray-300 tabular-nums">{waitedSec}s</p>
              {stillWaiting && waitedSec >= 40 && (
                <button
                  onClick={() => void requestQr()}
                  className="flex items-center gap-1.5 text-xs text-indigo-600 hover:underline"
                >
                  <RefreshCw className="w-3 h-3" /> Terlalu lama — minta ulang
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Add CS Form ──────────────────────────────────────────────────────────────
function AddCsForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await apiPost('/human-learning/sessions', { csName: name, csPhone: phone });
      setName(''); setPhone('');
      setOpen(false);
      onAdded();
    } catch (e: any) {
      setError(e.message ?? 'Gagal menambah CS');
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
      >
        <Plus className="w-4 h-4" /> Tambah CS Baru
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 bg-white border border-indigo-100 rounded-xl p-4 shadow-sm">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-600">Nama CS</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Rina"
          required
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg w-40 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-600">Nomor WhatsApp</label>
        <input
          value={phone}
          onChange={e => setPhone(e.target.value)}
          placeholder="081234567890"
          required
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg w-44 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>
      {error && <p className="text-xs text-rose-500 w-full">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 flex items-center gap-1.5 shadow-sm"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Simpan CS
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
        >
          Batal
        </button>
      </div>
    </form>
  );
}

// ─── Session Card ─────────────────────────────────────────────────────────────
function SessionCard({
  session,
  onRefresh,
}: {
  session: CsSession;
  onRefresh: () => void;
}) {
  const [showQr, setShowQr] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  const liveStatus = session.liveStatus;

  const handleQrClose = useCallback(() => setShowQr(false), []);
  const handleQrConnected = useCallback(() => { setShowQr(false); onRefresh(); }, [onRefresh]);

  const handleDelete = async () => {
    if (!confirm(`Hapus sesi CS ${session.csName}? Koneksi WhatsApp akan diputus.`)) return;
    setDeleting(true);
    try {
      await apiDelete(`/human-learning/sessions/${session.id}`);
      onRefresh();
    } catch (e: any) {
      alert(e.message ?? 'Gagal menghapus sesi');
      setDeleting(false);
    }
  };

  return (
    <>
      {showQr && (
        <QrModal
          session={session}
          onClose={handleQrClose}
          onConnected={handleQrConnected}
        />
      )}

      <div className="bg-white border border-gray-200/80 rounded-xl shadow-xs hover:shadow-md transition-all">
        {/* Main row */}
        <div className="flex items-center gap-4 p-4">
          {/* Avatar */}
          <div className="w-11 h-11 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center flex-shrink-0">
            <span className="text-indigo-700 font-bold text-sm">
              {session.csName.slice(0, 2).toUpperCase()}
            </span>
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-gray-900 text-sm">{session.csName}</span>
              <StatusBadge status={liveStatus} />
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500 mt-1 font-mono">
              <Phone className="w-3.5 h-3.5 text-gray-400" />
              <span>+{session.csPhone}</span>
            </div>
            {session.linkedPhone && session.linkedPhone !== session.csPhone && (
              <div className="flex items-start gap-1.5 mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-2.5 py-1.5">
                <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span>
                  Tertaut ke nomor <strong>+{session.linkedPhone}</strong> (bukan nomor terdaftar).
                </span>
              </div>
            )}
          </div>

          {/* Stats quick view */}
          <div className="hidden sm:flex flex-col items-end text-right">
            <div className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
              <Reply className="w-4 h-4 text-indigo-500" />
              {session.csReplies.toLocaleString('id-ID')}
            </div>
            <span className="text-xs text-gray-500 font-medium">Pesan CS Terbalas</span>
            <span className="text-[11px] text-gray-400">
              {session.buyerMessages.toLocaleString('id-ID')} pesan masuk
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
            {liveStatus !== 'CONNECTED' && liveStatus !== 'BANNED' && (
              <button
                onClick={() => setShowQr(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors shadow-2xs"
              >
                <QrCode className="w-3.5 h-3.5" />
                Scan QR
              </button>
            )}
            <button
              onClick={() => setShowDetail(v => !v)}
              className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              title="Lihat Detail Statistik"
            >
              {showDetail ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="p-2 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg disabled:opacity-50 transition-colors"
              title="Hapus sesi"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Detail panel */}
        {showDetail && (
          <div className="px-5 pb-5 pt-3 border-t border-gray-100 bg-gray-50/50 rounded-b-xl">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="bg-white p-3 rounded-lg border border-gray-100">
                <span className="text-gray-400 block text-[11px]">Terhubung sejak</span>
                <span className="font-semibold text-gray-800 mt-0.5 block">{formatRelative(session.linkedAt)}</span>
              </div>
              <div className="bg-white p-3 rounded-lg border border-gray-100">
                <span className="text-gray-400 block text-[11px]">Aktivitas terakhir</span>
                <span className="font-semibold text-gray-800 mt-0.5 block">{formatRelative(session.lastSeenAt)}</span>
              </div>
              <div className="bg-white p-3 rounded-lg border border-gray-100">
                <span className="text-gray-400 block text-[11px]">Pesan CS Terbalas</span>
                <span className="font-bold text-indigo-600 mt-0.5 block">{session.csReplies.toLocaleString('id-ID')}</span>
              </div>
              <div className="bg-white p-3 rounded-lg border border-gray-100">
                <span className="text-gray-400 block text-[11px]">Pesan Pembeli Masuk</span>
                <span className="font-bold text-emerald-600 mt-0.5 block">{session.buyerMessages.toLocaleString('id-ID')}</span>
              </div>
            </div>

            {/* Closing / Lost row */}
            <div className="mt-3 flex items-center justify-between bg-white p-3 rounded-lg border border-gray-100 text-xs">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-gray-400" />
                <span className="text-gray-600 font-medium">Performa Closing Terdeteksi:</span>
              </div>
              <div className="flex items-center gap-3 font-semibold">
                <span className="text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">
                  {session.totalClosingDetected} Closing
                </span>
                <span className="text-rose-600 bg-rose-50 px-2 py-0.5 rounded border border-rose-100">
                  {session.totalLostDetected} Lost
                </span>
              </div>
            </div>

            {/* Intent Stats */}
            {session.intentStats && Object.keys(session.intentStats).length > 0 && (
              <div className="mt-3 bg-white p-3 rounded-lg border border-gray-100">
                <span className="text-[11px] font-semibold text-gray-500 mb-2 block uppercase tracking-wider">
                  Top Kategori Chat Pelanggan
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(session.intentStats)
                    .sort(([,a], [,b]) => b - a)
                    .slice(0, 6)
                    .map(([intent, count]) => (
                      <span key={intent} className="text-xs bg-gray-50 border border-gray-200 text-gray-700 px-2 py-1 rounded-md">
                        {intent}: <strong className="text-gray-900">{count}</strong>
                      </span>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function DeviceCsPage() {
  const [sessions, setSessions] = useState<CsSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await apiGet<{ sessions: CsSession[] }>('/human-learning/sessions');
      setSessions(data.sessions);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? 'Gagal memuat sesi');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    const timer = setInterval(fetchSessions, 15_000);
    return () => clearInterval(timer);
  }, [fetchSessions]);

  const connected = sessions.filter(s => s.liveStatus === 'CONNECTED').length;
  const totalReplies = sessions.reduce((acc, s) => acc + s.csReplies, 0);
  const totalIncoming = sessions.reduce((acc, s) => acc + s.buyerMessages, 0);

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap border-b border-gray-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded text-xs font-bold tracking-wider bg-indigo-50 text-indigo-700 border border-indigo-100">
              WHATSAPP DEVICE MANAGER
            </span>
          </div>
          <h1 className="text-xl md:text-2xl font-bold text-gray-900 flex items-center gap-2 mt-1">
            <Users className="w-6 h-6 text-indigo-600" />
            Device & Sesi CS
          </h1>
          <p className="text-xs md:text-sm text-gray-500 mt-0.5">
            Pantau status koneksi WhatsApp CS, traffic pesan masuk/keluar, dan status real-time.
          </p>
        </div>
        <button
          onClick={fetchSessions}
          className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          title="Refresh Data"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Stats row - Clean 3 Card Grid */}
      {sessions.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white border border-gray-200/80 rounded-xl p-5 shadow-xs flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-gray-500 flex items-center gap-1.5 mb-1">
                <Users className="w-4 h-4 text-indigo-500" />
                CS Terdaftar
              </span>
              <div className="text-2xl font-bold text-gray-900">{sessions.length}</div>
              <p className="text-[11px] text-gray-400 mt-1">Total device ditambahkan</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600 font-bold">
              {sessions.length}
            </div>
          </div>

          <div className="bg-white border border-gray-200/80 rounded-xl p-5 shadow-xs flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-gray-500 flex items-center gap-1.5 mb-1">
                <Wifi className="w-4 h-4 text-emerald-500" />
                Aktif Sekarang
              </span>
              <div className="text-2xl font-bold text-emerald-600">{connected}</div>
              <p className="text-[11px] text-gray-400 mt-1">Sesi WhatsApp terhubung live</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600 font-bold">
              {connected}/{sessions.length}
            </div>
          </div>

          <div className="bg-white border border-gray-200/80 rounded-xl p-5 shadow-xs flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-gray-500 flex items-center gap-1.5 mb-1">
                <Reply className="w-4 h-4 text-blue-500" />
                Pesan Terbalas
              </span>
              <div className="text-2xl font-bold text-gray-900">{totalReplies.toLocaleString('id-ID')}</div>
              <p className="text-[11px] text-gray-400 mt-1">{totalIncoming.toLocaleString('id-ID')} pesan pembeli masuk</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600">
              <MessageSquare className="w-5 h-5" />
            </div>
          </div>
        </div>
      )}

      {/* Add CS form */}
      <AddCsForm onAdded={fetchSessions} />

      {/* Info box */}
      <div className="flex gap-3 bg-indigo-50/70 border border-indigo-100 rounded-xl p-4 text-xs md:text-sm text-indigo-900 leading-relaxed">
        <Activity className="w-5 h-5 text-indigo-600 flex-shrink-0 mt-0.5" />
        <div>
          <strong>Cara kerja:</strong> Setiap CS melakukan Scan QR satu kali. Setelah terhubung, seluruh pesan WhatsApp akan dipantau di latar belakang untuk mencatat konversi Meta CAPI, evaluasi respon CS, dan deteksi closing secara otomatis.
        </div>
      </div>

      {/* Sessions list */}
      {loading && (
        <div className="py-12 text-center text-gray-400 flex flex-col items-center gap-2">
          <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
          <span className="text-xs">Memuat daftar perangkat CS...</span>
        </div>
      )}

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={fetchSessions} className="text-xs underline font-semibold hover:text-rose-800">
            Coba lagi
          </button>
        </div>
      )}

      {!loading && sessions.length === 0 && (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200 p-6 space-y-3">
          <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mx-auto text-gray-400">
            <Users className="w-6 h-6" />
          </div>
          <h3 className="font-semibold text-gray-800">Belum ada CS yang didaftarkan</h3>
          <p className="text-xs text-gray-500 max-w-sm mx-auto">
            Klik tombol &quot;Tambah CS Baru&quot; di atas untuk mendaftarkan nomor WhatsApp CS pertama Anda.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            onRefresh={fetchSessions}
          />
        ))}
      </div>
    </div>
  );
}
