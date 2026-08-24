'use client';

import { useRef } from 'react';
import { Chip } from '@/components/ui';
import { PaperclipIcon } from '@/components/icons';
import { cn, formatBytes } from '@/lib/format';

export interface AttachmentBarProps {
  files: File[];
  onChange: (files: File[]) => void;
  /** Matches multer's `attachments` maxCount on the API. */
  maxFiles?: number;
  maxBytes?: number;
  onReject: (message: string) => void;
}

/**
 * The paperclip in the Compose header, with a count badge, plus the chips for
 * what is attached.
 *
 * The limits mirror the server's multer config rather than being independently
 * chosen — a file that the UI accepts and the API then rejects wastes an upload
 * and produces a confusing error at submit time.
 */
export function AttachmentBar({
  files,
  onChange,
  maxFiles = 5,
  maxBytes = 10 * 1024 * 1024,
  onReject,
}: AttachmentBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (picked: File[]) => {
    const room = maxFiles - files.length;
    if (room <= 0) {
      onReject(`You can attach at most ${maxFiles} files.`);
      return;
    }

    const tooBig = picked.find((file) => file.size > maxBytes);
    if (tooBig) {
      onReject(`“${tooBig.name}” is ${formatBytes(tooBig.size)}; the limit is ${formatBytes(maxBytes)}.`);
      return;
    }

    if (picked.length > room) {
      onReject(`Only ${room} more ${room === 1 ? 'file' : 'files'} can be attached.`);
    }

    onChange([...files, ...picked.slice(0, room)]);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(event) => {
          add(Array.from(event.target.files ?? []));
          // Reset so picking the same file again still fires a change event.
          event.target.value = '';
        }}
      />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        aria-label={files.length > 0 ? `Attachments (${files.length})` : 'Attach files'}
        title="Attach files"
        className={cn(
          'relative flex h-9 w-9 items-center justify-center rounded-full transition-colors',
          files.length > 0
            ? 'bg-primary-soft text-primary'
            : 'text-muted hover:bg-neutral-soft hover:text-ink',
        )}
      >
        <PaperclipIcon className="text-lg" />
        {files.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-white">
            {files.length}
          </span>
        )}
      </button>
    </>
  );
}

/** The chips below the editor, listing what is currently attached. */
export function AttachmentChips({
  files,
  onChange,
}: {
  files: File[];
  onChange: (files: File[]) => void;
}) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {files.map((file, index) => (
        <Chip
          // Name alone is not unique — two files can be picked from different
          // folders — so the index participates in the key.
          key={`${file.name}-${index}`}
          tone="neutral"
          icon={<PaperclipIcon className="text-[13px]" />}
          onRemove={() => onChange(files.filter((_, i) => i !== index))}
          removeLabel={`Remove ${file.name}`}
        >
          {file.name} · {formatBytes(file.size)}
        </Chip>
      ))}
    </div>
  );
}
