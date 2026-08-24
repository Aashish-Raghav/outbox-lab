import { z } from 'zod';
import { EMAIL_STATUSES, PAGINATION } from './constants.js';

/**
 * Request/response contracts shared by the API and the dashboard.
 *
 * The compose form is submitted as multipart/form-data (it can carry a lead
 * list and attachments), so every scalar arrives as a string. `z.coerce` is
 * used deliberately on the numeric and date fields for that reason.
 */

/** Normalises casing/whitespace so `Foo@Bar.com ` and `foo@bar.com` dedupe. */
export const emailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .email('Not a valid email address');

// ── Auth ─────────────────────────────────────────────────────────────────────

export const googleLoginSchema = z.object({
  /** The Google Identity Services ID token (JWT), verified server-side. */
  credential: z.string().min(1, 'Missing Google credential'),
});
export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;

export const passwordLoginSchema = z.object({
  email: emailAddress,
  password: z.string().min(1, 'Password is required'),
});
export type PasswordLoginInput = z.infer<typeof passwordLoginSchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
});
export type User = z.infer<typeof userSchema>;

// ── Senders ──────────────────────────────────────────────────────────────────

export const senderSchema = z.object({
  id: z.string(),
  name: z.string(),
  fromEmail: z.string(),
  isActive: z.boolean(),
  /** null => fall back to MAX_EMAILS_PER_HOUR_PER_SENDER. */
  maxEmailsPerHour: z.number().int().positive().nullable(),
});
export type Sender = z.infer<typeof senderSchema>;

/** Live quota usage for the current hour window, surfaced in the UI. */
export const senderQuotaSchema = senderSchema.extend({
  usedThisHour: z.number().int().nonnegative(),
  limitThisHour: z.number().int().positive(),
  windowResetsAt: z.string(),
});
export type SenderQuota = z.infer<typeof senderQuotaSchema>;

// ── Campaign creation (the Compose screen) ───────────────────────────────────

/**
 * `recipients` may arrive as a JSON array, a repeated field, or a
 * comma/newline separated blob, and may be supplemented by an uploaded CSV.
 * They are merged and de-duplicated server-side.
 */
export const createCampaignSchema = z.object({
  senderId: z.string().min(1, 'Pick a sender'),
  subject: z.string().trim().min(1, 'Subject is required').max(500),
  bodyHtml: z.string().min(1, 'Body is required'),
  recipients: z.array(emailAddress).default([]),
  /** Omitted => send as soon as the queue allows. */
  startAt: z.coerce.date().optional(),
  /** "Delay between 2 emails", in seconds, from the Figma field. */
  delayBetweenSeconds: z.coerce.number().int().min(0).max(3600).default(0),
  /** "Hourly Limit" from the Figma field. 0/omitted => use the server default. */
  hourlyLimit: z.coerce.number().int().min(0).max(100000).default(0),
});
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const campaignSchema = z.object({
  id: z.string(),
  subject: z.string(),
  status: z.string(),
  startAt: z.string(),
  delayBetweenMs: z.number().int(),
  hourlyLimit: z.number().int().nullable(),
  totalRecipients: z.number().int(),
  createdAt: z.string(),
  sender: senderSchema.pick({ id: true, name: true, fromEmail: true }).nullable(),
  counts: z
    .object({
      scheduled: z.number().int(),
      sent: z.number().int(),
      failed: z.number().int(),
    })
    .optional(),
});
export type Campaign = z.infer<typeof campaignSchema>;

/** What POST /api/campaigns returns — enough for an optimistic UI update. */
export const createCampaignResultSchema = z.object({
  campaign: campaignSchema,
  /** Addresses accepted after parsing, merging and de-duplication. */
  recipientsAccepted: z.number().int(),
  /** Duplicates dropped from the submitted list. */
  duplicatesRemoved: z.number().int(),
  /** Entries that were not parseable email addresses. */
  invalidSkipped: z.array(z.string()),
  /** When the last email in this campaign is currently projected to go out. */
  projectedCompletionAt: z.string(),
});
export type CreateCampaignResult = z.infer<typeof createCampaignResultSchema>;

// ── Attachments ──────────────────────────────────────────────────────────────

export const attachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

// ── Emails (the Scheduled / Sent lists) ──────────────────────────────────────

export const emailJobSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  toEmail: z.string(),
  subject: z.string(),
  /** Plain-text preview used for the greyed-out snippet in the list rows. */
  preview: z.string(),
  status: z.enum(EMAIL_STATUSES as [string, ...string[]]),
  scheduledAt: z.string(),
  sentAt: z.string().nullable(),
  attempts: z.number().int(),
  /** How many times the hourly quota pushed this into a later window. */
  rescheduleCount: z.number().int(),
  lastError: z.string().nullable(),
  /** Ethereal's web preview of the delivered message. */
  previewUrl: z.string().nullable(),
  isStarred: z.boolean(),
  sender: senderSchema.pick({ id: true, name: true, fromEmail: true }).nullable(),
});
export type EmailJob = z.infer<typeof emailJobSchema>;

/** Full record for the detail screen — includes the rendered body. */
export const emailJobDetailSchema = emailJobSchema.extend({
  bodyHtml: z.string(),
  attachments: z.array(attachmentSchema),
  createdAt: z.string(),
});
export type EmailJobDetail = z.infer<typeof emailJobDetailSchema>;

export const listEmailsQuerySchema = z.object({
  /** Which dashboard tab is asking. */
  mailbox: z.enum(['scheduled', 'sent']).optional(),
  /** Narrow further to one exact status. */
  status: z.enum(EMAIL_STATUSES as [string, ...string[]]).optional(),
  search: z.string().trim().max(200).optional(),
  starred: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).default(PAGINATION.defaultLimit),
});
export type ListEmailsQuery = z.infer<typeof listEmailsQuerySchema>;

export const paginationSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
  hasNext: z.boolean(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const listEmailsResultSchema = z.object({
  items: z.array(emailJobSchema),
  pagination: paginationSchema,
});
export type ListEmailsResult = z.infer<typeof listEmailsResultSchema>;

export const starEmailSchema = z.object({ isStarred: z.boolean() });
export type StarEmailInput = z.infer<typeof starEmailSchema>;

// ── Stats (sidebar counts) ───────────────────────────────────────────────────

export const statsSchema = z.object({
  scheduled: z.number().int(),
  sent: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
  /** Delivered within the current hour window, across all senders. */
  sentThisHour: z.number().int(),
});
export type Stats = z.infer<typeof statsSchema>;

// ── Envelope ─────────────────────────────────────────────────────────────────

/**
 * Every endpoint answers with `{ data }` or `{ error }`, so the client has one
 * unwrapping path instead of per-endpoint special cases.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Field-level messages from zod, keyed by dotted path. */
    details: z.record(z.array(z.string())).optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export type ApiSuccess<T> = { data: T };
export type ApiResponse<T> = ApiSuccess<T> | ApiError;
