/**
 * Values that both the API and the dashboard must agree on.
 */

/** Lifecycle of a single outbound email. */
export const EMAIL_STATUS = {
  /** Persisted with a future `scheduledAt`; a delayed BullMQ job exists for it. */
  SCHEDULED: 'SCHEDULED',
  /** Delay elapsed; sitting in the queue waiting for a free worker slot. */
  QUEUED: 'QUEUED',
  /** Claimed by exactly one worker, SMTP handoff in progress. */
  PROCESSING: 'PROCESSING',
  /** Accepted by the SMTP server. Terminal. */
  SENT: 'SENT',
  /** Exhausted retries, or bumped past MAX_RESCHEDULES. Terminal. */
  FAILED: 'FAILED',
  /** Cancelled by the user before it went out. Terminal. */
  CANCELLED: 'CANCELLED',
} as const;

export type EmailStatus = (typeof EMAIL_STATUS)[keyof typeof EMAIL_STATUS];

export const EMAIL_STATUSES = Object.values(EMAIL_STATUS) as EmailStatus[];

/** Statuses that still have (or need) a live queue job behind them. */
export const PENDING_STATUSES: EmailStatus[] = [
  EMAIL_STATUS.SCHEDULED,
  EMAIL_STATUS.QUEUED,
  EMAIL_STATUS.PROCESSING,
];

/** Statuses that will never change again. */
export const TERMINAL_STATUSES: EmailStatus[] = [
  EMAIL_STATUS.SENT,
  EMAIL_STATUS.FAILED,
  EMAIL_STATUS.CANCELLED,
];

export const CAMPAIGN_STATUS = {
  SCHEDULED: 'SCHEDULED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUS)[keyof typeof CAMPAIGN_STATUS];

/** The two dashboard tabs in the Figma map onto these status groups. */
export const MAILBOX_FILTERS = {
  scheduled: [
    EMAIL_STATUS.SCHEDULED,
    EMAIL_STATUS.QUEUED,
    EMAIL_STATUS.PROCESSING,
  ] as EmailStatus[],
  sent: [EMAIL_STATUS.SENT, EMAIL_STATUS.FAILED] as EmailStatus[],
} as const;

export type MailboxKey = keyof typeof MAILBOX_FILTERS;

/** BullMQ queue + job names. Kept here so producer and consumer cannot drift. */
export const EMAIL_QUEUE_NAME = 'email-send';
export const EMAIL_JOB_NAME = 'send-email';

export const PAGINATION = {
  defaultLimit: 25,
  maxLimit: 100,
} as const;
