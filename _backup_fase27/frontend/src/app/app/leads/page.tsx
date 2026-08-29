'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { apiGet } from '../../../lib/api';
import { formatWibDate, formatWibDateTime, getJakartaTodayStr, getJakartaOffsetStr, getJakartaFirstDayOfMonthStr } from '../../../lib/date';
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
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { LeadItem, LeadStats } from '../../../components/leads/types';
import { RtsAuditModal } from '../../../components/leads/RtsAuditModal';
import { LeadInsightModal } from '../../../components/leads/LeadInsightModal';
import { CustomerTimelineModal } from '../../../components/leads/CustomerTimelineModal';

export default function RiwayatPelangganPage() {
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [selectedRtsLead, setSelectedRtsLead] = useState<LeadItem | null>(null);
  const [selectedInsightLead, setSelectedInsightLead] = useState<LeadItem | null>(null);
  const [selectedTimelineLead, setSelectedTimelineLead] = useState<string | null>(null);
  const [stats, setStats] = useState<LeadStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'lastMessageAt' | 'createdAt'>('lastMessageAt');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  // debouncedSearch: nilai search yang benar-benar dikirim ke API (delay 500ms).
  // Ini memisahkan UI state (search) dari API call state (debouncedSearch),
  // mencegah spam request ke backend dan race condition pada hasil tabel.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
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

  const cleanMinatProduk = (p?: string | null): string | null => {
    if (!p) return null;
    const s = p.trim();
    if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'undefined' || s.toLowerCase() === 'none' || s.toLowerCase() === 'n/a' || s === '-') {
      return null;
    }
    return s;
  };

  const getObjectionDetail = useCallback((lead: LeadItem) => {
    const prodName = cleanMinatProduk(lead.minatProduk);
    const objType = (lead.objectionType || '').toUpperCase();

    // Map Tag, Label, dan Warna berdasarkan objectionType AI
    let meta = {
      shortTag: 'Follow Up',
      tagClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
      label: '💬 Tindak Lanjut Percakapan',
    };

    const isDeliveryConfirm =
      objType === 'AFTER_SALES_DELIVERY' ||
      /(sdh|sudah|telah|pun)\s+(diterima|sampai|sampe|tiba|mendarat|nyampe|masuk)/i.test(
        (lead.lastInsight || '') + ' ' + (lead.objectionType || '')
      );

    const isAfterSalesQuery =
      objType === 'AFTER_SALES_RESI' ||
      /(resi|status pengiriman|kurir|paket|kirim|sampai mana|belum sampai|lacak)/i.test(
        (lead.lastInsight || '') + ' ' + (lead.objectionType || '')
      );

    if (isDeliveryConfirm) {
      meta = {
        shortTag: 'Paket Diterima',
        tagClass: 'bg-teal-50 text-teal-700 border-teal-200',
        label: '📦 Paket Berhasil Diterima Pembeli',
      };
    } else if (isAfterSalesQuery) {
      meta = {
        shortTag: 'Tanya Resi',
        tagClass: 'bg-blue-50 text-blue-700 border-blue-200',
        label: '📦 Lacak Resi & Status Pengiriman',
      };
    } else if (objType === 'PRICE_OBJECTION') {
      meta = {
        shortTag: 'Nego Harga',
        tagClass: 'bg-orange-50 text-orange-700 border-orange-200',
        label: '🏷️ Nego Harga Produk',
      };
    } else if (objType === 'SHIPPING_COST') {
      meta = {
        shortTag: 'Nego Ongkir',
        tagClass: 'bg-amber-50 text-amber-700 border-amber-200',
        label: '💸 Keberatan Biaya Ongkir',
      };
    } else if (objType === 'SEEKING_PERMISSION') {
      meta = {
        shortTag: 'Izin Keluarga',
        tagClass: 'bg-teal-50 text-teal-700 border-teal-200',
        label: '👥 Musyawarah Keluarga / Pasangan',
      };
    } else if (objType === 'WAITING_SALARY') {
      meta = {
        shortTag: 'Nunggu Gajian',
        tagClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
        label: '🗓️ Menunggu Kesiapan Dana / Gajian',
      };
    } else if (objType === 'COD_UNCERTAINTY') {
      meta = {
        shortTag: 'Ragu COD',
        tagClass: 'bg-purple-50 text-purple-700 border-purple-200',
        label: '📦 Ragu SOP Kurir COD',
      };
    } else if (objType === 'PRODUCT_INQUIRY') {
      meta = {
        shortTag: 'Tanya Produk',
        tagClass: 'bg-sky-50 text-sky-700 border-sky-200',
        label: '🔍 Eksplorasi Kebutuhan Produk',
      };
    } else if (objType === 'COMPLAINT_DEFECT') {
      meta = {
        shortTag: 'Komplain Garansi',
        tagClass: 'bg-rose-50 text-rose-700 border-rose-200',
        label: '⚠️ Layanan Garansi & Retur',
      };
    } else if (lead.conversionStatus === 'CLOSING' || objType === 'DEAL_CONFIRMED') {
      meta = {
        shortTag: 'Deal Closing',
        tagClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        label: '✅ Transaksi Selesai (Deal Closing)',
      };
    } else if (lead.conversionStatus === 'LOST' || objType === 'LOST') {
      meta = {
        shortTag: 'Batal',
        tagClass: 'bg-rose-50 text-rose-700 border-rose-200',
        label: '❌ Transaksi Batal (Lost)',
      };
    }

    // Jika AI sudah menghasilkan taktik dan draft WA khusus, gunakan data AI murni!
    if (lead.taktikCS && lead.draftWA) {
      return {
        type: objType || 'AI_GENERATED',
        shortTag: meta.shortTag,
        tagClass: meta.tagClass,
        label: meta.label,
        summary: lead.lastInsight || 'Analisis percakapan diproses otomatis oleh AI.',
        suggestedAction: lead.taktikCS,
        followUpScript: lead.draftWA,
      };
    }

    // Fallback untuk data legacy:
    if (isDeliveryConfirm) {
      return {
        type: 'AFTER_SALES_DELIVERY',
        shortTag: meta.shortTag,
        tagClass: meta.tagClass,
        label: meta.label,
        summary: lead.lastInsight || 'Pelanggan mengonfirmasi bahwa paket pesanan telah sampai dan diterima dengan baik.',
        suggestedAction: 'Apresiasi kepuasan pelanggan, berikan doa keberkahan, dan tawarkan panduan perawatan bilah.',
        followUpScript: `Alhamdulillah, terima kasih banyak atas kepercayaannya ya Kak! Semoga berkah dan bermanfaat untuk aktivitas Kakak. Jika butuh panduan perawatan bilah, kami selalu siap bantu ya kak 🙏`,
      };
    }

    if (isAfterSalesQuery) {
      return {
        type: 'AFTER_SALES_RESI',
        shortTag: meta.shortTag,
        tagClass: meta.tagClass,
        label: meta.label,
        summary: lead.lastInsight || 'Pelanggan menanyakan status pengiriman / nomor resi paket.',
        suggestedAction: 'Segera koordinasikan dengan tim gudang untuk cek nomor resi ekspedisi dan sampaikan estimasi tiba secara ramah.',
        followUpScript: `Halo Kak! Untuk paket pesanannya sedang kami mintakan nomor resinya ke tim gudang ya kak. Mohon ditunggu sebentar ya kak 🙏`,
      };
    }

    if (lead.conversionStatus === 'CLOSING') {
      return {
        type: 'RESOLVED_CLOSING',
        shortTag: meta.shortTag,
        tagClass: meta.tagClass,
        label: meta.label,
        summary: 'Pembeli telah menyetujui pesanan dan mengonfirmasi alamat pengiriman.',
        suggestedAction: 'Segera cetak label pengiriman & serahkan paket ke kurir rekomendasi.',
        followUpScript: `Halo Kak! Pesanan ${prodName || 'Kakak'} sedang disiapkan untuk proses packing ya kak. Resi pengiriman akan segera kami informasikan begitu paket diserahkan ke kurir. Terima kasih banyak atas kepercayaannya! 🙏`,
      };
    }

    if (lead.conversionStatus === 'LOST') {
      return {
        type: 'LOST',
        shortTag: meta.shortTag,
        tagClass: meta.tagClass,
        label: meta.label,
        summary: 'Prospek menolak atau membatalkan pembelian.',
        suggestedAction: 'Arsipkan kontak dan hindari spam chat berlebihan. Simpan nomor untuk broadcast promo khusus peluncuran produk baru.',
        followUpScript: `Terima kasih atas waktunya ya Kak! Jika nanti membutuhkan ${prodName || 'alat bilah berkualitas'}, kami selalu siap membantu. Semoga lancar selalu aktivitasnya! 🙏`,
      };
    }

    return {
      type: 'GENERAL_INQUIRY',
      shortTag: meta.shortTag,
      tagClass: meta.tagClass,
      label: meta.label,
      summary: lead.lastInsight || 'Calon pembeli sedang mengeksplorasi pilihan produk.',
      suggestedAction: 'Sapa dengan ramah dan tanyakan kebutuhan penggunaan alat agar CS bisa merekomendasikan varian produk yang paling tepat.',
      followUpScript: `Halo Kak! Untuk ${prodName || 'produk kami'} ready siap kirim ya kak. Rencananya mau digunakan untuk kebutuhan apa kak biar kami bantu siapkan varian yang paling pas? 😊`,
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
  const [customStart, setCustomStart] = useState(() => getJakartaOffsetStr(-6));
  const [customEnd, setCustomEnd] = useState(() => getJakartaTodayStr());

  const { startDate, endDate, dateRangeLabel } = useMemo(() => {
    const todayStr = getJakartaTodayStr();

    if (datePreset === 'all') {
      return { startDate: undefined, endDate: undefined, dateRangeLabel: 'Semua Waktu' };
    }
    if (datePreset === 'today') {
      return { startDate: todayStr, endDate: todayStr, dateRangeLabel: 'Hari Ini' };
    }
    if (datePreset === '7d') {
      return { startDate: getJakartaOffsetStr(-6), endDate: todayStr, dateRangeLabel: '7 Hari Terakhir' };
    }
    if (datePreset === '30d') {
      return { startDate: getJakartaOffsetStr(-29), endDate: todayStr, dateRangeLabel: '30 Hari Terakhir' };
    }
    if (datePreset === 'this_month') {
      return { startDate: getJakartaFirstDayOfMonthStr(), endDate: todayStr, dateRangeLabel: 'Bulan Ini' };
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

  const handleSortToggle = (field: 'lastMessageAt' | 'createdAt') => {
    if (sortBy === field) {
      setSortOrder(prev => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
    setPage(1);
  };

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '50',
        sortBy,
        sortOrder,
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
  }, [page, debouncedSearch, categoryFilter, stageFilter, statusFilter, rtsFilter, csFilter, startDate, endDate, sortBy, sortOrder]);

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
      case 'REPEAT_ORDER':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-bold bg-purple-50 text-purple-700 border border-purple-200 shadow-sm">
            <span>👑</span>
            Repeat Order
          </span>
        );
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

  const renderStackedTimestamp = (isoStr: string | null) => {
    if (!isoStr) return <span className="text-gray-400 text-xs">-</span>;
    const datePart = formatWibDate(isoStr);
    const timePart = formatWibDateTime(isoStr).split(', ')[1] || '';

    return (
      <div className="flex flex-col">
        <span className="font-semibold text-gray-900 text-xs whitespace-nowrap">{datePart}</span>
        <span className="text-[11px] text-gray-500 font-mono flex items-center gap-1 mt-0.5 whitespace-nowrap">
          <Clock className="w-2.5 h-2.5 text-gray-400" />
          {timePart || '-'}
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
            Riwayat Pelanggan
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
                setCategoryFilter('PROSPEK_IKLAN');
                setPage(1);
              }}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap ${
                categoryFilter === 'PROSPEK_IKLAN'
                  ? 'bg-indigo-600 text-white shadow-sm ring-1 ring-indigo-500'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200/50'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>🎯 Prospek Iklan (Form)</span>
            </button>
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
              <span>🌱 Prospek Organik</span>
            </button>
            <button
              onClick={() => {
                setCategoryFilter('OTHERS');
                setPage(1);
              }}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap ${
                categoryFilter === 'OTHERS'
                  ? 'bg-indigo-600 text-white shadow-sm ring-1 ring-indigo-500'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200/50'
              }`}
            >
              <span>📦 Layanan & Lainnya</span>
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
                <option value="REPEAT_ORDER">👑 Repeat Order</option>
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
                <th
                  onClick={() => handleSortToggle('createdAt')}
                  className="px-4 py-3.5 cursor-pointer select-none hover:bg-gray-100/90 hover:text-indigo-600 transition-colors"
                  title="Klik untuk mengurutkan berdasarkan Tanggal Masuk"
                >
                  <div className="flex items-center gap-1.5">
                    <span>Tgl Masuk</span>
                    {sortBy === 'createdAt' ? (
                      sortOrder === 'desc' ? (
                        <ArrowDown className="w-3.5 h-3.5 text-indigo-600 font-bold" />
                      ) : (
                        <ArrowUp className="w-3.5 h-3.5 text-indigo-600 font-bold" />
                      )
                    ) : (
                      <ArrowUpDown className="w-3.5 h-3.5 text-gray-400 opacity-60" />
                    )}
                  </div>
                </th>
                <th className="px-4 py-3.5">Minat Produk</th>
                <th className="px-4 py-3.5 min-w-[260px]">Insight Terakhir AI</th>
                <th className="px-4 py-3.5">Kategori Lead</th>
                <th className="px-4 py-3.5">Status Closing</th>
                <th className="px-4 py-3.5">Risiko RTS & Ekspedisi</th>
                <th className="px-4 py-3.5">CS Pemegang</th>
                <th
                  onClick={() => handleSortToggle('lastMessageAt')}
                  className="px-4 py-3.5 cursor-pointer select-none hover:bg-gray-100/90 hover:text-indigo-600 transition-colors"
                  title="Klik untuk mengurutkan berdasarkan Aktivitas Chat Terkini"
                >
                  <div className="flex items-center gap-1.5">
                    <span>Terakhir Chat</span>
                    {sortBy === 'lastMessageAt' ? (
                      sortOrder === 'desc' ? (
                        <ArrowDown className="w-3.5 h-3.5 text-indigo-600 font-bold" />
                      ) : (
                        <ArrowUp className="w-3.5 h-3.5 text-indigo-600 font-bold" />
                      )
                    ) : (
                      <ArrowUpDown className="w-3.5 h-3.5 text-gray-400 opacity-60" />
                    )}
                  </div>
                </th>
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
                        <button
                          onClick={() => setSelectedTimelineLead(lead.waNumber)}
                          className="hover:text-indigo-600 hover:underline flex items-center gap-1 transition-colors"
                          title="Lihat Timeline Customer Journey"
                        >
                          {lead.waNumber}
                          <Calendar className="w-3 h-3 text-indigo-400" />
                        </button>
                        <a
                          href={`https://wa.me/${lead.waNumber}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Buka Chat WhatsApp"
                          className="text-emerald-600 hover:text-emerald-700 ml-1"
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
                      {(() => {
                        const prod = cleanMinatProduk(lead.minatProduk);
                        return (
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold max-w-[200px] truncate ${
                            prod 
                              ? 'bg-indigo-50 text-indigo-700 border border-indigo-100' 
                              : 'bg-gray-100 text-gray-500 border border-gray-200 italic'
                          }`}>
                            {prod || 'Belum Memilih Produk'}
                          </span>
                        );
                      })()}
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

      {/* ── MODAL 1: DETAIL PACKING & AUDIT ANTI-RTS ── */}
      <RtsAuditModal
        lead={selectedRtsLead}
        isOpen={Boolean(mounted && selectedRtsLead)}
        onClose={() => setSelectedRtsLead(null)}
        getConversionBadge={getConversionBadge}
        getStageBadge={getStageBadge}
      />

      {/* ── MODAL 2: DETAIL INSIGHT & PROFIL PEMBELI AI ── */}
      <LeadInsightModal
        lead={selectedInsightLead}
        isOpen={Boolean(mounted && selectedInsightLead)}
        onClose={() => setSelectedInsightLead(null)}
        getConversionBadge={getConversionBadge}
        getStageBadge={getStageBadge}
        getObjectionDetail={getObjectionDetail}
        copiedScript={copiedScript}
        handleCopyScript={handleCopyScript}
      />

      {/* ── MODAL 3: CUSTOMER 360° TIMELINE MODAL ── */}
      <CustomerTimelineModal
        waNumber={selectedTimelineLead}
        isOpen={Boolean(mounted && selectedTimelineLead)}
        onClose={() => setSelectedTimelineLead(null)}
        getConversionBadge={getConversionBadge}
      />
    </div>
  );
}
