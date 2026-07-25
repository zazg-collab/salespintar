'use client';

import Link from 'next/link';
import { MessageSquare, Zap, Shield, BarChart3 } from 'lucide-react';

const features = [
  { icon: MessageSquare, title: 'Auto Reply AI', desc: 'Balas otomatis 24/7 dengan Groq LLM. Konteks percakapan 20 pesan terakhir.' },
  { icon: Zap, title: 'Human Takeover', desc: 'Sales ambil alih kapan saja dengan satu klik. AI berhenti otomatis.' },
  { icon: Shield, title: 'Broadcast Aman', desc: 'Kirim pesan massal terjadwal dengan throttle cerdas. Anti spam built-in.' },
  { icon: BarChart3, title: 'Dashboard Real-time', desc: 'KPI, grafik tren, performa AI — semua real-time via WebSocket.' },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      <header className="px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <h1 className="text-2xl font-bold text-indigo-600">SalesPintar</h1>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-sm font-medium text-gray-600 hover:text-gray-900">
              Masuk
            </Link>
            <Link
              href="/register"
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
            >
              Coba Gratis
            </Link>
          </div>
        </div>
      </header>

      <section className="max-w-6xl mx-auto px-6 pt-20 pb-16 text-center">
        <h2 className="text-5xl font-bold tracking-tight text-gray-900">
          AI Customer Service untuk{' '}
          <span className="text-indigo-600">WhatsApp Bisnis</span>
        </h2>
        <p className="mt-6 text-xl text-gray-500 max-w-2xl mx-auto">
          Balas chat pelanggan otomatis 24/7 dengan AI, takeover oleh sales kapan saja, dan kirim broadcast terjadwal — semua dalam satu platform.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <Link
            href="/register"
            className="px-8 py-3 text-lg font-medium text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 shadow-lg shadow-indigo-200"
          >
            Mulai Gratis
          </Link>
          <a
            href="#features"
            className="px-8 py-3 text-lg font-medium text-gray-700 bg-white rounded-xl border border-gray-200 hover:bg-gray-50"
          >
            Lihat Fitur
          </a>
        </div>
      </section>

      <section id="features" className="max-w-6xl mx-auto px-6 py-20">
        <h3 className="text-3xl font-bold text-center text-gray-900">Fitur Unggulan</h3>
        <div className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          {features.map((f) => (
            <div key={f.title} className="p-6 bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
              <div className="w-12 h-12 bg-indigo-100 rounded-xl flex items-center justify-center mb-4">
                <f.icon className="w-6 h-6 text-indigo-600" />
              </div>
              <h4 className="text-lg font-semibold">{f.title}</h4>
              <p className="mt-2 text-sm text-gray-500">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-gray-200 py-8 text-center text-sm text-gray-400">
        &copy; 2026 SalesPintar. All rights reserved.
      </footer>
    </div>
  );
}
