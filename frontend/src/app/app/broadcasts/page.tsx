'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiDelete } from '../../../lib/api';
import { useAuthStore } from '../../../stores/auth';
import { Plus, Send, Trash2, X } from 'lucide-react';

export default function Broadcasts() {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    title: '',
    message: '',
    templateVars: '',
    scheduleAt: '',
    scheduleType: 'once',
  });

  const { data: broadcasts } = useQuery({
    queryKey: ['broadcasts'],
    queryFn: () => apiGet<any>('/broadcasts?limit=50'),
    refetchInterval: 10000,
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiPost('/broadcasts', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      setShowForm(false);
      setForm({ title: '', message: '', templateVars: '', scheduleAt: '', scheduleType: 'once' });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/broadcasts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['broadcasts'] }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const vars = form.templateVars.split(',').map(v => v.trim()).filter(Boolean);
    createMutation.mutate({
      title: form.title,
      message: form.message,
      templateVars: vars,
      scheduleAt: new Date(form.scheduleAt).toISOString(),
      scheduleType: form.scheduleType,
    });
  };

  const statusColors: Record<string, string> = {
    PENDING: 'bg-yellow-50 text-yellow-600',
    SENDING: 'bg-blue-50 text-blue-600',
    SENT: 'bg-green-50 text-green-600',
    PARTIAL: 'bg-orange-50 text-orange-600',
    FAILED: 'bg-red-50 text-red-600',
    CANCELLED: 'bg-gray-100 text-gray-500',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Broadcast</h1>
        {user?.role === 'ADMIN' && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
          >
            {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {showForm ? 'Tutup' : 'Buat Broadcast'}
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white p-6 rounded-xl border border-gray-200 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Judul</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder="Promo Akhir Bulan"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Variable (pisah koma)</label>
              <input
                type="text"
                value={form.templateVars}
                onChange={(e) => setForm(f => ({ ...f, templateVars: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder="nama, produk"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Jadwal</label>
              <input
                type="datetime-local"
                value={form.scheduleAt}
                onChange={(e) => setForm(f => ({ ...f, scheduleAt: e.target.value }))}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tipe</label>
              <select
                value={form.scheduleType}
                onChange={(e) => setForm(f => ({ ...f, scheduleType: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
              >
                <option value="once">Sekali</option>
                <option value="daily">Harian</option>
                <option value="weekly">Mingguan</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Pesan</label>
            <textarea
              value={form.message}
              onChange={(e) => setForm(f => ({ ...f, message: e.target.value }))}
              required
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
              placeholder="Halo {{nama}}, promo {{produk}} sedang berlangsung..."
            />
            <p className="text-xs text-gray-400 mt-1">Gunakan {'{{nama}}'} untuk variable</p>
          </div>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm font-medium"
          >
            {createMutation.isPending ? 'Menyimpan...' : 'Jadwalkan Broadcast'}
          </button>
        </form>
      )}

      <div className="space-y-3">
        {(!broadcasts?.data || broadcasts.data.length === 0) && (
          <div className="text-center py-12 text-gray-400">
            <Send className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>Belum ada broadcast</p>
          </div>
        )}
        {broadcasts?.data?.map((b: any) => (
          <div key={b.id} className="bg-white p-5 rounded-xl border border-gray-200">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-medium">{b.title}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[b.status] || ''}`}>
                    {b.status}
                  </span>
                </div>
                <p className="text-sm text-gray-500 line-clamp-2">{b.message}</p>
                <div className="flex items-center gap-4 mt-3 text-xs text-gray-400">
                  <span>Target: {b.totalTarget}</span>
                  <span>Terkirim: {b.totalSent}</span>
                  <span>Gagal: {b.totalFailed}</span>
                  <span>Terjadwal: {new Date(b.scheduleAt).toLocaleString('id-ID')}</span>
                </div>
              </div>
              {b.status === 'PENDING' && user?.role === 'ADMIN' && (
                <button
                  onClick={() => cancelMutation.mutate(b.id)}
                  className="p-2 text-gray-400 hover:text-red-500 rounded-lg hover:bg-red-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
            {b.status === 'SENDING' && (
              <div className="mt-3 w-full bg-gray-100 rounded-full h-1.5">
                <div
                  className="bg-indigo-600 h-1.5 rounded-full transition-all"
                  style={{
                    width: b.totalTarget > 0
                      ? `${Math.round((b.totalSent / b.totalTarget) * 100)}%`
                      : '0%',
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
