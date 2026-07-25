'use client';

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../../lib/api';
import {
  BarChart3,
  MessageSquare,
  Users,
  Zap,
  TrendingUp,
  Clock,
  Activity,
  Bot,
} from 'lucide-react';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['dashboard', 'stats'],
    queryFn: () => apiGet<any>('/dashboard/stats'),
    refetchInterval: 30000,
  });

  const { data: trends } = useQuery({
    queryKey: ['dashboard', 'trends', '7d'],
    queryFn: () => apiGet<any>('/dashboard/trends?period=7d'),
    refetchInterval: 60000,
  });

  const { data: recent } = useQuery({
    queryKey: ['dashboard', 'recent'],
    queryFn: () => apiGet<any>('/dashboard/recent?limit=5'),
    refetchInterval: 15000,
  });

  const { data: performance } = useQuery({
    queryKey: ['dashboard', 'performance'],
    queryFn: () => apiGet<any>('/dashboard/performance'),
    refetchInterval: 60000,
  });

  const cards = [
    { label: 'Chat Hari Ini', value: stats?.totalChatsToday ?? 0, icon: MessageSquare, color: 'text-blue-600', bg: 'bg-blue-50' },
    { label: 'Aktif', value: stats?.activeConversations ?? 0, icon: Activity, color: 'text-green-600', bg: 'bg-green-50' },
    { label: 'Total Leads', value: stats?.totalLeads ?? 0, icon: Users, color: 'text-purple-600', bg: 'bg-purple-50' },
    { label: 'Leads Baru', value: stats?.newLeadsToday ?? 0, icon: TrendingUp, color: 'text-indigo-600', bg: 'bg-indigo-50' },
    { label: 'AI Replies', value: stats?.aiReplies ?? 0, icon: Bot, color: 'text-cyan-600', bg: 'bg-cyan-50' },
    { label: 'Konversi', value: `${stats?.conversionRate ?? 0}%`, icon: Zap, color: 'text-orange-600', bg: 'bg-orange-50' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {cards.map((card) => (
          <div key={card.label} className="bg-white p-4 rounded-xl border border-gray-200">
            <div className={`w-10 h-10 ${card.bg} rounded-lg flex items-center justify-center mb-3`}>
              <card.icon className={`w-5 h-5 ${card.color}`} />
            </div>
            <p className="text-2xl font-bold">{card.value}</p>
            <p className="text-xs text-gray-500 mt-1">{card.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-xl border border-gray-200">
          <h3 className="font-semibold mb-4">Tren Chat (7 Hari)</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={trends?.daily ?? []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(v) => v.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="chats" stroke="#6366f1" strokeWidth={2} name="Chat" />
              <Line type="monotone" dataKey="ai" stroke="#06b6d4" strokeWidth={2} name="AI" />
              <Line type="monotone" dataKey="human" stroke="#f59e0b" strokeWidth={2} name="Human" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white p-6 rounded-xl border border-gray-200">
          <h3 className="font-semibold mb-4">Jam Sibuk</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={trends?.peakHours ?? []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="hour" tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}:00`} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} name="Pesan" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-xl border border-gray-200">
          <h3 className="font-semibold mb-4">Percakapan Terbaru</h3>
          {(!recent || recent.length === 0) && (
            <p className="text-sm text-gray-400">Belum ada percakapan</p>
          )}
          <div className="space-y-3">
            {recent?.map((c: any) => (
              <div key={c.id} className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50">
                <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-sm font-medium text-indigo-600">
                  {(c.lead?.name || '?')[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{c.lead?.name || c.lead?.waNumber}</p>
                  <p className="text-xs text-gray-400 truncate">
                    {c.messages?.[0]?.message || 'Belum ada pesan'}
                  </p>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full ${
                  c.status === 'AI' ? 'bg-cyan-50 text-cyan-600' :
                  c.status === 'HUMAN' ? 'bg-amber-50 text-amber-600' :
                  'bg-gray-100 text-gray-500'
                }`}>
                  {c.status}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white p-6 rounded-xl border border-gray-200">
          <h3 className="font-semibold mb-4">Performa AI</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <span className="text-sm text-gray-600">Total AI Replies</span>
              <span className="font-semibold">{performance?.totalAiReplies ?? 0}</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <span className="text-sm text-gray-600">Human Takeover Rate</span>
              <span className="font-semibold">{performance?.humanTakeoverRate ?? 0}%</span>
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">Top Intent</h4>
              <div className="space-y-2">
                {performance?.topIntents?.map((i: any) => (
                  <div key={i.intent} className="flex items-center justify-between text-sm">
                    <span className="text-gray-600 capitalize">{i.intent}</span>
                    <span className="font-medium">{i.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
