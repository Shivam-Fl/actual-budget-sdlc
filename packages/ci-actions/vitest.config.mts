import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.(js|jsx|ts|tsx)', 'bin/**/*.test.mjs'],
    environment: 'node',
    maxWorkers: 1,
    isolate: false,
    reporters: process.env.CI
      ? [
          'default',
          [
            'junit',
            { outputFile: './test-results/junit.xml', suiteName: 'ci-actions' },
          ],
        ]
      : ['default'],
  },
});
