'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/format';
import { Spinner } from './Spinner';

/**
 * The four button treatments in the Figma:
 *
 * - `primary`  — solid green, the Login submit
 * - `soft`     — pale green fill, the "Login with Google" button and the active nav pill
 * - `outline`  — white with a green 1px border, the Compose and Send pills
 * - `ghost`    — no chrome until hover, used for Cancel and toolbar actions
 */
type Variant = 'primary' | 'soft' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover disabled:hover:bg-primary',
  soft: 'bg-primary-soft text-primary hover:bg-primary-softHover disabled:hover:bg-primary-soft',
  outline:
    'border border-primary bg-white text-primary hover:bg-primary-soft disabled:hover:bg-white',
  ghost: 'text-ink hover:bg-neutral-soft disabled:hover:bg-transparent',
  danger: 'bg-danger text-white hover:brightness-95',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 gap-1.5 px-3 text-[13px]',
  md: 'h-10 gap-2 px-4 text-sm',
  lg: 'h-12 gap-2 px-5 text-[15px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner and blocks clicks — for in-flight mutations. */
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leftIcon,
    rightIcon,
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      // A loading button that stays clickable is how you get duplicate
      // campaigns, so `loading` disables as well as decorates.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-full font-medium',
        'transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? <Spinner className="text-current" /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
