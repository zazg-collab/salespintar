'use client';

import React from 'react';
import Link from 'next/link';
import { LayoutDashboard, Brain, ChevronRight, LogOut, Megaphone, HelpCircle, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '../../../stores/auth';

export default function HubPage() {
  const { business, logout } = useAuthStore();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-4 relative">
      {/* Header Kecil */}
      <div className="absolute top-6 right-6 flex items-center gap-4">
        <span className="text-sm text-gray-500 font-medium">Hai, {business?.name || 'Admin'}</span>
        <button
          onClick={() => void logout()}
          className="flex items-center gap-2 text-sm text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100 px-3 py-1.5 rounded-lg transition-colors font-medium"
        >
          <LogOut className="w-4 h-4" />
          Keluar
        </button>
      </div>

      <div className="max-w-4xl w-full">
        <div className="text-center mb-10">
          <h1 className="text-3xl md:text-4xl font-bold text-indigo-900 tracking-tight">Pilih Ruang Kerja</h1>
          <p className="mt-3 text-gray-500">Pusat kendali {business?.name || 'SalesPintar'} telah dipisah agar Anda bisa lebih fokus.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
          {/* Card Ads & CRM */}
          <Link 
            href="/app/dashboard"
            className="group relative bg-white p-8 rounded-2xl border border-gray-200 shadow-sm hover:shadow-xl hover:border-indigo-300 transition-all duration-300 flex flex-col justify-between overflow-hidden h-full"
          >
            <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-50 rounded-bl-full -mr-16 -mt-16 transition-transform group-hover:scale-110" />
            <div className="relative z-10 flex flex-col flex-1">
              <div className="w-14 h-14 bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center mb-6 shadow-xs">
                <Megaphone className="w-7 h-7" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2 group-hover:text-indigo-600 transition-colors">Ads & CRM Center</h2>
              <p className="text-gray-500 mb-6 leading-relaxed">
                Pantau konversi iklan, manajemen prospek, sinkronisasi Meta CAPI, dan performa omset tim CS Anda.
              </p>
              
              <div className="mt-auto pt-4 flex items-center justify-between text-indigo-600 font-semibold border-t border-transparent group-hover:border-indigo-50 transition-colors">
                <span>Masuk ke CRM</span>
                <ChevronRight className="w-5 h-5 transform group-hover:translate-x-1 transition-transform" />
              </div>
            </div>
          </Link>

          {/* Card AI Learning */}
          <Link 
            href="/app/knowledge"
            className="group relative bg-white p-8 rounded-2xl border border-gray-200 shadow-sm hover:shadow-xl hover:border-amber-300 transition-all duration-300 flex flex-col justify-between overflow-hidden h-full"
          >
            <div className="absolute top-0 right-0 w-32 h-32 bg-amber-50 rounded-bl-full -mr-16 -mt-16 transition-transform group-hover:scale-110" />
            <div className="relative z-10 flex flex-col flex-1">
              <div className="w-14 h-14 bg-amber-100 text-amber-600 rounded-xl flex items-center justify-center mb-6 shadow-xs">
                <Brain className="w-7 h-7" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2 group-hover:text-amber-600 transition-colors">AI Learning Center</h2>
              <p className="text-gray-500 mb-6 leading-relaxed">
                Pustaka pengetahuan cerdas, kurasi draf balasan otomatis, dan analisis klaster pertanyaan pelanggan (Shadow Mining).
              </p>
              
              <div className="mt-auto pt-4 flex items-center justify-between text-amber-600 font-semibold border-t border-transparent group-hover:border-amber-50 transition-colors">
                <span>Masuk ke Lab AI</span>
                <ChevronRight className="w-5 h-5 transform group-hover:translate-x-1 transition-transform" />
              </div>
            </div>
          </Link>

          {/* Card Meta Video AI Guards */}
          <Link
            href="/app/video-guard"
            className="group relative bg-white p-8 rounded-2xl border border-gray-200 shadow-sm hover:shadow-xl hover:border-emerald-300 transition-all duration-300 flex flex-col justify-between overflow-hidden h-full"
          >
            <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-50 rounded-bl-full -mr-16 -mt-16 transition-transform group-hover:scale-110" />
            <div className="relative z-10 flex flex-col flex-1">
              <div className="w-14 h-14 bg-emerald-100 text-emerald-600 rounded-xl flex items-center justify-center mb-6 shadow-xs">
                <ShieldCheck className="w-7 h-7" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2 group-hover:text-emerald-600 transition-colors">Meta Video AI Guards</h2>
              <p className="text-gray-500 mb-6 leading-relaxed">
                Audit kepatuhan iklan video Meta Ads sebelum tayang — deteksi pelanggaran kebijakan
                senjata/sajam, plus modul opsional penguatan presentasi visual.
              </p>

              <div className="mt-auto pt-4 flex items-center justify-between text-emerald-600 font-semibold border-t border-transparent group-hover:border-emerald-50 transition-colors">
                <span>Masuk ke Video Guard</span>
                <ChevronRight className="w-5 h-5 transform group-hover:translate-x-1 transition-transform" />
              </div>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
