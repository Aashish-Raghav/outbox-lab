import nodemailer, { type Transporter } from 'nodemailer';
import type { Sender } from '@prisma/client';
import { scopedLogger } from '../lib/logger.js';

const log = scopedLogger('mail:transport');

/**
 * Per-sender SMTP transports.
 *
 * Transports are cached and pooled because building one per send would open a
 * fresh TCP + TLS handshake for every email — the dominant cost at any real
 * throughput, and the fastest way to get an SMTP provider to start refusing
 * connections.
 */

interface CachedTransport {
  transporter: Transporter;
  /** Detects credential rotation so a stale transport is not reused. */
  fingerprint: string;
}

const cache = new Map<string, CachedTransport>();

function fingerprintOf(sender: Sender): string {
  return [sender.smtpHost, sender.smtpPort, sender.smtpUser, sender.smtpPass, sender.smtpSecure].join('|');
}

export function getTransport(sender: Sender): Transporter {
  const fingerprint = fingerprintOf(sender);
  const cached = cache.get(sender.id);

  if (cached && cached.fingerprint === fingerprint) return cached.transporter;

  if (cached) {
    log.info({ senderId: sender.id }, 'sender credentials changed, rebuilding transport');
    cached.transporter.close();
  }

  const transporter = nodemailer.createTransport({
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    auth: { user: sender.smtpUser, pass: sender.smtpPass },

    // Reuse connections across sends.
    pool: true,
    // Ethereal is a single shared test host; more parallel sockets per sender
    // buys nothing and invites throttling. The scheduler's own limiter, not the
    // socket count, is what governs throughput.
    maxConnections: 3,
    maxMessages: 100,

    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  cache.set(sender.id, { transporter, fingerprint });
  return transporter;
}

/** Confirms credentials work — used by the provisioning script and health checks. */
export async function verifyTransport(sender: Sender): Promise<{ ok: boolean; error?: string }> {
  try {
    await getTransport(sender).verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Closes every pooled connection. Called during graceful shutdown. */
export function closeAllTransports(): void {
  for (const [, { transporter }] of cache) transporter.close();
  cache.clear();
}
