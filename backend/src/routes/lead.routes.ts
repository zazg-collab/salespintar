import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { NotFoundError } from '../utils/errors';
import { LeadsRepository } from '../modules/leads/leads.repository';
import { TimelineService } from '../modules/leads/timeline.service';
import { LeadStage, ConversionStatus } from '../modules/leads/dto/lead-profile.dto';
import { toJakartaDateStr } from '../utils/timezone';

const router = Router();

const createLeadSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  waNumber: z.string().min(5).max(15),
  segment: z.string().max(50).optional(),
  labels: z.array(z.string()).optional(),
});

const updateLeadSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  segment: z.string().max(50).optional(),
  labels: z.array(z.string()).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'CONVERTED', 'BLOCKED']).optional(),
  leadStage: z.enum(['COLD', 'WARM', 'HOT', 'VERY_HOT']).optional(),
  conversionStatus: z.enum(['CLOSING', 'PENDING', 'LOST']).optional(),
  minatProduk: z.string().max(255).optional(),
  lastInsight: z.string().optional(),
});

/**
 * GET /api/v1/leads/cs-list
 * Daftar nama CS yang tersedia untuk dropdown filter
 */
router.get('/cs-list', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const list = await LeadsRepository.getCsList(businessId);
    res.json(list);
  } catch (err) { next(err); }
});

/**
 * GET /api/v1/leads/stats
 * Ringkasan metrik CRM: total, hot, warm, cold, closing, pending, lost
 */
router.get('/stats', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const csPhone = req.query.csPhone as string | undefined;
    const csName = req.query.csName as string | undefined;
    const leadCategory = req.query.leadCategory as string | undefined;
    const filterBy = req.query.filterBy as 'createdAt' | 'lastMessageAt' | undefined;
    const stats = await LeadsRepository.getStats(businessId, startDate, endDate, csPhone, csName, leadCategory, filterBy);
    res.json(stats);
  } catch (err) { next(err); }
});

/**
 * GET /api/v1/leads/export
 * Export CSV format tabel CRM (Nomor HP, Minat Produk, Insight Terakhir, Stage, Status, CS, Tanggal)
 */
router.get('/export', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const stage = req.query.stage as LeadStage | 'ALL' | undefined;
    const conversion = req.query.conversion as ConversionStatus | 'ALL' | undefined;
    const rtsLevel = req.query.rtsLevel as 'LOW' | 'MEDIUM' | 'HIGH' | 'ALL' | undefined;
    const csPhone = req.query.csPhone as string | undefined;
    const csName = req.query.csName as string | undefined;
    const leadCategory = req.query.leadCategory as string | undefined;
    const search = req.query.search as string | undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const filterBy = req.query.filterBy as 'createdAt' | 'lastMessageAt' | undefined;

    const leads = await LeadsRepository.getAllForExport({
      businessId,
      stage,
      conversion,
      rtsLevel,
      csPhone,
      csName,
      leadCategory,
      search,
      startDate,
      endDate,
      filterBy,
    });

    const headers = [
      'Nomor HP',
      'Minat Produk',
      'Insight Terakhir',
      'Kategori Lead',
      'Skor Lead',
      'Status Closing',
      'Risiko RTS',
      'Skor Risiko (%)',
      'Rekomendasi Kurir',
      'CS Pemegang',
      'HP CS',
      'Tgl Leads Masuk',
      'Terakhir Chat',
    ].join(',') + '\n';

    const rows = leads.map((l: any) => {
      return [
        escapeCsv(l.waNumber),
        escapeCsv(l.minatProduk || 'Umum'),
        escapeCsv(l.lastInsight || '-'),
        escapeCsv(l.leadCategory || 'NEW_INBOUND'),
        l.score || 0,
        escapeCsv(l.conversionStatus || 'PENDING'),
        escapeCsv(l.rtsRiskLevel || 'LOW'),
        l.rtsRiskScore ?? '-',
        escapeCsv(l.courierRecommendation || '-'),
        escapeCsv(l.assignedCsName || '-'),
        escapeCsv(l.assignedCsPhone || '-'),
        toJakartaDateStr(l.createdAt),
        l.lastMessageAt ? toJakartaDateStr(l.lastMessageAt) : '-',
      ].join(',');
    }).join('\n');

    const csvContent = '\uFEFF' + headers + rows; // Add UTF-8 BOM for Excel compatibility

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-crm-${toJakartaDateStr(new Date())}.csv"`);
    res.send(csvContent);
  } catch (err) { next(err); }
});

/**
 * GET /api/v1/leads
 * Query daftar lead dengan pagination & multi-filter
 */
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const stage = req.query.stage as LeadStage | 'ALL' | undefined;
    const conversion = req.query.conversion as ConversionStatus | 'ALL' | undefined;
    const rtsLevel = req.query.rtsLevel as 'LOW' | 'MEDIUM' | 'HIGH' | 'ALL' | undefined;
    const csPhone = req.query.csPhone as string | undefined;
    const csName = req.query.csName as string | undefined;
    const leadCategory = req.query.leadCategory as string | undefined;
    const search = req.query.search as string | undefined;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 25;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const sortBy = req.query.sortBy as 'lastMessageAt' | 'createdAt' | undefined;
    const sortOrder = req.query.sortOrder as 'asc' | 'desc' | undefined;
    const filterBy = req.query.filterBy as 'createdAt' | 'lastMessageAt' | undefined;

    const result = await LeadsRepository.listLeads({
      businessId,
      page,
      limit,
      stage,
      conversion,
      rtsLevel,
      csPhone,
      csName,
      leadCategory,
      search,
      startDate,
      endDate,
      sortBy,
      sortOrder,
      filterBy,
    });

    res.json({
      leads: result.items,
      total: result.meta.total,
      page: result.meta.page,
      limit: result.meta.limit,
      totalPages: result.meta.totalPages,
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/v1/leads/:waNumber/timeline
 * Customer 360° Timeline Lintas Sesi & Multi-Order
 */
router.get('/:waNumber/timeline', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const waNumber = req.params.waNumber as string;
    const timeline = await TimelineService.getCustomerTimeline(businessId, waNumber);
    if (!timeline) {
      return res.status(404).json({ error: { message: 'Riwayat timeline tidak ditemukan untuk nomor ini' } });
    }
    res.json({ success: true, data: timeline });
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id as string, businessId: req.user!.businessId },
    });
    if (!lead) throw new NotFoundError('Lead');
    res.json(lead);
  } catch (err) { next(err); }
});

router.post('/', authenticate, validate(createLeadSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lead = await prisma.lead.create({
      data: {
        businessId: req.user!.businessId,
        ...req.body,
        labels: req.body.labels || [],
      },
    });
    res.status(201).json(lead);
  } catch (err) { next(err); }
});

router.patch('/:id', authenticate, validate(updateLeadSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.lead.findFirst({
      where: { id, businessId: req.user!.businessId },
    });
    if (!existing) throw new NotFoundError('Lead');

    const lead = await prisma.lead.update({
      where: { id },
      data: req.body,
    });
    res.json(lead);
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.lead.findFirst({
      where: { id, businessId: req.user!.businessId },
    });
    if (!existing) throw new NotFoundError('Lead');

    await prisma.lead.update({
      where: { id },
      data: { status: 'INACTIVE' },
    });
    res.json({ message: 'Lead soft-deleted' });
  } catch (err) { next(err); }
});

const importRateLimit = rateLimit({
  windowMs: env.IMPORT_RATE_LIMIT_WINDOW_MS,
  max: env.IMPORT_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user!.businessId,
  message: { error: { message: 'Terlalu banyak permintaan impor. Coba lagi beberapa menit lagi.' } },
});

router.post('/import', authenticate, importRateLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = req.user!;
    const { leads: leadsData } = req.body;

    if (!Array.isArray(leadsData)) {
      return res.status(400).json({ error: { message: 'leads must be an array' } });
    }

    if (leadsData.length > 5000) {
      return res.status(400).json({ error: { message: 'Maximum 5000 leads per import request. Use batches for larger datasets.' } });
    }

    const results = { imported: 0, skipped: 0, errors: 0 };
    for (const data of leadsData) {
      try {
        const waNumber = String(data.waNumber).replace(/[^0-9]/g, '');
        if (waNumber.length < 5) { results.errors++; continue; }

        const existing = await prisma.lead.findFirst({
          where: { businessId, waNumber },
          orderBy: { createdAt: 'desc' },
        });
        if (existing) { results.skipped++; continue; }

        await prisma.lead.create({
          data: {
            businessId,
            name: data.name || null,
            waNumber,
            segment: data.segment || null,
            labels: data.labels || [],
          },
        });
        results.imported++;
      } catch { results.errors++; }
    }

    res.status(201).json(results);
  } catch (err) { next(err); }
});

function escapeCsv(val: string): string {
  const sanitized = String(val ?? '').replace(/^([=+\-@\t\r])/, "'$1");
  return `"${sanitized.replace(/"/g, '""')}"`;
}

export default router;
