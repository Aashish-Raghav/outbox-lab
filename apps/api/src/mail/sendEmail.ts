import { createReadStream } from 'node:fs';
import nodemailer from 'nodemailer';
import type { Attachment as DbAttachment, Sender } from '@prisma/client';
import sanitizeHtml from 'sanitize-html';
import { getTransport } from './transport.js';
import { scopedLogger } from '../lib/logger.js';

const log = scopedLogger('mail:send');

export interface SendResult {
  messageId: string;
  /** Ethereal's hosted preview of the delivered message, when available. */
  previewUrl: string | null;
  /** Addresses the SMTP server explicitly refused. */
  rejected: string[];
  accepted: string[];
}

/**
 * The body is authored in a rich-text editor and rendered into an email client,
 * so it is sanitised before it leaves the system. `sanitize-html` strips script
 * and style content, event handlers and javascript: URLs, which keeps a
 * malicious lead list or a pasted payload from turning into stored XSS in
 * whatever renders the message.
 */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
    'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    '*': ['style'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  // Inline styles are how the editor expresses alignment and sizing, so they
  // are kept — but restricted to a safe, enumerated set of properties.
  allowedStyles: {
    '*': {
      'text-align': [/^left$|^right$|^center$|^justify$/],
      'font-size': [/^\d+(?:\.\d+)?(?:px|em|rem|%)$/],
      'font-weight': [/^\d{3}$|^bold$|^normal$/],
      'font-style': [/^italic$|^normal$/],
      'text-decoration': [/^underline$|^line-through$|^none$/],
      'line-height': [/^\d+(?:\.\d+)?$/],
      color: [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\([\d\s,.]+\)$/],
      'background-color': [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\([\d\s,.]+\)$/],
      'margin-left': [/^\d+(?:px|em|rem)$/],
    },
  },
  transformTags: {
    // Anything opening a new tab must not be able to reach back via window.opener.
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
};

export function sanitizeBody(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

/** Rough plain-text alternative, so the message is not HTML-only. */
export function htmlToText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SendEmailParams {
  sender: Sender;
  to: string;
  subject: string;
  bodyHtml: string;
  attachments?: DbAttachment[];
  /**
   * Stable Message-ID derived from the job id. If a retry ever does re-deliver,
   * a conforming mail client will collapse the duplicate rather than showing
   * the recipient the same email twice — a last line of defence behind the
   * database-level idempotency guard.
   */
  messageIdSeed?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<SendResult> {
  const { sender, to, subject, bodyHtml, attachments = [], messageIdSeed } = params;

  const safeHtml = sanitizeBody(bodyHtml);
  const transporter = getTransport(sender);

  const info = await transporter.sendMail({
    from: { name: sender.name, address: sender.fromEmail },
    to,
    subject,
    html: safeHtml,
    text: htmlToText(safeHtml),
    ...(messageIdSeed
      ? { messageId: `<${messageIdSeed}@${sender.fromEmail.split('@')[1] ?? 'reachinbox.local'}>` }
      : {}),
    attachments: attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.mimeType,
      content: createReadStream(attachment.storagePath),
    })),
  });

  // Ethereal returns a browsable URL for the delivered message; a real provider
  // returns `false` here, which the `|| null` collapses to null.
  const previewUrl = nodemailer.getTestMessageUrl(info) || null;

  log.debug({ to, messageId: info.messageId, previewUrl }, 'smtp accepted message');

  return {
    messageId: info.messageId,
    previewUrl,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  };
}
