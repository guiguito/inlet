import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/setup/global.ts'],
    include: ['test/**/*.test.ts'],
    // The integration suite shares one PostgreSQL database and one bucket, and each
    // file truncates between tests, so files must not run concurrently.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});
