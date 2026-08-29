// backend/src/services/meta-result-resolver.service.ts
//
// [2026-08-26] SATU sumber kebenaran untuk menentukan "tipe hasil" (Result) sebuah campaign Meta
// Ads -- dipakai oleh SEMUA titik yang sebelumnya masing-masing re-implement heuristik sendiri
// secara terpisah (frontend meta-capi-dashboard/page.tsx getMetaResultAndCpr(), business.routes.ts
// getCampaignResultAndCpr() [PIC leaderboard] + /budget-facts inline block, ai-ads.routes.ts
// computeCampaignAuditFacts()). Lihat ledger 2026-08-26 "FIX FATAL: Result '-' padahal Meta ada
// Add To Cart" utk root cause kenapa konsolidasi ini penting, dan entry "EKSEKUSI GABUNGAN OPSI
// 1+2+3" utk keputusan menggabungkan 3 opsi hardening jadi satu putaran kerja.
//
// Helikopter view (3 lapis, semua digabung di modul ini):
//  1) KONSOLIDASI (Opsi 1): SATU implementasi dipakai semua consumer, bukan 4 salinan independen
//     yang bisa saling drift kalau salah satu diubah tanpa yang lain ikut diubah.
//  2) GROUND TRUTH (Opsi 2): utamakan optimization_goal / promoted_object.custom_event_type dari
//     ad set (FAKTA dari Meta, bukan tebakan dari kategori objective + daftar action_type manual).
//     Kalau tersedia & TIDAK mixed antar ad set dalam 1 campaign, ini SELALU menang atas heuristik
//     lama. PENTING soal rate limit Meta: modul ini TIDAK melakukan fetch API apapun sendiri --
//     optimizationGoal/customEventType HARUS sudah disediakan caller. Semua caller saat ini
//     menumpang di call Graph API adsets yang MEMANG SUDAH ADA utk keperluan lain (budget ABO,
//     learning phase, dst) dengan cuma menambah 2 field ke fields= yang sudah di-fetch -- 0 API
//     call tambahan, jadi TIDAK menambah beban/risiko rate limit Meta.
//  3) SAFETY NET (Opsi 3): kalau ground truth TIDAK tersedia/tidak dikenal DAN heuristik lama juga
//     gak match apapun padahal ada actions & spend, LOG supaya ketahuan ada tipe konversi baru yang
//     belum dikenal sistem -- bukan diam-diam tampil "-" seperti bug sebelumnya.
//
// Vocabulary Result yang didukung SAAT INI (jangan tambah tipe baru di sini tanpa juga menambah
// UI label-nya di 4 consumer + approval Bossfren -- custom_event_type/optimization_goal Meta yang
// belum kita kenal SENGAJA dibiarkan jatuh ke heuristik lama + kena safety net log, bukan otomatis
// dapat label baru yang belum direview):
//   purchase | addToCart | lead | msg | click | engage

import { logger } from '../utils/logger';

export type MetaResultMatchedType = 'purchase' | 'addToCart' | 'lead' | 'msg' | 'click' | 'engage';

export interface MetaActionEntry {
  action_type: string;
  value: string;
}

export interface MetaResultResolverInput {
  objective?: string | null;
  actions?: MetaActionEntry[];
  costPerActionType?: MetaActionEntry[];
  spend?: number;
  /** optimization_goal ad set (Meta ground truth) -- caller yang fetch, resolver cuma pakai. */
  optimizationGoal?: string | null;
  /** promoted_object.custom_event_type ad set (Meta ground truth) -- caller yang fetch. */
  customEventType?: string | null;
  /** Konteks buat safety-net log -- opsional tapi sangat disarankan diisi caller. */
  campaignId?: string;
  campaignName?: string;
}

export interface MetaResultResolverOutput {
  matchedType: MetaResultMatchedType;
  resultLabel: string;
  badgeLabel: string;
  resultValue: number;
  cprValue: number;
  source: 'ground_truth' | 'heuristic_objective';
}

const LABELS: Record<MetaResultMatchedType, { resultLabel: string; badgeLabel: string }> = {
  purchase: { resultLabel: 'Pembelian Situs Web', badgeLabel: 'Per Purchase' },
  addToCart: { resultLabel: 'Tambah ke Keranjang', badgeLabel: 'Per Tambah ke Keranjang' },
  lead: { resultLabel: 'Prospek', badgeLabel: 'Per Lead' },
  msg: { resultLabel: 'Pesan Baru', badgeLabel: 'Per Pesan' },
  click: { resultLabel: 'Klik Tautan', badgeLabel: 'Per Klik' },
  engage: { resultLabel: 'Interaksi', badgeLabel: 'Per Engagement' },
};

// Predikat action_type -- PERSIS salinan dari 4 implementasi lama (semantik TIDAK diubah, cuma
// dipindah ke 1 tempat), termasuk fix 2026-08-26 (addToCartPred) yang sudah live sebelumnya.
const purchasePred = (t: string) => t.includes('purchase') || t === 'omni_purchase' || t.includes('fb_pixel_purchase');
const addToCartPred = (t: string) => t.includes('add_to_cart');
const leadPred = (t: string) => t === 'lead' || t.includes('fb_pixel_lead') || t.includes('lead_grouped') || t.includes('contact');
const msgPred = (t: string) => t.includes('messaging') || t.includes('message');
const clickPred = (t: string) => t === 'link_click' || t === 'outbound_click' || t.includes('click');
const engagePred = (t: string) => t.includes('engagement') || t.includes('interaction') || t.includes('like') || t.includes('comment');

const PRED_BY_TYPE: Record<MetaResultMatchedType, (t: string) => boolean> = {
  purchase: purchasePred,
  addToCart: addToCartPred,
  lead: leadPred,
  msg: msgPred,
  click: clickPred,
  engage: engagePred,
};

const ALL_TYPES: MetaResultMatchedType[] = ['purchase', 'addToCart', 'lead', 'msg', 'click', 'engage'];

function findActionNum(arr: MetaActionEntry[] | undefined, predicate: (t: string) => boolean): number {
  if (!arr || !Array.isArray(arr)) return 0;
  const item = arr.find((a) => predicate(a.action_type));
  return item ? parseFloat(item.value) || 0 : 0;
}

function hasAnyAction(actions: MetaActionEntry[] | undefined, costPerActionType: MetaActionEntry[] | undefined, predicate: (t: string) => boolean): boolean {
  return findActionNum(actions, predicate) > 0 || findActionNum(costPerActionType, predicate) > 0;
}

// custom_event_type Meta (dari promoted_object ad set, DETERMINISTIK) -> vocabulary kita. HANYA
// custom_event_type yang SUDAH ADA label UI-nya yang dipetakan -- custom_event_type lain
// (INITIATE_CHECKOUT, VIEW_CONTENT, SUBSCRIBE, SEARCH, dll) SENGAJA TIDAK dipetakan supaya tidak
// diam-diam muncul label baru yang belum direview manual; kalau kejadian akan ke-log safety net.
const CUSTOM_EVENT_TYPE_MAP: Record<string, MetaResultMatchedType> = {
  PURCHASE: 'purchase',
  ADD_TO_CART: 'addToCart',
  LEAD: 'lead',
  COMPLETE_REGISTRATION: 'lead',
  SUBMIT_APPLICATION: 'lead',
  CONTACT: 'msg',
};

// optimization_goal Meta (dari ad set, DETERMINISTIK) -> vocabulary kita. Dipakai kalau
// custom_event_type kosong/gak kita kenal (mis. optimasi bukan custom conversion, spt
// LINK_CLICKS/LEAD_GENERATION/POST_ENGAGEMENT). OFFSITE_CONVERSIONS/ONSITE_CONVERSIONS SENGAJA
// tidak dipetakan di sini -- makna sebenarnya ada di custom_event_type, bukan optimization_goal-nya.
const OPTIMIZATION_GOAL_MAP: Record<string, MetaResultMatchedType> = {
  LEAD_GENERATION: 'lead',
  QUALITY_LEAD: 'lead',
  LINK_CLICKS: 'click',
  LANDING_PAGE_VIEWS: 'click',
  CONVERSATIONS: 'msg',
  MESSAGING_PURCHASE_CONVERSION: 'msg',
  MESSAGING_APPOINTMENT_CONVERSATION: 'msg',
  POST_ENGAGEMENT: 'engage',
  PAGE_LIKES: 'engage',
  THRUPLAY: 'engage',
  EVENT_RESPONSES: 'engage',
};

function resolveViaGroundTruth(input: MetaResultResolverInput): MetaResultMatchedType | null {
  const cet = (input.customEventType || '').toUpperCase();
  if (cet && CUSTOM_EVENT_TYPE_MAP[cet]) return CUSTOM_EVENT_TYPE_MAP[cet];
  const og = (input.optimizationGoal || '').toUpperCase();
  if (og && OPTIMIZATION_GOAL_MAP[og]) return OPTIMIZATION_GOAL_MAP[og];
  return null;
}

// Heuristik lama (objective kategori luas + cascade action_type) -- DIPERTAHANKAN APA ADANYA
// sebagai fallback kalau ground truth gak tersedia (token gak akses adsets, adset baru, dll) atau
// mixed antar ad set dalam 1 campaign. Semantik PERSIS sama dgn yang sudah live & teruji.
function resolveViaObjectiveHeuristic(input: MetaResultResolverInput): MetaResultMatchedType {
  const obj = (input.objective || '').toUpperCase();
  const isSales = obj.includes('SALES') || obj.includes('CONVERSION') || obj.includes('PURCHASE');
  const isTraffic = obj.includes('TRAFFIC') || obj.includes('LINK_CLICK');
  const isLead = obj.includes('LEAD');
  const isEngagement = obj.includes('ENGAGEMENT') || obj.includes('MESSAG') || obj.includes('INTERACTION');

  const has = (t: MetaResultMatchedType) => hasAnyAction(input.actions, input.costPerActionType, PRED_BY_TYPE[t]);

  if (isSales) {
    if (has('purchase')) return 'purchase';
    if (has('addToCart')) return 'addToCart';
    return 'purchase';
  }
  if (isLead) return 'lead';
  if (isTraffic) return 'click';
  if (isEngagement) return 'engage';

  if (has('purchase')) return 'purchase';
  if (has('addToCart')) return 'addToCart';
  if (has('msg')) return 'msg';
  if (has('lead')) return 'lead';
  if (has('click')) return 'click';
  if (has('engage')) return 'engage';
  return 'purchase';
}

/** Tentukan matchedType + sumbernya (ground_truth Meta atau heuristik objective lama). */
export function resolveMatchedType(input: MetaResultResolverInput): { matchedType: MetaResultMatchedType; source: MetaResultResolverOutput['source'] } {
  const groundTruth = resolveViaGroundTruth(input);
  if (groundTruth) {
    return { matchedType: groundTruth, source: 'ground_truth' };
  }
  const matchedType = resolveViaObjectiveHeuristic(input);

  // --- Safety net (Opsi 3) ---
  // Kalau ground truth gak tersedia/gak dikenal, DAN heuristik objective juga gak match satupun
  // action_type dari 6 tipe yang kita kenal padahal campaign ini beneran punya actions tercatat,
  // itu sinyal ada tipe konversi baru yang belum dipetakan sistem kita sama sekali -- LOG, jangan
  // diam-diam biarin Result tampil "-" (persis bug fatal sebelumnya, sebelum ada fallback addToCart).
  const spend = input.spend || 0;
  const hasKnownAction = ALL_TYPES.some((t) => hasAnyAction(input.actions, input.costPerActionType, PRED_BY_TYPE[t]));
  if (spend > 0 && !hasKnownAction && (input.actions?.length || 0) > 0) {
    const actionTypesSeen = (input.actions || []).map((a) => a.action_type).join(', ');
    logger.warn(
      `[MetaResultResolver] SAFETY NET: campaign "${input.campaignName || input.campaignId || '?'}" ` +
      `(id=${input.campaignId || '?'}, objective=${input.objective}, optimizationGoal=${input.optimizationGoal}, ` +
      `customEventType=${input.customEventType}) punya spend=${spend} & actions tercatat, tapi TIDAK ADA ` +
      `action_type yang cocok 6 tipe hasil yang kita kenal (purchase/addToCart/lead/msg/click/engage). ` +
      `action_types tercatat: [${actionTypesSeen}]. Kemungkinan tipe konversi baru yang belum dipetakan -- ` +
      `cek manual, pertimbangkan tambah predicate/label baru di meta-result-resolver.service.ts.`
    );
  }

  return { matchedType, source: 'heuristic_objective' };
}

/** Label UI (Bahasa Indonesia) untuk sebuah matchedType -- konsisten di semua consumer. */
export function getResultLabels(matchedType: MetaResultMatchedType): { resultLabel: string; badgeLabel: string } {
  return LABELS[matchedType];
}

/**
 * Hitung resultValue & cprValue numerik untuk matchedType tertentu, dari SATU set actions/
 * cost_per_action_type/spend (bisa dipanggil terpisah utk "hari ini" vs "7 hari" dgn matchedType
 * yang SAMA -- itu yang dipakai /budget-facts & computeCampaignAuditFacts).
 */
export function computeResultValue(
  matchedType: MetaResultMatchedType,
  actions: MetaActionEntry[] | undefined,
  costPerActionType: MetaActionEntry[] | undefined,
  spend: number
): { resultValue: number; cprValue: number } {
  const pred = PRED_BY_TYPE[matchedType];
  let resultValue = findActionNum(actions, pred);
  let cprValue = findActionNum(costPerActionType, pred);

  if (resultValue > 0 && cprValue === 0 && spend > 0) {
    cprValue = spend / resultValue;
  } else if (cprValue > 0 && resultValue === 0 && spend > 0) {
    resultValue = Math.round(spend / cprValue);
  }

  return { resultValue, cprValue };
}

/**
 * Versi komposit -- utk consumer yang cuma punya SATU set actions/cost_per_action_type/spend
 * (tabel drill-down campaign per hari, PIC leaderboard). Consumer yang butuh "hari ini" DAN
 * "7 hari" dgn matchedType yang sama (budget popup, AI audit narrative) pakai resolveMatchedType()
 * + getResultLabels() + computeResultValue() terpisah supaya cuma ditentukan SEKALI dari data
 * agregat yang paling representatif (7 hari), lalu diterapkan ke kedua rentang.
 */
export function resolveMetaResult(input: MetaResultResolverInput): MetaResultResolverOutput {
  const { matchedType, source } = resolveMatchedType(input);
  const { resultLabel, badgeLabel } = getResultLabels(matchedType);
  const { resultValue, cprValue } = computeResultValue(matchedType, input.actions, input.costPerActionType, input.spend || 0);
  return { matchedType, resultLabel, badgeLabel, resultValue, cprValue, source };
}
