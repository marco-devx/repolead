import { defineConfig, globalIgnores, ts } from '@rslint/core';

export default defineConfig([
  globalIgnores(['**/dist/**', '**/node_modules/**']),
  ts.configs.recommended,
]);
