import { scopedLogger } from '../lib/logger.js';

const log = scopedLogger('mail:ethereal');

const ETHEREAL_API = 'https://api.nodemailer.com/user';

/**
 * A freshly minted Ethereal SMTP account.
 */
export interface EtherealAccount {
  user: string;
  pass: string;
  smtp: { host: string; port: number; secure: boolean };
  web: string;
}

interface EtherealApiResponse {
  status?: string;
  user?: string;
  pass?: string;
  smtp?: { host: string; port: number; secure: boolean };
  web?: string;
  error?: string;
}

/**
 * Creates one Ethereal test account.
 *
 * Deliberately hits the API directly instead of `nodemailer.createTestAccount()`:
 * that helper memoises the first account it receives and returns the same
 * credentials on every subsequent call, which would silently collapse a
 * multi-sender setup down to a single sender. We need genuinely distinct
 * inboxes to demonstrate per-sender quotas.
 */
export async function createEtherealAccount(signal?: AbortSignal): Promise<EtherealAccount> {
  const response = await fetch(ETHEREAL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestor: 'reachinbox-scheduler', version: '1.0.0' }),
    signal: signal ?? AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Ethereal API returned HTTP ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as EtherealApiResponse;

  if (payload.status !== 'success' || !payload.user || !payload.pass || !payload.smtp) {
    throw new Error(`Ethereal API did not return an account: ${payload.error ?? 'unknown error'}`);
  }

  log.debug({ user: payload.user }, 'created ethereal account');

  return {
    user: payload.user,
    pass: payload.pass,
    smtp: payload.smtp,
    web: payload.web ?? 'https://ethereal.email',
  };
}

/**
 * Creates `count` distinct accounts, one at a time.
 *
 * Sequential on purpose — Ethereal is a free shared service and firing a
 * parallel burst at it is both impolite and less reliable than a short serial
 * loop that runs once at setup.
 */
export async function createEtherealAccounts(count: number): Promise<EtherealAccount[]> {
  const accounts: EtherealAccount[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < count; i += 1) {
    const account = await createEtherealAccount();

    if (seen.has(account.user)) {
      throw new Error(
        `Ethereal returned a duplicate account (${account.user}); cannot provision distinct senders.`,
      );
    }

    seen.add(account.user);
    accounts.push(account);
  }

  return accounts;
}
