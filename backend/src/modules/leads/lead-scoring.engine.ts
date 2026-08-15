import { BuyingSignals, LeadStage } from './dto/lead-profile.dto';

interface BuyingTrigger {
  points: number;
  label: string;
  pattern: RegExp;
}

/**
 * Deterministic Buying Triggers (Diadopsi 1:1 dari hermes_repo / Sentinel Pattern).
 * Rule engine ini memberikan skor lantai (floor score) objektif sehingga model LLM
 * yang tidak konsisten tidak bisa mengecilkan skor lead yang nyata-nyata ingin beli.
 */
const BUYING_TRIGGERS: BuyingTrigger[] = [
  { points: 45, label: 'booking/DP/deal', pattern: /\b(dp|booking|book|pesan|order|deposit|uang muka|tanda jadi|mau beli|ambil|bungkus)\b/i },
  { points: 35, label: 'metode bayar/rekening', pattern: /\b(bayar|pembayaran|transfer|rekening|norek|no rek|bca|mandiri|bri|bni|cod|bayar di tempat|payment|qris)\b/i },
  { points: 30, label: 'tanya harga/promo/diskon', pattern: /\b(harga|berapa|brp|price|cost|diskon|promo|potongan|nego|total|ongkir|ongkos kirim)\b/i },
  { points: 25, label: 'kirim data diri/alamat', pattern: /\b(alamat|kirim ke|kecamatan|kelurahan|kabupaten|kota|provinsi|kode pos|nama lengkap|nomor hp|no hp|penerima)\b/i },
  { points: 20, label: 'cek spesifikasi/stok/varian', pattern: /\b(stok|stock|ready|tersedia|available|sisa|ukuran|warna|tipe|model|paket|varian|bahan|dimensi|panjang)\b/i },
];

export class LeadScoringEngine {
  /**
   * Deteksi sinyal pembelian deterministik dari teks pesan pembeli.
   */
  static detectBuyingSignals(buyerMessages: string[]): BuyingSignals {
    const text = (buyerMessages ?? []).join('\n');
    let score = 0;
    const reasons: string[] = [];

    for (const trig of BUYING_TRIGGERS) {
      if (trig.pattern.test(text)) {
        score += trig.points;
        reasons.push(trig.label);
      }
    }

    return { score: Math.min(100, score), reasons };
  }

  /**
   * Konversi skor numerik (0-100) menjadi LeadStage.
   */
  static stageFromScore(score: number): LeadStage {
    if (score >= 81) return 'VERY_HOT';
    if (score >= 61) return 'HOT';
    if (score >= 31) return 'WARM';
    return 'COLD';
  }

  /**
   * Gabungkan skor LLM dengan deterministic rule engine (Hermes Blend).
   * Nilai final adalah yang tertinggi antara LLM vs Heuristic.
   */
  static blendScore(
    llmScore: number,
    llmReasons: string[],
    signals: BuyingSignals,
  ): { score: number; stage: LeadStage; reasons: string[] } {
    const score = Math.max(0, Math.min(100, Math.max(llmScore, signals.score)));
    const reasons = Array.from(new Set([...signals.reasons, ...(llmReasons || [])]));
    return {
      score,
      stage: this.stageFromScore(score),
      reasons,
    };
  }

  /**
   * Resolusi State Machine Anti-Downgrade.
   * Lead yang sudah HOT / VERY_HOT tidak boleh tiba-tiba jatuh ke COLD hanya karena
   * buffer chat berikutnya sangat pendek ("makasih", "ok"), kecuali obrolan baru
   * eksplisit terdeteksi LOST / batal.
   */
  static resolveNextStage(
    currentStage: LeadStage,
    currentScore: number,
    newStage: LeadStage,
    newScore: number,
    isLost: boolean,
  ): { finalStage: LeadStage; finalScore: number } {
    if (isLost) {
      return { finalStage: 'COLD', finalScore: Math.min(currentScore, 10) };
    }

    // High-water mark ranking
    const rank: Record<LeadStage, number> = {
      COLD: 1,
      WARM: 2,
      HOT: 3,
      VERY_HOT: 4,
    };

    if (rank[newStage] >= rank[currentStage]) {
      return { finalStage: newStage, finalScore: Math.max(currentScore, newScore) };
    }

    // Pertahankan stage lama jika chat baru tidak downgrade secara tegas
    return { finalStage: currentStage, finalScore: Math.max(currentScore, newScore) };
  }
}
