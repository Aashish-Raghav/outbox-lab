import { readFile, unlink } from 'node:fs/promises';
import { Router } from 'express';
import {
  createCampaignSchema,
  mergeRecipients,
  parseRecipients,
} from '@reachinbox/shared';
import { prisma } from '../../lib/prisma.js';
import { scopedLogger } from '../../lib/logger.js';
import { toMessage } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { campaignLimiter } from '../../middleware/apiRateLimit.js';
import { composeUpload } from '../../middleware/upload.js';
import { scheduleCampaign } from '../../scheduler/scheduleCampaign.js';

const log = scopedLogger('campaigns');

export const campaignsRouter: Router = Router();

campaignsRouter.use(requireAuth);

/**
 * Recipients can arrive three ways, and the UI uses all of them: a JSON array,
 * repeated form fields, or a pasted comma/newline blob. Normalising here keeps
 * that mess out of the schema and the scheduler.
 */
function readRecipientField(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || value.trim() === '') return [];

  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Not JSON after all; fall through to delimiter splitting.
    }
  }

  return trimmed.split(/[,;\n]/);
}

campaignsRouter.post(
  '/',
  campaignLimiter,
  composeUpload,
  asyncHandler(async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const leadFile = files?.leads?.[0];
    const attachmentFiles = files?.attachments ?? [];

    // ── Build the recipient list ──────────────────────────────────────────
    let fromFile: string[] = [];
    let invalidLines: string[] = [];
    // Duplicates can occur twice over: within the uploaded file, and again
    // between the file and the addresses typed into the To field. Both are
    // counted, or the UI under-reports what it dropped.
    let duplicatesInFile = 0;

    if (leadFile) {
      try {
        const raw = await readFile(leadFile.path, 'utf8');
        const parsed = parseRecipients(raw);
        fromFile = parsed.emails;
        invalidLines = parsed.invalidLines;
        duplicatesInFile = parsed.duplicatesRemoved;
      } finally {
        // The address list itself is not retained once parsed.
        await unlink(leadFile.path).catch((error) =>
          log.warn({ err: toMessage(error) }, 'could not remove uploaded lead list'),
        );
      }
    }

    const typed = readRecipientField(req.body.recipients);
    const merged = mergeRecipients(typed, fromFile);

    // Validate the merged list through the shared schema so the API and the
    // dashboard agree on what counts as a valid address.
    const input = createCampaignSchema.parse({
      senderId: req.body.senderId,
      subject: req.body.subject,
      bodyHtml: req.body.bodyHtml,
      recipients: merged.emails,
      startAt: req.body.startAt || undefined,
      delayBetweenSeconds: req.body.delayBetweenSeconds ?? 0,
      hourlyLimit: req.body.hourlyLimit ?? 0,
    });

    const result = await scheduleCampaign({
      userId: req.user!.id,
      senderId: input.senderId,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      recipients: input.recipients,
      startAt: input.startAt,
      delayBetweenMs: input.delayBetweenSeconds * 1000,
      hourlyLimit: input.hourlyLimit,
      attachments: attachmentFiles.map((file) => ({
        filename: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        storagePath: file.path,
      })),
    });

    const sender = await prisma.sender.findUnique({
      where: { id: input.senderId },
      select: { id: true, name: true, fromEmail: true },
    });

    res.status(201).json({
      data: {
        campaign: {
          id: result.campaign.id,
          subject: result.campaign.subject,
          status: result.campaign.status,
          startAt: result.campaign.startAt.toISOString(),
          delayBetweenMs: result.campaign.delayBetweenMs,
          hourlyLimit: result.campaign.hourlyLimit,
          totalRecipients: result.campaign.totalRecipients,
          createdAt: result.campaign.createdAt.toISOString(),
          sender,
        },
        recipientsAccepted: input.recipients.length,
        duplicatesRemoved: duplicatesInFile + merged.duplicatesRemoved,
        invalidSkipped: invalidLines,
        projectedCompletionAt: result.projectedCompletionAt.toISOString(),
        // Surfaced so the UI can warn that a large batch will span hours.
        windowsRequired: result.windowsRequired,
        throttledByHourlyLimit: result.throttledByHourlyLimit,
      },
    });
  }),
);

campaignsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const campaigns = await prisma.campaign.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        sender: { select: { id: true, name: true, fromEmail: true } },
        _count: { select: { emailJobs: true } },
      },
    });

    // One grouped query for all campaigns rather than one per row.
    const grouped = await prisma.emailJob.groupBy({
      by: ['campaignId', 'status'],
      where: { campaignId: { in: campaigns.map((campaign) => campaign.id) } },
      _count: { _all: true },
    });

    res.json({
      data: campaigns.map((campaign) => {
        const rows = grouped.filter((entry) => entry.campaignId === campaign.id);
        const countOf = (status: string) =>
          rows.find((entry) => entry.status === status)?._count._all ?? 0;

        return {
          id: campaign.id,
          subject: campaign.subject,
          status: campaign.status,
          startAt: campaign.startAt.toISOString(),
          delayBetweenMs: campaign.delayBetweenMs,
          hourlyLimit: campaign.hourlyLimit,
          totalRecipients: campaign.totalRecipients,
          createdAt: campaign.createdAt.toISOString(),
          sender: campaign.sender,
          counts: {
            scheduled: countOf('SCHEDULED') + countOf('QUEUED') + countOf('PROCESSING'),
            sent: countOf('SENT'),
            failed: countOf('FAILED'),
          },
        };
      }),
    });
  }),
);
