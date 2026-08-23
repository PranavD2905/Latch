import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export function createDbClient(databaseUrl: string) {
  const sql = postgres(databaseUrl)
  const db = drizzle(sql, { schema })
  return { sql, db }
}

export type Db = ReturnType<typeof createDbClient>['db']
