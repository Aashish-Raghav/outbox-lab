import { Router } from 'express';
import { listEmailsQuerySchema, starEmailSchema } from '@reachinbox/shared';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { cancelEmail, getEmail, getStats, listEmails, setStarred } from './emails.service.js';

export const emailsRouter: Router = Router();

emailsRouter.use(requireAuth);

emailsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = listEmailsQuerySchema.parse(req.query);
    res.json({ data: await listEmails(req.user!.id, query) });
  }),
);

emailsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ data: await getEmail(req.user!.id, req.params.id!) });
  }),
);

emailsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    res.json({ data: await cancelEmail(req.user!.id, req.params.id!) });
  }),
);

emailsRouter.patch(
  '/:id/star',
  asyncHandler(async (req, res) => {
    const { isStarred } = starEmailSchema.parse(req.body);
    res.json({ data: await setStarred(req.user!.id, req.params.id!, isStarred) });
  }),
);

/** Sidebar counts. Mounted separately as /api/stats in server.ts. */
export const statsRouter: Router = Router();

statsRouter.use(requireAuth);

statsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ data: await getStats(req.user!.id) });
  }),
);
