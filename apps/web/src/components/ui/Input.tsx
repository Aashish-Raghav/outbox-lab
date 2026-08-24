'use client';

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/format';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** Validation message. Present => the field renders in its error state. */
  error?: string;
  hint?: string;
  leftIcon?: ReactNode;
  rightSlot?: ReactNode;
  /**
   * `filled` is the Figma login field (grey fill, no border);
   * `underline` is the Compose field (no fill, single bottom rule).
   */
  variant?: 'filled' | 'underline';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, leftIcon, rightSlot, variant = 'filled', className, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-ink">
          {label}
        </label>
      )}

      <div className="relative flex items-center">
        {leftIcon && (
          <span className="pointer-events-none absolute left-3 text-base text-muted">
            {leftIcon}
          </span>
        )}

        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'w-full text-sm text-ink placeholder:text-muted',
            'transition-colors disabled:cursor-not-allowed disabled:opacity-60',
            variant === 'filled' &&
              'h-11 rounded-field bg-neutral-soft px-3.5 focus:bg-neutral-softHover',
            variant === 'underline' &&
              'h-10 border-b border-line bg-transparent px-0 focus:border-primary',
            leftIcon && (variant === 'filled' ? 'pl-9' : 'pl-7'),
            rightSlot && 'pr-10',
            error && (variant === 'filled' ? 'ring-1 ring-danger' : 'border-danger'),
            className,
          )}
          {...props}
        />

        {rightSlot && <span className="absolute right-3 flex items-center">{rightSlot}</span>}
      </div>

      {error ? (
        <p id={`${inputId}-error`} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="mt-1.5 text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
