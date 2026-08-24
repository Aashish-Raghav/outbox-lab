/**
 * Lead-list parsing, shared by the browser and the API.
 *
 * The Compose screen shows "N email addresses detected" the instant a file is
 * dropped, and the server re-parses the same bytes when the campaign is
 * submitted. Both paths call this function so the number the user was shown is
 * the number that actually gets scheduled.
 *
 * Accepts whatever a sales team realistically uploads:
 *   - a CSV with headers, where the address may be in any column
 *   - a CSV with no headers
 *   - a newline- or comma-separated .txt dump
 *   - "Display Name <person@example.com>" style entries
 */

/**
 * Deliberately stricter than the RFC: it must not match trailing punctuation
 * from a CSV cell, and it rejects consecutive/edge dots in the local part.
 */
const EMAIL_PATTERN =
  /[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}/g;

export interface ParsedRecipients {
  /** Unique, lower-cased, in first-seen order. */
  emails: string[];
  /** Total addresses found before de-duplication. */
  totalFound: number;
  /** How many were dropped as duplicates. */
  duplicatesRemoved: number;
  /**
   * Non-empty lines that contained no recognisable address. Capped, because a
   * user who uploads the wrong file should get a readable message rather than
   * ten thousand error strings.
   */
  invalidLines: string[];
}

const MAX_REPORTED_INVALID_LINES = 20;

/**
 * Extracts every email address from a raw CSV/TXT blob.
 *
 * Rather than parsing CSV structurally — which breaks on quoting, semicolon
 * delimiters, BOMs and stray columns — we scan for addresses directly. That
 * makes column order and the presence of a header row irrelevant.
 */
export function parseRecipients(raw: string): ParsedRecipients {
  // Strip a UTF-8 BOM and normalise line endings from Windows-authored files.
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  const seen = new Set<string>();
  const emails: string[] = [];
  const invalidLines: string[] = [];
  let totalFound = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // `matchAll` needs the regex reset between lines because it is /g.
    EMAIL_PATTERN.lastIndex = 0;
    const matches = trimmed.match(EMAIL_PATTERN);

    if (!matches) {
      if (invalidLines.length < MAX_REPORTED_INVALID_LINES) {
        invalidLines.push(trimmed.slice(0, 120));
      }
      continue;
    }

    for (const match of matches) {
      totalFound += 1;
      const normalised = match.toLowerCase();
      if (seen.has(normalised)) continue;
      seen.add(normalised);
      emails.push(normalised);
    }
  }

  return {
    emails,
    totalFound,
    duplicatesRemoved: totalFound - emails.length,
    invalidLines,
  };
}

/**
 * Merges addresses typed into the "To" field with any uploaded list,
 * de-duplicating across both sources while preserving first-seen order.
 */
export function mergeRecipients(...groups: string[][]): {
  emails: string[];
  duplicatesRemoved: number;
} {
  const seen = new Set<string>();
  const emails: string[] = [];
  let total = 0;

  for (const group of groups) {
    for (const candidate of group) {
      const normalised = candidate.trim().toLowerCase();
      if (normalised === '') continue;
      total += 1;
      if (seen.has(normalised)) continue;
      seen.add(normalised);
      emails.push(normalised);
    }
  }

  return { emails, duplicatesRemoved: total - emails.length };
}
