import { migrate } from 'drizzle-orm/libsql/migrator'
import { db, client } from './index.js'

console.log('Running migrations...')
await migrate(db, { migrationsFolder: './drizzle' })
console.log('Migrations complete.')
client.close()
