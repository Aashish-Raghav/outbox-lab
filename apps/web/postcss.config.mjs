import { fileURLToPath } from 'node:url';

/**
 * Tailwind resolves `tailwind.config.ts` relative to the *process* cwd, not to
 * this file. In a monorepo that means a build launched from the repo root
 * silently finds no config, falls back to an empty `content` array, and emits a
 * stylesheet with none of the theme in it — which surfaces as
 * "The `text-ink` class does not exist" rather than as a missing config.
 *
 * Anchoring the path to this file makes the build behave the same from any cwd.
 */
const config = fileURLToPath(new URL('./tailwind.config.ts', import.meta.url));

/** @type {import('postcss-load-config').Config} */
export default {
  plugins: {
    tailwindcss: { config },
    autoprefixer: {},
  },
};
