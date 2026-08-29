'use client';

// Chunk (g) bagian 4 -- Fase 4 (Cowork, 2026-08-28)
//
// Blok "Budget Auto-Pilot Center" utk /app/ai-ads. Ditambahkan BERDAMPINGAN dgn 3 blok Action
// Center lama (SentinelRadarBlock/ActionQueueBlock/AuditTrailBlock di page.tsx) -- SENGAJA TIDAK
// mengganti sistem lama itu. Keduanya sistem yang VALID & BEDA fungsi (dicek langsung ke
// schema.prisma & blueprint sebelum coding, bukan asumsi dari riset awal):
//   - Action Center lama (AiAdsRecommendation, shiftType MORNING_EARLY_KILL/dst) = Mode 1 di
//     blueprint -- rekomendasi 3x/hari dari cron run_shift.py, WAJIB approval manusia per rekomendasi.
//   - Budget Auto-Pilot Center (blok ini) = Mode 2 -- sentinel_scan.py tick 30 menit, mode
//     SEMI_AUTO (approval manusia per-antrean, endpoint sama polanya) atau FULL_AUTO (auto-approve,
//     belum ada di UI ini -- toggle mode-nya ADA di config, tapi eksekusi FULL_AUTO otomatis itu
//     kerjaan backend/sentinel_scan.py sendiri, bukan hal yang di-drive dari sini).
//
// Semua endpoint di bawah SUDAH ADA & LENGKAP di backend/src/routes/ai-ads.routes.ts (dicek
// langsung sebelum coding blok ini -- TIDAK ADA perubahan backend sama sekali utk bagian 4):
//   GET  /ai-ads/automation/status          -> { configured, config, pendingCount, last24hActions }
//   PUT  /ai-ads/automation/config          -> simpan MetaAutopilotConfig (ADMIN)
//   GET  /ai-ads/automation/queue           -> antrean AdBudgetActionHistory (executedAt: null)
//   POST /ai-ads/automation/execute         -> { id, decision: APPROVE|REJECT } (ADMIN)
//   POST /ai-ads/automation/emergency-brake -> { active: boolean } (ADMIN) -- kill switch
//
// `tacticalBadge` di tiap item antrean (WINNER/BLEEDER/FATIGUED) dirender pakai component
// `TacticalBadge` dari Chunk (g) bagian 1 -- inilah pemakaian pertamanya di halaman sungguhan.

import { useEffect, useState, type FormEvent } from 'react';
import {
  Bot,
  Loader2,
  AlertTriangle,
  Check,
  X as XIcon,
  Settings2,
  Siren,
  RefreshCw,
} from 'lucide-react';
import { apiGet, apiPost, apiPut } from '../../lib/api';
import { TacticalBadge } from './TacticalBadge';

type AutopilotMode = 'SEMI_AUTO' | 'FULL_AUTO';

interface AutopilotConfig {
  mode: AutopilotMode;
  maxDailySpendTotal: string;
  targetRoas: string;
  targetCpa: string;
  autoScaleEnabled: boolean;
  autoReduceEnabled: boolean;
  autoKillEnabled: boolean;
  emergencyBrakeActive: boolean;
}

interface AutopilotStatus {
  configured: boolean;
  config: AutopilotConfig | null;
  pendingCount: number;
  last24hActions: number;
}

interface QueueItem {
  id: string;
  adAccountId: string;
  campaignName: string;
  adSetName: string;
  tacticalBadge: string;
  actionType: string;
  triggerReason: string;
  previousBudget: string;
  newBudget: string;
  shiftType: string;
  executionMode: string;
  createdAt: string;
}

function formatRupiah(v: string): string {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return v;
  return `Rp${Math.round(n).toLocaleString('id-ID')}`;
}

// Form config -- dipisah state string per field (input number di React paling gampang dikontrol
// sbg string, di-parse ke number cuma pas submit) supaya user bisa ngetik bebas tanpa NaN loncat2.
function ConfigForm({
  initial,
  onSaved,
}: {
  initial: AutopilotConfig | null;
  onSaved: (config: AutopilotConfig) => void;
}) {
  const [mode, setMode] = useState<AutopilotMode>(initial?.mode ?? 'SEMI_AUTO');
  const [maxDailySpendTotal, setMaxDailySpendTotal] = useState(initial?.maxDailySpendTotal ?? '');
  const [targetRoas, setTargetRoas] = useState(initial?.targetRoas ?? '');
  const [targetCpa, setTargetCpa] = useState(initial?.targetCpa ?? '');
  const [autoScaleEnabled, setAutoScaleEnabled] = useState(initial?.autoScaleEnabled ?? true);
  const [autoReduceEnabled, setAutoReduceEnabled] = useState(initial?.autoReduceEnabled ?? true);
  const [autoKillEnabled, setAutoKillEnabled] = useState(initial?.autoKillEnabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const payload = {
      mode,
      maxDailySpendTotal: parseFloat(maxDailySpendTotal) || 0,
      targetRoas: parseFloat(targetRoas) || 0,
      targetCpa: parseFloat(targetCpa) || 0,
      autoScaleEnabled,
      autoReduceEnabled,
      autoKillEnabled,
    };
    setSaving(true);
    try {
      const res = await apiPut<{ ok: boolean; config: AutopilotConfig }>('/ai-ads/automation/config', payload);
      onSaved(res.config);
    } catch (e) {
      setError((e as Error).message || 'Gagal menyimpan konfigurasi. Butuh akses ADMIN.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-4">
      {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2 text-xs">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Mode</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as AutopilotMode)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="SEMI_AUTO">Semi-Auto (butuh approval manual)</option>
            <option value="FULL_AUTO">Full-Auto (eksekusi otomatis)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Max Spend Harian Total (Rp)</label>
          <input
            type="number"
            value={maxDailySpendTotal}
            onChange={(e) => setMaxDailySpendTotal(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            placeholder="mis. 5000000"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Target ROAS</label>
          <input
            type="number"
            step="0.1"
            value={targetRoas}
            onChange={(e) => setTargetRoas(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            placeholder="mis. 3"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Target CPA (Rp)</label>
          <input
            type="number"
            value={targetCpa}
            onChange={(e) => setTargetCpa(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            placeholder="mis. 50000"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-1.5 text-xs text-gray-700">
          <input type="checkbox" checked={autoScaleEnabled} onChange={(e) => setAutoScaleEnabled(e.target.checked)} />
          Izinkan Auto-Scale
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-700">
          <input type="checkbox" checked={autoReduceEnabled} onChange={(e) => setAutoReduceEnabled(e.target.checked)} />
          Izinkan Auto-Reduce
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-700">
          <input type="checkbox" checked={autoKillEnabled} onChange={(e) => setAutoKillEnabled(e.target.checked)} />
          Izinkan Auto-Kill
        </label>
      </div>

      <button
        type="submit"
        disabled={saving}
        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Settings2 className="w-3.5 h-3.5" />}
        Simpan Konfigurasi
      </button>
    </form>
  );
}

export default function BudgetAutoPilotBlock() {
  const [status, setStatus] = useState<AutopilotStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [showConfig, setShowConfig] = useState(false);

  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const [brakeBusy, setBrakeBusy] = useState(false);

  async function loadStatus() {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await apiGet<AutopilotStatus>('/ai-ads/automation/status');
      setStatus(res);
      setShowConfig(!res.configured);
    } catch (e) {
      setStatusError((e as Error).message || 'Gagal memuat status Autopilot.');
    } finally {
      setStatusLoading(false);
    }
  }

  async function loadQueue() {
    setQueueLoading(true);
    setQueueError(null);
    try {
      const res = await apiGet<{ items: QueueItem[]; count: number }>('/ai-ads/automation/queue');
      setQueue(res.items);
    } catch (e) {
      setQueueError((e as Error).message || 'Gagal memuat antrean Autopilot.');
    } finally {
      setQueueLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
    loadQueue();
  }, []);

  async function handleDecision(item: QueueItem, decision: 'APPROVE' | 'REJECT') {
    setActingId(item.id);
    try {
      await apiPost('/ai-ads/automation/execute', { id: item.id, decision });
      setQueue((prev) => (prev ?? []).filter((x) => x.id !== item.id));
      loadStatus();
    } catch (e) {
      setQueueError((e as Error).message || 'Gagal memproses keputusan. Butuh akses ADMIN.');
    } finally {
      setActingId(null);
    }
  }

  async function handleEmergencyBrake(active: boolean) {
    setBrakeBusy(true);
    try {
      await apiPost<{ ok: boolean; emergencyBrakeActive: boolean }>('/ai-ads/automation/emergency-brake', { active });
      loadStatus();
    } catch (e) {
      setStatusError((e as Error).message || 'Gagal mengubah Emergency Brake. Butuh akses ADMIN.');
    } finally {
      setBrakeBusy(false);
    }
  }

  const brakeActive = status?.config?.emergencyBrakeActive ?? false;

  return (
    <div className="bg-white border border-gray-200 rounded-2xl shadow-xs overflow-hidden">
      <div className="border-b border-gray-100 px-5 py-4 flex items-center justify-between flex-wrap gap-3 bg-gradient-to-r from-indigo-50 to-white">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-900">⚡ Budget Auto-Pilot Center</h2>
            <p className="text-[11px] text-gray-500">
              Real-time, tick 30 menit (Sentinel Layer 1-17) — beda dari rekomendasi shift di atas yang 3x/hari.
            </p>
          </div>
        </div>
        <button
          onClick={() => handleEmergencyBrake(!brakeActive)}
          disabled={brakeBusy || statusLoading}
          className={`flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${
            brakeActive
              ? 'bg-rose-600 hover:bg-rose-700 text-white'
              : 'bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-300'
          }`}
          title="Emergency Brake -- kill switch, hentikan semua eksekusi Autopilot"
        >
          <Siren className="w-3.5 h-3.5" />
          {brakeActive ? 'Emergency Brake AKTIF -- Klik utk Matikan' : 'Emergency Brake'}
        </button>
      </div>

      <div className="p-5 space-y-4">
        {statusError && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2 text-xs flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {statusError}
          </div>
        )}

        {statusLoading ? (
          <div className="text-sm text-gray-400 flex items-center gap-2 py-4 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Memuat status…</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className={`px-2 py-1 rounded font-semibold ${status?.configured ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                {status?.configured ? `Mode: ${status.config?.mode}` : 'Belum dikonfigurasi'}
              </span>
              <span className="text-gray-500">Antrean pending: <strong className="text-gray-800">{status?.pendingCount ?? 0}</strong></span>
              <span className="text-gray-500">Aksi 24 jam terakhir: <strong className="text-gray-800">{status?.last24hActions ?? 0}</strong></span>
              <button
                onClick={() => setShowConfig((v) => !v)}
                className="ml-auto text-indigo-600 hover:text-indigo-800 font-semibold flex items-center gap-1"
              >
                <Settings2 className="w-3.5 h-3.5" /> {showConfig ? 'Sembunyikan Konfigurasi' : 'Ubah Konfigurasi'}
              </button>
            </div>

            {showConfig && (
              <ConfigForm
                initial={status?.config ?? null}
                onSaved={(config) => setStatus((prev) => (prev ? { ...prev, configured: true, config } : prev))}
              />
            )}
          </>
        )}

        <div className="pt-2 border-t border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide">Antrean Keputusan</h3>
            <button onClick={loadQueue} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> Muat ulang
            </button>
          </div>

          {queueError && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2 text-xs mb-2">{queueError}</div>}

          {queueLoading ? (
            <div className="text-sm text-gray-400 flex items-center gap-2 py-4 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Memuat…</div>
          ) : !queue || queue.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-6 bg-gray-50 rounded-xl border border-gray-100">
              Tidak ada antrean keputusan saat ini.
            </div>
          ) : (
            <div className="space-y-2.5">
              {queue.map((item) => (
                <div key={item.id} className="border border-gray-200 rounded-xl p-3.5 space-y-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <TacticalBadge badge={item.tacticalBadge} />
                      <span className="text-xs font-mono text-gray-400">{item.actionType}</span>
                    </div>
                    <span className="text-sm font-semibold text-gray-900 truncate max-w-[240px]" title={item.campaignName}>
                      {item.campaignName}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">{item.adSetName}</p>
                  <div className="flex items-center gap-2 text-xs text-gray-700">
                    <span>{formatRupiah(item.previousBudget)}</span>
                    <span className="text-gray-400">→</span>
                    <span className="font-semibold">{formatRupiah(item.newBudget)}</span>
                  </div>
                  <p className="text-xs text-gray-600 bg-gray-50 rounded-lg px-2.5 py-1.5">{item.triggerReason}</p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      disabled={actingId === item.id}
                      onClick={() => handleDecision(item, 'APPROVE')}
                      className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                    >
                      <Check className="w-3.5 h-3.5" /> Approve
                    </button>
                    <button
                      disabled={actingId === item.id}
                      onClick={() => handleDecision(item, 'REJECT')}
                      className="flex items-center gap-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                    >
                      <XIcon className="w-3.5 h-3.5" /> Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
