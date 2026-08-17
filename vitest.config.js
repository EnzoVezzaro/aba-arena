import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.{cjs,mjs}', 'ui/src/**/*.test.{js,jsx}'],
    setupFiles: ['ui/src/__tests__/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.cjs', 'ui/src/**/*.{js,jsx}'],
      exclude: ['**/*.test.*', '**/*.spec.*'],
    },
    environmentOptions: {
      jsdom: {
        url: 'http://localhost:5199',
      },
    },
  },
});
