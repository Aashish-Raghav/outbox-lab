'use client';

import { useRef, useState, type DragEvent } from 'react';
import { cn } from '@/lib/format';
import { UploadIcon } from '../icons';

export interface FileDropzoneProps {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  label?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Click-or-drop file input for the lead list and attachments.
 *
 * `dragenter`/`dragleave` fire for every child element the pointer crosses, so
 * a boolean flag would flicker as the cursor moves over the icon or the text.
 * Counting enters and leaves instead keeps the highlight stable, which is the
 * standard fix for this.
 */
export function FileDropzone({
  onFiles,
  accept,
  multiple = false,
  label = 'Upload a file',
  hint,
  disabled = false,
  className,
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const emit = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length > 0) onFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!disabled) emit(event.dataTransfer.files);
  };

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        if (!disabled) setDragging(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      // Without preventDefault on dragover the browser navigates to the file.
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      className={cn(
        'rounded-card border border-dashed p-6 text-center transition-colors',
        dragging ? 'border-primary bg-primary-soft' : 'border-line bg-white',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          emit(event.target.files);
          // Reset, so re-picking the same file still fires a change event.
          event.target.value = '';
        }}
      />

      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="mx-auto flex flex-col items-center gap-2 disabled:cursor-not-allowed"
      >
        <UploadIcon className="text-xl text-primary" />
        <span className="text-sm font-medium text-primary">{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </button>
    </div>
  );
}
