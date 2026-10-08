import { defineConfig } from '@playwright/test';

/** Logic tests only: no browser, no LinkedIn, no network. Run with `npm run test:unit`. */
export default defineConfig({
  testDir: './tests/unit',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
});
