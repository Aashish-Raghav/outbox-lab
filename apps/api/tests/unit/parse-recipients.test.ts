import { describe, expect, it } from 'vitest';
import { mergeRecipients, parseRecipients } from '@reachinbox/shared';

describe('parseRecipients', () => {
  it('reads a CSV with headers regardless of column order', () => {
    const result = parseRecipients(
      ['first_name,email,company', 'Alice,alice@example.com,Acme', 'Bob,bob@example.com,Globex'].join('\n'),
    );

    expect(result.emails).toEqual(['alice@example.com', 'bob@example.com']);
    // A header row is the normal shape of an export, not a broken line.
    expect(result.invalidLines).toEqual([]);
  });

  it('reads a CSV with the address in a trailing column', () => {
    const result = parseRecipients('name,company,email\nAlice,Acme,alice@example.com');
    expect(result.emails).toEqual(['alice@example.com']);
  });

  it('reads a headerless newline-separated dump', () => {
    const result = parseRecipients('alice@example.com\nbob@example.com\n');
    expect(result.emails).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('reads a comma-separated single line', () => {
    const result = parseRecipients('alice@example.com, bob@example.com,carol@example.com');
    expect(result.emails).toHaveLength(3);
  });

  it('extracts addresses from "Display Name <addr>" entries', () => {
    const result = parseRecipients('Alice Smith <alice@example.com>');
    expect(result.emails).toEqual(['alice@example.com']);
  });

  it('de-duplicates case-insensitively and counts what it dropped', () => {
    const result = parseRecipients(
      ['alice@example.com', 'ALICE@EXAMPLE.COM', '  Alice@Example.com  ', 'bob@example.com'].join('\n'),
    );

    expect(result.emails).toEqual(['alice@example.com', 'bob@example.com']);
    expect(result.totalFound).toBe(4);
    expect(result.duplicatesRemoved).toBe(2);
  });

  it('preserves first-seen order', () => {
    const result = parseRecipients('zoe@example.com\nadam@example.com\nmia@example.com');
    expect(result.emails).toEqual(['zoe@example.com', 'adam@example.com', 'mia@example.com']);
  });

  it('reports unparseable lines instead of silently dropping them', () => {
    const result = parseRecipients('alice@example.com\nnot an address at all\nbob@example.com');

    expect(result.emails).toHaveLength(2);
    expect(result.invalidLines).toEqual(['not an address at all']);
  });

  it('caps the invalid-line report so a wrong file gives a readable error', () => {
    const junk = Array.from({ length: 500 }, (_, i) => `garbage line ${i}`).join('\n');
    const result = parseRecipients(junk);

    expect(result.emails).toEqual([]);
    expect(result.invalidLines.length).toBeLessThanOrEqual(20);
  });

  it('handles a Windows-authored file with a BOM and CRLF endings', () => {
    const result = parseRecipients('﻿email\r\nalice@example.com\r\nbob@example.com\r\n');
    expect(result.emails).toEqual(['alice@example.com', 'bob@example.com']);
    expect(result.invalidLines).toEqual([]);
  });

  it('does not swallow trailing punctuation from a CSV cell', () => {
    const result = parseRecipients('"alice@example.com",Acme');
    expect(result.emails).toEqual(['alice@example.com']);
  });

  it('ignores blank lines', () => {
    const result = parseRecipients('alice@example.com\n\n\n   \nbob@example.com');
    expect(result.emails).toHaveLength(2);
    expect(result.invalidLines).toEqual([]);
  });

  it('returns nothing for empty input', () => {
    expect(parseRecipients('')).toEqual({
      emails: [],
      totalFound: 0,
      duplicatesRemoved: 0,
      invalidLines: [],
    });
  });
});

describe('mergeRecipients', () => {
  it('de-duplicates across the typed field and the uploaded list', () => {
    const merged = mergeRecipients(
      ['alice@example.com', 'dave@example.com'],
      ['ALICE@example.com', 'bob@example.com'],
    );

    expect(merged.emails).toEqual([
      'alice@example.com',
      'dave@example.com',
      'bob@example.com',
    ]);
    expect(merged.duplicatesRemoved).toBe(1);
  });

  it('keeps the typed addresses first', () => {
    const merged = mergeRecipients(['typed@example.com'], ['uploaded@example.com']);
    expect(merged.emails[0]).toBe('typed@example.com');
  });

  it('ignores empty groups and blank entries', () => {
    const merged = mergeRecipients([], ['', '   ', 'alice@example.com']);
    expect(merged.emails).toEqual(['alice@example.com']);
    expect(merged.duplicatesRemoved).toBe(0);
  });
});
