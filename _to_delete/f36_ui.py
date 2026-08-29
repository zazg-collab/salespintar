import sys, io, os

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

path = os.path.join(ROOT, 'frontend/src/app/app/knowledge/page.tsx')
src = io.open(path, encoding='utf-8').read()

def rep(old, new):
    global src
    n = src.count(old)
    if n != 1:
        print(f'FAIL: pola ditemukan {n}x (harus 1):\n---\n{old[:200]}\n---')
        sys.exit(1)
    src = src.replace(old, new)

# ── 1. Komponen modal unggah berkas ─────────────────────────────────────────
rep("""// Upload Modal
// ──────────────────────────────────────────────────────────────────────────────
function UploadModal(""",
"""// Unggah Berkas (PDF / DOCX / TXT / gambar)
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

// ──────────────────────────────────────────────────────────────────────────────
// Upload Modal (ketik/tempel teks)
// ──────────────────────────────────────────────────────────────────────────────
function UploadModal(""")

# ── 2. state ────────────────────────────────────────────────────────────────
rep("  const [showUploadModal, setShowUploadModal] = useState(false);",
    "  const [showUploadModal, setShowUploadModal] = useState(false);\n  const [showFileModal, setShowFileModal] = useState(false);")

# ── 3. tombol di header ─────────────────────────────────────────────────────
rep("""          <button
            onClick={() => setShowUploadModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 shadow-sm transition-all"
          >
            <Plus className="w-4 h-4" />
            Tambah Pengetahuan
          </button>""",
"""          <button
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
          </button>""")

# ── 4. render modal ─────────────────────────────────────────────────────────
rep("      {showUploadModal && (",
    """      {showFileModal && (
        <FileUploadModal
          onClose={() => setShowFileModal(false)}
          onSuccess={() => { loadTree(); loadStatus(); }}
        />
      )}

      {showUploadModal && (""")

# ── 5. import apiUpload + Loader2 ───────────────────────────────────────────
rep("import { apiGet, apiPost, apiDelete, apiRequest } from '../../../lib/api';",
    "import { apiGet, apiPost, apiDelete, apiRequest, apiUpload } from '../../../lib/api';")

io.open(path, 'w', encoding='utf-8').write(src)
print('OK   knowledge/page.tsx (5 substitusi)')
