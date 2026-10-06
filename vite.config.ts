import { defineConfig } from 'vitest/config';

// `base: './'` makes every emitted asset URL relative, so the build works
// from any subpath (e.g. https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'server/**/*.test.mjs'],
  },
});
