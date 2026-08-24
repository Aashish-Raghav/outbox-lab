import type { Prisma } from '@prisma/client';
import {
  EMAIL_STATUS,
  MAILBOX_FILTERS,
  type EmailStatus,
  type ListEmailsQuery,
} from '@reachinbox/shared';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { htmlToText } from '../../mail/sendEmail.js';
import { removeEmailJob } from '../../queue/emailQueue.js';

/** Length of the greyed-out snippet shown after the subject in list rows. */
const PREVIEW_LENGTH = 140;

const listSelect = {
  id: true,
  campaignId: true,
  toEmail: true,
  subject: true,
  bodyHtml: true,
  status: true,
  scheduledAt: true,
  sentAt: true,
  attempts: true,
  rescheduleCount: true,
  lastError: true,
  previewUrl: true,
  isStarred: true,
  sender: { select: { id: true, name: true, fromEmail: true } },
} satisfies Prisma.EmailJobSelect;

type EmailRow = Prisma.EmailJobGetPayload<{ select: typeof listSelect }>;

function toDto(row: EmailRow) {
  const text = htmlToText(row.bodyHtml);
  return {
    id: row.id,
    campaignId: row.campaignId,
    toEmail: row.toEmail,
    subject: row.subject,
    preview: text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    attempts: row.attempts,
    rescheduleCount: row.rescheduleCount,
    lastError: row.lastError,
    previewUrl: row.previewUrl,
    isStarred: row.isStarred,
    sender: row.sender,
  };
}

/**
 * Powers both dashboard tabs.
 *
 * "Scheduled" and "Sent" are views over the same table rather than separate
 * entities — `MAILBOX_FILTERS` maps a tab to the statuses it contains, so the
 * two tabs cannot drift apart as statuses are added.
 */
export async function listEmails(userId: string, query: ListEmailsQuery) {
  const statuses: EmailStatus[] = query.status
    ? [query.status as EmailStatus]
    : query.mailbox
      ? [...MAILBOX_FILTERS[query.mailbox]]
      : [];

  const where: Prisma.EmailJobWhereInput = {
    userId,
    ...(statuses.length > 0 ? { status: { in: statuses } } : {}),
    ...(query.starred !== undefined ? { isStarred: query.starred } : {}),
    ...(query.search
      ? {
          OR: [
            { toEmail: { contains: query.search, mode: 'insensitive' } },
            { subject: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  // Scheduled emails read best soonest-first (what goes out next); sent emails
  // read best newest-first (what just happened).
  const orderBy: Prisma.EmailJobOrderByWithRelationInput[] =
    query.mailbox === 'sent'
      ? [{ sentAt: 'desc' }, { scheduledAt: 'desc' }]
      : [{ scheduledAt: 'asc' }, { seq: 'asc' }];

  const [total, rows] = await Promise.all([
    prisma.emailJob.count({ where }),
    prisma.emailJob.findMany({
      where,
      select: listSelect,
      orderBy,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    items: rows.map(toDto),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNext: query.page < totalPages,
    },
  };
}

export async function getEmail(userId: string, id: string) {
  const row = await prisma.emailJob.findFirst({
    where: { id, userId },
    select: {
      ...listSelect,
      createdAt: true,
      campaign: { select: { attachments: true } },
    },
  });

  if (!row) throw new NotFoundError('Email');

  return {
    ...toDto(row),
    bodyHtml: row.bodyHtml,
    createdAt: row.createdAt.toISOString(),
    attachments: row.campaign.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    })),
  };
}

/**
 * Cancels a scheduled email.
 *
 * The database row is flipped first and the queue job removed second. If the
 * removal fails because a worker already picked the job up, that is harmless:
 * the worker re-reads the row, sees CANCELLED, and returns without sending.
 */
export async function cancelEmail(userId: string, id: string) {
  const row = await prisma.emailJob.findFirst({ where: { id, userId } });
  if (!row) throw new NotFoundError('Email');

  if (row.status === EMAIL_STATUS.SENT) {
    throw new ValidationError('That email has already been sent');
  }
  if (row.status === EMAIL_STATUS.CANCELLED) {
    return { id, status: EMAIL_STATUS.CANCELLED };
  }

  await prisma.$transaction(async (tx) => {
    await tx.emailJob.update({
      where: { id },
      data: { status: EMAIL_STATUS.CANCELLED, lockedAt: null, lockedBy: null },
    });
    await tx.emailEvent.create({
      data: {
        emailJobId: id,
        status: EMAIL_STATUS.CANCELLED,
        message: 'cancelled by user',
        actor: userId,
      },
    });
  });

  await removeEmailJob(id);

  return { id, status: EMAIL_STATUS.CANCELLED };
}

export async function setStarred(userId: string, id: string, isStarred: boolean) {
  const { count } = await prisma.emailJob.updateMany({
    where: { id, userId },
    data: { isStarred },
  });
  if (count === 0) throw new NotFoundError('Email');
  return { id, isStarred };
}

/** Sidebar counts. */
export async function getStats(userId: string) {
  const grouped = await prisma.emailJob.groupBy({
    by: ['status'],
    where: { userId },
    _count: { _all: true },
  });

  const countOf = (status: EmailStatus) =>
    grouped.find((entry) => entry.status === status)?._count._all ?? 0;

  const hourAgo = new Date(Date.now() - 3_600_000);
  const sentThisHour = await prisma.emailJob.count({
    where: { userId, status: EMAIL_STATUS.SENT, sentAt: { gte: hourAgo } },
  });

  return {
    // The tab shows everything still pending, matching MAILBOX_FILTERS.
    scheduled:
      countOf(EMAIL_STATUS.SCHEDULED) + countOf(EMAIL_STATUS.QUEUED) + countOf(EMAIL_STATUS.PROCESSING),
    sent: countOf(EMAIL_STATUS.SENT),
    failed: countOf(EMAIL_STATUS.FAILED),
    cancelled: countOf(EMAIL_STATUS.CANCELLED),
    sentThisHour,
  };
}
