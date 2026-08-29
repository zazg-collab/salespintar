'use client';

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Calendar,
  X,
  RefreshCw,
  AlertCircle,
  Clock,
  CheckCircle2,
  XCircle,
  Truck,
  Sparkles,
  ExternalLink,
  Check,
  Copy,
} from 'lucide-react';
import { apiGet } from '../../lib/api';
import { CustomerTimelineResult } from './types';

interface CustomerTimelineModalProps {
  waNumber: string | null;
  isOpen: boolean;
  onClose: () => void;
  getConversionBadge: (status: string) => React.ReactNode;
}

export const CustomerTimelineModal: React.FC<CustomerTimelineModalProps> = ({
  waNumber,
  isOpen,
  onClose,
  getConversionBadge,
}) => {
  const [timelineData, setTimelineData] = useState<CustomerTimelineResult | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [copiedTimeline, setCopiedTimeline] = useState(false);

  useEffect(() => {
    if (!isOpen || !waNumber) {
      setTimelineData(null);
      setTimelineError(null);
      return;
    }
    let isCancelled = false;
    setTimelineLoading(true);
    setTimelineError(null);

    apiGet<{ success: boolean; data: CustomerTimelineResult }>(`/leads/${waNumber}/timeline`)
      .then((res: any) => {
        if (!isCancelled) {
          if (res && res.data) {
            setTimelineData(res.data);
          } else {
            setTimelineData(res);
          }
        }
      })
      .catch((err: any) => {
        if (!isCancelled) {
          setTimelineError(err.message || 'Gagal memuat riwayat timeline perjalanan pembeli.');
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setTimelineLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [isOpen, waNumber]);

  if (!isOpen || !waNumber || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-hidden flex flex-col relative animate-in slide-in-from-bottom-4 duration-300">
        {/* Header */}
        <div className="bg-gradient-to-r from-indigo-700 via-indigo-800 to-slate-900 p-5 shrink-0 text-white flex items-center justify-between shadow-md">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-white/10 rounded-xl backdrop-blur-md border border-white/10 text-indigo-200">
              <Calendar className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-lg text-white">Timeline Perjalanan Pembeli</h3>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/40 text-indigo-100 border border-indigo-400/30">
                  Customer 360°
                </span>
              </div>
              <p className="text-indigo-200 text-xs mt-0.5 flex items-center gap-1.5">
                Nomor WhatsApp: <span className="font-mono font-bold text-white bg-white/10 px-1.5 py-0.5 rounded">{waNumber}</span>
                {timelineData?.name && <span className="text-white/80">• An. {timelineData.name}</span>}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-colors"
            title="Tutup (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Customer Summary KPI Bar */}
        {timelineData && (
          <div className="bg-slate-50 border-b border-gray-200/80 px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2">
              {timelineData.isRepeatBuyer ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-800 font-bold border border-emerald-300">
                  <span>👑</span> REPEAT BUYER ({timelineData.totalClosings || timelineData.totalOrders}x Transaksi)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 font-bold border border-indigo-200">
                  <span>🎯</span> FIRST ORDER (Pelanggan Baru)
                </span>
              )}
              <span className="text-gray-400">•</span>
              <span className="text-gray-600">
                CS Pemegang: <strong className="text-gray-900">{timelineData.assignedCsName}</strong>
              </span>
            </div>
            <div className="flex items-center gap-4 text-gray-700">
              <div>
                <span className="text-gray-400 block text-[10px] uppercase font-bold">Total Nilai LTV</span>
                <span className="font-bold text-emerald-600 font-mono text-sm">
                  Rp {timelineData.totalLifetimeValue?.toLocaleString('id-ID') || 0}
                </span>
              </div>
              <div className="border-l border-gray-200 pl-4">
                <span className="text-gray-400 block text-[10px] uppercase font-bold">Siklus Penjualan</span>
                <span className="font-bold text-indigo-600 font-mono text-sm">
                  {timelineData.salesCycleDays || 0} Hari
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Content Body (Scrollable) */}
        <div className="p-5 overflow-y-auto flex-1 bg-gray-50/50 space-y-6">
          {timelineLoading && (
            <div className="py-16 text-center text-gray-400 space-y-3">
              <RefreshCw className="w-8 h-8 animate-spin mx-auto text-indigo-500" />
              <p className="text-sm font-medium text-gray-600">Menyusun kronologi perjalanan pembeli...</p>
            </div>
          )}

          {timelineError && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 flex gap-3 text-rose-800 items-start">
              <AlertCircle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-bold">Gagal Memuat Timeline</p>
                <p className="text-rose-700 text-xs mt-0.5">{timelineError}</p>
              </div>
            </div>
          )}

          {!timelineLoading && !timelineError && timelineData?.orderGroups && (
            <div className="space-y-6">
              {timelineData.orderGroups.map((group, gIdx) => (
                <div key={group.leadId || gIdx} className="space-y-4">
                  {/* Penanda Jeda Waktu (Multi-Day Gap) jika ada */}
                  {group.gapDaysFromPrevious && group.gapDaysFromPrevious > 0 && (
                    <div className="relative flex items-center justify-center my-6">
                      <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-dashed border-indigo-300"></div>
                      </div>
                      <div className="relative bg-indigo-50 border border-indigo-200 text-indigo-800 text-xs font-bold px-3 py-1 rounded-full shadow-sm flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-indigo-600" />
                        <span>⏳ Jeda {group.gapDaysFromPrevious} Hari Berlalu — Pelanggan Kembali Menghubungi</span>
                      </div>
                    </div>
                  )}

                  {/* Kartu Order Group */}
                  <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden transition-all hover:border-indigo-300">
                    {/* Order Header */}
                    <div className="bg-gradient-to-r from-gray-50 to-indigo-50/40 p-4 border-b border-gray-200/80 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-indigo-600 text-white font-bold text-xs shadow-sm">
                          #{group.orderNumber}
                        </span>
                        <div>
                          <h4 className="font-bold text-gray-900 text-sm flex items-center gap-2">
                            <span>{group.product}</span>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                              group.category === 'PROSPEK_IKLAN'
                                ? 'bg-indigo-100 text-indigo-700 border border-indigo-200'
                                : 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                            }`}>
                              {group.categoryLabel}
                            </span>
                          </h4>
                          <p className="text-gray-500 text-[11px] mt-0.5">
                            CS: <strong className="text-gray-700">{group.csName}</strong> • {group.startDateWib}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {getConversionBadge(group.conversionStatus)}
                        <span className="font-bold text-gray-900 font-mono text-xs bg-white px-2 py-1 rounded-md border border-gray-200">
                          Rp {group.estimatedValue?.toLocaleString('id-ID') || 0}
                        </span>
                      </div>
                    </div>

                    {/* Milestones Flow */}
                    <div className="p-4 space-y-4">
                      <div className="relative pl-6 space-y-5 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-indigo-100">
                        {group.events?.map((event, eIdx) => {
                          const isClosingEvent = (event.type === 'DEAL_CONVERSION' && (group.conversionStatus === 'CLOSING' || group.conversionStatus === 'REPEAT_ORDER'));
                          const isLostEvent = event.type === 'DEAL_CONVERSION' && group.conversionStatus === 'LOST';
                          const isRtsEvent = event.type === 'RTS_VALIDATION';
                          const isInbound = event.type === 'FIRST_INBOUND';

                          return (
                            <div key={event.id || eIdx} className="relative group">
                              {/* Dot Ikon */}
                              <div className={`absolute -left-[27px] top-0.5 flex items-center justify-center w-5 h-5 rounded-full border-2 bg-white ${
                                isClosingEvent
                                  ? 'border-emerald-500 text-emerald-600'
                                  : isLostEvent
                                  ? 'border-rose-500 text-rose-600'
                                  : isRtsEvent
                                  ? 'border-amber-500 text-amber-600'
                                  : isInbound
                                  ? 'border-indigo-500 text-indigo-600'
                                  : 'border-blue-400 text-blue-500'
                              }`}>
                                {isClosingEvent ? (
                                  <CheckCircle2 className="w-3 h-3" />
                                ) : isLostEvent ? (
                                  <XCircle className="w-3 h-3" />
                                ) : isRtsEvent ? (
                                  <Truck className="w-3 h-3" />
                                ) : isInbound ? (
                                  <Sparkles className="w-3 h-3" />
                                ) : (
                                  <Clock className="w-3 h-3" />
                                )}
                              </div>

                              {/* Event Content */}
                              <div className="bg-gray-50/70 p-3 rounded-xl border border-gray-100 space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                  <h5 className="font-bold text-gray-900 text-xs">{event.title}</h5>
                                  <time className="font-mono text-[11px] text-gray-500 whitespace-nowrap">
                                    {event.timestampWib}
                                  </time>
                                </div>
                                <p className="text-gray-600 text-xs leading-relaxed">{event.description}</p>
                                {event.badge && (
                                  <div className="pt-1">
                                    <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded ${
                                      event.badge.color === 'emerald'
                                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                        : event.badge.color === 'rose'
                                        ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                        : event.badge.color === 'amber'
                                        ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                        : 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                                    }`}>
                                      {event.badge.text}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200/80 bg-white flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <a
              href={`https://wa.me/${waNumber}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition shadow-sm"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Buka Chat WhatsApp
            </a>
            <button
              onClick={() => {
                if (timelineData) {
                  const summary = `Riwayat Pembeli: ${timelineData.name} (${timelineData.waNumber})\nTotal Transaksi: ${timelineData.totalOrders} order (LTV: Rp ${timelineData.totalLifetimeValue?.toLocaleString('id-ID')})\nCS: ${timelineData.assignedCsName}\nStatus: ${timelineData.currentConversion}`;
                  navigator.clipboard.writeText(summary);
                  setCopiedTimeline(true);
                  setTimeout(() => setCopiedTimeline(false), 2000);
                }
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl text-xs font-semibold transition"
            >
              {copiedTimeline ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedTimeline ? 'Tersalin!' : 'Salin Ringkasan'}</span>
            </button>
          </div>
          <button
            onClick={onClose}
            className="px-5 py-2 text-xs font-bold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
