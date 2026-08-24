import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from '../load-env.js'
import { createDbClient } from './client.js'

loadEnvFile()

const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set')
}

const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url))

const { sql, db } = createDbClient(databaseUrl)
await migrate(db, { migrationsFolder })
await sql.end()
console.log('migrations applied')
