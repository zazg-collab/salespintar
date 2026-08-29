import io

SRC = 'src/app/app/wa-setup/page.tsx'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:80]
    s = s.replace(old, new)

# ── 1. Mutasi diberi keadaan & pesan galat ───────────────────────────────────
once(
    """  const { mutate: disconnect } = useMutation({
    mutationFn: () => apiPost('/wa/disconnect'),
    onSuccess: () => refetch(),
  });

  const { mutate: reconnect } = useMutation({
    mutationFn: () => apiPost('/wa/reconnect'),
    onSuccess: () => refetch(),
  });""",
    """  // ── Kenapa umpan balik di sini bukan hiasan ────────────────────────────────
  // Kedua tombol ini dulu tidak punya `onError` maupun `isPending`. Jadi
  // permintaan yang GAGAL tampak persis sama seperti yang berhasil: tombol diam,
  // galatnya ditelan diam-diam.
  //
  // Akibatnya nyata, bukan soal kenyamanan. Waktu sambungan WhatsApp bermasalah
  // (30 Juli 2026), tombol Reconnect diklik berulang-ulang karena tampak tidak
  // bereaksi — dan tiap klik membangun socket baru yang menendang socket
  // sebelumnya dengan conflict 440. Tampilan yang bisu ikut menyalakan perang
  // rebutan socket itu.
  const [aksiPesan, setAksiPesan] = useState('');
  const [aksiGagal, setAksiGagal] = useState(false);

  const { mutate: disconnect, isPending: disconnecting } = useMutation({
    mutationFn: () => apiPost('/wa/disconnect'),
    onMutate: () => { setAksiPesan(''); setAksiGagal(false); },
    onSuccess: () => {
      setAksiPesan('Koneksi diputuskan.');
      setAksiGagal(false);
      refetch();
    },
    onError: (err: Error) => { setAksiPesan(err.message); setAksiGagal(true); },
  });

  const { mutate: reconnect, isPending: reconnecting } = useMutation({
    mutationFn: () => apiPost<any>('/wa/reconnect'),
    onMutate: () => { setAksiPesan(''); setAksiGagal(false); },
    onSuccess: (data: any) => {
      // Socket baru biasanya belum selesai jabat tangan saat balasan ini tiba,
      // jadi status PENDING itu wajar. Yang penting pemakainya tahu bahwa
      // permintaannya DITERIMA — supaya tidak mengklik lagi.
      setAksiPesan(
        data?.connection === 'CONNECTED'
          ? 'Tersambung.'
          : 'Permintaan sambung ulang dikirim. Status di atas menyegarkan sendiri tiap 5 detik — tunggu sebentar, jangan diklik lagi.',
      );
      setAksiGagal(false);
      refetch();
    },
    onError: (err: Error) => { setAksiPesan(err.message); setAksiGagal(true); },
  });""",
)

# ── 2. Tombol: tidak bisa diklik saat proses jalan, dan hasilnya ditampilkan ──
once(
    """        <h3 className="font-medium mb-4">Tindakan</h3>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => reconnect()}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm"
          >
            <RefreshCw className="w-4 h-4" /> Reconnect
          </button>
          <button
            onClick={() => disconnect()}
            className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 text-sm"
          >
            <XCircle className="w-4 h-4" /> Putuskan Koneksi
          </button>
        </div>
      </div>""",
    """        <h3 className="font-medium mb-4">Tindakan</h3>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => reconnect()}
            disabled={reconnecting || disconnecting}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
          >
            <RefreshCw className={`w-4 h-4 ${reconnecting ? 'animate-spin' : ''}`} />
            {reconnecting ? 'Menyambung...' : 'Reconnect'}
          </button>
          <button
            onClick={() => disconnect()}
            disabled={reconnecting || disconnecting}
            className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
          >
            <XCircle className="w-4 h-4" />
            {disconnecting ? 'Memutuskan...' : 'Putuskan Koneksi'}
          </button>
        </div>

        {aksiPesan && (
          <div
            className={`mt-4 p-3 rounded-xl text-sm border ${
              aksiGagal
                ? 'bg-red-50 border-red-200 text-red-700'
                : 'bg-blue-50 border-blue-200 text-blue-700'
            }`}
          >
            {aksiPesan}
          </div>
        )}
      </div>""",
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   wa-setup/page.tsx diperbarui')
