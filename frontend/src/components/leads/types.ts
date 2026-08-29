export interface LeadItem {
  id: string;
  waNumber: string;
  waId: string | null;
  name?: string | null;
  leadCategory?: 'PROSPEK_IKLAN' | 'NEW_INBOUND' | 'AFTER_SALES' | 'OTHERS';
  minatProduk: string | null;
  lastInsight: string | null;
  leadStage: 'COLD' | 'WARM' | 'HOT' | 'VERY_HOT';
  score: number;
  conversionStatus: 'CLOSING' | 'REPEAT_ORDER' | 'PENDING' | 'LOST' | string;
  assignedCsName: string | null;
  assignedCsPhone: string | null;
  rtsRiskScore: number | null;
  // Langkah E Fase 27: sinkron dgn backend rts-risk.engine.ts (Langkah D Fase 26,
  // Temuan T2) -- 'EVALUATION_FAILED' = evaluasi RTS gagal total, BUKAN "aman".
  rtsRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EVALUATION_FAILED' | null;
  rtsReasons: string[];
  courierRecommendation: string | null;
  mengantarData: any;
  objectionType?: string | null;
  taktikCS?: string | null;
  draftWA?: string | null;
  totalMessages: number;
  lastMessageAt: string | null;
  createdAt: string;
  capiEventsSent?: string[];
}

export interface LeadStats {
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

export interface ObjectionDetail {
  type: string;
  shortTag: string;
  tagClass: string;
  label: string;
  summary: string;
  suggestedAction: string;
  suggestedScript: string;
}

export interface TimelineMilestoneEvent {
  id: string;
  type: 'FIRST_INBOUND' | 'CS_RESPONSE' | 'DEAL_CONVERSION' | 'RTS_VALIDATION' | 'AFTER_SALES' | 'NOTE';
  title: string;
  timestamp: string;
  timestampWib: string;
  description: string;
  badge?: {
    text: string;
    color: 'indigo' | 'emerald' | 'amber' | 'rose' | 'blue' | 'gray';
  };
  details?: Record<string, any>;
}

export interface CustomerOrderGroup {
  orderNumber: number;
  leadId: string;
  product: string;
  category: 'PROSPEK_IKLAN' | 'NEW_INBOUND' | 'AFTER_SALES';
  categoryLabel: string;
  conversionStatus: string;
  rtsRiskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'EVALUATION_FAILED' | null;
  rtsReasons?: string[];
  courierRecommendation?: string | null;
  estimatedValue: number;
  csName: string;
  csPhone: string;
  startDate: string;
  startDateWib: string;
  endDate: string;
  endDateWib: string;
  gapDaysFromPrevious?: number;
  events: TimelineMilestoneEvent[];
}

export interface CustomerTimelineResult {
  waNumber: string;
  name: string;
  totalOrders: number;
  totalClosings: number;
  totalLifetimeValue: number;
  isRepeatBuyer: boolean;
  firstContactAt: string;
  firstContactAtWib: string;
  latestContactAt: string;
  latestContactAtWib: string;
  salesCycleDays: number;
  currentStage: string;
  currentConversion: string;
  assignedCsName: string;
  assignedCsPhone: string;
  orderGroups: CustomerOrderGroup[];
}
