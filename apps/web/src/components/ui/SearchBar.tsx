'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/format';
import { SearchIcon, XIcon } from '../icons';

export interface SearchBarProps {
  /** The committed (debounced) value, owned by the parent. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
  className?: string;
}

/**
 * The rounded search pill above the email lists.
 *
 * Typing updates local state immediately so the field stays responsive, and
 * only settles into the parent after `debounceMs` — otherwise every keystroke
 * would be its own query key and its own request.
 */
export function SearchBar({
  value,
  onChange,
  placeholder = 'Search',
  debounceMs = 300,
  className,
}: SearchBarProps) {
  const [draft, setDraft] = useState(value);

  // Keeps the field in step when the parent resets the search (e.g. tab change).
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), debounceMs);
    return () => clearTimeout(timer);
  }, [draft, value, debounceMs, onChange]);

  return (
    <div
      className={cn(
        'flex h-10 flex-1 items-center gap-2.5 rounded-full bg-neutral-soft px-4',
        'transition-colors focus-within:bg-neutral-softHover',
        className,
      )}
    >
      <SearchIcon className="shrink-0 text-base text-muted" />
      <input
        type="search"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn(
          'min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted',
          // Safari draws its own clear button on type=search; we have our own.
          '[&::-webkit-search-cancel-button]:hidden',
        )}
      />
      {draft && (
        <button
          type="button"
          onClick={() => setDraft('')}
          aria-label="Clear search"
          className="rounded-full p-0.5 text-muted transition-colors hover:text-ink"
        >
          <XIcon className="text-sm" />
        </button>
      )}
    </div>
  );
}
