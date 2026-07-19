import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.js', 'src/**/*.test.{js,jsx}', 'api/**/*.test.js'],
  },
});
