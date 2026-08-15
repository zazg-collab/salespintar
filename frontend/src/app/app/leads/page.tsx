'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { apiGet } from '../../../lib/api';
import {
  Users,
  Search,
  Download,
  RefreshCw,
  Flame,
  Sun,
  Snowflake,
  CheckCircle2,
  Clock,
  XCircle,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Filter,
  MessageSquare,
  Sparkles,
  Calendar,
  ShieldCheck,
  AlertCircle,
  Truck,
  Info,
  X,
  Lightbulb,
  AlertTriangle,
  Copy,
  Check,
  Send,
  UserCheck,
} from 'lucide-react';

interface LeadItem {
  id: string;
  waNumber: string;
  waId: string | null;
  leadCategory?: 'NEW_INBOUND' | 'AFTER_SALES';
  minatProduk: string | null;
  lastInsight: string | null;
  leadStage: 'COLD' | 'WARM' | 'HOT' | 'VERY_HOT';
  score: number;
  conversionStatus: 'CLOSING' | 'PENDING' | 'LOST';
  assignedCsName: string | null;
  assignedCsPhone: string | null;
  rtsRiskScore: number | null;
  rtsRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  rtsReasons: string[];
  courierRecommendation: string | null;
  mengantarData: any;
  totalMessages: number;
  lastMessageAt: string | null;
  createdAt: string;
}

interface LeadStats {
  totalLeads: number;
  hotLeads: number;
  warmLeads: number;
  coldLeads: number;
  closingLeads: number;
  pendingLeads: number;
  lostLeads: number;
  avgRtsRisk?: number;
  highRiskRtsLeads?: number;
}

export default function RiwayatPelangganPage() {
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [selectedRtsLead, setSelectedRtsLead] = useState<LeadItem | null>(null);
  const [selectedInsightLead, setSelectedInsightLead] = useState<LeadItem | null>(null);
  const [stats, setStats] = useState<LeadStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // debouncedSearch: nilai search yang benar-benar dikirim ke API (delay 500ms).
  // Ini memisahkan UI state (search) dari API call state (debouncedSearch),
  // mencegah spam request ke backend dan race condition pada hasil tabel.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('NEW_INBOUND');
  const [stageFilter, setStageFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [rtsFilter, setRtsFilter] = useState<string>('ALL');
  const [csFilter, setCsFilter] = useState<string>('ALL');
  const [csList, setCsList] = useState<{ name: string; phone: string | null }[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalLeads, setTotalLeads] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [copiedScript, setCopiedScript] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Debounce search input: tunggu 500ms setelah user berhenti mengetik
  // sebelum memperbarui debouncedSearch yang memicu API call.
  // Ini menghilangkan spam request (mis. ketik "Bambang" = 7 request) dan
  // race condition di mana response lama bisa tiba setelah response baru.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1); // Reset ke halaman 1 saat search berubah
    }, 500);
    return () => clearTimeout(timer); // Cleanup: batalkan timer jika search berubah lagi
  }, [search]);

  const getObjectionDetail = useCallback((lead: LeadItem) => {
    if (lead.conversionStatus === 'CLOSING') {
      return {
        type: 'RESOLVED_CLOSING',
        shortTag: 'Deal Closing',
        tagClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        label: '✅ Transaksi Selesai (Deal Closing)',
        summary: 'Pembeli telah menyetujui pesanan dan mengonfirmasi alamat pengiriman.',
        suggestedAction: 'Segera cetak label pengiriman & serahkan paket ke kurir rekomendasi.',
        followUpScript: `Halo Kak! Pesanan ${lead.minatProduk || 'produk'} sedang disiapkan untuk proses packing ya kak. Resi pengiriman akan segera kami informasikan begitu paket diserahkan ke kurir. Terima kasih banyak atas kepercayaannya! 🙏`,
      };
    }

    if (lead.conversionStatus === 'LOST') {
      return {
        type: 'LOST',
        shortTag: 'Batal',
        tagClass: 'bg-rose-50 text-rose-700 border-rose-200',
        label: '❌ Transaksi Batal (Lost)',
        summary: 'Prospek menolak atau membatalkan pembelian.',
        suggestedAction: 'Arsipkan kontak dan hindari spam chat berlebihan. Simpan nomor untuk broadcast promo khusus peluncuran produk baru.',
        followUpScript: `Terima kasih atas waktunya ya Kak! Jika nanti membutuhkan ${lead.minatProduk || 'alat pisau/golok berkualitas'}, kami selalu siap membantu. Semoga lancar selalu aktivitasnya! 🙏`,
      };
    }

    // Status: PENDING (Follow Up)
    const text = (lead.lastInsight || '').toLowerCase();
    const isBladeProduct = /(golok|pisau|bilah|sembelih|gke|mamba|situmang|betekok|duralium|pedang|tajam)/i.test(
      (lead.minatProduk || '') + ' ' + text
    );

    // 1. Ragu SOP COD / Takut Tertipu
    if (/(cek barang|buka paket|lihat dulu|sebelum bayar|takut tertipu|buka dulu|marketplace|shopee)/i.test(text)) {
      return {
        type: 'COD_HESITATION',
        shortTag: 'Ragu SOP COD',
        tagClass: 'bg-purple-50 text-purple-700 border-purple-200',
        label: '📦 Ragu SOP COD / Minta Cek Fisik Sebelum Bayar',
        summary: 'Pembeli ragu/takut tertipu dan ingin memastikan barang asli sebelum membayar ke kurir.',
        suggestedAction: isBladeProduct
          ? 'Edukasi SOP kurir resmi COD, berikan Garansi 100% Ganti Baru, dan tawarkan BONUS BATU ASAHAN + video tes ketajaman bilah dari gudang.'
          : 'Edukasi bahwa SOP resmi kurir COD tidak mengizinkan buka segel sebelum bayar, namun toko memberikan Garansi Retur 100% / Kirim video real produk.',
        followUpScript: isBladeProduct
          ? `Halo Kak! Untuk metode COD sesuai SOP resmi ekspedisi memang pembayaran dilakukan ke kurir sebelum buka paket ya kak. Namun jangan khawatir, kami berikan Garansi 100% Ganti Baru + kami sertakan BONUS BATU ASAHAN. Boleh kami kirimkan video tes ketajaman ${lead.minatProduk || 'pisaunya'} langsung dari gudang kak? 🙏`
          : `Halo Kak! Untuk metode COD sesuai SOP resmi ekspedisi pembayaran dilakukan ke kurir sebelum buka paket ya kak. Namun toko kami berikan Garansi 100% Ganti Baru jika barang tidak sesuai. Mau kami kirimkan video fisik asli ${lead.minatProduk || 'barangnya'} kak? 🙏`,
      };
    }

    // 2. Ragu Gambar / Ketidaksesuaian Fisik Produk
    if (/(gambar|foto|fisik|asli|bentuk|ketidaksesuaian|sesuai)/i.test(text)) {
      return {
        type: 'PICTURE_MISMATCH',
        shortTag: 'Ragu Gambar',
        tagClass: 'bg-rose-50 text-rose-700 border-rose-200',
        label: '📸 Keraguan Bentuk Fisik & Gambar Produk',
        summary: 'Pembeli ragu dengan bentuk fisik atau keaslian barang berdasarkan foto iklan.',
        suggestedAction: isBladeProduct
          ? 'Kirimkan foto & video fisik asli produk langsung dari gudang, serta sertakan BONUS BATU ASAHAN untuk meyakinkan pembeli tanpa diskon ongkir.'
          : 'Kirimkan foto & video detail fisik asli produk langsung dari gudang toko.',
        followUpScript: isBladeProduct
          ? `Halo Kak! Terkait keraguan bentuk fisik ${lead.minatProduk || 'pisaunya'}, ini kami fotokan barang aslinya langsung dari gudang ya kak. Khusus hari ini kami sertakan juga BONUS BATU ASAHAN jika diproseskan sekarang kak. Mau kami amankan slot kirimnya kak? 🙏`
          : `Halo Kak! Untuk ${lead.minatProduk || 'barangnya'}, ini kami fotokan fisik aslinya langsung dari gudang ya kak. Barangnya ready dan siap dipacking hari ini. Mau kami bantu proseskan pengirimannya kak? 😊`,
      };
    }

    // 3. Keberatan Biaya Ongkir Murni
    if (/(ongkir|biaya kirim|ongkos kirim|kirimnya mahal)/i.test(text)) {
      return {
        type: 'SHIPPING_COST',
        shortTag: 'Nego Ongkir',
        tagClass: 'bg-amber-50 text-amber-700 border-amber-200',
        label: '💸 Keberatan Biaya Ongkir Pengiriman',
        summary: 'Pembeli merasa total ongkir ekspedisi terlalu tinggi di luar estimasi budgetnya.',
        suggestedAction: 'Bantu carikan opsi kurir termurah atau terapkan SOP DISKON ONGKIR (Maksimal 20%). Simpan bonus asahan untuk negosiasi lanjutan jika masih mentok.',
        followUpScript: `Halo Kak! Terkait pemesanan ${lead.minatProduk || 'produknya'}, khusus hari ini kami bantu subsidi potongan ongkir hingga 20% ke alamat Kakak agar lebih hemat. Mau kami bantu proseskan pengirimannya sekarang kak? 😊`,
      };
    }

    // 4. Nego Harga Produk / Kemahalan Barang
    if (/(kemahalan|mahal|diskon harga|potongan harga|kurang mas|nego|harga)/i.test(text)) {
      return {
        type: 'PRICE_OBJECTION',
        shortTag: 'Nego Harga',
        tagClass: 'bg-orange-50 text-orange-700 border-orange-200',
        label: '🏷️ Nego Harga Produk',
        summary: 'Pembeli merasa harga barang kemahalan dan meminta potongan harga jual.',
        suggestedAction: isBladeProduct
          ? 'Pertahankan harga produk dengan edukasi kualitas baja tempa asli, dan tawarkan BONUS BATU ASAHAN sebagai nilai tambah tanpa memotong harga jual.'
          : 'Edukasi keunggulan material dan ketahanan produk untuk mempertahankan harga jual.',
        followUpScript: isBladeProduct
          ? `Halo Kak! Untuk ${lead.minatProduk || 'produk ini'} harganya sudah pas karena materialnya baja tempa asli dengan ketajaman teruji kak. Tapi khusus hari ini, kami sertakan BONUS BATU ASAHAN gratis agar Kakak tidak perlu beli asahan lagi. Boleh kami bantu siapkan pesanannya kak? 😊`
          : `Halo Kak! Untuk ${lead.minatProduk || 'produk ini'} harganya sudah sangat hemat sebanding dengan kualitas dan daya tahannya kak. Mau kami bantu siapkan pengirimannya hari ini kak? 😊`,
      };
    }

    // 5. Menunggu Gajian / Tanggal Tertentu
    if (/(gajian|tanggal|tgl|akhir bulan|awal bulan|minggu depan|nunggu uang|gaji)/i.test(text)) {
      return {
        type: 'SALARY_PENDING',
        shortTag: 'Nunggu Gajian',
        tagClass: 'bg-blue-50 text-blue-700 border-blue-200',
        label: '🗓️ Menunggu Gajian / Kesiapan Dana',
        summary: 'Pembeli sangat berminat namun meminta penundaan transaksi sampai tanggal gajian tiba.',
        suggestedAction: isBladeProduct
          ? 'Amankan slot booking promo + simpan kuota BONUS BATU ASAHAN, dan jadwalkan pesan pengingat sopan pada pagi hari tanggal gajian.'
          : 'Amankan data booking pesanan agar promo tidak hangus, dan jadwalkan follow-up sopan pada tanggal perkiraan gajian.',
        followUpScript: isBladeProduct
          ? `Halo Kak! Mau info untuk promo ${lead.minatProduk || 'pesanannya'} beserta slot BONUS BATU ASAHAN sudah kami amankan ya kak. Kalau nanti gajiannya sudah siap, boleh langsung kabari kami agar bisa segera dipacking dan dikirim ya kak. Terima kasih Kak! 🙏`
          : `Halo Kak! Mau info untuk promo ${lead.minatProduk || 'pesanannya'} sudah kami amankan slotnya ya kak. Kalau nanti gajiannya sudah siap, boleh kabari kami agar langsung kami prioritaskan packing ya kak 🙏`,
      };
    }

    // 6. Tanya Keluarga / Pasangan
    if (/(tanya suami|tanya istri|tanya bapak|rembukan|diskusi)/i.test(text)) {
      return {
        type: 'DECISION_MAKER',
        shortTag: 'Musyawarah Keluarga',
        tagClass: 'bg-teal-50 text-teal-700 border-teal-200',
        label: '👥 Musyawarah dengan Pasangan / Keluarga',
        summary: 'Pembeli bukan pengambil keputusan tunggal dan perlu persetujuan keluarga.',
        suggestedAction: isBladeProduct
          ? 'Kirimkan foto detail orisinalitas bahan baja tempa dan video uji ketajaman bilah kertas/tali yang mudah diperlihatkan ke pasangan/keluarga.'
          : 'Kirimkan foto detail orisinalitas bahan dan spesifikasi produk yang ringkas untuk diperlihatkan ke keluarga.',
        followUpScript: isBladeProduct
          ? `Halo Kak! Bagaimana hasil diskusinya dengan keluarga untuk ${lead.minatProduk || 'produk bilahnya'}? Jika butuh foto detail atau video tes ketajaman untuk diperlihatkan ke keluarga, boleh kami kirimkan sekarang ya kak 😊`
          : `Halo Kak! Bagaimana hasil diskusinya dengan keluarga untuk ${lead.minatProduk || 'produknya'}? Jika butuh foto detail atau spesifikasinya boleh kami bantu kirimkan ya kak 😊`,
      };
    }

    // Default: Follow Up / Tanya Spesifikasi
    return {
      type: 'GENERAL_INQUIRY',
      shortTag: 'Tanya Spesifikasi',
      tagClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
      label: '🔍 Eksplorasi Produk & Kebutuhan Bilah',
      summary: 'Prospek sedang mencari informasi bahan, dimensi, atau peruntukan alat.',
      suggestedAction: isBladeProduct
        ? 'Tanyakan kebutuhan pemakaian (misal sembelih sapi, kambing, tebas ranting, atau semak kebun) agar CS bisa merekomendasikan tipe & ukuran yang paling presisi.'
        : 'Tanyakan kebutuhan pemakaian spesifik pembeli agar CS bisa merekomendasikan varian produk yang paling cocok.',
      followUpScript: isBladeProduct
        ? `Halo Kak! Untuk ${lead.minatProduk || 'produk ini'} bahan bilahnya sudah baja tempa asli dengan ketajaman siap pakai kak. Rencananya mau digunakan untuk sembelih hewan atau kebutuhan kebun kak? Biar kami rekomendasikan varian yang paling pas 🙏`
        : `Halo Kak! Untuk ${lead.minatProduk || 'produk ini'} spesifikasinya sudah teruji berkualitas kak. Rencananya untuk kebutuhan apa kak biar kami bantu rekomendasikan yang terbaik? 😊`,
    };
  }, []);

  const handleCopyScript = (scriptText: string, leadId: string) => {
    navigator.clipboard.writeText(scriptText);
    setCopiedScript(leadId);
    setTimeout(() => {
      setCopiedScript(null);
    }, 2500);
  };

  const [datePreset, setDatePreset] = useState<'all' | 'today' | '7d' | '30d' | 'this_month' | 'custom'>('all');
  const [customStart, setCustomStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return d.toISOString().split('T')[0];
  });
  const [customEnd, setCustomEnd] = useState(() => new Date().toISOString().split('T')[0]);

  const { startDate, endDate, dateRangeLabel } = useMemo(() => {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    if (datePreset === 'all') {
      return { startDate: undefined, endDate: undefined, dateRangeLabel: 'Semua Waktu' };
    }
    if (datePreset === 'today') {
      return { startDate: todayStr, endDate: todayStr, dateRangeLabel: 'Hari Ini' };
    }
    if (datePreset === '7d') {
      const d = new Date();
      d.setDate(d.getDate() - 6);
      return { startDate: d.toISOString().split('T')[0], endDate: todayStr, dateRangeLabel: '7 Hari Terakhir' };
    }
    if (datePreset === '30d') {
      const d = new Date();
      d.setDate(d.getDate() - 29);
      return { startDate: d.toISOString().split('T')[0], endDate: todayStr, dateRangeLabel: '30 Hari Terakhir' };
    }
    if (datePreset === 'this_month') {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      return { startDate: firstDay.toISOString().split('T')[0], endDate: todayStr, dateRangeLabel: 'Bulan Ini' };
    }
    return {
      startDate: customStart || todayStr,
      endDate: customEnd || todayStr,
      dateRangeLabel: `${customStart} s/d ${customEnd}`,
    };
  }, [datePreset, customStart, customEnd]);

  const fetchCsList = useCallback(async () => {
    try {
      const data = await apiGet<{ name: string; phone: string | null }[]>('/leads/cs-list');
      setCsList(data || []);
    } catch (err) {
      console.error('Gagal memuat list CS:', err);
    }
  }, []);

  useEffect(() => {
    fetchCsList();
  }, [fetchCsList]);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '20',
      });
      if (categoryFilter !== 'ALL') params.set('leadCategory', categoryFilter);
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
      if (stageFilter !== 'ALL') params.set('stage', stageFilter);
      if (statusFilter !== 'ALL') params.set('conversion', statusFilter);
      if (rtsFilter !== 'ALL') params.set('rtsLevel', rtsFilter);
      if (csFilter !== 'ALL') params.set('csName', csFilter);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);

      const res = await apiGet<{
        leads: LeadItem[];
        total: number;
        page: number;
        totalPages: number;
      }>(`/leads?${params.toString()}`);

      setLeads(res.leads || []);
      setTotalLeads(res.total || 0);
      setTotalPages(res.totalPages || 1);
    } catch (err) {
      console.error('Gagal memuat daftar leads:', err);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, categoryFilter, stageFilter, statusFilter, rtsFilter, csFilter, startDate, endDate]);

  const fetchStats = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (categoryFilter !== 'ALL') params.set('leadCategory', categoryFilter);
      if (csFilter !== 'ALL') params.set('csName', csFilter);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      const data = await apiGet<LeadStats>(`/leads/stats?${params.toString()}`);
      setStats(data);
    } catch (err) {
      console.error('Gagal memuat stats leads:', err);
    }
  }, [categoryFilter, csFilter, startDate, endDate]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const handleExportCsv = () => {
    const params = new URLSearchParams();
    if (categoryFilter !== 'ALL') params.set('leadCategory', categoryFilter);
    if (stageFilter !== 'ALL') params.set('stage', stageFilter);
    if (statusFilter !== 'ALL') params.set('conversion', statusFilter);
    if (rtsFilter !== 'ALL') params.set('rtsLevel', rtsFilter);
    if (csFilter !== 'ALL') params.set('csName', csFilter);
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);

    const token = localStorage.getItem('token');
    const url = `/api/v1/leads/export?${params.toString()}`;
    
    fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((resp) => resp.blob())
      .then((blob) => {
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `riwayat-pelanggan-${startDate || 'all'}-${endDate || 'all'}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(downloadUrl);
      })
      .catch((err) => alert('Gagal mengunduh CSV: ' + err.message));
  };

  const getRtsBadge = (lead: LeadItem) => {
    // 1. Jika prospek belum closing (masih Follow Up / Tanya-Tanya)
    if (lead.conversionStatus === 'PENDING') {
      if (lead.mengantarData && (lead.mengantarData.totalRts || 0) > 0) {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
            Histori {lead.mengantarData.totalRts}x RTS ({lead.mengantarData.overallDeliveryRate}% Sukses)
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">
          <Clock className="w-3.5 h-3.5 text-slate-500" />
          Belum Order (Follow Up)
        </span>
      );
    }

    // 2. Jika prospek Batal (Lost)
    if (lead.conversionStatus === 'LOST') {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
          <XCircle className="w-3.5 h-3.5 text-gray-400" />
          Batal Kirim
        </span>
      );
    }

    // 3. Status CLOSING (Sudah Deal Transaksi)
    const score = lead.rtsRiskScore ?? 0;
    if (score >= 46 || lead.rtsRiskLevel === 'HIGH') {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200 shadow-xs">
          <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
          Bahaya Retur ({score}%)
        </span>
      );
    }
    if (score >= 16 || lead.rtsRiskLevel === 'MEDIUM') {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
          Waspada Retur ({score}%)
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
        <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
        Aman ({score}%)
      </span>
    );
  };

  const getStageBadge = (stage: string, score: number) => {
    switch (stage) {
      case 'VERY_HOT':
      case 'HOT':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200">
            <Flame className="w-3.5 h-3.5 text-rose-600 fill-rose-500" />
            HOT ({score})
          </span>
        );
      case 'WARM':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
            <Sun className="w-3.5 h-3.5 text-amber-600" />
            WARM ({score})
          </span>
        );
      case 'COLD':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
            <Snowflake className="w-3.5 h-3.5 text-blue-500" />
            COLD ({score})
          </span>
        );
    }
  };

  const getConversionBadge = (status: string) => {
    switch (status) {
      case 'CLOSING':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
            Closing Deal
          </span>
        );
      case 'LOST':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200">
            <XCircle className="w-3 h-3 text-rose-600" />
            Lost / Batal
          </span>
        );
      case 'PENDING':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <Clock className="w-3 h-3 text-amber-600" />
            Follow Up
          </span>
        );
    }
  };

  const formatWibDate = (isoStr: string | null) => {
    if (!isoStr) return '-';
    return new Date(isoStr).toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Jakarta',
    });
  };

  const formatWibDateTime = (isoStr: string | null) => {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    const datePart = d.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Jakarta',
    });
    const timePart = d.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Jakarta',
    }).replace('.', ':');
    return `${datePart}, ${timePart} WIB`;
  };

  const renderStackedTimestamp = (isoStr: string | null) => {
    if (!isoStr) return <span className="text-gray-400 text-xs">-</span>;
    const d = new Date(isoStr);
    const datePart = d.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Jakarta',
    });
    const timePart = d.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Jakarta',
    }).replace('.', ':');

    return (
      <div className="flex flex-col">
        <span className="font-semibold text-gray-900 text-xs whitespace-nowrap">{datePart}</span>
        <span className="text-[11px] text-gray-500 font-mono flex items-center gap-1 mt-0.5 whitespace-nowrap">
          <Clock className="w-2.5 h-2.5 text-gray-400" />
          {timePart} WIB
        </span>
      </div>
    );
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto p-4 md:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Users className="w-6 h-6 text-indigo-600" />
            Riwayat Pelanggan & CRM Prospek
          </h1>
          <p className="text-xs md:text-sm text-gray-500 mt-1">
            Database prospek otomatis dari percakapan WhatsApp. Dilengkapi minat produk, insight AI, dan scoring lead.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => {
              fetchStats();
              fetchLeads();
            }}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs md:text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Segarkan
          </button>

          <button
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs md:text-sm font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition shadow-sm"
          >
            <Download className="w-4 h-4" />
            Export CSV / Excel
          </button>
        </div>
      </div>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-gray-200 shadow-sm">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-indigo-600" />
          <span className="text-xs font-bold text-gray-800">Rentang Waktu:</span>
          <span className="text-xs text-gray-500 font-medium">{dateRangeLabel}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-lg">
            <button
              onClick={() => setDatePreset('all')}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                datePreset === 'all' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Semua Waktu
            </button>
            <button
              onClick={() => setDatePreset('today')}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                datePreset === 'today' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Hari Ini
            </button>
            <button
              onClick={() => setDatePreset('7d')}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                datePreset === '7d' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              7 Hari
            </button>
            <button
              onClick={() => setDatePreset('30d')}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                datePreset === '30d' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              30 Hari
            </button>
            <button
              onClick={() => setDatePreset('this_month')}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                datePreset === 'this_month' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Bulan Ini
            </button>
            <button
              onClick={() => setDatePreset('custom')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                datePreset === 'custom' ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Custom
            </button>
          </div>

          {datePreset === 'custom' && (
            <div className="flex items-center gap-1.5 bg-gray-50 p-1 rounded-lg border border-gray-200">
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="px-2 py-0.5 text-xs bg-white border border-gray-300 rounded text-gray-700 focus:outline-none"
              />
              <span className="text-xs text-gray-400">s/d</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="px-2 py-0.5 text-xs bg-white border border-gray-300 rounded text-gray-700 focus:outline-none"
              />
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7 bg-white p-4 rounded-xl border border-gray-200 shadow-sm space-y-3">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-800">
                Pipeline Penjualan & Transaksi
              </h3>
            </div>
            <span className="text-[11px] text-gray-400 font-medium">Klik kartu untuk memfilter tabel</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {/* Total Prospek */}
            <div 
              onClick={() => {
                setStatusFilter('ALL');
                setStageFilter('ALL');
                setPage(1);
              }}
              className={`p-3 rounded-xl border transition-all cursor-pointer select-none ${
                statusFilter === 'ALL' && stageFilter === 'ALL'
                  ? 'bg-indigo-50/90 hover:bg-indigo-100/90 border-indigo-300 shadow-sm ring-2 ring-indigo-500'
                  : 'bg-gray-50/80 hover:bg-gray-100 border-gray-200/80 text-gray-900'
              }`}
            >
              <div className={`text-[11px] font-semibold ${statusFilter === 'ALL' && stageFilter === 'ALL' ? 'text-indigo-700' : 'text-gray-500'}`}>Total Prospek</div>
              <div className={`text-xl font-bold mt-1 ${statusFilter === 'ALL' && stageFilter === 'ALL' ? 'text-indigo-950' : 'text-gray-900'}`}>{stats?.totalLeads ?? 0}</div>
              <div className={`text-[10px] mt-0.5 ${statusFilter === 'ALL' && stageFilter === 'ALL' ? 'text-indigo-600/80' : 'text-gray-400'}`}>Semua Kontak</div>
            </div>

            {/* Closing Deal */}
            <div 
              onClick={() => {
                setStatusFilter(prev => prev === 'CLOSING' ? 'ALL' : 'CLOSING');
                setStageFilter('ALL');
                setPage(1);
              }}
              className={`p-3 rounded-xl border transition-all cursor-pointer select-none ${
                statusFilter === 'CLOSING'
                  ? 'bg-emerald-600 text-white border-emerald-600 shadow-md ring-2 ring-emerald-400'
                  : 'bg-emerald-50/60 hover:bg-emerald-100/80 border-emerald-200 text-emerald-900'
              }`}
            >
              <div className={`text-[11px] font-semibold flex items-center gap-1 ${statusFilter === 'CLOSING' ? 'text-emerald-100' : 'text-emerald-700'}`}>
                <CheckCircle2 className={`w-3.5 h-3.5 ${statusFilter === 'CLOSING' ? 'text-white' : 'text-emerald-600'}`} /> Closing Deal
              </div>
              <div className={`text-xl font-bold mt-1 ${statusFilter === 'CLOSING' ? 'text-white' : 'text-emerald-700'}`}>{stats?.closingLeads ?? 0}</div>
              <div className={`text-[10px] mt-0.5 ${statusFilter === 'CLOSING' ? 'text-emerald-200' : 'text-emerald-600/80'}`}>Berhasil Transaksi</div>
            </div>

            {/* Follow Up */}
            <div 
              onClick={() => {
                setStatusFilter(prev => prev === 'PENDING' ? 'ALL' : 'PENDING');
                setStageFilter('ALL');
                setPage(1);
              }}
              className={`p-3 rounded-xl border transition-all cursor-pointer select-none ${
                statusFilter === 'PENDING'
                  ? 'bg-amber-500 text-white border-amber-500 shadow-md ring-2 ring-amber-300'
                  : 'bg-amber-50/60 hover:bg-amber-100/80 border-amber-200 text-amber-900'
              }`}
            >
              <div className={`text-[11px] font-semibold flex items-center gap-1 ${statusFilter === 'PENDING' ? 'text-amber-100' : 'text-amber-700'}`}>
                <Clock className={`w-3.5 h-3.5 ${statusFilter === 'PENDING' ? 'text-white' : 'text-amber-600'}`} /> Follow Up
              </div>
              <div className={`text-xl font-bold mt-1 ${statusFilter === 'PENDING' ? 'text-white' : 'text-amber-700'}`}>{stats?.pendingLeads ?? 0}</div>
              <div className={`text-[10px] mt-0.5 ${statusFilter === 'PENDING' ? 'text-amber-200' : 'text-amber-600/80'}`}>Perlu Tindak Lanjut</div>
            </div>

            {/* Lost / Batal */}
            <div 
              onClick={() => {
                setStatusFilter(prev => prev === 'LOST' ? 'ALL' : 'LOST');
                setStageFilter('ALL');
                setPage(1);
              }}
              className={`p-3 rounded-xl border transition-all cursor-pointer select-none ${
                statusFilter === 'LOST'
                  ? 'bg-rose-600 text-white border-rose-600 shadow-md ring-2 ring-rose-400'
                  : 'bg-rose-50/60 hover:bg-rose-100/80 border-rose-200 text-rose-900'
              }`}
            >
              <div className={`text-[11px] font-semibold flex items-center gap-1 ${statusFilter === 'LOST' ? 'text-rose-100' : 'text-rose-700'}`}>
                <XCircle className={`w-3.5 h-3.5 ${statusFilter === 'LOST' ? 'text-white' : 'text-rose-600'}`} /> Lost / Batal
              </div>
              <div className={`text-xl font-bold mt-1 ${statusFilter === 'LOST' ? 'text-white' : 'text-rose-700'}`}>{stats?.lostLeads ?? 0}</div>
              <div className={`text-[10px] mt-0.5 ${statusFilter === 'LOST' ? 'text-rose-200' : 'text-rose-600/80'}`}>Gagal Transaksi</div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5 bg-white p-4 rounded-xl border border-gray-200 shadow-sm space-y-3">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2">
            <div className="flex items-center gap-1.5">
              <Flame className="w-4 h-4 text-rose-500" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-800">
                Kualitas & Minat Prospek
              </h3>
            </div>
            <span className="text-[11px] text-gray-400 font-medium">Klik untuk memfilter skor</span>
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            {/* HOT */}
            <div 
              onClick={() => {
                setStageFilter(prev => prev === 'HOT' ? 'ALL' : 'HOT');
                setStatusFilter('ALL');
                setPage(1);
              }}
              className={`p-3 rounded-xl border transition-all cursor-pointer select-none ${
                stageFilter === 'HOT'
                  ? 'bg-rose-600 text-white border-rose-600 shadow-md ring-2 ring-rose-400'
                  : 'bg-rose-50/50 hover:bg-rose-100/80 border-rose-200 text-rose-900'
              }`}
            >
              <div className={`text-[11px] font-semibold flex items-center gap-1 ${stageFilter === 'HOT' ? 'text-rose-100' : 'text-rose-700'}`}>
                <Flame className={`w-3.5 h-3.5 ${stageFilter === 'HOT' ? 'fill-white text-white' : 'fill-rose-500 text-rose-500'}`} /> HOT
              </div>
              <div className={`text-xl font-bold mt-1 ${stageFilter === 'HOT' ? 'text-white' : 'text-rose-700'}`}>{stats?.hotLeads ?? 0}</div>
              <div className={`text-[10px] mt-0.5 ${stageFilter === 'HOT' ? 'text-rose-200' : 'text-rose-500/80'}`}>Skor 61 - 100</div>
            </div>

            {/* WARM */}
            <div 
              onClick={() => {
                setStageFilter(prev => prev === 'WARM' ? 'ALL' : 'WARM');
                setStatusFilter('ALL');
                setPage(1);
              }}
              className={`p-3 rounded-xl border transition-all cursor-pointer select-none ${
                stageFilter === 'WARM'
                  ? 'bg-amber-500 text-white border-amber-500 shadow-md ring-2 ring-amber-300'
                  : 'bg-amber-50/50 hover:bg-amber-100/80 border-amber-200 text-amber-900'
              }`}
            >
              <div className={`text-[11px] font-semibold flex items-center gap-1 ${stageFilter === 'WARM' ? 'text-amber-100' : 'text-amber-700'}`}>
                <Sun className={`w-3.5 h-3.5 ${stageFilter === 'WARM' ? 'text-white' : 'text-amber-600'}`} /> WARM
              </div>
              <div className={`text-xl font-bold mt-1 ${stageFilter === 'WARM' ? 'text-white' : 'text-amber-700'}`}>{stats?.warmLeads ?? 0}</div>
              <div className={`text-[10px] mt-0.5 ${stageFilter === 'WARM' ? 'text-amber-200' : 'text-amber-600/80'}`}>Skor 31 - 60</div>
            </div>

            {/* COLD */}
            <div 
              onClick={() => {
                setStageFilter(prev => prev === 'COLD' ? 'ALL' : 'COLD');
                setStatusFilter('ALL');
                setPage(1);
              }}
              className={`p-3 rounded-xl border transition-all cursor-pointer select-none ${
                stageFilter === 'COLD'
                  ? 'bg-blue-600 text-white border-blue-600 shadow-md ring-2 ring-blue-400'
                  : 'bg-blue-50/50 hover:bg-blue-100/80 border-blue-200 text-blue-900'
              }`}
            >
              <div className={`text-[11px] font-semibold flex items-center gap-1 ${stageFilter === 'COLD' ? 'text-blue-100' : 'text-blue-700'}`}>
                <Snowflake className={`w-3.5 h-3.5 ${stageFilter === 'COLD' ? 'text-white' : 'text-blue-500'}`} /> COLD
              </div>
              <div className={`text-xl font-bold mt-1 ${stageFilter === 'COLD' ? 'text-white' : 'text-blue-700'}`}>{stats?.coldLeads ?? 0}</div>
              <div className={`text-[10px] mt-0.5 ${stageFilter === 'COLD' ? 'text-blue-200' : 'text-blue-500/80'}`}>Skor 0 - 30</div>
            </div>
          </div>
        </div>
      </div>

      {/* TOOLBAR FILTER & PENCARIAN ELEGAN & RESPONSIF */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
        {/* Row 1: Search Bar & Primary Category Tabs */}
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
          {/* Search Bar yang Luas & Jelas */}
          <div className="relative flex-1 min-w-[280px]">
            <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Cari Nomor HP, Minat Produk, atau Insight AI..."
              className="w-full pl-10 pr-9 py-2.5 text-xs md:text-sm bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition placeholder:text-gray-400"
            />
            {search && (
              <button
                onClick={() => {
                  setSearch('');
                  setPage(1);
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5"
                title="Hapus pencarian"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Segmented Pills untuk Kategori Lead / Sumber */}
          <div className="flex items-center gap-1 bg-gray-100/80 p-1 rounded-xl border border-gray-200/60 overflow-x-auto">
            <button
              onClick={() => {
                setCategoryFilter('NEW_INBOUND');
                setPage(1);
              }}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap ${
                categoryFilter === 'NEW_INBOUND'
                  ? 'bg-indigo-600 text-white shadow-sm ring-1 ring-indigo-500'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200/50'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>🎯 Prospek Iklan (Form Baru)</span>
            </button>
            <button
              onClick={() => {
                setCategoryFilter('AFTER_SALES');
                setPage(1);
              }}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap ${
                categoryFilter === 'AFTER_SALES'
                  ? 'bg-indigo-600 text-white shadow-sm ring-1 ring-indigo-500'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200/50'
              }`}
            >
              <span>📦 After-Sales (Resi/Layanan)</span>
            </button>
            <button
              onClick={() => {
                setCategoryFilter('ALL');
                setPage(1);
              }}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap ${
                categoryFilter === 'ALL'
                  ? 'bg-indigo-600 text-white shadow-sm ring-1 ring-indigo-500'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200/50'
              }`}
            >
              <span>🌐 Semua Percakapan</span>
            </button>
          </div>
        </div>

        {/* Row 2: Secondary Dropdown Filters */}
        <div className="pt-2 border-t border-gray-100 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1 mr-1">
              <Filter className="w-3 h-3 text-indigo-600" /> Filter:
            </span>

            {/* Filter CS */}
            <div className="relative">
              <select
                value={csFilter}
                onChange={(e) => {
                  setCsFilter(e.target.value);
                  setPage(1);
                }}
                className="pl-3 pr-7 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded-lg text-gray-700 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer hover:bg-gray-100/60"
              >
                <option value="ALL">👤 Semua CS ({csList.length > 0 ? csList.length : 'Semua'})</option>
                {csList.map((cs) => (
                  <option key={cs.name} value={cs.name}>
                    👤 {cs.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Filter Status Closing */}
            <div className="relative">
              <select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
                className="pl-3 pr-7 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded-lg text-gray-700 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer hover:bg-gray-100/60"
              >
                <option value="ALL">Status: Semua</option>
                <option value="CLOSING">✅ Closing Deal</option>
                <option value="PENDING">⏳ Follow Up / Pending</option>
                <option value="LOST">❌ Lost / Batal</option>
              </select>
            </div>

            {/* Filter Kualitas Lead (Score Stage) */}
            <div className="relative">
              <select
                value={stageFilter}
                onChange={(e) => {
                  setStageFilter(e.target.value);
                  setPage(1);
                }}
                className="pl-3 pr-7 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded-lg text-gray-700 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer hover:bg-gray-100/60"
              >
                <option value="ALL">Kualitas: Semua Skor</option>
                <option value="HOT">🔥 HOT (61 - 100)</option>
                <option value="WARM">🌤️ WARM (31 - 60)</option>
                <option value="COLD">❄️ COLD (0 - 30)</option>
              </select>
            </div>

            {/* Filter Risiko RTS */}
            <div className="relative">
              <select
                value={rtsFilter}
                onChange={(e) => {
                  setRtsFilter(e.target.value);
                  setPage(1);
                }}
                className="pl-3 pr-7 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded-lg text-gray-700 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer hover:bg-gray-100/60"
              >
                <option value="ALL">Risiko RTS: Semua</option>
                <option value="LOW">🟢 Rendah (&lt; 25%)</option>
                <option value="MEDIUM">🟡 Sedang (25 - 55%)</option>
                <option value="HIGH">🔴 Tinggi (&gt; 55%)</option>
              </select>
            </div>
          </div>

          {/* Reset Filter Button (Muncul jika ada filter aktif) */}
          {(csFilter !== 'ALL' || statusFilter !== 'ALL' || stageFilter !== 'ALL' || rtsFilter !== 'ALL' || search.trim()) && (
            <button
              onClick={() => {
                setCsFilter('ALL');
                setStatusFilter('ALL');
                setStageFilter('ALL');
                setRtsFilter('ALL');
                setSearch('');
                setPage(1);
              }}
              className="px-2.5 py-1 text-xs font-semibold text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100/80 border border-rose-200 rounded-lg transition-colors flex items-center gap-1"
            >
              <X className="w-3 h-3" />
              <span>Reset Filter</span>
            </button>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs md:text-sm">
            <thead className="bg-gray-50/80 text-gray-600 text-xs font-semibold uppercase tracking-wider border-b border-gray-200">
              <tr>
                <th className="px-4 py-3.5">Nomor HP (WhatsApp)</th>
                <th className="px-4 py-3.5">Tgl Masuk</th>
                <th className="px-4 py-3.5">Minat Produk</th>
                <th className="px-4 py-3.5 min-w-[260px]">Insight Terakhir AI</th>
                <th className="px-4 py-3.5">Kategori Lead</th>
                <th className="px-4 py-3.5">Status Closing</th>
                <th className="px-4 py-3.5">Risiko RTS & Ekspedisi</th>
                <th className="px-4 py-3.5">CS Pemegang</th>
                <th className="px-4 py-3.5">Terakhir Chat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    <div className="inline-flex items-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-indigo-600" />
                      Memuat riwayat pelanggan...
                    </div>
                  </td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    <MessageSquare className="w-8 h-8 mx-auto text-gray-300 mb-2" />
                    Belum ada data prospek yang cocok dengan filter ini.
                  </td>
                </tr>
              ) : (
                leads.map((lead) => (
                  <tr
                    key={lead.id}
                    className="hover:bg-indigo-50/40 transition-colors group"
                  >
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 font-semibold text-gray-900 font-mono text-xs">
                        <span>{lead.waNumber}</span>
                        <a
                          href={`https://wa.me/${lead.waNumber}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Buka Chat WhatsApp"
                          className="text-emerald-600 hover:text-emerald-700"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        {lead.totalMessages} interaksi buffer
                      </div>
                    </td>

                    {/* TGL MASUK (DEKAT NO WHATSAPP & STACKED TANGGAL + JAM) */}
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      {renderStackedTimestamp(lead.createdAt)}
                    </td>

                    <td className="px-4 py-3.5">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold max-w-[200px] truncate ${
                        lead.minatProduk 
                          ? 'bg-indigo-50 text-indigo-700 border border-indigo-100' 
                          : 'bg-gray-100 text-gray-500 border border-gray-200 italic'
                      }`}>
                        {lead.minatProduk || 'Belum Memilih Produk'}
                      </span>
                    </td>
                    {/* INSIGHT TERAKHIR AI (MICRO-CARD ELEGAN & TYPOGRAPHY TAJAM) */}
                    <td 
                      className="px-4 py-3 min-w-[280px] max-w-sm cursor-pointer group/insight"
                      onClick={() => setSelectedInsightLead(lead)}
                      title="Klik untuk melihat Detail Profil & Insight AI Pembeli"
                    >
                      <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 group-hover/insight:bg-indigo-50/70 group-hover/insight:border-indigo-200 transition-all duration-150 shadow-2xs">
                        <div className="flex items-start gap-2">
                          <Sparkles className="w-3.5 h-3.5 text-indigo-600 flex-shrink-0 mt-0.5 group-hover/insight:scale-110 transition-transform" />
                          <p className="text-xs text-slate-800 font-medium leading-relaxed line-clamp-2">
                            {lead.lastInsight || 'Klik untuk analisis detail AI'}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      {getStageBadge(lead.leadStage, lead.score)}
                    </td>
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <div className="flex flex-col gap-1">
                        <div>{getConversionBadge(lead.conversionStatus)}</div>
                        {(() => {
                          const obj = getObjectionDetail(lead);
                          if (lead.conversionStatus === 'PENDING') {
                            return (
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border ${obj.tagClass} max-w-fit shadow-2xs`}>
                                ↳ {obj.shortTag}
                              </span>
                            );
                          }
                          return null;
                        })()}
                      </div>
                    </td>
                    <td 
                      className="px-4 py-3.5 whitespace-nowrap cursor-pointer hover:bg-emerald-50"
                      onClick={() => setSelectedRtsLead(lead)}
                    >
                      <div className="flex flex-col gap-1.5">
                        <div>{getRtsBadge(lead)}</div>
                        {lead.courierRecommendation ? (
                          <div className="inline-flex items-center gap-1.5 text-[11px] text-gray-700 font-medium bg-gray-50 px-2 py-0.5 rounded-md border border-gray-200/80">
                            <Truck className="w-3 h-3 text-indigo-600 flex-shrink-0" />
                            <span className="truncate max-w-[150px]" title={lead.courierRecommendation}>
                              {lead.courierRecommendation}
                            </span>
                          </div>
                        ) : (
                          <span className="text-[10px] text-gray-400 font-normal">Kurir Bebas</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <div className="font-medium text-gray-800 text-xs">
                        {lead.assignedCsName || 'CS'}
                      </div>
                    </td>
                    {/* TERAKHIR CHAT (DI BELAKANG & STACKED TANGGAL + JAM) */}
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      {renderStackedTimestamp(lead.lastMessageAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="p-4 border-t border-gray-200 flex items-center justify-between text-xs text-gray-500 bg-gray-50/50">
          <div>
            Menampilkan <span className="font-semibold text-gray-800">{leads.length}</span> dari{' '}
            <span className="font-semibold text-gray-800">{totalLeads}</span> prospek
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span>Halaman {page} dari {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* ── MODAL 1: DETAIL PACKING & AUDIT ANTI-RTS (PORTAL TO BODY) ── */}
      {mounted && selectedRtsLead && createPortal(
        <div className="fixed inset-0 z-[99999] w-screen h-screen bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="relative bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-gray-100 p-6 space-y-5 my-auto">
            {/* Header Modal */}
            <div className="flex items-start justify-between border-b border-gray-100 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-base font-bold text-gray-900">{selectedRtsLead.waNumber}</span>
                  {getConversionBadge(selectedRtsLead.conversionStatus)}
                  {getStageBadge(selectedRtsLead.leadStage, selectedRtsLead.score)}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  CS Pemegang: <strong>{selectedRtsLead.assignedCsName || 'CS'}</strong> ({selectedRtsLead.assignedCsPhone || '-'}) • Terakhir Chat: {formatWibDateTime(selectedRtsLead.lastMessageAt)}
                </p>
              </div>
              <button
                onClick={() => setSelectedRtsLead(null)}
                className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Rekomendasi Ekspedisi Otomatis di Layar CRM / Packing */}
            <div className={`p-4 rounded-xl border space-y-1.5 ${
              selectedRtsLead.courierRecommendation 
                ? 'bg-gradient-to-r from-emerald-50 to-teal-50 border-emerald-200'
                : 'bg-gray-50 border-gray-200'
            }`}>
              <div className="flex items-center gap-2 font-bold text-xs">
                <Lightbulb className="w-4 h-4 text-amber-500" />
                <span className={selectedRtsLead.courierRecommendation ? 'text-emerald-900' : 'text-gray-700'}>
                  SARAN OTOMATIS LAYAR CRM / PACKING:
                </span>
              </div>
              <div className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <Truck className={`w-5 h-5 ${selectedRtsLead.courierRecommendation ? 'text-emerald-600' : 'text-gray-400'}`} />
                <span>
                  {selectedRtsLead.courierRecommendation ? (
                    `Rekomendasi Ekspedisi: Kirim pakai ${selectedRtsLead.courierRecommendation}`
                  ) : (
                    'Belum Ada Rekomendasi Kurir Khusus (Bebas Pilih Ekspedisi Rekanan Toko)'
                  )}
                </span>
              </div>
              <p className={`text-xs leading-relaxed ${selectedRtsLead.courierRecommendation ? 'text-emerald-700' : 'text-gray-500'}`}>
                {selectedRtsLead.courierRecommendation
                  ? `Kurir di atas memiliki riwayat keberhasilan pengantaran tertinggi ke pembeli ini berdasarkan database logistik Mengantar.`
                  : `Nomor ini belum memiliki riwayat pengantaran di database Mengantar. Evaluasi risiko retur murni dihitung dari kualitas chat CS.`}
              </p>
            </div>

            {/* Analisis 2-Layer Anti-RTS Firewall */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-gray-700 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-600" />
                Audit 2-Layer Anti-RTS Firewall
              </h4>

              {/* Layer 1: Audit Chat AI (Kualitas Chat CS) */}
              <div className="p-3.5 bg-gray-50 rounded-xl border border-gray-200 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-bold text-gray-800 block">
                      Layer 1: Audit Kualitas Chat CS (Bobot 65%)
                    </span>
                    <span className="text-[11px] text-gray-500">
                      Evaluasi SOP CS: Persetujuan pembeli, patokan rumah, rincian COD & kesiapan uang tunai.
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                    Audit SOP CS
                  </span>
                </div>

                <div className="text-xs text-gray-600 space-y-1 pt-1.5 border-t border-gray-200/60">
                  <div className="font-semibold text-gray-700">Temuan SOP Percakapan:</div>
                  {(() => {
                    if (selectedRtsLead.conversionStatus === 'PENDING') {
                      return (
                        <p className="text-amber-800 bg-amber-50 p-2 rounded-lg border border-amber-200/60 leading-relaxed">
                          ℹ️ <strong>Masih Tahap Follow Up / Tanya-Jawab:</strong> Prospek belum melakukan pemesanan (deal). Audit kelengkapan alamat dan SOP komitmen COD akan aktif otomatis saat prospek mencapai tahap Closing.
                        </p>
                      );
                    }
                    if (selectedRtsLead.conversionStatus === 'LOST') {
                      return (
                        <p className="text-gray-500 italic bg-gray-100/70 p-2 rounded-lg border border-gray-200/60">
                          ❌ Percakapan selesai tanpa transaksi (batal beli / tidak ada pengiriman paket).
                        </p>
                      );
                    }

                    // Status CLOSING
                    const chatFindings = (selectedRtsLead.rtsReasons || []).filter(
                      (r: string) => !r.toLowerCase().includes('mengantar') && !r.toLowerCase().includes('riwayat logistik')
                    );

                    // Pengecekan jika transkrip belum ada / belum tersinkronisasi
                    if (chatFindings.some((r: string) => r.toLowerCase().includes('belum tersinkronisasi') || r.toLowerCase().includes('kosong atau tidak terdeteksi'))) {
                      return (
                        <div className="flex items-center gap-2 text-slate-700 bg-slate-100 p-2.5 rounded-lg border border-slate-200 text-xs">
                          <Info className="w-4 h-4 text-slate-500 flex-shrink-0" />
                          <span>Transkrip percakapan belum tersinkronisasi. Evaluasi SOP CS akan otomatis aktif saat riwayat chat masuk.</span>
                        </div>
                      );
                    }

                    if (chatFindings.length > 0 && chatFindings[0] !== 'SOP percakapan CS terpenuhi & komitmen pembeli terpantau baik' && chatFindings[0] !== 'Kualitas transaksi dan komitmen pembeli terpantau baik') {
                      return (
                        <ul className="list-disc list-inside space-y-1 text-gray-600">
                          {chatFindings.map((reason: string, i: number) => (
                            <li key={i} className={reason.includes('rawan') || reason.includes('tidak') || reason.includes('minim') || reason.includes('dipaksa') || reason.includes('belum') ? 'text-amber-800 font-medium' : ''}>
                              {reason}
                            </li>
                          ))}
                        </ul>
                      );
                    }
                    return (
                      <div className="flex items-center gap-1.5 text-emerald-800 bg-emerald-50 p-2 rounded-lg border border-emerald-200/60">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                        <span>Seluruh SOP closing CS terpenuhi (Persetujuan deal jelas, alamat lengkap, dan komitmen COD terkonfirmasi).</span>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Layer 2: Riwayat Logistik Mengantar */}
              <div className="p-3.5 bg-gray-50 rounded-xl border border-gray-200 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-bold text-gray-800 block">
                      Layer 2: Riwayat Pengiriman Ekspedisi Mengantar (Bobot 35%)
                    </span>
                    <span className="text-[11px] text-gray-500">
                      Basis data multi-kurir Mengantar (keberhasilan kirim vs retur per kurir).
                    </span>
                  </div>
                  {selectedRtsLead.mengantarData?.totalOrders ? (
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                      selectedRtsLead.mengantarData.isHighRisk 
                        ? 'bg-rose-50 text-rose-700 border border-rose-200' 
                        : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    }`}>
                      {selectedRtsLead.mengantarData.overallDeliveryRate}% Sukses
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                      Nomor Baru
                    </span>
                  )}
                </div>

                {/* Catatan Logistik Khusus Mengantar */}
                {selectedRtsLead.mengantarData?.riskReasons && selectedRtsLead.mengantarData.riskReasons.length > 0 && (
                  <div className="p-2 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 space-y-0.5">
                    <div className="font-bold flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
                      Catatan Logistik Mengantar:
                    </div>
                    <ul className="list-disc list-inside space-y-0.5 pl-1">
                      {selectedRtsLead.mengantarData.riskReasons.map((r: string, i: number) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Kurir Breakdown */}
                {selectedRtsLead.mengantarData?.courierBreakdown && Object.keys(selectedRtsLead.mengantarData.courierBreakdown).length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
                    {Object.entries(selectedRtsLead.mengantarData.courierBreakdown).map(([courier, data]: [string, any]) => (
                      <div key={courier} className="p-2.5 bg-white rounded-lg border border-gray-200 text-xs shadow-xs">
                        <div className="font-bold text-gray-900 flex items-center justify-between">
                          <span>{courier}</span>
                          <span className="text-[10px] text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded font-semibold">
                            Rate {data.rate}
                          </span>
                        </div>
                        <div className="text-[11px] text-gray-600 mt-1">
                          Sukses: <strong className="text-emerald-600">{data.delivered || 0}</strong> / {data.total || 0}
                        </div>
                        <div className="text-[10px] text-rose-600 font-medium">
                          Retur (RTS): {data.rts || 0}x
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500 italic bg-white p-2.5 rounded-lg border border-gray-200">
                    Belum ada riwayat nomor ini di database Mengantar Logistics (Pembeli baru / belum pernah order via ekspedisi Mengantar).
                  </p>
                )}
              </div>
            </div>

            {/* Footer Modal Actions */}
            <div className="flex items-center justify-between border-t border-gray-100 pt-4">
              <a
                href={`https://wa.me/${selectedRtsLead.waNumber}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition shadow-sm"
              >
                <ExternalLink className="w-4 h-4" /> Buka WhatsApp Pembeli
              </a>
              <button
                onClick={() => setSelectedRtsLead(null)}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-xs font-semibold transition"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── MODAL 2: DETAIL INSIGHT & PROFIL PEMBELI AI (PORTAL TO BODY) ── */}
      {mounted && selectedInsightLead && createPortal(
        <div className="fixed inset-0 z-[99999] w-screen h-screen bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="relative bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-gray-100 p-6 space-y-5 my-auto">
            {/* Header Modal */}
            <div className="flex items-start justify-between border-b border-gray-100 pb-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-base font-bold text-gray-900">{selectedInsightLead.waNumber}</span>
                  {getConversionBadge(selectedInsightLead.conversionStatus)}
                  {getStageBadge(selectedInsightLead.leadStage, selectedInsightLead.score)}
                </div>
                <p className="text-xs text-gray-500">
                  CS Pemegang: <strong>{selectedInsightLead.assignedCsName || 'CS'}</strong> ({selectedInsightLead.assignedCsPhone || '-'}) • Terakhir Chat: {formatWibDateTime(selectedInsightLead.lastMessageAt)}
                </p>
              </div>
              <button
                onClick={() => setSelectedInsightLead(null)}
                className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Banner Minat Produk Teridentifikasi */}
            <div className="p-4 bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl flex items-center justify-between">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-700 block">
                  Produk Yang Diminati / Dipesan:
                </span>
                <span className="text-base font-bold text-gray-900 mt-0.5 block">
                  {selectedInsightLead.minatProduk || 'Belum Menentukan Produk'}
                </span>
              </div>
              <div className="text-right">
                <span className="text-[10px] text-gray-500 block font-medium">Skor Minat Beli</span>
                <span className="text-xl font-bold text-indigo-600">{selectedInsightLead.score} / 100</span>
              </div>
            </div>

            {/* Rangkuman Insight Psikologi Pembeli */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-gray-700 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-indigo-600" />
                Rangkuman Profil & Psikologi Pembeli (AI Profiler)
              </h4>
              <div className="p-4 bg-gray-50 rounded-xl border border-gray-200 text-xs text-gray-700 leading-relaxed space-y-2">
                <p className="font-semibold text-gray-900 text-sm leading-relaxed">
                  {selectedInsightLead.lastInsight || 'Belum ada catatan insight mendalam untuk prospek ini.'}
                </p>
                <p className="text-[11px] text-gray-500 pt-2 border-t border-gray-200/60">
                  Analisis ini diekstrak otomatis oleh AI dari interaksi chat pembeli: gaya bahasa, respon harga, tingkat urgensi, serta form spesifikasi pesanan yang dikirim ke CS.
                </p>
              </div>
            </div>

            {/* ── OBJECTION & ACTIONABLE FOLLOW-UP INTELLIGENCE (GRID 2 KOLOM) ── */}
            {(() => {
              const obj = getObjectionDetail(selectedInsightLead);
              return (
                <div className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-gray-700 flex items-center gap-1.5">
                    <Lightbulb className="w-4 h-4 text-amber-500" />
                    Strategi Follow-Up & Diagnosa Rintangan CS
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Card Kiri: Diagnosa Rintangan & Taktik CS */}
                    <div className="p-3.5 bg-gray-50 rounded-xl border border-gray-200 space-y-2.5 flex flex-col justify-between">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-gray-700">
                            🎯 Status Kendala:
                          </span>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${obj.tagClass}`}>
                            {obj.shortTag}
                          </span>
                        </div>
                        <h5 className="font-bold text-gray-900 text-xs">
                          {obj.label}
                        </h5>
                        <p className="text-[11px] text-gray-600 leading-relaxed">
                          {obj.summary}
                        </p>
                      </div>

                      <div className="p-2.5 bg-indigo-50/70 border border-indigo-100 rounded-lg space-y-1">
                        <span className="text-[10px] font-bold text-indigo-900 uppercase flex items-center gap-1">
                          <Lightbulb className="w-3.5 h-3.5 text-amber-500" /> Taktik Penanganan CS:
                        </span>
                        <p className="text-[11px] text-indigo-950 font-medium leading-relaxed">
                          {obj.suggestedAction}
                        </p>
                      </div>
                    </div>

                    {/* Card Kanan: Draft Kalimat Follow-up Siap Pakai */}
                    <div className="p-3.5 bg-emerald-50/50 rounded-xl border border-emerald-200 space-y-2.5 flex flex-col justify-between">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-900 flex items-center gap-1 whitespace-nowrap">
                            <MessageSquare className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" /> Draft Chat Siap Kirim
                          </span>
                          <span className="text-[10px] text-emerald-700 font-semibold bg-white px-1.5 py-0.5 rounded border border-emerald-200 whitespace-nowrap flex-shrink-0">
                            WA Ready
                          </span>
                        </div>
                        <div className="p-2.5 bg-white rounded-lg border border-emerald-200/80 text-[11px] text-gray-800 leading-relaxed font-sans shadow-2xs italic relative">
                          "{obj.followUpScript}"
                        </div>
                      </div>

                      <div className="pt-1 flex items-center gap-2">
                        <button
                          onClick={() => handleCopyScript(obj.followUpScript, selectedInsightLead.id)}
                          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition shadow-xs"
                        >
                          {copiedScript === selectedInsightLead.id ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-300" />
                              <span>Tersalin ke Clipboard!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>Salin Draft Chat</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Parameter Kualifikasi Prospek */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 text-xs">
                <span className="text-[10px] text-gray-400 block font-semibold uppercase">Tahap Corong (Funnel)</span>
                <span className="font-bold text-gray-800 text-sm mt-0.5 block">{selectedInsightLead.leadStage}</span>
              </div>
              <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 text-xs">
                <span className="text-[10px] text-gray-400 block font-semibold uppercase">Status Transaksi</span>
                <span className="font-bold text-gray-800 text-sm mt-0.5 block">{selectedInsightLead.conversionStatus}</span>
              </div>
              <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 text-xs">
                <span className="text-[10px] text-gray-400 block font-semibold uppercase">Volume Interaksi</span>
                <span className="font-bold text-gray-800 text-sm mt-0.5 block">{selectedInsightLead.totalMessages} pesan buffer</span>
              </div>
            </div>

            {/* Footer Actions */}
            <div className="flex items-center justify-between border-t border-gray-100 pt-4">
              <a
                href={`https://wa.me/${selectedInsightLead.waNumber}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition shadow-sm"
              >
                <ExternalLink className="w-4 h-4" /> Buka WhatsApp Pembeli
              </a>
              <button
                onClick={() => setSelectedInsightLead(null)}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-xs font-semibold transition"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
