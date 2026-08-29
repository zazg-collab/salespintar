import io, re

SRC = 'src/services/baileys.service.ts'
s = io.open(SRC, encoding='utf-8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'jangkar tidak unik/tidak ketemu: %r' % old[:80]
    s = s.replace(old, new)

# ── 1. Catat kapan socket dibuat, bukan cuma kapan tersambung ────────────────
once(
    """  /** Kapan socket ini berhasil terhubung — dipakai mengukur umur sesi saat putus. */
  connectedAt?: number;
}""",
    """  /** Kapan socket ini berhasil terhubung — dipakai mengukur umur sesi saat putus. */
  connectedAt?: number;
  /**
   * Kapan socket ini DIBUAT (belum tentu tersambung).
   *
   * Dibutuhkan pemantau kesehatan: selama jabat tangan berlangsung,
   * `ws.isOpen` masih `false`. Tanpa masa tenggang berbasis waktu ini, pemantau
   * akan menganggap setiap socket yang baru lahir sebagai bangkai, membunuhnya,
   * lalu membuat yang baru — dan itu justru pabrik socket ganda.
   */
  createdAt: number;
}""",
)

# ── 2. Penjaga "apakah socket ini masih yang berlaku" ────────────────────────
once(
    """    const instance: BaileysInstance = { sock, businessId, waCredentialId: cred.id };
    this.instances.set(businessId, instance);""",
    """    const instance: BaileysInstance = { sock, businessId, waCredentialId: cred.id, createdAt: Date.now() };
    this.instances.set(businessId, instance);

    // ── Penjaga terpenting di seluruh berkas ini ─────────────────────────────
    //
    // Setiap penangan kejadian di bawah terikat pada SATU socket, tapi `instances`
    // berkunci businessId — jadi socket baru MENIMPA entri socket lama. Ketika
    // socket lama akhirnya menutup (dan WhatsApp memang menutupnya dengan
    // conflict/replaced begitu socket baru masuk), penangannya masih hidup dan
    // ikut menjalankan `instances.delete(businessId)` — yang dihapusnya entri
    // milik socket BARU yang sedang sehat.
    //
    // Akibatnya terlihat di log 30 Juli 2026 sebagai urutan yang mustahil:
    //
    //     10:18:22 info : WhatsApp connected for business 777779f9...
    //     10:18:22 error: Failed to send message ... WhatsApp not connected
    //
    // Socket hidup, tapi hilang dari daftar — jadi `getStatus()` melaporkan
    // DISCONNECTED dan `sendMessage()` menolak, padahal sambungannya baik-baik
    // saja. Lebih jauh: karena daftarnya kosong, penjaga "sudah ada socket" di
    // `doConnect` tidak pernah menahan apa pun, sehingga setiap klik Reconnect
    // membuat socket baru, tiap socket baru menendang yang lama dengan
    // conflict 440, dan penangan yang lama menghapus yang baru — perang yang
    // memberi makan dirinya sendiri.
    //
    // Sejak sekarang tiap penangan wajib memastikan dirinya masih yang berlaku
    // sebelum menyentuh keadaan bersama.
    const masihBerlaku = () => this.instances.get(businessId) === instance;""",
)

# ── 3. creds.update: socket basi tidak boleh menulis kredensial ──────────────
once(
    """    sock.ev.on('creds.update', async () => {
      await saveCreds();""",
    """    sock.ev.on('creds.update', async () => {
      // Socket basi menulis kredensial yang lebih tua ke atas yang lebih baru.
      // Diamkan; yang berlaku akan menyimpan versinya sendiri.
      if (!masihBerlaku()) return;
      await saveCreds();""",
)

# ── 4. connection === 'open' hanya sah dari socket yang berlaku ──────────────
once(
    """      if (connection === 'open') {
        const waId = sock.user?.id;
        if (!waId) return;""",
    """      if (connection === 'open') {
        const waId = sock.user?.id;
        if (!waId) return;
        if (!masihBerlaku()) {
          logger.warn(`Socket WA lama untuk business ${businessId} melapor 'open' padahal sudah digantikan — diabaikan`);
          return;
        }""",
)

# ── 5. connection === 'close' — inti perbaikannya ────────────────────────────
once(
    """        logger.warn(
          `WhatsApp closed for business ${businessId}: ${reason} (statusCode: ${statusCode}) ` +
          `| umur sesi: ${uptimeText} | PID ${process.pid}`,
        );
        this.instances.delete(businessId);
        logger.info(`WhatsApp disconnected for business ${businessId}`);""",
    """        logger.warn(
          `WhatsApp closed for business ${businessId}: ${reason} (statusCode: ${statusCode}) ` +
          `| umur sesi: ${uptimeText} | PID ${process.pid}`,
        );

        // Socket yang sudah digantikan menutup diri: itu WAJAR dan bukan urusan
        // siapa pun. Ia tidak boleh menghapus daftar, tidak boleh menyetel status
        // DISCONNECTED, dan sama sekali tidak boleh menjadwalkan sambung ulang —
        // sambungan yang sekarang berjalan justru punya socket lain yang sehat.
        if (!masihBerlaku()) {
          logger.info(
            `Penutupan di atas milik socket WA lama business ${businessId} yang sudah digantikan — diabaikan, sambungan yang berlaku tidak disentuh`,
          );
          return;
        }

        this.instances.delete(businessId);
        logger.info(`WhatsApp disconnected for business ${businessId}`);""",
)

# ── 6. doConnect: jangan bikin socket kedua kalau yang ada masih hidup ───────
once(
    """  private async doConnect(businessId: string, waitForQR: boolean = false): Promise<string | void> {
    if (this.instances.has(businessId)) {
      const existing = this.instances.get(businessId)!;
      const waId = existing.sock.user?.id;
      if (waitForQR) {
        if (waId) {
          const cred = await prisma.waCredential.findFirst({ where: { businessId } });
          if (cred?.qrCode) return cred.qrCode;
        }
        await this.disconnect(businessId);
      } else {
        if (waId) return;
        await this.disconnect(businessId);
      }
    }""",
    """  /**
   * Berapa lama socket baru diberi waktu menyelesaikan jabat tangan sebelum
   * dianggap gagal. Selama tenggang ini `ws.isOpen` boleh saja masih `false`.
   */
  private static readonly HANDSHAKE_GRACE_MS = 20_000;

  /** Socket ini hidup, atau setidaknya masih pantas ditunggu? */
  private masihHidup(inst: BaileysInstance): boolean {
    if (inst.sock.ws?.isOpen) return true;
    return Date.now() - inst.createdAt < BaileysManager.HANDSHAKE_GRACE_MS;
  }

  private async doConnect(businessId: string, waitForQR: boolean = false): Promise<string | void> {
    const existing = this.instances.get(businessId);
    if (existing) {
      // ── Sudah ada socket yang hidup: JANGAN buat lagi ─────────────────────
      // Dulu syaratnya `sock.user?.id` — properti yang hanya terisi kalau
      // pairing sudah selesai. Socket yang sedang jabat tangan belum punya itu,
      // jadi ia dianggap tidak ada lalu socket kedua dibuat. WhatsApp menutup
      // salah satunya dengan conflict 440, dan siklusnya berulang.
      //
      // Yang benar ditanyakan: apakah socket-nya HIDUP (atau masih pantas
      // ditunggu), bukan apakah pairing-nya sudah selesai.
      if (this.masihHidup(existing)) {
        if (waitForQR) {
          const cred = await prisma.waCredential.findFirst({ where: { businessId } });
          if (cred?.qrCode) return cred.qrCode;
          // Socket hidup tapi belum ada QR: kemungkinan besar sesi lama masih
          // sah dan WhatsApp tidak akan menerbitkan QR sama sekali.
          if (existing.sock.user?.id) return '';
        } else {
          logger.info(`Permintaan connect business ${businessId} dilewati: socket yang ada masih hidup`);
          return;
        }
      }
      // Socket memang sudah mati/kedaluwarsa — bersihkan lalu bangun yang baru.
      await this.disconnect(businessId);
    }""",
)

# ── 7. Pemantau kesehatan: beri tenggang jabat tangan ───────────────────────
once(
    """      for (const [businessId, instance] of this.instances) {
        if (instance.sock.ws?.isOpen) continue;
        logger.warn(`[Health] Socket WA business ${businessId} sudah mati tanpa event close — dibersihkan & disambungkan ulang`);""",
    """      for (const [businessId, instance] of this.instances) {
        if (this.masihHidup(instance)) continue;
        logger.warn(`[Health] Socket WA business ${businessId} sudah mati tanpa event close — dibersihkan & disambungkan ulang`);""",
)

# ── 8. connectAllActive: pulihkan dari DISK, bukan dari status di database ───
once(
    """  async connectAllActive(): Promise<void> {
    const activeCreds = await prisma.waCredential.findMany({
      where: { status: 'CONNECTED', business: { isActive: true } },
      include: { business: true },
    });

    for (const cred of activeCreds) {
      try {
        await this.connect(cred.businessId);
      } catch (err) {
        logger.error(`Failed to reconnect business ${cred.businessId}: ${err}`);
      }
    }
  }""",
    """  /**
   * Pulihkan sesi WhatsApp saat backend menyala.
   *
   * ── Kenapa syaratnya BUKAN status di database ─────────────────────────────
   * Versi sebelumnya hanya memulihkan kredensial yang statusnya `CONNECTED`.
   * Itu menjebak diri sendiri, karena saat backend dimatikan ia menjalankan
   * `disconnectAll()` yang menyetel status jadi `DISCONNECTED`. Jadi urutannya:
   *
   *     backend mati  → status jadi DISCONNECTED
   *     backend nyala → mencari yang CONNECTED → tidak ada
   *                   → socket tidak pernah dibangun lagi
   *
   * Hasilnya WhatsApp mati setiap kali backend restart — dan di masa
   * pengembangan `tsx watch` me-restart tiap kali satu berkas berubah. Yang
   * ditunggu manusia adalah "kok tidak nyambung sendiri", padahal
   * kredensialnya sehat dan perangkatnya masih terdaftar di HP.
   *
   * Sejak Fase 13 DISK adalah sumber kebenaran, dan status di database cuma
   * cerminan. Jadi yang ditanyakan sekarang: apakah `creds.json` ada di disk.
   * Status `BANNED` tetap dihormati, dan begitu juga bisnis yang dimatikan.
   */
  async connectAllActive(): Promise<void> {
    const creds = await prisma.waCredential.findMany({
      where: { status: { not: 'BANNED' }, business: { isActive: true } },
      include: { business: true },
    });

    for (const cred of creds) {
      const credsPath = path.join(this.getSessionDir(cred.businessId), 'creds.json');
      if (!fs.existsSync(credsPath)) {
        // Belum pernah scan, atau sesinya sudah dibersihkan. Menyambung di sini
        // hanya akan menerbitkan QR yang tidak ada yang melihat.
        logger.info(`Sesi WA business ${cred.businessId} dilewati saat bootstrap: creds.json belum ada (perlu scan QR)`);
        continue;
      }
      try {
        logger.info(`Memulihkan sesi WA business ${cred.businessId} dari disk...`);
        await this.connect(cred.businessId);
      } catch (err) {
        logger.error(`Failed to reconnect business ${cred.businessId}: ${err}`);
      }
    }
  }""",
)

io.open(SRC, 'w', encoding='utf-8').write(s)
print('OK   baileys.service.ts diperbarui')
