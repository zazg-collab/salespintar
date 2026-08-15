export type LeadStage = 'COLD' | 'WARM' | 'HOT' | 'VERY_HOT';
export type ConversionStatus = 'CLOSING' | 'PENDING' | 'LOST';

export interface BuyingSignals {
  score: number;
  reasons: string[];
}

export interface LeadProfileAnalysis {
  leadCategory?: 'NEW_INBOUND' | 'AFTER_SALES';
  minatProduk: string | null;
  lastInsight: string;
  conversion: ConversionStatus;
  rawScore: number;
  stage: LeadStage;
  reasons: string[];
  rtsRiskScore?: number;
  rtsRiskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  rtsReasons?: string[];
  courierRecommendation?: string | null;
  mengantarData?: any;
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
  leadCategory?: 'NEW_INBOUND' | 'AFTER_SALES' | 'ALL' | string;
  stage?: LeadStage | 'ALL';
  conversion?: ConversionStatus | 'ALL';
  rtsLevel?: 'ALL' | 'LOW' | 'MEDIUM' | 'HIGH';
  csPhone?: string;
  csName?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
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
