'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../../lib/api';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { useAuthStore } from '../../../stores/auth';
import { Send, ArrowLeft, UserCheck, RotateCcw, CheckCircle } from 'lucide-react';

export default function ChatPage() {
  const router = useRouter();
  return (
    <div className="flex h-[calc(100vh-6rem)] -m-6">
      <div className="w-80 border-r border-gray-200 bg-white overflow-y-auto">
        <ChatList onSelect={(id) => router.push(`/app/chat/${id}`)} />
      </div>
      <div className="flex-1 flex flex-col bg-white items-center justify-center text-gray-400">
        <div className="text-center">
          <Send className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>Pilih percakapan untuk mulai chat</p>
        </div>
      </div>
    </div>
  );
}

function ChatList({ onSelect }: { onSelect: (id: string) => void }) {
  const { data: conversations } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => apiGet<any>('/conversations?limit=50'),
    refetchInterval: 10000,
  });

  return (
    <>
      <div className="p-4 border-b border-gray-200">
        <h2 className="font-semibold">Percakapan</h2>
      </div>
      {(!conversations?.data || conversations.data.length === 0) && (
        <p className="p-4 text-sm text-gray-400">Belum ada percakapan</p>
      )}
      {conversations?.data?.map((c: any) => (
        <button
          key={c.id}
          onClick={() => onSelect(c.id)}
          className="w-full p-4 text-left hover:bg-gray-50 border-b border-gray-100"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-sm font-medium text-indigo-600 flex-shrink-0">
              {(c.lead?.name || c.lead?.waNumber || '?')[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{c.lead?.name || c.lead?.waNumber}</p>
              <p className="text-xs text-gray-400 truncate">
                {c.messages?.[0]?.message || '...'}
              </p>
            </div>
            <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${
              c.status === 'AI' ? 'bg-cyan-50 text-cyan-600' :
              c.status === 'HUMAN' ? 'bg-amber-50 text-amber-600' :
              'bg-gray-100 text-gray-500'
            }`}>
              {c.status}
            </span>
          </div>
        </button>
      ))}
    </>
  );
}
