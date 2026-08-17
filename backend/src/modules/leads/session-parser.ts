/**
 * Session Boundary & Role Normalizer Parser.
 * Membagi aliran chat mentah WhatsApp menjadi sesi-sesi transaksi terisolasi
 * dan menormalisasi peran pengirim (CS vs Pembeli).
 */

export interface ParsedChatMessage {
  timestamp: Date | null;
  senderRole: 'CS' | 'BUYER';
  senderName: string;
  text: string;
}

export interface SegmentedSession {
  sessionIndex: number;
  startTime: Date | null;
  endTime: Date | null;
  messages: ParsedChatMessage[];
  rawTranscript: string;
  isInboundAdTrigger: boolean;
  inboundProductCandidate: string | null;
}

export interface SessionParseResult {
  totalSessions: number;
  isRepeatOrder: boolean;
  activeSession: SegmentedSession;
  allSessions: SegmentedSession[];
}

export class SessionBoundaryParser {
  private static readonly CS_INDICATORS = [
    /\bcordova\b/i,
    /\bcs\b/i,
    /\badmin\b/i,
    /\btoko\b/i,
    /\bjuragan\b/i,
    /\baluna\b/i,
    /\bdeva\b/i,
    /\bcici\b/i,
    /\badisa\b/i,
    /\bannisa\b/i,
    /\bputri\b/i,
    /\bita\b/i,
  ];

  private static readonly INBOUND_AD_PATTERNS = [
    /Halo,\s*saya\s*sudah\s*melakukan\s*pemesanan\s*([^\n\r,]+?)\s*,\s*atas\s*nama/i,
    /saya\s*mau\s*(?:pesan|order|beli)\s*([^\n\r,]+)/i,
    /form\s+pemesanan\s+([^\n\r!]+?)\s+di\s+toko\s+kami/i,
    /Terima\s+kasih\s+sudah\s+mengisi\s+form\s+pemesanan\s+([^\n\r!]+)/i,
    /(?:📦\s*)?Produk\s*:\s*([^\n\r💰]+)/i,
    /pesanan\s+([^\n\r,]+?)\s+warna/i,
    /pesanan\s+([^\n\r,]+)/i,
  ];

  private static readonly TERMINAL_CLOSING_PATTERNS = [
    /CATATAN[\s\S]*?Pastikan\s+hp\s+Selalu\s+Aktif/i,
    /paketnya\s+udah\s+di\s+kirim/i,
    /hari\s+ini\s+barangnya\s+sampe/i,
    /akan\s+langsung\s+kami\s+proses/i,
    /pesanan\s+(?:kakak|bapak|ibu|anda)?\s*segera\s+kami\s+proses/i,
    /terimakasih\s+untuk\s+orderan/i,
    /tidak\s+jadi\s+order/i,
    /g\s+jadilah/i,
  ];

  /**
   * Cek apakah transkrip memiliki tanda formulir landing page resmi (inbound form).
   * Hanya mencocokkan format pesan pengisian formulir pembeli, BUKAN rincian biaya/total COD dari CS.
   */
  public static isTrueFormInbound(transcript: string): boolean {
    if (!transcript) return false;
    return (
      /-\s*(?:Fb|Goo[A-Za-z0-9]*|TT|Ad|NPM|NFR)\s*-?/i.test(transcript) ||
      /Halo,\s*saya\s*sudah\s*melakukan\s*pemesanan/i.test(transcript) ||
      /saya\s+sudah\s+melakukan\s+pemesanan|atas\s+nama\s*[\w\s]+,|mohon\s+segera\s+diproses\s+ya/i.test(transcript) ||
      /Terima\s+kasih\s+sudah\s+mengisi\s+form\s+pemesanan/i.test(transcript) ||
      /form\s+pemesanan\s+([^\n\r!]+?)\s+di\s+toko\s+kami/i.test(transcript) ||
      /Formulir\s+Pemesanan/i.test(transcript) ||
      /cdv\.form\.id|app\.formulir\.com|orderonline/i.test(transcript)
    );
  }

  /**
   * Cek apakah transkrip memiliki konfirmasi closing transaksi sah.
   *
   * @param transcript   - Teks penuh sesi aktif (CS + Buyer), dipakai untuk deteksi sinyal closing positif.
   * @param buyerOnlyText - Teks pesan BUYER saja (opsional). Jika disediakan, dipakai untuk cek
   *                        exclusion (ragu-ragu / purna jual) agar template CS tidak memblokir closing.
   */
  public static isDeterministicClosing(transcript: string, buyerOnlyText?: string): boolean {
    if (!transcript) return false;

    // Gunakan buyer-only text untuk exclusion agar template CS tidak memicu false-block.
    // Contoh: "resi akan segera kami informasikan" dari CS TIDAK boleh memblokir closing.
    const exclusionText = buyerOnlyText ?? transcript;

    // Jangan tandai closing jika ada sinyal keraguan/penolakan kuat dari PEMBELI
    const hasHesitation = /(tanya\s+(?:mama|ibu|istri|suami|bapak|ortu|orang\s*tua)|minta\s+izin|izin\s+dulu|pikir\s+dulu|nanti\s+dulu|belum\s+ada\s+uang|belum\s+gajian|kemahalan|gak\s+jadi|nggak\s+jadi|batal|cancel)/i.test(exclusionText);
    if (hasHesitation) return false;

    // Jangan tandai closing jika PEMBELI mengirim sinyal purna jual (resi / barang sampai / komplain)
    // CATATAN: "terima kasih banyak atas kepercayaannya" SENGAJA dihapus dari sini —
    // frasa itu adalah template CS DEAL_CONFIRMED (item 10), bukan sinyal purna jual pembeli.
    const isAfterSalesChat = /(resi|nomor\s+resi|status\s+pengiriman|kapan\s+sampai|belum\s+sampai|sudah\s+diterima|sdh\s+diterima)/i.test(exclusionText);
    if (isAfterSalesChat) return false;

    return (
      /akan\s+langsung\s+kami\s+proses|pesanan\s+(?:kakak|bapak|ibu|anda)?\s*segera\s+kami\s+proses/i.test(transcript) ||
      /CATATAN[\s\S]*?Pastikan\s+hp\s+Selalu\s+Aktif/i.test(transcript) ||
      /(?:TOTAL\s+COD|RINCIAN\s+BIAYA)[\s\S]*?(?:sudah\s+benar|sudah\s+sesuai|fix\s+kirim|bungkus\s+kak|bungkus\s+mas|proses\s+sekarang|kirim\s+sekarang)/i.test(transcript)
    );
  }

  /**
   * Parse baris chat mentah menjadi daftar ParsedChatMessage terstruktur.
   */
  public static parseLines(transcript: string): ParsedChatMessage[] {
    if (!transcript || !transcript.trim()) return [];

    const lines = transcript.split(/\r?\n/);
    const parsed: ParsedChatMessage[] = [];

    // Regex standar WhatsApp export (Android, iOS, WA Web):
    // e.g. "19/06/26 07.24 - Cordova Store Aluna: Hai kak Zamri"
    // e.g. "14/08/26, 22:28 - H. MHD ZAMRI: Halo..."
    // e.g. "[14/08/26 22.28.15] Cordova Store: ..."
    const waLineRegex = /^(?:\[?(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})[,\s]+(\d{1,2}[\.:]\d{1,2}(?:[\.:]\d{1,2})?(?:\s*[AaPp][Mm])?)\]?\s*[-–]?\s*)?([^:]+?):\s*([\s\S]*)$/;

    let currentMsg: ParsedChatMessage | null = null;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      // Abaikan baris sistem enkripsi / timer WA
      if (
        trimmed.includes('Pesan dan telepon terenkripsi') ||
        trimmed.includes('timer default untuk pesan sementara') ||
        trimmed.includes('kini menjadi kontak') ||
        trimmed.includes('layanan yang aman dari Meta') ||
        trimmed.includes('mengaktifkan tanggapan AI') ||
        trimmed.includes('menonaktifkan pesan sementara')
      ) {
        continue;
      }

      // 1. Cek format Tagged Buffer (e.g. [CS] text atau [BUYER] text dari live Baileys stream)
      const tagMatch = rawLine.match(/^\[(CS|SELLER|ADMIN|BUYER|CUSTOMER|PEMBELI)\]:?\s*([\s\S]*)$/i);
      if (tagMatch) {
        const tag = tagMatch[1].toUpperCase();
        const textContent = (tagMatch[2] || '').trim();
        const isCs = ['CS', 'SELLER', 'ADMIN'].includes(tag);
        currentMsg = {
          timestamp: null,
          senderRole: isCs ? 'CS' : 'BUYER',
          senderName: isCs ? 'CS Store' : 'Pembeli',
          text: textContent,
        };
        parsed.push(currentMsg);
        continue;
      }

      const match = rawLine.match(waLineRegex);
      if (match) {
        const dateStr = match[1];
        const timeStr = match[2];
        const senderRaw = (match[3] || '').trim();
        const textContent = (match[4] || '').trim();

        // Tentukan apakah pengirim adalah CS atau Pembeli
        const isCs = this.CS_INDICATORS.some((pattern) => pattern.test(senderRaw));
        const senderRole: 'CS' | 'BUYER' = isCs ? 'CS' : 'BUYER';

        let timestamp: Date | null = null;
        if (dateStr && timeStr) {
          timestamp = this.parseDate(dateStr, timeStr);
        }

        currentMsg = {
          timestamp,
          senderRole,
          senderName: senderRaw,
          text: textContent,
        };
        parsed.push(currentMsg);
      } else if (currentMsg) {
        // Multi-line continuation of previous message
        currentMsg.text += `\n${rawLine}`;
      } else {
        // Baris pembuka tanpa header pengirim
        parsed.push({
          timestamp: null,
          senderRole: 'BUYER',
          senderName: 'Pembeli',
          text: rawLine,
        });
      }
    }

    return parsed;
  }

  /**
   * Segmentasi percakapan menjadi beberapa sesi berdasarkan terminal status dan pemicu iklan baru.
   */
  public static segmentSessions(transcript: string): SessionParseResult {
    const messages = this.parseLines(transcript);

    if (messages.length === 0) {
      const emptySession: SegmentedSession = {
        sessionIndex: 0,
        startTime: null,
        endTime: null,
        messages: [],
        rawTranscript: transcript,
        isInboundAdTrigger: false,
        inboundProductCandidate: null,
      };
      return {
        totalSessions: 1,
        isRepeatOrder: false,
        activeSession: emptySession,
        allSessions: [emptySession],
      };
    }

    const sessions: SegmentedSession[] = [];
    let currentSessionMsgs: ParsedChatMessage[] = [];
    let prevMsg: ParsedChatMessage | null = null;
    let hadTerminalInCurrent = false;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      let isNewSessionTrigger = false;
      let inboundProd: string | null = null;

      // Cek apakah pesan pembeli merupakan pemicu klik iklan baru
      if (msg.senderRole === 'BUYER') {
        for (const pattern of this.INBOUND_AD_PATTERNS) {
          const m = msg.text.match(pattern);
          if (m && m[1]) {
            inboundProd = m[1].replace(/-(?:Fb|Goo\d*|Google|Tiktok|Ig|Ads|NPM|NFR|Ad)\b.*/i, '').trim();
            break;
          }
        }
      }

      // Evaluasi jeda waktu (Inactivity Gap > 48 jam)
      let hasLongTimeGap = false;
      if (prevMsg && prevMsg.timestamp && msg.timestamp) {
        const diffHours = (msg.timestamp.getTime() - prevMsg.timestamp.getTime()) / (1000 * 60 * 60);
        if (diffHours >= 48) {
          hasLongTimeGap = true;
        }
      }

      // Kondisi pemotongan sesi baru:
      // 1. Ditemukan Inbound Ad Trigger baru dari pembeli, DAN sudah ada pesan di sesi sebelumnya
      // 2. ATAU ada jeda waktu lama (>48 jam) SETELAH sesi sebelumnya mencapai status terminal (selesai/closing/lost)
      if (currentSessionMsgs.length >= 3) {
        if (inboundProd && msg.senderRole === 'BUYER') {
          isNewSessionTrigger = true;
        } else if (hasLongTimeGap && hadTerminalInCurrent) {
          isNewSessionTrigger = true;
        }
      }

      if (isNewSessionTrigger) {
        // Tutup sesi sebelumnya
        sessions.push(this.buildSessionObject(sessions.length, currentSessionMsgs));
        currentSessionMsgs = [];
        hadTerminalInCurrent = false;
      }

      currentSessionMsgs.push(msg);

      // Cek apakah pesan ini menandai status terminal
      if (this.TERMINAL_CLOSING_PATTERNS.some((pat) => pat.test(msg.text))) {
        hadTerminalInCurrent = true;
      }

      prevMsg = msg;
    }

    if (currentSessionMsgs.length > 0) {
      sessions.push(this.buildSessionObject(sessions.length, currentSessionMsgs));
    }

    const activeSession = sessions[sessions.length - 1]!;
    const isRepeatOrder = sessions.length > 1;

    return {
      totalSessions: sessions.length,
      isRepeatOrder,
      activeSession,
      allSessions: sessions,
    };
  }

  private static buildSessionObject(index: number, msgs: ParsedChatMessage[]): SegmentedSession {
    let startTime: Date | null = null;
    let endTime: Date | null = null;
    let isInboundAdTrigger = false;
    let inboundProductCandidate: string | null = null;

    if (msgs.length > 0) {
      startTime = msgs[0]?.timestamp || null;
      endTime = msgs[msgs.length - 1]?.timestamp || null;

      // Cari pesan pemicu iklan pertama pembeli atau CS
      for (const m of msgs) {
        for (const pattern of this.INBOUND_AD_PATTERNS) {
          const match = m.text.match(pattern);
          if (match && match[1]) {
            isInboundAdTrigger = true;
            inboundProductCandidate = match[1]
              .replace(/-(?:Fb|Goo\d*|Google|Tiktok|Ig|Ads|NPM|NFR|Ad)\b.*/i, '')
              .trim();
            break;
          }
        }
        if (isInboundAdTrigger && inboundProductCandidate) break;
      }
    }

    const rawTranscript = msgs
      .map((m) => {
        const timePrefix = m.timestamp
          ? `${m.timestamp.toLocaleDateString('id-ID')} ${m.timestamp.toLocaleTimeString('id-ID')} - `
          : '';
        return `${timePrefix}${m.senderName}: ${m.text}`;
      })
      .join('\n');

    return {
      sessionIndex: index,
      startTime,
      endTime,
      messages: msgs,
      rawTranscript,
      isInboundAdTrigger,
      inboundProductCandidate,
    };
  }

  private static parseDate(dateStr: string, timeStr: string): Date | null {
    try {
      // Normalisasi 19/06/26 atau 19/06/2026
      const parts = dateStr.split(/[\/\-\.]/);
      if (parts.length < 3) return null;
      const d = parseInt(parts[0]!, 10);
      const m = parseInt(parts[1]!, 10);
      let y = parseInt(parts[2]!, 10);
      if (y < 100) y += 2000;

      // Normalisasi waktu 07.24 atau 22:28:15
      const timeParts = timeStr.replace(/[^\d:]/g, ':').split(':').filter(Boolean);
      const hour = parseInt(timeParts[0] || '0', 10);
      const minute = parseInt(timeParts[1] || '0', 10);
      const sec = parseInt(timeParts[2] || '0', 10);

      // WhatsApp export waktu di Indonesia menggunakan zona waktu WIB (UTC+7 / Asia/Jakarta).
      // Konstruksi ISO-8601 dengan offset eksplisit +07:00 agar waktu UTC tersimpan tepat dan konsisten.
      const mmStr = String(m).padStart(2, '0');
      const ddStr = String(d).padStart(2, '0');
      const hhStr = String(hour).padStart(2, '0');
      const minStr = String(minute).padStart(2, '0');
      const secStr = String(sec).padStart(2, '0');

      const isoWib = `${y}-${mmStr}-${ddStr}T${hhStr}:${minStr}:${secStr}+07:00`;
      const date = new Date(isoWib);
      return isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }
}
