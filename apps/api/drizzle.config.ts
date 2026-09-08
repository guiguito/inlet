import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.INLET_DATABASE_URL ?? 'postgresql://inlet:inlet@localhost:5433/inlet',
  },
  migrations: { table: 'inlet_migrations', schema: 'public' },
  strict: true,
  verbose: true,
});
