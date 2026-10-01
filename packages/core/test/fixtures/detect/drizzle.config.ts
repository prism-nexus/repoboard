// @ts-nocheck — fixture text only, read as a string by the detector; `drizzle-kit` is not a
// dependency of this package.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
});
