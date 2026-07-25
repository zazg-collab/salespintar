'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '../../../lib/api';
import { Users, Search, Plus, Edit2, Trash2 } from 'lucide-react';

export default function Contacts() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: '', waNumber: '', segment: '', labels: '' });

  const { data: leads } = useQuery({
    queryKey: ['leads', search],
    queryFn: () => apiGet<any>(`/leads?search=${search}&limit=50`),
    refetchInterval: 15000,
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiPost('/leads', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setShowForm(false);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => apiPatch(`/leads/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setEditing(null);
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/leads/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });

  const resetForm = () => setForm({ name: '', waNumber: '', segment: '', labels: '' });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const data = {
      ...form,
      labels: form.labels.split(',').map(l => l.trim()).filter(Boolean),
    };
    if (editing) {
      updateMutation.mutate({ id: editing.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const startEdit = (lead: any) => {
    setEditing(lead);
    setForm({
      name: lead.name || '',
      waNumber: lead.waNumber,
      segment: lead.segment || '',
      labels: (lead.labels || []).join(', '),
    });
  };

  const statusColors: Record<string, string> = {
    ACTIVE: 'bg-green-50 text-green-600',
    INACTIVE: 'bg-gray-100 text-gray-500',
    CONVERTED: 'bg-blue-50 text-blue-600',
    BLOCKED: 'bg-red-50 text-red-600',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Kontak</h1>
        <button
          onClick={() => { setEditing(null); resetForm(); setShowForm(!showForm); }}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
        >
          <Plus className="w-4 h-4" /> Tambah Kontak
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
          placeholder="Cari kontak..."
        />
      </div>

      {(showForm || editing) && (
        <form onSubmit={handleSubmit} className="bg-white p-6 rounded-xl border border-gray-200 space-y-4">
          <h3 className="font-medium">{editing ? 'Edit Kontak' : 'Tambah Kontak'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nama</label>
              <input type="text" value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nomor WA</label>
              <input type="text" value={form.waNumber} onChange={(e) => setForm(f => ({ ...f, waNumber: e.target.value }))} required className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="628123456789" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Segmen</label>
              <input type="text" value={form.segment} onChange={(e) => setForm(f => ({ ...f, segment: e.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="Pelanggan Tetap" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Label (pisah koma)</label>
              <input type="text" value={form.labels} onChange={(e) => setForm(f => ({ ...f, labels: e.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="vip, promo" />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium">
              {editing ? 'Simpan' : 'Tambah'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditing(null); }} className="px-4 py-2 text-gray-600 rounded-lg hover:bg-gray-100 text-sm">
              Batal
            </button>
          </div>
        </form>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {(!leads?.data || leads.data.length === 0) && (
          <div className="text-center py-12 text-gray-400">
            <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>Belum ada kontak</p>
          </div>
        )}
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 text-left text-sm text-gray-500">
              <th className="p-4 font-medium">Nama</th>
              <th className="p-4 font-medium">Nomor WA</th>
              <th className="p-4 font-medium">Segmen</th>
              <th className="p-4 font-medium">Label</th>
              <th className="p-4 font-medium">Skor</th>
              <th className="p-4 font-medium">Status</th>
              <th className="p-4 font-medium">Intent</th>
              <th className="p-4 font-medium">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {leads?.data?.map((lead: any) => (
              <tr key={lead.id} className="border-b border-gray-100 text-sm hover:bg-gray-50">
                <td className="p-4 font-medium">{lead.name || '-'}</td>
                <td className="p-4 text-gray-500">{lead.waNumber}</td>
                <td className="p-4">{lead.segment || '-'}</td>
                <td className="p-4">
                  <div className="flex flex-wrap gap-1">
                    {(lead.labels || []).map((l: string) => (
                      <span key={l} className="text-xs px-2 py-0.5 bg-gray-100 rounded-full">{l}</span>
                    ))}
                  </div>
                </td>
                <td className="p-4">{lead.score}</td>
                <td className="p-4">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[lead.status] || ''}`}>
                    {lead.status}
                  </span>
                </td>
                <td className="p-4 text-gray-500 capitalize">{lead.intent || '-'}</td>
                <td className="p-4">
                  <div className="flex items-center gap-1">
                    <button onClick={() => startEdit(lead)} className="p-1.5 text-gray-400 hover:text-indigo-600 rounded-lg hover:bg-indigo-50">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button onClick={() => deleteMutation.mutate(lead.id)} className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
