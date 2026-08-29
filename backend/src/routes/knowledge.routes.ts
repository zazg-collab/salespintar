import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { knowledgeService } from '../services/knowledge.service';
import { z } from 'zod';
import { ValidationError } from '../utils/errors';

const router = Router();

const createKnowledgeSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(10),
  category: z.enum(['Produk', 'SOP', 'FAQ']).default('FAQ'),
});

router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await knowledgeService.listKnowledge(req.user!.businessId);
    res.json(list);
  } catch (err) { next(err); }
});

router.post('/', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = createKnowledgeSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.errors[0].message);

    const { vaultPath } = await knowledgeService.addKnowledge(
      req.user!.businessId,
      result.data.title,
      result.data.content as string,
      result.data.category,
    );
    res.status(201).json({
      message: 'Pengetahuan ditulis ke vault Obsidian. Bot mempelajarinya dalam beberapa detik.',
      data: { vaultPath },
    });
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await knowledgeService.deleteKnowledge(req.params.id as string, req.user!.businessId);
    res.json({ message: 'Knowledge deleted' });
  } catch (err) { next(err); }
});

export default router;
