'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Lightbulb,
  Truck,
  ShieldCheck,
  CheckCircle2,
  Info,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react';
import { LeadItem } from './types';
import { formatWibDateTime } from '../../lib/date';

interface RtsAuditModalProps {
  lead: LeadItem | null;
  isOpen: boolean;
  onClose: () => void;
  getConversionBadge: (status: string) => React.ReactNode;
  getStageBadge: (stage: string, score: number) => React.ReactNode;
}

export const RtsAuditModal: React.FC<RtsAuditModalProps> = ({
  lead,
  isOpen,
  onClose,
  getConversionBadge,
  getStageBadge,
}) => {
  if (!isOpen || !lead || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[99999] w-screen h-screen bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="relative bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-gray-100 p-6 space-y-5 my-auto">
        {/* Header Modal */}
        <div className="flex items-start justify-between border-b border-gray-100 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-base font-bold text-gray-900">{lead.waNumber}</span>
              {getConversionBadge(lead.conversionStatus)}
              {getStageBadge(lead.leadStage, lead.score)}
            </div>
            <p className="text-xs text-gray-500 mt-1">
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

        {/* Rekomendasi Ekspedisi Otomatis di Layar CRM / Packing */}
        <div className={`p-4 rounded-xl border space-y-1.5 ${
          lead.courierRecommendation 
            ? 'bg-gradient-to-r from-emerald-50 to-teal-50 border-emerald-200'
            : 'bg-gray-50 border-gray-200'
        }`}>
          <div className="flex items-center gap-2 font-bold text-xs">
            <Lightbulb className="w-4 h-4 text-amber-500" />
            <span className={lead.courierRecommendation ? 'text-emerald-900' : 'text-gray-700'}>
              SARAN OTOMATIS EKSPEDISI / PACKING:
            </span>
          </div>
          <div className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <Truck className={`w-5 h-5 ${lead.courierRecommendation ? 'text-emerald-600' : 'text-gray-400'}`} />
            <span>
              {lead.courierRecommendation ? (
                `Rekomendasi Ekspedisi: Kirim pakai ${lead.courierRecommendation}`
              ) : (
                'Belum Ada Rekomendasi Kurir Khusus (Bebas Pilih Ekspedisi Rekanan Toko)'
              )}
            </span>
          </div>
          <p className={`text-xs leading-relaxed ${lead.courierRecommendation ? 'text-emerald-700' : 'text-gray-500'}`}>
            {lead.courierRecommendation
              ? `Kurir di atas memiliki riwayat keberhasilan pengantaran tertinggi ke pembeli ini berdasarkan database logistik Mengantar.`
              : `Nomor ini belum memiliki riwayat pengantaran di database Mengantar. Evaluasi risiko retur murni dihitung dari kualitas chat CS.`}
          </p>
        </div>

        {/* Analisis 2-Layer Anti-RTS Firewall */}
        <div className="space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-gray-700 flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            Audit 2-Layer Anti-RTS Firewall
          </h4>

          {/* Layer 1: Audit Chat AI (Kualitas Chat CS) */}
          <div className="p-3.5 bg-gray-50 rounded-xl border border-gray-200 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-gray-800 block">
                  Layer 1: Audit Kualitas Chat CS (Bobot 65%)
                </span>
                <span className="text-[11px] text-gray-500">
                  Evaluasi SOP CS: Persetujuan pembeli, patokan rumah, rincian COD & kesiapan uang tunai.
                </span>
              </div>
              <span className="px-2 py-0.5 rounded text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                Audit SOP CS
              </span>
            </div>

            <div className="text-xs text-gray-600 space-y-1 pt-1.5 border-t border-gray-200/60">
              <div className="font-semibold text-gray-700">Temuan SOP Percakapan:</div>
              {(() => {
                if (lead.conversionStatus === 'PENDING') {
                  return (
                    <p className="text-amber-800 bg-amber-50 p-2 rounded-lg border border-amber-200/60 leading-relaxed">
                      ℹ️ <strong>Masih Tahap Follow Up / Tanya-Jawab:</strong> Prospek belum melakukan pemesanan (deal). Audit kelengkapan alamat dan SOP komitmen COD akan aktif otomatis saat prospek mencapai tahap Closing.
                    </p>
                  );
                }
                if (lead.conversionStatus === 'LOST') {
                  return (
                    <p className="text-gray-500 italic bg-gray-100/70 p-2 rounded-lg border border-gray-200/60">
                      ❌ Percakapan selesai tanpa transaksi (batal beli / tidak ada pengiriman paket).
                    </p>
                  );
                }

                // Langkah E Fase 27 (Temuan T7, kritis): dicek SEBELUM filter chatFindings
                // di bawah dengan sengaja. Sentinel EVALUATION_FAILED (Langkah D Fase 26)
                // mengandung kata "RTS" di teksnya sendiri ("Evaluasi RTS gagal
                // dijalankan..."), jadi filter `!r.includes('rts')` di bawah ini justru
                // MEMBUANG alasan sentinel itu -- chatFindings jadi kosong dan modal
                // fallback ke pesan hijau "Seluruh SOP closing CS terpenuhi" yang salah
                // total. Ditangani lebih dulu di sini supaya tidak pernah sampai ke filter itu.
                if (lead.rtsRiskLevel === 'EVALUATION_FAILED') {
                  return (
                    <div className="flex items-center gap-2 text-amber-800 bg-amber-50 p-2.5 rounded-lg border border-amber-200 text-xs">
                      <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                      <span>
                        Evaluasi RTS gagal dijalankan karena error teknis -- alamat & SOP closing <strong>BELUM tervalidasi</strong>, wajib dicek manual sebelum kirim COD.
                      </span>
                    </div>
                  );
                }

                // Status CLOSING / REPEAT_ORDER
                const chatFindings = (lead.rtsReasons || []).filter(
                  (r: string) =>
                    !r.toLowerCase().includes('mengantar') &&
                    !r.toLowerCase().includes('riwayat logistik') &&
                    !r.toLowerCase().includes('rts') &&
                    !r.toLowerCase().includes('tingkat pengiriman') &&
                    !r.toLowerCase().includes('pengiriman sukses')
                );

                if (chatFindings.some((r: string) => r.toLowerCase().includes('belum tersinkronisasi') || r.toLowerCase().includes('kosong atau tidak terdeteksi'))) {
                  return (
                    <div className="flex items-center gap-2 text-slate-700 bg-slate-100 p-2.5 rounded-lg border border-slate-200 text-xs">
                      <Info className="w-4 h-4 text-slate-500 flex-shrink-0" />
                      <span>Transkrip percakapan belum tersinkronisasi. Evaluasi SOP CS akan otomatis aktif saat riwayat chat masuk.</span>
                    </div>
                  );
                }

                if (chatFindings.length > 0 && chatFindings[0] !== 'SOP percakapan CS terpenuhi & komitmen pembeli terpantau baik' && chatFindings[0] !== 'Kualitas transaksi dan komitmen pembeli terpantau baik') {
                  return (
                    <ul className="list-disc list-inside space-y-1 text-gray-600">
                      {chatFindings.map((reason: string, i: number) => (
                        <li key={i} className={reason.includes('rawan') || reason.includes('tidak') || reason.includes('minim') || reason.includes('dipaksa') || reason.includes('belum') ? 'text-amber-800 font-medium' : ''}>
                          {reason}
                        </li>
                      ))}
                    </ul>
                  );
                }
                return (
                  <div className="flex items-center gap-1.5 text-emerald-800 bg-emerald-50 p-2 rounded-lg border border-emerald-200/60">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                    <span>Seluruh SOP closing CS terpenuhi (Persetujuan deal jelas, alamat lengkap, dan komitmen COD terkonfirmasi).</span>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Layer 2: Riwayat Logistik Mengantar */}
          <div className="p-3.5 bg-gray-50 rounded-xl border border-gray-200 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-gray-800 block">
                  Layer 2: Riwayat Pengiriman Ekspedisi Mengantar (Bobot 35%)
                </span>
                <span className="text-[11px] text-gray-500">
                  Basis data multi-kurir Mengantar (keberhasilan kirim vs retur per kurir).
                </span>
              </div>
              {lead.mengantarData?.totalOrders ? (
                <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                  lead.mengantarData.isHighRisk 
                    ? 'bg-rose-50 text-rose-700 border border-rose-200' 
                    : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                }`}>
                  {lead.mengantarData.overallDeliveryRate}% Sukses
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                  Nomor Baru
                </span>
              )}
            </div>

            {/* Catatan Logistik Khusus Mengantar */}
            {lead.mengantarData?.riskReasons && lead.mengantarData.riskReasons.length > 0 && (
              <div className="p-2 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 space-y-0.5">
                <div className="font-bold flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
                  Catatan Logistik Mengantar:
                </div>
                <ul className="list-disc list-inside space-y-0.5 pl-1">
                  {lead.mengantarData.riskReasons.map((r: string, i: number) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Kurir Breakdown */}
            {lead.mengantarData?.courierBreakdown && Object.keys(lead.mengantarData.courierBreakdown).length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
                {Object.entries(lead.mengantarData.courierBreakdown).map(([courier, data]: [string, any]) => (
                  <div key={courier} className="p-2.5 bg-white rounded-lg border border-gray-200 text-xs shadow-xs">
                    <div className="font-bold text-gray-900 flex items-center justify-between">
                      <span>{courier}</span>
                      <span className="text-[10px] text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded font-semibold">
                        Rate {data.rate}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-600 mt-1">
                      Sukses: <strong className="text-emerald-600">{data.delivered || 0}</strong> / {data.total || 0}
                    </div>
                    <div className="text-[10px] text-rose-600 font-medium">
                      Retur (RTS): {data.rts || 0}x
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-500 italic bg-white p-2.5 rounded-lg border border-gray-200">
                Belum ada riwayat nomor ini di database Mengantar Logistics (Pembeli baru / belum pernah order via ekspedisi Mengantar).
              </p>
            )}
          </div>
        </div>

        {/* Footer Modal Actions */}
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
