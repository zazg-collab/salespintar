'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Sparkles,
  Lightbulb,
  MessageSquare,
  Copy,
  Check,
  ExternalLink,
} from 'lucide-react';
import { LeadItem } from './types';
import { formatWibDateTime } from '../../lib/date';

interface LeadInsightModalProps {
  lead: LeadItem | null;
  isOpen: boolean;
  onClose: () => void;
  getConversionBadge: (status: string) => React.ReactNode;
  getStageBadge: (stage: string, score: number) => React.ReactNode;
  getObjectionDetail: (lead: LeadItem) => {
    type: string;
    shortTag: string;
    tagClass: string;
    label: string;
    summary: string;
    suggestedAction: string;
    followUpScript: string;
  };
  copiedScript: string | null;
  handleCopyScript: (script: string, leadId: string) => void;
}

export const LeadInsightModal: React.FC<LeadInsightModalProps> = ({
  lead,
  isOpen,
  onClose,
  getConversionBadge,
  getStageBadge,
  getObjectionDetail,
  copiedScript,
  handleCopyScript,
}) => {
  if (!isOpen || !lead || typeof document === 'undefined') return null;

  const obj = getObjectionDetail(lead);

  return createPortal(
    <div className="fixed inset-0 z-[99999] w-screen h-screen bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="relative bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-gray-100 p-6 space-y-5 my-auto">
        {/* Header Modal */}
        <div className="flex items-start justify-between border-b border-gray-100 pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-base font-bold text-gray-900">{lead.waNumber}</span>
              {getConversionBadge(lead.conversionStatus)}
              {getStageBadge(lead.leadStage, lead.score)}
            </div>
            <p className="text-xs text-gray-500">
              CS Pemegang: <strong>{lead.assignedCsName || 'CS'}</strong> ({lead.assignedCsPhone || '-'}) • Terakhir Chat: {formatWibDateTime(lead.lastMessageAt)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Banner Minat Produk Teridentifikasi */}
        <div className="p-4 bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl flex items-center justify-between">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-700 block">
              Produk Yang Diminati / Dipesan:
            </span>
            <span className="text-base font-bold text-gray-900 mt-0.5 block">
              {(lead.minatProduk && lead.minatProduk !== 'null' && lead.minatProduk !== 'undefined' && lead.minatProduk !== 'none') ? lead.minatProduk : 'Belum Menentukan Produk'}
            </span>
          </div>
          <div className="text-right">
            <span className="text-[10px] text-gray-500 block font-medium">Skor Minat Beli</span>
            <span className="text-xl font-bold text-indigo-600">{lead.score} / 100</span>
          </div>
        </div>

        {/* Rangkuman Insight Psikologi Pembeli */}
        <div className="space-y-2">
          <h4 className="text-xs font-bold uppercase tracking-wider text-gray-700 flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-indigo-600" />
            Rangkuman Profil & Psikologi Pembeli (AI Profiler)
          </h4>
          <div className="p-4 bg-gray-50 rounded-xl border border-gray-200 text-xs text-gray-700 leading-relaxed space-y-2">
            <p className="font-semibold text-gray-900 text-sm leading-relaxed">
              {lead.lastInsight || 'Belum ada catatan insight mendalam untuk prospek ini.'}
            </p>
            <p className="text-[11px] text-gray-500 pt-2 border-t border-gray-200/60">
              Analisis ini diekstrak otomatis oleh AI dari interaksi chat pembeli: gaya bahasa, respon harga, tingkat urgensi, serta form spesifikasi pesanan yang dikirim ke CS.
            </p>
          </div>
        </div>

        {/* ── OBJECTION & ACTIONABLE FOLLOW-UP INTELLIGENCE (GRID 2 KOLOM) ── */}
        <div className="space-y-2">
          <h4 className="text-xs font-bold uppercase tracking-wider text-gray-700 flex items-center gap-1.5">
            <Lightbulb className="w-4 h-4 text-amber-500" />
            Strategi Follow-Up & Diagnosa Rintangan CS
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Card Kiri: Diagnosa Rintangan & Taktik CS */}
            <div className="p-3.5 bg-gray-50 rounded-xl border border-gray-200 space-y-2.5 flex flex-col justify-between">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-gray-700">
                    🎯 Status Kendala:
                  </span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${obj.tagClass}`}>
                    {obj.shortTag}
                  </span>
                </div>
                <h5 className="font-bold text-gray-900 text-xs">
                  {obj.label}
                </h5>
                <p className="text-[11px] text-gray-600 leading-relaxed">
                  {obj.summary}
                </p>
              </div>

              <div className="p-2.5 bg-indigo-50/70 border border-indigo-100 rounded-lg space-y-1">
                <span className="text-[10px] font-bold text-indigo-900 uppercase flex items-center gap-1">
                  <Lightbulb className="w-3.5 h-3.5 text-amber-500" /> Taktik Penanganan CS:
                </span>
                <p className="text-[11px] text-indigo-950 font-medium leading-relaxed">
                  {obj.suggestedAction}
                </p>
              </div>
            </div>

            {/* Card Kanan: Draft Kalimat Follow-up Siap Pakai */}
            <div className="p-3.5 bg-emerald-50/50 rounded-xl border border-emerald-200 space-y-2.5 flex flex-col justify-between">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-900 flex items-center gap-1 whitespace-nowrap">
                    <MessageSquare className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" /> Draft Chat Siap Kirim
                  </span>
                  <span className="text-[10px] text-emerald-700 font-semibold bg-white px-1.5 py-0.5 rounded border border-emerald-200 whitespace-nowrap flex-shrink-0">
                    WA Ready
                  </span>
                </div>
                <div className="p-2.5 bg-white rounded-lg border border-emerald-200/80 text-[11px] text-gray-800 leading-relaxed font-sans shadow-2xs italic relative">
                  "{obj.followUpScript}"
                </div>
              </div>

              <div className="pt-1 flex items-center gap-2">
                <button
                  onClick={() => handleCopyScript(obj.followUpScript, lead.id)}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition shadow-xs"
                >
                  {copiedScript === lead.id ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-300" />
                      <span>Tersalin ke Clipboard!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Salin Draft Chat</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Parameter Kualifikasi Prospek */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 text-xs">
            <span className="text-[10px] text-gray-400 block font-semibold uppercase">Tahap Corong (Funnel)</span>
            <span className="font-bold text-gray-800 text-sm mt-0.5 block">{lead.leadStage}</span>
          </div>
          <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 text-xs">
            <span className="text-[10px] text-gray-400 block font-semibold uppercase">Status Transaksi</span>
            <span className="font-bold text-gray-800 text-sm mt-0.5 block">{lead.conversionStatus}</span>
          </div>
          <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 text-xs">
            <span className="text-[10px] text-gray-400 block font-semibold uppercase">Volume Interaksi</span>
            <span className="font-bold text-gray-800 text-sm mt-0.5 block">{lead.totalMessages} pesan buffer</span>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between border-t border-gray-100 pt-4">
          <a
            href={`https://wa.me/${lead.waNumber}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition shadow-sm"
          >
            <ExternalLink className="w-4 h-4" /> Buka WhatsApp Pembeli
          </a>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-xs font-semibold transition"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
