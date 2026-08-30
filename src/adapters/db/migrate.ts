import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import { requireDatabaseUrl } from '../build-deps.js'
import { loadEnvFile } from '../load-env.js'
import { createDbClient } from './client.js'

loadEnvFile()

const databaseUrl = requireDatabaseUrl()

const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url))

const { sql, db } = createDbClient(databaseUrl)
await migrate(db, { migrationsFolder })
await sql.end()
console.log('migrations applied')
