"use client";

import React from "react";
import { createPortal } from "react-dom";
import {
  X,
  ExternalLink,
  CheckCircle2,
  CircleDashed,
  Zap,
  Info,
  ShoppingCart,
  UserCheck,
  Eye,
  CreditCard,
} from "lucide-react";
import { LeadItem } from "./types";
import Link from "next/link";

interface CapiFunnelModalProps {
  lead: LeadItem | null;
  isOpen: boolean;
  onClose: () => void;
  getConversionBadge: (status: string) => React.ReactNode;
  getStageBadge: (stage: string, score: number) => React.ReactNode;
}

export function MetaLogoIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2.04c-5.5 0-10 4.49-10 10.02 0 5 3.66 9.15 8.44 9.9v-7H7.9v-2.9h2.54V9.85c0-2.51 1.49-3.89 3.78-3.89 1.09 0 2.23.19 2.23.19v2.47h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.45 2.9h-2.33v7a10 10 0 0 0 8.44-9.9c0-5.53-4.5-10.02-10-10.02Z" />
    </svg>
  );
}

export const CapiFunnelModal: React.FC<CapiFunnelModalProps> = ({
  lead,
  isOpen,
  onClose,
  getConversionBadge,
  getStageBadge,
}) => {
  if (!isOpen || !lead || typeof document === "undefined") return null;

  const eventsSent = lead.capiEventsSent || [];
  const hasViewContent = eventsSent.includes("ViewContent");
  const hasLead = eventsSent.includes("Lead");
  const hasAddToCart = eventsSent.includes("AddToCart");
  const hasPurchase = eventsSent.includes("Purchase") || lead.conversionStatus === "CLOSING" || lead.conversionStatus === "REPEAT_ORDER";

  const funnelSteps = [
    {
      id: "ViewContent",
      name: "Pesan Pertama (ViewContent)",
      icon: Eye,
      isSent: hasViewContent,
      description: "Ditransmisikan saat pembeli pertama kali mengirim pesan dari iklan atau mengisi form pemesanan.",
      stageRequired: "COLD (Pesan Baru)",
    },
    {
      id: "Lead",
      name: "Minat Produk (Lead)",
      icon: UserCheck,
      isSent: hasLead,
      description: "Ditransmisikan saat pembeli menunjukkan ketertarikan nyata (bertanya harga, ongkir, spesifikasi produk).",
      stageRequired: "WARM (Minat Produk)",
    },
    {
      id: "AddToCart",
      name: "Niat Beli (AddToCart)",
      icon: ShoppingCart,
      isSent: hasAddToCart,
      description: "Ditransmisikan saat pembeli meminta rincian total biaya COD atau meminta nomor rekening transfer.",
      stageRequired: "HOT (Niat Beli)",
    },
    {
      id: "Purchase",
      name: "Transaksi Deal (Purchase)",
      icon: CreditCard,
      isSent: hasPurchase,
      description: "Ditransmisikan saat pembayaran transfer berhasil diverifikasi atau pemesanan COD telah terkonfirmasi.",
      stageRequired: "CLOSING / REPEAT ORDER",
    },
  ];

  const sentCount = funnelSteps.filter((s) => s.isSent).length;
  const progressPercent = Math.round((sentCount / funnelSteps.length) * 100);

  return createPortal(
    <div className="fixed inset-0 z-[99999] w-screen h-screen bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="relative bg-white rounded-2xl max-w-xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-gray-100 p-6 space-y-5 my-auto animate-in fade-in zoom-in-95 duration-150">
        {/* Header Modal */}
        <div className="flex items-start justify-between border-b border-gray-100 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-[#0668E1] shadow-2xs">
              <MetaLogoIcon className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-gray-900">Funnel Meta Conversions API</h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-300">
                  CAPI v2
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                Status sinkronisasi event konversi server-side ke Meta Ads Manager
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Lead Info Banner */}
        <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-xl flex flex-wrap items-center justify-between gap-2.5">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-bold text-gray-900">
                {lead.name ? `${lead.name} (${lead.waNumber})` : lead.waNumber}
              </span>
            </div>
            <p className="text-[11px] text-gray-500">
              Kategori: <strong className="text-indigo-700">{lead.leadCategory || "PROSPEK_IKLAN"}</strong> • CS: {lead.assignedCsName || "CS"}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {getStageBadge(lead.leadStage, lead.score)}
            {getConversionBadge(lead.conversionStatus)}
          </div>
        </div>

        {/* Progress Bar Funnel */}
        <div className="p-4 bg-gradient-to-r from-blue-50/70 via-indigo-50/40 to-slate-50 border border-blue-100 rounded-xl space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-800 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-blue-600" />
              Kemajuan Funnel Meta
            </span>
            <span className="font-bold text-blue-700">
              {sentCount} dari {funnelSteps.length} Event ({progressPercent}%)
            </span>
          </div>
          <div className="w-full bg-blue-200/60 rounded-full h-2 overflow-hidden">
            <div
              className="bg-gradient-to-r from-blue-600 to-indigo-600 h-2 rounded-full transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* Timeline Events List */}
        <div className="space-y-3">
          <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wider">
            Rincian Status 4 Event CAPI
          </h4>

          <div className="space-y-2.5">
            {funnelSteps.map((step, idx) => {
              const StepIcon = step.icon;
              return (
                <div
                  key={step.id}
                  className={`p-3.5 rounded-xl border transition-all ${
                    step.isSent
                      ? "bg-emerald-50/40 border-emerald-200/80 shadow-2xs"
                      : "bg-white border-gray-200/80 opacity-75"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${
                          step.isSent
                            ? "bg-emerald-100 text-emerald-700 border border-emerald-300"
                            : "bg-gray-100 text-gray-400 border border-gray-200"
                        }`}
                      >
                        <StepIcon className="w-3.5 h-3.5" />
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-gray-900">
                            {idx + 1}. {step.name}
                          </span>
                          <span className="text-[10px] text-gray-500 font-mono">
                            [{step.stageRequired}]
                          </span>
                        </div>
                        <p className="text-[11px] text-gray-600 leading-relaxed">
                          {step.description}
                        </p>
                      </div>
                    </div>

                    <div className="flex-shrink-0">
                      {step.isSent ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 shadow-2xs">
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                          Terkirim
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500 border border-gray-200">
                          <CircleDashed className="w-3 h-3 text-gray-400" />
                          Belum
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer info & Actions */}
        <div className="pt-3 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <Info className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
            <span>Event CAPI dikirim otomatis & terdeduplikasi oleh Meta.</span>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <Link
              href="/app/meta-capi-dashboard"
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition w-full sm:w-auto"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Buka Dashboard Ads
            </Link>
            <button
              onClick={onClose}
              className="inline-flex items-center justify-center px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-lg transition shadow-sm w-full sm:w-auto"
            >
              Tutup
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
