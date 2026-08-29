import sys, io, os

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

path = os.path.join(ROOT, 'frontend/src/app/app/question-miner/page.tsx')
src = io.open(path, encoding='utf-8').read()

def rep(old, new):
    global src
    n = src.count(old)
    if n != 1:
        print(f'FAIL: pola ditemukan {n}x (harus 1):\n---\n{old[:220]}\n---')
        sys.exit(1)
    src = src.replace(old, new)

# ── 1. status cancelled ──────────────────────────────────────────────────────
rep("""  status: 'pending' | 'running' | 'done' | 'failed';""",
    """  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';""")

# ── 2. state + fungsi batal ──────────────────────────────────────────────────
rep("""  const [publishing, setPublishing] = useState(false);""",
"""  const [publishing, setPublishing] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);""")

rep("""  const saveAnswer = async (q: MinedQuestion) => {""",
"""  const cancelSession = async (id: string) => {
    setCancelling(id);
    try {
      const res = await apiPost<any>(`/question-miner/sessions/${id}/cancel`, {});
      toast(res.message || 'Penambangan dihentikan');
      // Ditarik ulang, bukan ditebak dari sisi klien: yang menentukan berapa file
      // sempat batal adalah antrean di server, bukan angka yang kebetulan ada di layar.
      fetchAll();
    } catch (err: any) {
      toast(err?.message || 'Gagal menghentikan penambangan', 'error');
    } finally {
      setCancelling(null);
    }
  };

  const saveAnswer = async (q: MinedQuestion) => {""")

# ── 3. daftar sesi berjalan, untuk tombol batal ─────────────────────────────
rep("""  /** File yang belum selesai ditambang, dijumlah dari semua sesi yang jalan. */
  const pending = sessions
    .filter(s => s.status === 'running' || s.status === 'pending')
    .reduce((sum, s) => sum + Math.max(s.totalFiles - s.processedFiles, 0), 0);""",
"""  const activeSessions = sessions.filter(s => s.status === 'running' || s.status === 'pending');
  /** File yang belum selesai ditambang, dijumlah dari semua sesi yang jalan. */
  const pending = activeSessions
    .reduce((sum, s) => sum + Math.max(s.totalFiles - s.processedFiles, 0), 0);""")

# ── 4. spanduk progres + tombol batal ───────────────────────────────────────
rep("""            <div className="flex-1 min-w-0">
              <h2 className="font-semibold text-gray-900">Menambang pertanyaan...</h2>
              <p className="text-sm text-gray-600 mt-1">{pending} file menunggu giliran</p>
              <div className="mt-3 h-2 w-full bg-teal-100 rounded-full overflow-hidden">
                <div className="h-full w-1/3 bg-teal-600 rounded-full animate-pulse" />
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Halaman ini menyegar sendiri, aman ditinggal.
              </p>
            </div>""",
"""            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="font-semibold text-gray-900">Menambang pertanyaan...</h2>
                  <p className="text-sm text-gray-600 mt-1">{pending} file menunggu giliran</p>
                </div>
                {/* Setiap proses panjang harus bisa dihentikan. Tanpa ini, satu
                    unggahan yang salah berarti menunggu sampai habis sambil
                    membakar token, atau mematikan server. */}
                <div className="flex flex-col items-end gap-1">
                  {activeSessions.map(s => (
                    <button
                      key={s.id}
                      onClick={() => cancelSession(s.id)}
                      disabled={cancelling === s.id}
                      className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-60"
                    >
                      {cancelling === s.id
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <XCircle className="w-3.5 h-3.5" />}
                      Hentikan {activeSessions.length > 1 ? `"${s.label.slice(0, 18)}"` : ''}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-3 h-2 w-full bg-teal-100 rounded-full overflow-hidden">
                <div className="h-full w-1/3 bg-teal-600 rounded-full animate-pulse" />
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Halaman ini menyegar sendiri, aman ditinggal. Pertanyaan yang sudah terkumpul
                tetap tersimpan walau dihentikan di tengah jalan.
              </p>
            </div>""")

# ── 5. riwayat sesi: buang hitungan pertanyaan yang menyesatkan ────────────
rep("""              <span className="font-medium text-gray-600">{s.label}</span>
              <span>·</span>
              <span>{s.processedFiles}/{s.totalFiles} file</span>
              <span>·</span>
              <span>{s.questionCount} pertanyaan</span>
              {s.failedFiles > 0 && (
                <>
                  <span>·</span>
                  <span className="text-amber-600">
                    {s.failedFiles} file dilewati (jatah token Groq habis)
                  </span>
                </>
              )}""",
"""              <span className="font-medium text-gray-600">{s.label}</span>
              <span>·</span>
              <span>{s.processedFiles}/{s.totalFiles} file</span>
              {/* Hitungan pertanyaan per sesi SENGAJA tidak ditampilkan.
                  Pertanyaan yang maknanya sama digabung ke baris yang sudah ada,
                  dan baris itu tetap milik sesi pertama yang menemukannya — jadi
                  unggahan kedua yang berhasil pun akan tertulis "0 pertanyaan".
                  Angka yang benar tapi menyesatkan lebih buruk daripada tidak ada. */}
              {s.status === 'cancelled' && (
                <>
                  <span>·</span>
                  <span className="text-gray-400">dihentikan</span>
                </>
              )}
              {s.failedFiles > 0 && (
                <>
                  <span>·</span>
                  <span className="text-amber-600">{s.failedFiles} file tidak terproses</span>
                </>
              )}""")

# ── 6. import XCircle ───────────────────────────────────────────────────────
rep("""  AlertTriangle, RefreshCw, FileText, MessageSquareQuote,""",
    """  AlertTriangle, RefreshCw, FileText, MessageSquareQuote, XCircle,""")

io.open(path, 'w', encoding='utf-8').write(src)
print('OK   page.tsx (6 substitusi)')
