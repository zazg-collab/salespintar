export type LeadStage = 'COLD' | 'WARM' | 'HOT' | 'VERY_HOT';
export type ConversionStatus = 'CLOSING' | 'REPEAT_ORDER' | 'PENDING' | 'LOST';

export type ObjectionType = 
  | 'AFTER_SALES_DELIVERY'
  | 'AFTER_SALES_RESI'
  | 'PRICE_OBJECTION'
  | 'SHIPPING_COST'
  | 'TRUST_ISSUE'
  | 'PRODUCT_INQUIRY'
  | 'PENDING_TRANSFER'
  | 'SWITCH_SHOPEE'
  | 'GENERAL_INBOUND';

export interface BuyingSignals {
  score: number;
  reasons: string[];
}

export type LeadCategory = 'PROSPEK_IKLAN' | 'NEW_INBOUND' | 'OTHERS';

export interface LeadProfileAnalysis {
  leadCategory?: LeadCategory;
  minatProduk: string | null;
  lastInsight: string;
  conversion: ConversionStatus;
  rawScore: number;
  stage: LeadStage;
  reasons: string[];
  rtsRiskScore?: number;
  // Langkah D Fase 26 (Temuan T2): tambah 'EVALUATION_FAILED' -- lihat RtsRiskLevel di
  // rts-risk.engine.ts utk rasionalisasi lengkap.
  rtsRiskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'EVALUATION_FAILED';
  rtsReasons?: string[];
  courierRecommendation?: string | null;
  mengantarData?: any;
  objectionType?: string | null;
  taktikCS?: string | null;
  draftWA?: string | null;
  // Langkah D-lanjutan (Fase 29): nominal "TOTAL COD: Rp xxx" yg DIKETIK CS SENDIRI saat
  // konfirmasi ke pembeli -- acuan utama nilai transaksi, dgn fallback ke katalog SKU di
  // timeline.service.ts kalau CS tidak menyebut angka.
  confirmedCodAmount?: number | null;
}

export interface ProcessConversationInput {
  businessId: string;
  contactJid: string;
  csPhone: string;
  csName?: string;
  rawTranscript: string;
  messageTimestamp?: Date;
}

export interface LeadFilterParams {
  businessId: string;
  page?: number;
  limit?: number;
  leadCategory?: LeadCategory | 'ALL' | string;
  stage?: LeadStage | 'ALL';
  conversion?: ConversionStatus | 'ALL';
  rtsLevel?: 'ALL' | 'LOW' | 'MEDIUM' | 'HIGH';
  csPhone?: string;
  csName?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  sortBy?: 'lastMessageAt' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
  // 'createdAt' = filter berdasarkan tanggal lahir lead (default, angka stabil/historis)
  // 'lastMessageAt' = filter berdasarkan chat terakhir (untuk mode monitoring aktif "⚡ Update Terbaru")
  filterBy?: 'createdAt' | 'lastMessageAt';
}

export interface LeadSummaryStats {
  totalLeads: number;
  hotLeads: number;
  warmLeads: number;
  coldLeads: number;
  closingLeads: number;
  pendingLeads: number;
  lostLeads: number;
  avgRtsRisk: number;
  highRiskRtsLeads: number;
}


/**
 * Saringan Integritas Nama Produk (Anti-Corrupted Carry-Over).
 * Memastikan string di DB bukan nilai hampa/placeholder/potongan chat obrolan sebelum di-carry-forward.
 */
export function isValidSpecificProductName(name: string | null | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (
    [
      '',
      'null',
      'undefined',
      'none',
      'n/a',
      '-',
      'umum',
      'tidak ada',
      'tidak ada informasi produk',
      'tidak diketahui',
      'belum spesifik',
      'umum (internal cs)',
    ].includes(lower)
  ) {
    return false;
  }
  if (
    lower.includes('belum spesifik') ||
    lower.includes('lanjut di proses') ||
    lower.includes('total ') ||
    lower.includes('?')
  ) {
    return false;
  }
  if (/^(?:saya|sy|kak|kakak|mas|pak|bapak|ibu|gan|min|admin)\b/i.test(lower)) {
    return false;
  }
  return trimmed.length >= 3;
}
