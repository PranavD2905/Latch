import { defineConfig } from 'drizzle-kit'

process.loadEnvFile?.('.env')

export default defineConfig({
  schema: './src/adapters/db/schema.ts',
  out: './src/adapters/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch',
  },
})
