'use client';

/**
 * /app/ai-ads/chat — "Agent Workspace" (Global Agent Workspace), halaman penuh.
 *
 * Bagian dari blueprint "Ekstensi Fase 3: Global Agent Workspace & Multi-BM Token Vault" v1.3.
 *
 * [2026-08-25] Langkah B — halaman ini sekarang murni pembungkus tipis di sekitar komponen
 * bersama `GlobalAgentChat` (mode="page"), yang juga dipakai oleh widget floating pojok kanan
 * bawah (`GlobalAgentWidget`, dipasang di app/layout.tsx). Implementasi standalone Langkah A
 * (state conversationId lokal, SSE parser sendiri) DIHAPUS dari sini karena kontrak backend
 * sekarang berbasis PIC (`picName`, bukan `conversationId` dari client) — logikanya sudah
 * dipindah seluruhnya ke GlobalAgentChat.tsx supaya satu sumber kebenaran untuk kedua mode.
 */

import Link from 'next/link';
import { Bot, ArrowLeft } from 'lucide-react';
import GlobalAgentChat from '../../../../components/GlobalAgentChat';

export default function AgentWorkspaceChatPage() {
  return (
    <div className="max-w-3xl mx-auto p-6 flex flex-col h-[calc(100vh-2rem)]">
      <div className="flex items-center gap-2 mb-1">
        <Link href="/app/ai-ads" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <Bot className="w-6 h-6 text-indigo-600" />
        <h1 className="text-xl font-bold">Agent Workspace</h1>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Chat lintas-BM dengan AI Media Buyer — Global Agent Workspace. Percakapan tersimpan
        per-PIC dan tetap ada walau halaman di-refresh. Widget yang sama juga tersedia mengambang
        di pojok kanan bawah pada halaman manapun.
      </p>

      <div className="flex-1 min-h-0 bg-white rounded-lg shadow border border-gray-100 overflow-hidden p-4">
        <GlobalAgentChat mode="page" />
      </div>
    </div>
  );
}
