import { defineConfig } from '@rstest/core';

export default defineConfig({
  include: ['{apps,packages,adapters}/**/*.test.ts'],
});
