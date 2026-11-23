// Unit tests run without the IWSDK dev plugin.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'scanner/**/*.test.js', 'api/**/*.test.ts'] },
});
