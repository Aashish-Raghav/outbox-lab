import type { Config } from 'tailwindcss';

/**
 * The design tokens read off the Figma, in one place.
 *
 * Components reference these names only — there are no one-off hex values in
 * JSX. That is what makes "the green in the Compose button" and "the green in
 * the active nav pill" provably the same green, and what makes a design tweak a
 * one-line change here rather than a search-and-replace.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#3D9B4A',
          hover: '#348140',
          soft: '#E9F6EC',
          softHover: '#DCF0E1',
        },
        warning: {
          DEFAULT: '#E8890C',
          soft: '#FFF4E5',
        },
        danger: {
          DEFAULT: '#DC2626',
          soft: '#FEF2F2',
        },
        neutral: {
          soft: '#F3F4F5',
          softHover: '#E9EAEC',
        },
        ink: '#1F2937',
        muted: '#9CA3AF',
        line: '#E5E7EB',
      },
      borderRadius: {
        card: '12px',
        field: '8px',
      },
      fontFamily: {
        // Figma uses Inter; the stack degrades to the platform UI font so the
        // dashboard never renders in Times New Roman while a webfont loads.
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06)',
        pop: '0 8px 24px rgba(16, 24, 40, 0.12)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        // Slides an over-wide gradient across the element. Animating
        // background-position rather than transform means the shimmer can live
        // on the skeleton block itself instead of an extra overlay child.
        shimmer: {
          from: { backgroundPosition: '100% 0' },
          to: { backgroundPosition: '-100% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        shimmer: 'shimmer 1.4s infinite',
      },
    },
  },
  plugins: [],
};

export default config;
