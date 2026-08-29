import os, sys
repo = os.path.join(os.environ['HOME'], 'mnt', 'salespintar_repo')
path = os.path.join(repo, 'backend/src/routes/video-guard.routes.ts')
with open(path) as f:
    content = f.read()
backup = path + '.bak-20260825-feedback-fix'
with open(backup, 'w') as f:
    f.write(content)

edits = []

# EDIT 1: persistAuditReport -- fix sumber layersApplied (channels_used, bukan
# presentation_layers_applied yg selalu kosong) + preservasi _ad_context saat overwrite rawReportJson.
old1 = """async function persistAuditReport(auditId: string, businessId: string, report: Record<string, unknown>): Promise<void> {
  try {
    await prisma.videoAdAudit.updateMany({
      where: { id: auditId, businessId },
      data: {
        overallScore: typeof report.overall_compliance_score === 'number' ? report.overall_compliance_score : undefined,
        verdict: typeof report.verdict === 'string' ? report.verdict : undefined,
        layersApplied: parseLayers(report.presentation_layers_applied),
        rawReportJson: report as Prisma.InputJsonValue,
      },
    });
  } catch (e) {
    logger.warn(`[VideoGuard] Gagal update VideoAdAudit ${auditId}: ${(e as Error).message}`);
  }
}"""
new1 = """async function persistAuditReport(auditId: string, businessId: string, report: Record<string, unknown>): Promise<void> {
  try {
    // FIX 2026-08-25 (feedback Bossfren -- kolom Status di Riwayat Audit): metaguard_service
    // sekarang mengisi `channels_used`, BUKAN `presentation_layers_applied` (field itu selalu
    // kosong -- drift lama antara kontrak Node<->metaguard_service, baru ketahuan lewat investigasi
    // "kok video jarang ke-cek" hari ini). Prioritaskan channels_used, fallback field lama.
    const layers = parseLayers((report as any).channels_used ?? report.presentation_layers_applied);

    // _ad_context (adName asli + copy asli sebelum diaudit, lihat POST /meta-rejected-creatives/
    // :adId/audit) ditulis saat baris dibuat (submit) -- HARUS dipertahankan di sini, kalau tidak
    // hilang tertimpa waktu rawReportJson diisi penuh dgn hasil report akhir.
    const existingRow = await prisma.videoAdAudit.findUnique({ where: { id: auditId }, select: { rawReportJson: true } });
    const existingAdContext = (existingRow?.rawReportJson as any)?._ad_context;

    await prisma.videoAdAudit.updateMany({
      where: { id: auditId, businessId },
      data: {
        overallScore: typeof report.overall_compliance_score === 'number' ? report.overall_compliance_score : undefined,
        verdict: typeof report.verdict === 'string' ? report.verdict : undefined,
        layersApplied: layers,
        rawReportJson: (existingAdContext ? { ...report, _ad_context: existingAdContext } : report) as Prisma.InputJsonValue,
      },
    });
  } catch (e) {
    logger.warn(`[VideoGuard] Gagal update VideoAdAudit ${auditId}: ${(e as Error).message}`);
  }
}

/** Tempel _ad_context (adName/originalHeadline/originalPrimaryText yg sudah tersimpan di DB) ke
 *  object report yang mau dikirim ke frontend. report dari metaguard_service sendiri (in-memory)
 *  TIDAK tahu-menahu soal _ad_context krn itu murni ditambahkan Node di sini -- jadi wajib digabung
 *  manual tiap kali baca (GET /audit/:auditId & POST /audit/:auditId/clarify), bukan cuma sekali
 *  waktu persist. Best-effort, tidak boleh menggagalkan response utama. */
async function attachAdContext(auditId: string, report: Record<string, unknown>): Promise<void> {
  try {
    const row = await prisma.videoAdAudit.findUnique({ where: { id: auditId }, select: { rawReportJson: true } });
    const ctx = (row?.rawReportJson as any)?._ad_context;
    if (ctx) {
      (report as any).ad_name = ctx.adName ?? null;
      (report as any).original_headline = ctx.originalHeadline ?? null;
      (report as any).original_primary_text = ctx.originalPrimaryText ?? null;
    }
  } catch { /* best-effort */ }
}"""

# EDIT 2: GET /audit/:auditId -- panggil attachAdContext setelah persist.
old2 = """    if (upstream.ok && data?.status === 'done' && data?.report) {
      await persistAuditReport(auditId, businessId, data.report);
    }
    res.status(upstream.status).json(data);
  } catch (e) { next(e); }
});

const clarifySchema"""
new2 = """    if (upstream.ok && data?.status === 'done' && data?.report) {
      await persistAuditReport(auditId, businessId, data.report);
      await attachAdContext(auditId, data.report);
    }
    res.status(upstream.status).json(data);
  } catch (e) { next(e); }
});

const clarifySchema"""

# EDIT 3: POST /audit/:auditId/clarify -- sama, attachAdContext setelah persist.
old3 = """    if (upstream.ok && typeof data?.verdict === 'string') {
      await persistAuditReport(auditId, businessId, data);
    }
    res.status(upstream.status).json(data);
  } catch (e) { next(e); }
});

// ══════════════════════════════════════════════════════════════════════════
// POST /video-guard/reinforce"""
new3 = """    if (upstream.ok && typeof data?.verdict === 'string') {
      await persistAuditReport(auditId, businessId, data);
      await attachAdContext(auditId, data);
    }
    res.status(upstream.status).json(data);
  } catch (e) { next(e); }
});

// ══════════════════════════════════════════════════════════════════════════
// POST /video-guard/reinforce"""

# EDIT 4: GET /history -- tambah adName + channelsCompleted/channelsTotal, rawReportJson tidak
# diteruskan mentah ke response (cuma dipakai hitung 2 field lalu dibuang).
old4 = """router.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const businessId = req.user!.businessId;
    const take = Math.min(Number(req.query.take) || 50, 200);
    const audits = await prisma.videoAdAudit.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        adTitle: true,
        overallScore: true,
        verdict: true,
        layersApplied: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    res.json({ audits });
  } catch (e) { next(e); }
});"""
new4 = """const TOTAL_AUDIT_CHANNELS = 5; // visual, audio, teks, thumbnail, landing page -- lihat CHANNEL_LABELS di frontend page.tsx

router.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const businessId = req.user!.businessId;
    const take = Math.min(Number(req.query.take) || 50, 200);
    const rows = await prisma.videoAdAudit.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        adTitle: true,
        overallScore: true,
        verdict: true,
        layersApplied: true,
        rawReportJson: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    // Feedback Bossfren 2026-08-25: (1) judul Riwayat harus konsisten dgn kartu "Ads Creative" --
    // pakai adName asli (dari _ad_context) kalau ada; (2) kolom status kelengkapan channel, krn
    // investigasi hari ini nemu banyak audit diam-diam cuma pakai teks+thumbnail (video gagal
    // diambil dari Meta) tanpa ada tanda apa pun di UI. `rawReportJson` SENGAJA tidak diteruskan
    // utuh ke response (bisa berat, ada raw_assessment lengkap) -- cuma dipakai hitung 2 field di
    // bawah lalu dibuang.
    const audits = rows.map((r) => {
      const ctx = (r.rawReportJson as any)?._ad_context;
      return {
        id: r.id,
        adTitle: r.adTitle,
        adName: ctx?.adName ?? null,
        overallScore: r.overallScore,
        verdict: r.verdict,
        channelsCompleted: (r.layersApplied || []).length,
        channelsTotal: TOTAL_AUDIT_CHANNELS,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
    res.json({ audits });
  } catch (e) { next(e); }
});"""

# EDIT 5: POST /meta-rejected-creatives/:adId/audit -- simpan _ad_context saat create baris awal.
old5 = """        await prisma.videoAdAudit.create({
          data: {
            id: data.audit_id,
            businessId,
            adTitle: String(adTitle),
            metaAdId: adId,
            metaVideoId: metaVideoId || undefined,
          },
        });"""
new5 = """        await prisma.videoAdAudit.create({
          data: {
            id: data.audit_id,
            businessId,
            adTitle: String(adTitle),
            metaAdId: adId,
            metaVideoId: metaVideoId || undefined,
            // _ad_context (2026-08-25, feedback Bossfren): simpan nama ad ASLI (adData.name --
            // yang tampil di kartu "Ads Creative") + copy asli SEBELUM diaudit, supaya halaman
            // Riwayat & Laporan bisa konsisten dgn kartu Ads Creative (bukan cuma nama creative
            // yg dipakai `adTitle`), dan "Saran Caption" bisa dibandingkan versi asli vs saran.
            rawReportJson: {
              _ad_context: {
                adName: adData.name || null,
                originalHeadline: headline || null,
                originalPrimaryText: primaryText || null,
              },
            } as Prisma.InputJsonValue,
          },
        });"""

edits = [(old1, new1, 'persistAuditReport+attachAdContext'), (old2, new2, 'GET /audit/:auditId'), (old3, new3, 'POST /audit/:auditId/clarify'), (old4, new4, 'GET /history'), (old5, new5, 'POST meta-rejected create')]

for old, new, label in edits:
    count = content.count(old)
    if count != 1:
        print(f"ABORT pada edit '{label}': matched {count} kali (harus 1)")
        sys.exit(1)

for old, new, label in edits:
    content = content.replace(old, new, 1)

with open(path, 'w') as f:
    f.write(content)
print("OK: 5 edit berhasil diterapkan ke", path)
