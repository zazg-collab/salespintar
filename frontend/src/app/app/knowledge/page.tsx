'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiDelete, apiRequest, apiUpload } from '../../../lib/api';
import {
  FolderOpen, Folder, FileText, Plus, Trash2, Loader2,
  BookOpen, RefreshCw, Upload, Edit3, Save, X, ChevronRight,
  ChevronDown, Brain, Wifi, WifiOff, Clock, CheckCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────
interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  size?: number;
  extension?: string;
}

interface SyncStatus {
  isWatching: boolean;
  vaultPath: string;
  totalSynced: number;
  totalDeleted: number;
  lastSyncAt: string | null;
}

interface FileContent {
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────────────

function SyncStatusBadge({ status }: { status: SyncStatus | null }) {
  if (!status) return null;
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-white rounded-xl border border-gray-200 shadow-sm text-sm">
      {status.isWatching ? (
        <span className="flex items-center gap-1.5 text-green-600 font-medium">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          Live
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-gray-400">
          <WifiOff className="w-3.5 h-3.5" />
          Offline
        </span>
      )}
      <span className="text-gray-400">|</span>
      <span className="text-gray-600">{status.totalSynced} file tersynced</span>
      {status.lastSyncAt && (
        <>
          <span className="text-gray-400">|</span>
          <span className="flex items-center gap-1 text-gray-500">
            <Clock className="w-3.5 h-3.5" />
            {new Date(status.lastSyncAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </>
      )}
    </div>
  );
}

function FileTreeNode({
  node,
  selectedPath,
  onSelectFile,
  onDeleteFile,
  depth = 0,
}: {
  node: FileNode;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onDeleteFile: (path: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const isSelected = selectedPath === node.path;

  if (node.type === 'folder') {
    const isDraft = node.name === 'Draft_AI';
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left hover:bg-gray-100 rounded-lg transition-colors"
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
          {expanded ? <FolderOpen className="w-4 h-4 text-indigo-500 flex-shrink-0" /> : <Folder className="w-4 h-4 text-indigo-400 flex-shrink-0" />}
          <span className={`font-medium truncate ${isDraft ? 'text-amber-600' : 'text-gray-700'}`}>{node.name}</span>
          {isDraft && <span className="ml-auto text-xs bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-full">Draft</span>}
          {node.children && <span className="ml-auto text-xs text-gray-400">{node.children.length}</span>}
        </button>
        {expanded && node.children && (
          <div>
            {node.children.map(child => (
              <FileTreeNode
                key={child.path}
                node={child}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
                onDeleteFile={onDeleteFile}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`group flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg cursor-pointer transition-colors ${
        isSelected ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'
      }`}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
      onClick={() => onSelectFile(node.path)}
    >
      <FileText className={`w-4 h-4 flex-shrink-0 ${isSelected ? 'text-indigo-500' : 'text-gray-400'}`} />
      <span className="truncate flex-1">{node.name}</span>
      {node.size && <span className="text-xs text-gray-400">{Math.round(node.size / 1024 * 10) / 10}kb</span>}
      <button
        onClick={(e) => { e.stopPropagation(); onDeleteFile(node.path); }}
        className="opacity-0 group-hover:opacity-100 p-1 text-red-400 hover:text-red-600 rounded transition-all"
        title="Hapus file"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Unggah Berkas (PDF / DOCX / TXT / gambar)
//
// Terpisah dari "Tambah Pengetahuan" yang berbasis ketikan, karena alurnya
// memang beda: di sini tidak ada yang diketik, dan hasilnya perlu dilaporkan
// balik (berapa karakter terbaca, apakah lewat OCR) supaya pengguna tahu
// kualitas bacaannya sebelum mempercayainya.
// ──────────────────────────────────────────────────────────────────────────────
function FileUploadModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [folder, setFolder] = useState('Produk');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const submit = async () => {
    if (!file) { toast.error('Pilih berkasnya dulu'); return; }
    setBusy(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('folder', folder);
      const res = await apiUpload<any>('/sync/vault/upload-file', form);
      setResult(res.data);
      toast.success(res.message || 'Berkas terbaca');
      onSuccess();
    } catch (err: any) {
      toast.error(err.message || 'Gagal membaca berkas');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-100 rounded-lg">
              <Upload className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900">Unggah Berkas</h2>
              <p className="text-xs text-gray-500 mt-0.5">PDF, Word, teks, atau foto katalog</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Folder Tujuan</label>
            <select
              value={folder}
              onChange={e => setFolder(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm"
            >
              {['Produk', 'SOP', 'FAQ'].map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Berkas</label>
            <input
              type="file"
              accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp"
              onChange={e => { setFile(e.target.files?.[0] || null); setResult(null); }}
              className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 file:mr-3 file:px-3 file:py-1 file:rounded-lg file:border-0 file:bg-gray-100 file:text-sm"
            />
            <p className="text-xs text-gray-500 mt-2">
              Maksimal 25 MB. PDF hasil pindaian dan foto katalog dibaca lewat pengenalan tulisan —
              perlu waktu lebih lama dan angkanya wajib diperiksa ulang.
            </p>
          </div>

          {result && (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm space-y-1">
              <p className="font-medium text-gray-800">
                Terbaca {result.characters} karakter
                {result.pages > 1 ? ` dari ${result.pages} halaman` : ''}
              </p>
              <p className="text-xs text-gray-500">Disimpan sebagai {result.path}</p>
              {(result.notes || []).map((n: string, i: number) => (
                <p key={i} className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2 py-1">{n}</p>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-xl">
            {result ? 'Tutup' : 'Batal'}
          </button>
          <button
            onClick={submit}
            disabled={busy || !file}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-xl hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? <><Loader2 className="w-4 h-4 animate-spin" />Membaca berkas...</> : <><Upload className="w-4 h-4" />Baca & Simpan</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Ambang panjang dokumen pengetahuan, dalam karakter.
 *
 * Angkanya BUKAN batas keras — tidak ada yang menolak dokumen yang lebih panjang,
 * dan `text-chunker.ts` tetap memecahnya jadi beberapa potongan supaya seluruh
 * isinya terbaca. Yang dibatasi adalah hal lain: `KNOWLEDGE_CONTEXT_MAX_CHARS`
 * menentukan berapa banyak karakter pengetahuan yang boleh ikut dalam SATU
 * balasan. Dokumen yang lebih panjang dari itu tidak mungkin sampai ke model
 * secara utuh dalam sekali jawab — sebagian potongannya akan kalah peringkat dan
 * dibuang, dan bagian yang dibuang itulah yang sering justru memuat jawabannya.
 *
 * Diukur 2 Agustus 2026: menaikkan batas 6.000 → 12.000 memindahkan skor audit
 * dari 64,5% ke 74–76%. Jadi angka di sini sengaja dibuat sama dengan batas itu:
 * penulis dokumen bisa melihat, saat mengetik, apakah tulisannya masih muat
 * dibaca bot sekaligus.
 */
const AMBANG_KARAKTER = 12000;

/**
 * Penghitung karakter ala X/Twitter: memerah begitu ambang terlampaui.
 *
 * Ditaruh di sebelah judul dokumen, bukan di bawah kotak teks, karena yang perlu
 * tahu bukan cuma orang yang sedang mengetik — juga orang yang sedang membaca
 * daftar dan bertanya "kenapa dokumen ini jarang kepakai".
 */
function PenghitungKarakter({ jumlah, className = '' }: { jumlah: number; className?: string }) {
  const lewat = jumlah > AMBANG_KARAKTER;
  return (
    <span
      className={`text-xs font-mono tabular-nums whitespace-nowrap ${lewat ? 'text-red-600 font-semibold' : 'text-gray-400'} ${className}`}
      title={
        lewat
          ? `Dokumen ini ${jumlah.toLocaleString('id-ID')} karakter, lebih panjang dari ${AMBANG_KARAKTER.toLocaleString('id-ID')} karakter yang muat dibaca bot dalam satu balasan. Isinya tetap tersimpan dan tetap dipecah jadi beberapa potongan — tapi tidak semua potongan akan ikut saat bot menjawab. Pertimbangkan memecahnya jadi beberapa dokumen bertopik tunggal.`
          : `${jumlah.toLocaleString('id-ID')} dari ${AMBANG_KARAKTER.toLocaleString('id-ID')} karakter yang muat dibaca bot dalam satu balasan.`
      }
    >
      {jumlah.toLocaleString('id-ID')}/{AMBANG_KARAKTER.toLocaleString('id-ID')}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Upload Modal (ketik/tempel teks)
// ──────────────────────────────────────────────────────────────────────────────
function UploadModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [form, setForm] = useState({
    folder: 'Produk',
    filename: '',
    content: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

const FOLDERS = ['Produk', 'SOP', 'FAQ', 'Draft_AI'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const filename = form.filename.endsWith('.md') ? form.filename : `${form.filename}.md`;
    if (!form.content.trim()) { toast.error('Konten tidak boleh kosong'); return; }

    setIsSubmitting(true);
    try {
      await apiPost('/sync/vault/upload', { folder: form.folder, filename, content: form.content });
      toast.success('File berhasil diupload! Bot akan belajar dalam beberapa detik 🧠');
      onSuccess();
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Gagal upload');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 rounded-lg">
              <Upload className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900">Upload Pengetahuan Baru</h2>
              <p className="text-xs text-gray-500 mt-0.5">Tulis atau paste konten pengetahuan untuk otak bot</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Folder Tujuan</label>
              <select
                value={form.folder}
                onChange={e => setForm({ ...form, folder: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              >
                {FOLDERS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Nama File</label>
              <div className="relative">
                <input
                  type="text"
                  required
                  value={form.filename}
                  onChange={e => setForm({ ...form, filename: e.target.value })}
                  placeholder="contoh-produk"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent pr-12"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">.md</span>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Konten Pengetahuan
              <span className="ml-2 text-xs text-gray-400 font-normal">Mendukung format Markdown</span>
            </label>
            <textarea
              required
              rows={10}
              value={form.content}
              onChange={e => setForm({ ...form, content: e.target.value })}
              placeholder={`# Judul Pengetahuan\n\nTulis informasi detail di sini...\n\n## Harga\n- Produk A: Rp 100.000\n\n## FAQ\n**Q: Apakah bisa dicicil?**\nA: Ya, tersedia cicilan 0%.`}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
            />
            <p className="mt-1.5 text-xs text-gray-400 flex items-center gap-2 flex-wrap">
              <PenghitungKarakter jumlah={form.content.length} />
              <span>karakter</span>
              {form.content.length > AMBANG_KARAKTER ? (
                <span className="text-red-600">
                  · Terlalu panjang untuk dibaca bot sekaligus — sebaiknya dipecah jadi beberapa dokumen bertopik tunggal
                </span>
              ) : (
                <span>· Tips: semakin detail dan terstruktur, semakin akurat jawaban bot</span>
              )}
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
              Batal
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" />Mengupload...</> : <><Upload className="w-4 h-4" />Upload ke Vault</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Main Page
// ──────────────────────────────────────────────────────────────────────────────
export default function KnowledgePage() {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showFileModal, setShowFileModal] = useState(false);

  const fetchTree = useCallback(async () => {
    try {
      const res = await apiGet<{ success: boolean; data: { tree: FileNode[] } }>('/sync/vault/tree');
      setTree(res.data?.tree || []);
    } catch {
      toast.error('Gagal memuat file tree vault');
    }
  }, []);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await apiGet<{ success: boolean; data: SyncStatus }>('/sync/status');
      setSyncStatus(res.data);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    Promise.all([fetchTree(), fetchSyncStatus()]).finally(() => setLoading(false));
    const interval = setInterval(fetchSyncStatus, 10000);
    return () => clearInterval(interval);
  }, [fetchTree, fetchSyncStatus]);

  const handleSelectFile = async (filePath: string) => {
    if (isEditing && selectedPath && editContent !== fileContent?.content) {
      if (!confirm('Ada perubahan yang belum disimpan. Buka file lain?')) return;
    }
    setSelectedPath(filePath);
    setIsEditing(false);
    setFileLoading(true);
    try {
      const res = await apiGet<{ success: boolean; data: FileContent }>(`/sync/vault/file?path=${encodeURIComponent(filePath)}`);
      setFileContent(res.data);
      setEditContent(res.data.content);
    } catch {
      toast.error('Gagal membuka file');
    } finally {
      setFileLoading(false);
    }
  };

  const handleSave = async () => {
    if (!selectedPath) return;
    setIsSaving(true);
    try {
      await apiRequest('/sync/vault/file', {
        method: 'PUT',
        body: JSON.stringify({ path: selectedPath, content: editContent }),
      });
      toast.success('Disimpan! Watcher akan re-embed otomatis 🔄');
      setIsEditing(false);
      setFileContent(prev => prev ? { ...prev, content: editContent } : null);
      fetchTree();
    } catch (err: any) {
      toast.error(err.message || 'Gagal menyimpan');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteFile = async (filePath: string) => {
    if (!confirm(`Hapus file "${filePath}"? File akan dihapus dari vault dan DB.`)) return;
    try {
      await apiRequest(`/sync/vault/file?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
      toast.success('File dihapus dari vault');
      if (selectedPath === filePath) { setSelectedPath(null); setFileContent(null); }
      fetchTree();
    } catch (err: any) {
      toast.error(err.message || 'Gagal menghapus');
    }
  };

  const handleManualSync = async () => {
    setIsSyncing(true);
    try {
      const res = await apiPost<{ success: boolean; data: { synced: number; errors: number } }>('/sync/obsidian');
      toast.success(`Resync selesai: ${res.data.synced} file tersync ✅`);
      fetchSyncStatus();
    } catch {
      toast.error('Gagal trigger sync');
    } finally {
      setIsSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-600 mx-auto mb-3" />
          <p className="text-sm text-gray-500">Memuat vault pengetahuan...</p>
        </div>
      </div>
    );
  }

  const countFiles = (nodes: FileNode[]): number =>
    nodes.reduce((sum, n) => sum + (n.type === 'file' ? 1 : countFiles(n.children || [])), 0);

  return (
    <div className="h-full flex flex-col gap-0">
      {/* ── Header ── */}
      <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Brain className="w-5 h-5 text-indigo-600" />
            <h1 className="text-xl font-bold text-gray-900">Otak SalesPintar</h1>
          </div>
          <p className="text-sm text-gray-500">
            Semua file di vault ini otomatis dipelajari bot WhatsApp secara real-time.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <SyncStatusBadge status={syncStatus} />
          <button
            onClick={handleManualSync}
            disabled={isSyncing}
            title="Force resync semua file"
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 disabled:opacity-50 shadow-sm transition-all"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? 'Syncing...' : 'Sync'}
          </button>
          <button
            onClick={() => setShowFileModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-xl hover:bg-emerald-700 shadow-sm transition-all"
          >
            <Upload className="w-4 h-4" />
            Unggah Berkas
          </button>
          <button
            onClick={() => setShowUploadModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 shadow-sm transition-all"
          >
            <Plus className="w-4 h-4" />
            Tambah Pengetahuan
          </button>
        </div>
      </div>

      {/* ── Main: 2-pane layout ── */}
      <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">

        {/* File Tree Sidebar */}
        <div className="w-64 flex-shrink-0 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Vault Explorer</span>
            <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">
              {countFiles(tree)} file
            </span>
          </div>
          <div className="flex-1 overflow-y-auto py-2 px-1">
            {tree.length === 0 ? (
              <div className="p-4 text-center text-gray-400 text-sm">
                <BookOpen className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                Vault kosong. Upload file pertama!
              </div>
            ) : (
              tree.map(node => (
                <FileTreeNode
                  key={node.path}
                  node={node}
                  selectedPath={selectedPath}
                  onSelectFile={handleSelectFile}
                  onDeleteFile={handleDeleteFile}
                />
              ))
            )}
          </div>
        </div>

        {/* Content Pane */}
        <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col overflow-hidden min-w-0">
          {!selectedPath ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center max-w-sm">
                <div className="w-16 h-16 bg-indigo-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <Brain className="w-8 h-8 text-indigo-400" />
                </div>
                <h3 className="font-semibold text-gray-700 mb-2">Pilih file untuk dilihat atau diedit</h3>
                <p className="text-sm text-gray-400 mb-5">
                  Klik file di Explorer kiri, atau upload pengetahuan baru untuk langsung dipelajari bot.
                </p>
                <button
                  onClick={() => setShowUploadModal(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100"
                >
                  <Upload className="w-4 h-4" />
                  Upload Pengetahuan Pertama
                </button>
              </div>
            </div>
          ) : fileLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
            </div>
          ) : fileContent ? (
            <>
              {/* File Header */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                  <span className="text-sm font-medium text-gray-700 truncate">{selectedPath}</span>
                  <PenghitungKarakter jumlah={((isEditing ? editContent : fileContent.content) ?? '').length} className="flex-shrink-0" />
                  <span title="Tersync ke DB">
                    <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {isEditing ? (
                    <>
                      <button onClick={() => { setIsEditing(false); setEditContent(fileContent.content); }} className="px-3 py-1.5 text-xs text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
                        Batal
                      </button>
                      <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        {isSaving ? 'Menyimpan...' : 'Simpan'}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setIsEditing(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      Edit
                    </button>
                  )}
                </div>
              </div>

              {/* File Content */}
              <div className="flex-1 overflow-hidden">
                {isEditing ? (
                  <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    className="w-full h-full p-5 text-sm font-mono text-gray-800 resize-none focus:outline-none"
                    spellCheck={false}
                  />
                ) : (
                  <div className="h-full overflow-y-auto p-5">
                    <pre className="text-sm text-gray-700 whitespace-pre-wrap font-mono leading-relaxed">
                      {fileContent.content || <span className="text-gray-400 italic">File kosong</span>}
                    </pre>
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {showFileModal && (
        <FileUploadModal
          onClose={() => setShowFileModal(false)}
          onSuccess={() => { fetchTree(); fetchSyncStatus(); }}
        />
      )}

      {showUploadModal && (
        <UploadModal onClose={() => setShowUploadModal(false)} onSuccess={fetchTree} />
      )}
    </div>
  );
}
