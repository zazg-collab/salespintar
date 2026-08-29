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

# ── 1. Tipe sesi ─────────────────────────────────────────────────────────────
rep("""interface MiningSession {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  totalFiles: number;
  processedFiles: number;
  totalMessages: number;
  errorMessage: string | null;
  questionCount: number;
  answeredCount: number;
}""",
"""interface MiningSession {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  totalFiles: number;
  processedFiles: number;
  /** File yang gagal ditambang. Bukan lagi bikin seluruh sesi berstatus gagal. */
  failedFiles: number;
  totalMessages: number;
  questionCount: number;
  answeredCount: number;
}""")

# ── 2. Tipe pertanyaan + ambang ──────────────────────────────────────────────
rep("""  status: 'open' | 'answered' | 'dismissed' | 'published';
  vaultPath: string | null;
}""",
"""  status: 'open' | 'answered' | 'dismissed' | 'published';
  vaultPath: string | null;
  /** Dokumen pustaka paling mirip, kalau ada. */
  coveredTitle: string | null;
  /** Kemiripannya 0–1. Ditampilkan apa adanya supaya penilaian mesin bisa
   *  diperiksa manusia — kalau judulnya jelas tidak nyambung, langsung kelihatan. */
  coveredScore: number | null;
}

// Harus sama dengan COVERED_THRESHOLD / PARTIAL_THRESHOLD di question-miner.repo.ts
const COVERED = 0.78;
const PARTIAL = 0.55;

type Coverage = 'covered' | 'partial' | 'gap';

function coverageOf(q: MinedQuestion): Coverage {
  const s = q.coveredScore ?? 0;
  if (s >= COVERED) return 'covered';
  if (s >= PARTIAL) return 'partial';
  return 'gap';
}""")

# ── 3. Teks pembuka ──────────────────────────────────────────────────────────
rep("""        Bedanya dengan Auto-Learning: di sana AI membaca chat lalu menulis sendiri jawabannya, jadi
        harga lama bisa ikut terbawa. Di sini <strong>jawaban CS dibuang</strong> — yang diambil cuma
        pertanyaannya, dan Anda yang mengisi jawabannya. Hasilnya jadi pustaka yang faktanya bisa
        dipertanggungjawabkan.""",
"""        Halaman ini menjawab pertanyaan yang tidak bisa dijawab Auto-Learning:
        <strong> apa yang sebenarnya ingin diketahui pelanggan Anda</strong>, dan mana yang
        botnya belum bisa jawab. Tiap pertanyaan dicocokkan ke pustaka yang ada sekarang, lalu
        yang belum ada jawabannya dinaikkan ke atas. Anggap ini daftar tugas menulis dokumen,
        terurut dari yang paling sering ditanya — bukan formulir yang harus diisi sampai habis.""")

# ── 4. Buang spanduk sesi gagal, ganti ringkasan sesi yang tenang ────────────
rep("""      {/* Sesi gagal */}
      {sessions.filter(s => s.status === 'failed').map(s => (
        <div key={s.id} className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm">
          <p className="font-medium text-red-700 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Sesi &ldquo;{s.label}&rdquo; bermasalah
          </p>
          {s.errorMessage && <p className="text-red-600 mt-1 break-words">{s.errorMessage}</p>}
        </div>
      ))}""",
"""      {/* Riwayat sesi — sengaja tenang dan abu-abu.
          Versi sebelumnya memasang spanduk merah permanen begitu ada SATU file
          bermasalah, tanpa cara menutupnya, walau puluhan file lain berhasil.
          Itu menakut-nakuti tanpa memberi informasi yang benar. */}
      {sessions.length > 0 && (
        <div className="text-xs text-gray-500 space-y-1">
          {sessions.slice(0, 3).map(s => (
            <div key={s.id} className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-gray-600">{s.label}</span>
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
              )}
            </div>
          ))}
        </div>
      )}""")

# ── 5. Judul daftar: hitung LUBANG, bukan yang terjawab ─────────────────────
rep("""            <MessageSquareQuote className="w-4 h-4 text-teal-500" />
            Pertanyaan Pelanggan
            {open.length > 0 && (
              <span className="bg-teal-100 text-teal-700 text-xs px-2 py-0.5 rounded-full">
                {answeredCount}/{open.length} terjawab
              </span>
            )}""",
"""            <MessageSquareQuote className="w-4 h-4 text-teal-500" />
            Pertanyaan Pelanggan
            {open.length > 0 && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                gapCount > 0 ? 'bg-rose-100 text-rose-700' : 'bg-green-100 text-green-700'
              }`}>
                {gapCount > 0
                  ? `${gapCount} belum bisa dijawab bot`
                  : 'semua sudah ada di pustaka'}
              </span>
            )}""")

# ── 6. Hitungan lubang ───────────────────────────────────────────────────────
rep("""  const open = questions.filter(q => q.status === 'open' || q.status === 'answered');
  const answeredCount = open.filter(q => q.answer && q.answer.trim()).length;""",
"""  const open = questions.filter(q => q.status === 'open' || q.status === 'answered');
  const answeredCount = open.filter(q => q.answer && q.answer.trim()).length;
  /** Inti halaman ini: berapa pertanyaan yang pustakanya belum bisa menjawab. */
  const gapCount = open.filter(q => coverageOf(q) === 'gap').length;""")

# ── 7. Kartu pertanyaan: lencana cakupan + jawaban jadi opsional ────────────
rep("""                        {q.answer && q.answer.trim() && !dirty && (
                          <span className="text-xs text-green-600 flex items-center gap-1">
                            <CheckCircle className="w-3 h-3" /> terjawab
                          </span>
                        )}""",
"""                        {cov === 'gap' && (
                          <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-rose-100 text-rose-700">
                            bot belum bisa jawab
                          </span>
                        )}
                        {cov === 'partial' && (
                          <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">
                            pustaka baru menyinggung
                          </span>
                        )}
                        {cov === 'covered' && (
                          <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-green-100 text-green-700">
                            sudah ada di pustaka
                          </span>
                        )}
                        {q.answer && q.answer.trim() && !dirty && (
                          <span className="text-xs text-green-600 flex items-center gap-1">
                            <CheckCircle className="w-3 h-3" /> dijawab manual
                          </span>
                        )}""")

rep("""              const draft = drafts[q.id];
              const value = draft ?? q.answer ?? '';
              const dirty = draft !== undefined && draft !== (q.answer ?? '');""",
"""              const draft = drafts[q.id];
              const value = draft ?? q.answer ?? '';
              const dirty = draft !== undefined && draft !== (q.answer ?? '');
              const cov = coverageOf(q);
              // Kotak jawaban hanya muncul kalau diminta, atau kalau memang sudah
              // pernah diisi. Menampilkannya untuk semua baris membuat halaman ini
              // terasa seperti formulir wajib — padahal jawabannya sebaiknya
              // ditulis sebagai dokumen utuh di menu Pengetahuan, bukan
              // sepotong-sepotong di sini.
              const showAnswer = expanded[q.id] || Boolean(q.answer && q.answer.trim());""")

rep("""                      <h3 className="font-medium text-gray-900">{q.question}</h3>
                      {/* Kutipan asli — supaya salah gabung bisa terlihat mata manusia */}
                      <p className="text-xs text-gray-400 mt-1 italic">&ldquo;{q.sampleRaw}&rdquo;</p>
                    </div>""",
"""                      <h3 className="font-medium text-gray-900">{q.question}</h3>
                      {/* Kutipan asli — supaya salah gabung bisa terlihat mata manusia */}
                      <p className="text-xs text-gray-400 mt-1 italic">&ldquo;{q.sampleRaw}&rdquo;</p>
                      {/* Judul dokumen pencocok hanya ditampilkan kalau kemiripannya
                          cukup berarti. Menampilkan dokumen terdekat dengan skor 0
                          justru menyesatkan — itu bukan "hampir cocok", itu
                          "tidak ada yang cocok sama sekali". */}
                      {cov !== 'gap' && q.coveredTitle && (
                        <p className="text-xs text-gray-500 mt-1">
                          Dijawab oleh: <span className="font-medium">{q.coveredTitle}</span>
                          <span className="text-gray-400"> ({Math.round((q.coveredScore ?? 0) * 100)}% mirip)</span>
                        </p>
                      )}
                    </div>""")

rep("""                  <div className="mt-3 flex items-start gap-2">
                    <textarea
                      value={value}
                      onChange={e => setDrafts(prev => ({ ...prev, [q.id]: e.target.value }))}
                      placeholder="Tulis jawaban resmi Anda di sini..."
                      rows={2}
                      className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 resize-y"
                    />
                    <button
                      onClick={() => saveAnswer(q)}
                      disabled={savingId === q.id || !dirty}
                      className="px-3 py-2 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium disabled:opacity-30 flex-shrink-0"
                    >
                      {savingId === q.id ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Simpan'}
                    </button>
                  </div>""",
"""                  {showAnswer ? (
                    <div className="mt-3 flex items-start gap-2">
                      <textarea
                        value={value}
                        onChange={e => setDrafts(prev => ({ ...prev, [q.id]: e.target.value }))}
                        placeholder="Jawaban singkat, kalau memang cukup sebaris dua baris..."
                        rows={2}
                        className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 resize-y"
                      />
                      <button
                        onClick={() => saveAnswer(q)}
                        disabled={savingId === q.id || !dirty}
                        className="px-3 py-2 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium disabled:opacity-30 flex-shrink-0"
                      >
                        {savingId === q.id ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Simpan'}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setExpanded(prev => ({ ...prev, [q.id]: true }))}
                      className="mt-2 text-xs text-teal-700 hover:text-teal-900 hover:underline"
                    >
                      + Jawab singkat di sini
                    </button>
                  )}""")

# ── 8. State expanded ────────────────────────────────────────────────────────
rep("""  const [savingId, setSavingId] = useState<string | null>(null);""",
"""  const [savingId, setSavingId] = useState<string | null>(null);
  /** Baris mana yang kotak jawabannya sedang dibuka. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});""")

# ── 9. Kondisi kosong ────────────────────────────────────────────────────────
rep("""            <p className="font-medium text-gray-600">Belum ada pertanyaan</p>
            <p className="text-sm text-gray-400 mt-1">Unggah ekspor chat di atas untuk mulai menambang.</p>""",
"""            <p className="font-medium text-gray-600">Belum ada pertanyaan</p>
            <p className="text-sm text-gray-400 mt-1">
              Unggah ekspor chat di atas untuk melihat apa yang paling sering ditanya pelanggan.
            </p>""")

io.open(path, 'w', encoding='utf-8').write(src)
print('OK   page.tsx (9 substitusi)')
