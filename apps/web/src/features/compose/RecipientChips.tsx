'use client';

import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { parseRecipients } from '@reachinbox/shared';
import { Chip } from '@/components/ui';
import { cn } from '@/lib/format';

export interface RecipientChipsProps {
  value: string[];
  onChange: (recipients: string[]) => void;
  /** Chips beyond this collapse into a `+N` pill, as in the Figma. */
  visibleLimit?: number;
  disabled?: boolean;
}

/**
 * The "To" field: green outlined chips with a `+4` overflow.
 *
 * Commits on Enter, Tab, comma and semicolon, and on blur — the four things
 * people actually do — and parses a paste through the same shared function the
 * server uses, so pasting a column out of a spreadsheet works.
 */
export function RecipientChips({
  value,
  onChange,
  visibleLimit = 6,
  disabled = false,
}: RecipientChipsProps) {
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  const commit = (raw: string): boolean => {
    const { emails, invalidLines } = parseRecipients(raw);

    if (emails.length === 0) {
      setRejected(invalidLines[0] ?? raw.trim());
      return false;
    }

    setRejected(null);
    const existing = new Set(value);
    const added = emails.filter((email) => !existing.has(email));
    if (added.length > 0) onChange([...value, ...added]);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === 'Tab' || event.key === ',' || event.key === ';') {
      if (draft.trim() === '') return;
      // Tab still moves focus if there is nothing to commit, which is what a
      // keyboard user expects.
      event.preventDefault();
      if (commit(draft)) setDraft('');
      return;
    }

    // Backspace on an empty field removes the last chip — standard behaviour
    // for this control, and the only way to fix a typo without the mouse.
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    // A single address is more useful left in the field, where it can still be
    // edited; anything multi-line or delimited is clearly a list.
    if (!/[,;\n\t]/.test(text)) return;
    event.preventDefault();
    if (commit(text)) setDraft('');
  };

  const hidden = expanded ? 0 : Math.max(0, value.length - visibleLimit);
  const shown = expanded ? value : value.slice(0, visibleLimit);

  return (
    <div className="w-full">
      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5 border-b border-line py-1.5',
          disabled && 'opacity-60',
        )}
      >
        {shown.map((email) => (
          <Chip
            key={email}
            tone="primary"
            onRemove={disabled ? undefined : () => onChange(value.filter((e) => e !== email))}
            removeLabel={`Remove ${email}`}
          >
            {email}
          </Chip>
        ))}

        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="rounded-full bg-neutral-soft px-2.5 py-1 text-xs font-medium text-ink/70 transition-colors hover:bg-neutral-softHover"
          >
            +{hidden}
          </button>
        )}

        {expanded && value.length > visibleLimit && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="px-1 text-xs text-muted underline-offset-2 hover:underline"
          >
            Show less
          </button>
        )}

        <input
          type="text"
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setRejected(null);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            if (draft.trim() !== '' && commit(draft)) setDraft('');
          }}
          placeholder={value.length === 0 ? 'name@company.com' : ''}
          aria-label="Recipients"
          className="min-w-[180px] flex-1 bg-transparent py-1 text-sm text-ink outline-none placeholder:text-muted"
        />
      </div>

      {rejected && (
        <p className="mt-1.5 text-xs text-danger">
          “{rejected}” is not a valid email address.
        </p>
      )}
    </div>
  );
}
