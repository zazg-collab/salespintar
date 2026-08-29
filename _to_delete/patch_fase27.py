import sys, io, os

ROOT = None
for base in os.listdir('/sessions'):
    p = f'/sessions/{base}/mnt/projek-ceo/salespintar_repo'
    if os.path.isdir(p):
        ROOT = p
        break
assert ROOT, 'repo not found'

def patch(relpath, pairs):
    path = os.path.join(ROOT, relpath)
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    for old, new in pairs:
        n = src.count(old)
        if n != 1:
            print(f'FAIL {relpath}: pola ditemukan {n}x (harus 1):\n---\n{old[:200]}\n---')
            sys.exit(1)
        src = src.replace(old, new)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'OK   {relpath} ({len(pairs)} substitusi)')


# ── BACKEND: hitung juga job berjeda ─────────────────────────────────────────
patch('backend/src/routes/auto-learning.routes.ts', [
(
"""      const [waiting, active, completed, failed] = await Promise.all([
        shadowMiningQueue.getWaitingCount(),
        shadowMiningQueue.getActiveCount(),
        shadowMiningQueue.getCompletedCount(),
        shadowMiningQueue.getFailedCount(),
      ]);""",
"""      // `delayed` wajib ikut dihitung. Impor massal mengantrekan job dengan jeda
      // bertingkat (`delay: n * 1500` di chat-import.routes.ts), dan BullMQ menaruh
      // job berjeda di set `delayed` — BUKAN `waiting`. Tanpa angka ini, ratusan
      // percakapan yang sedang mengantre terbaca sebagai antrean kosong di dashboard,
      // sehingga pengguna mengira impornya gagal padahal sedang berjalan.
      const [waiting, active, delayed, completed, failed] = await Promise.all([
        shadowMiningQueue.getWaitingCount(),
        shadowMiningQueue.getActiveCount(),
        shadowMiningQueue.getDelayedCount(),
        shadowMiningQueue.getCompletedCount(),
        shadowMiningQueue.getFailedCount(),
      ]);"""
),
(
"          queue: { waiting, active, completed, failed },",
"          queue: { waiting, active, delayed, completed, failed },"
),
])


# ── FRONTEND ──────────────────────────────────────────────────────────────────
patch('frontend/src/app/app/auto-learning/page.tsx', [

# 1. tipe queue
(
"  queue: { waiting: number; active: number; completed: number; failed: number };",
"""  /** `delayed` ikut dibawa karena impor massal menjadwalkan job dengan jeda
   *  bertingkat, jadi job yang baru diantrekan duduk di set `delayed`, bukan
   *  `waiting`. Opsional supaya UI lama tidak pecah kalau backend belum di-restart. */
  queue: { waiting: number; active: number; delayed?: number; completed: number; failed: number };"""
),

# 2. state batch + tick
(
"  const [triggerLoading, setTriggerLoading] = useState(false);",
"""  const [triggerLoading, setTriggerLoading] = useState(false);
  /** Penanda satu gelombang impor, supaya progresnya bisa ditampilkan pasti
   *  (X dari Y) dan bukan sekadar spinner. `startedAt` jadi masa tenggang:
   *  tepat sesudah pengantrean, antrean masih terbaca 0 selama sesaat — tanpa
   *  tenggang, bannernya akan langsung dibersihkan sebelum sempat terlihat. */
  const [batch, setBatch] = useState<{ total: number; startedAt: number } | null>(null);
  /** Naik tiap polling selesai. Efek pembersih batch bersandar pada ini supaya
   *  tetap berjalan walau angka antreannya kebetulan tidak berubah. */
  const [tick, setTick] = useState(0);"""
),

# 3. fetchAll -> tick
(
"""      setLoading(false);
    }
  }, []);""",
"""      setLoading(false);
      setTick(t => t + 1);
    }
  }, []);"""
),

# 4. polling adaptif + pembersih batch
(
"""  // Poll status setiap 15 detik
  useEffect(() => {
    const id = setInterval(() => { fetchAll(); }, 15000);
    return () => clearInterval(id);
  }, [fetchAll]);""",
"""  /** Job penambangan yang belum tuntas. `delayed` ikut dijumlah — kalau tidak,
   *  impor massal terlihat seperti tidak melakukan apa-apa di detik-detik awal. */
  const pending =
    (status?.queue.waiting ?? 0) + (status?.queue.active ?? 0) + (status?.queue.delayed ?? 0);

  // Polling adaptif: rapat (3 detik) saat ada pekerjaan berjalan supaya progresnya
  // terasa hidup, longgar (15 detik) saat menganggur supaya tidak membebani server
  // dengan permintaan yang jawabannya selalu sama.
  useEffect(() => {
    const interval = pending > 0 ? 3000 : 15000;
    const id = setInterval(() => { fetchAll(); }, interval);
    return () => clearInterval(id);
  }, [fetchAll, pending]);

  // Bersihkan penanda batch begitu antreannya habis, dengan tenggang 8 detik
  // untuk menghindari salah bersih saat job pertama belum sempat terbaca.
  useEffect(() => {
    if (!batch || pending > 0) return;
    if (Date.now() - batch.startedAt < 8000) return;
    setBatch(null);
    toast(`Penambangan selesai — ${batch.total} percakapan diproses. Cek daftar draft di bawah.`);
  }, [tick, pending, batch]);"""
),

# 5. processImport -> set batch
(
"""      const res = await apiUpload<any>('/chat-import/process', form);
      toast(res.message || 'Percakapan diantrekan');
      setAnalysis(null);""",
"""      const res = await apiUpload<any>('/chat-import/process', form);
      toast(res.message || 'Percakapan diantrekan');
      const queued: number = res?.data?.queued ?? 0;
      if (queued > 0) setBatch({ total: queued, startedAt: Date.now() });
      setAnalysis(null);"""
),

# 6. banner progres sebelum Stats Row
(
"""      {/* Stats Row */}""",
"""      {/* ── Progres penambangan ──────────────────────────────────────────────
          Muncul hanya saat benar-benar ada pekerjaan. Untuk impor, totalnya
          diketahui di muka sehingga barnya bisa pasti; untuk mining otomatis,
          totalnya tidak pernah diketahui sehingga barnya sengaja dibuat bergerak
          tanpa persentase daripada menampilkan angka karangan. */}
      {pending > 0 && (
        <div className="bg-indigo-50 border-2 border-indigo-200 rounded-2xl p-5">
          <div className="flex items-start gap-4">
            <div className="p-3 bg-indigo-100 rounded-xl flex-shrink-0">
              <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="font-semibold text-gray-900">
                {batch ? 'Menambang chat impor...' : 'Menambang percakapan...'}
              </h2>
              <p className="text-sm text-gray-600 mt-1">
                {batch
                  ? `${Math.min(Math.max(batch.total - pending, 0), batch.total)} dari ${batch.total} percakapan selesai · ${pending} menunggu giliran`
                  : `${pending} percakapan dalam antrean`}
              </p>

              <div className="mt-3 h-2 w-full bg-indigo-100 rounded-full overflow-hidden">
                {batch ? (
                  <div
                    className="h-full bg-indigo-600 rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.round(
                        (Math.min(Math.max(batch.total - pending, 0), batch.total) / batch.total) * 100,
                      )}%`,
                    }}
                  />
                ) : (
                  <div className="h-full w-1/3 bg-indigo-600 rounded-full animate-pulse" />
                )}
              </div>

              <p className="text-xs text-gray-500 mt-2">
                Tiap percakapan melewati 3 lapis filter Groq — sekitar 10–30 detik per percakapan.
                Halaman ini menyegar sendiri, aman ditinggal.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stats Row */}"""
),

# 7. stat antrean pakai pending
(
"            { label: 'Antrian Mining', value: status.queue.waiting + status.queue.active, color: 'text-indigo-600', bg: 'bg-indigo-50' },",
"            { label: 'Antrian Mining', value: pending, color: 'text-indigo-600', bg: 'bg-indigo-50' },"
),
])

print('SELESAI')
