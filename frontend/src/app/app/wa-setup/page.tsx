'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../../lib/api';
import { Smartphone, RefreshCw, AlertCircle, CheckCircle, XCircle } from 'lucide-react';

export default function WASetup() {
  const [qrError, setQrError] = useState('');

  const { data: status, isLoading, refetch } = useQuery({
    queryKey: ['wa-status'],
    queryFn: () => apiGet<any>('/wa/status'),
    refetchInterval: 5000,
  });

  const { data: qrData, mutate: generateQR, isPending: qrLoading } = useMutation({
    mutationFn: () => apiGet<any>('/wa/qr'),
    onError: (err: Error) => setQrError(err.message),
    onSuccess: () => setQrError(''),
  });

  // ── Kenapa umpan balik di sini bukan hiasan ────────────────────────────────
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
  });

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">WhatsApp Setup</h1>

      <div className="bg-white p-6 rounded-xl border border-gray-200">
        <div className="flex items-center gap-3 mb-6">
          <div className={`w-3 h-3 rounded-full ${
            status?.connection === 'CONNECTED' ? 'bg-green-500' :
            status?.connection === 'DISCONNECTED' ? 'bg-red-400' : 'bg-yellow-400'
          }`} />
          <div>
            <p className="font-medium">
              Status: {status?.connection || 'Unknown'}
            </p>
            {status?.credential?.waNumber && (
              <p className="text-sm text-gray-500">
                Nomor: {status.credential.waNumber}
              </p>
            )}
            {status?.credential?.lastConnectedAt && (
              <p className="text-xs text-gray-400">
                Terakhir connect: {new Date(status.credential.lastConnectedAt).toLocaleString('id-ID')}
              </p>
            )}
          </div>
        </div>

        {status?.connection !== 'CONNECTED' && (
          <div className="space-y-4">
            <button
              onClick={() => generateQR()}
              disabled={qrLoading}
              className="flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-50 font-medium"
            >
              <Smartphone className="w-5 h-5" />
              {qrLoading ? 'Memproses...' : 'Scan QR WhatsApp'}
            </button>

            {qrError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                {qrError}
              </div>
            )}

            {qrData && (
              <div className="p-6 bg-gray-50 rounded-xl text-center">
                <p className="text-sm text-gray-500 mb-4">
                  Scan QR ini dengan WhatsApp di ponsel Anda:
                  Buka WhatsApp → Settings → Linked Devices → Link a Device
                </p>
                <div className="inline-block bg-white p-4 rounded-xl shadow-sm">
                  <img src={qrData.qrCode} alt="WhatsApp QR" className="w-64 h-64" />
                </div>
                {qrData.expiresAt && (
                  <p className="text-xs text-red-400 mt-3">
                    QR expired: {new Date(qrData.expiresAt).toLocaleTimeString('id-ID')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {status?.connection === 'CONNECTED' && (
          <div className="p-4 bg-green-50 rounded-xl flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-green-600" />
            <span className="text-sm text-green-700">
              WhatsApp terhubung! Sekarang Anda bisa menerima dan membalas pesan.
            </span>
          </div>
        )}
      </div>

      <div className="bg-white p-6 rounded-xl border border-gray-200">
        <h3 className="font-medium mb-4">Tindakan</h3>
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
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-amber-700">
            <p className="font-medium mb-1">Peringatan</p>
            <p>SalesPintar menggunakan library unofficial WhatsApp (Baileys). Risiko: nomor WhatsApp bisa terkena ban atau di-flag sebagai unofficial client. Gunakan nomor cadangan untuk produksi.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
