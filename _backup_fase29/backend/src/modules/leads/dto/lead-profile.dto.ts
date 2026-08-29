export type LeadStage = 'COLD' | 'WARM' | 'HOT' | 'VERY_HOT';
export type ConversionStatus = 'CLOSING' | 'REPEAT_ORDER' | 'PENDING' | 'LOST';

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
