'use client';

import { useState } from 'react';
import { parseRecipients, type ParsedRecipients } from '@reachinbox/shared';
import { Button, FileDropzone } from '@/components/ui';
import { CheckIcon, FileIcon, UploadIcon, XIcon } from '@/components/icons';
import { formatBytes } from '@/lib/format';

export interface UploadListProps {
  file: File | null;
  onFile: (file: File | null) => void;
  /** Reported upward so the submit button can show the true total. */
  onParsed: (parsed: ParsedRecipients | null) => void;
}

/** Refuse before reading — a mis-picked video would hang the browser tab. */
const MAX_LEAD_FILE_BYTES = 5 * 1024 * 1024;

/**
 * The `⬆ Upload List` control beside the To field.
 *
 * The assignment asks the UI to show the *count of detected addresses*, so the
 * file is parsed in the browser with the same shared `parseRecipients` the API
 * uses on submit. Same bytes, same function, same number — the count shown is
 * not an estimate that the server might later contradict.
 */
export function UploadList({ file, onFile, onParsed }: UploadListProps) {
  const [open, setOpen] = useState(false);
  const [parsed, setParsed] = useState<ParsedRecipients | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const reset = () => {
    onFile(null);
    onParsed(null);
    setParsed(null);
    setError(null);
  };

  const accept = async (picked: File) => {
    setError(null);

    if (picked.size > MAX_LEAD_FILE_BYTES) {
      setError(`That file is ${formatBytes(picked.size)}; the limit is 5 MB.`);
      return;
    }

    setReading(true);
    try {
      const result = parseRecipients(await picked.text());

      if (result.emails.length === 0) {
        setError('No email addresses were found in that file.');
        reset();
        return;
      }

      onFile(picked);
      onParsed(result);
      setParsed(result);
      setOpen(false);
    } catch {
      setError('That file could not be read as text.');
    } finally {
      setReading(false);
    }
  };

  if (file && parsed) {
    return (
      <div className="flex items-center gap-2.5 rounded-field bg-primary-soft px-3 py-2">
        <FileIcon className="shrink-0 text-base text-primary" />

        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{file.name}</p>
          <p className="text-xs text-primary">
            <CheckIcon className="mr-1 inline text-[13px]" />
            {parsed.emails.length} email {parsed.emails.length === 1 ? 'address' : 'addresses'}{' '}
            detected
            {parsed.duplicatesRemoved > 0 && ` · ${parsed.duplicatesRemoved} duplicate${
              parsed.duplicatesRemoved === 1 ? '' : 's'
            } removed`}
            {parsed.invalidLines.length > 0 &&
              ` · ${parsed.invalidLines.length} line${
                parsed.invalidLines.length === 1 ? '' : 's'
              } skipped`}
          </p>
        </div>

        <button
          type="button"
          onClick={reset}
          aria-label="Remove the uploaded list"
          className="rounded-full p-1 text-primary transition-colors hover:bg-primary-softHover"
        >
          <XIcon className="text-sm" />
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary underline-offset-2 hover:underline"
        >
          <UploadIcon className="text-base" />
          Upload List
        </button>
        {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <FileDropzone
        accept=".csv,.txt,.tsv,text/csv,text/plain"
        disabled={reading}
        label={reading ? 'Reading…' : 'Drop a CSV or TXT list, or click to browse'}
        hint="Addresses are found in any column, with or without a header row"
        onFiles={(files) => {
          if (files[0]) void accept(files[0]);
        }}
      />

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      <Button variant="ghost" size="sm" className="mt-2" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}
