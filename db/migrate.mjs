/**
 * Taskia DB setup (PostgreSQL).
 *
 *   npm run db:setup     → CREATE SCHEMA + aplica schema.pg.sql
 *   npm run db:migrate   → si no hay tablas, aplica schema.pg.sql; si ya está, no-op
 *
 * El schema de aplicación es PG_SCHEMA (por defecto "taskia"), no public.
 * Las migraciones históricas de MySQL en db/migrations/ no se aplican aquí:
 * el esquema vivo está en schema.pg.sql.
 *
 * Env: PG_* / PG_DSN del --env-file del script npm (.env.development por defecto).
 * Override: TASKIA_ENV=qa|pd|production o --env=pd
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const setupOnly = args.includes('--setup')
const envArg = args.find((a) => a.startsWith('--env='))?.slice('--env='.length)
const envName = envArg || process.env.TASKIA_ENV || 'development'
const envFiles = {
  development: '.env.development',
  qa: '.env.qa',
  pd: '.env.pd',
  production: '.env.production',
}
const envFile = envFiles[envName] ?? `.env.${envName}`

const envPath = path.join(root, envFile)
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath })
} else if (fs.existsSync(path.join(root, '.env'))) {
  dotenv.config({ path: path.join(root, '.env') })
} else {
  console.error(`No se encontró ${envFile} ni .env en taskia_backend`)
  process.exit(1)
}

const pgDsn = (process.env.PG_DSN ?? process.env.DATABASE_URL ?? '').trim()
const pgSchema = (process.env.PG_SCHEMA ?? 'taskia').trim() || 'taskia'
const sslmode = (
  process.env.PG_SSLMODE ?? (pgDsn ? 'require' : 'prefer')
).toLowerCase()

if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pgSchema)) {
  console.error('PG_SCHEMA inválido')
  process.exit(1)
}

function quoteIdent(name) {
  return `"${name}"`
}

function sslConfig() {
  if (sslmode === 'require' || sslmode === 'verify-full') {
    return { rejectUnauthorized: sslmode === 'verify-full' }
  }
  return undefined
}

function clientConfig() {
  const ssl = sslConfig()
  if (pgDsn) return { connectionString: pgDsn, ssl }
  return {
    host: process.env.PG_HOST ?? 'localhost',
    port: Number(process.env.PG_PORT ?? 5432),
    user: process.env.PG_USER ?? 'postgres',
    password: process.env.PG_PASSWORD ?? '',
    database: process.env.PG_DATABASE ?? 'postgres',
    ssl,
  }
}

const schemaPath = path.join(__dirname, 'schema.pg.sql')

function splitPgStatements(sql) {
  const out = []
  let i = 0
  let buf = ''
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (c === "'") {
      buf += c
      i += 1
      while (i < n) {
        buf += sql[i]
        if (sql[i] === "'" && sql[i + 1] === "'") {
          buf += sql[i + 1]
          i += 2
          continue
        }
        if (sql[i] === "'") {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (c === '$' && sql[i + 1] === '$') {
      const end = sql.indexOf('$$', i + 2)
      if (end === -1) {
        buf += sql.slice(i)
        break
      }
      buf += sql.slice(i, end + 2)
      i = end + 2
      continue
    }
    if (c === ';') {
      const stmt = buf.trim()
      if (stmt) out.push(stmt)
      buf = ''
      i += 1
      continue
    }
    buf += c
    i += 1
  }
  const last = buf.trim()
  if (last) out.push(last)
  return out
}

async function applySchema(client) {
  const sql = fs.readFileSync(schemaPath, 'utf8')
  console.log('→ schema.pg.sql')
  for (const stmt of splitPgStatements(sql)) {
    await client.query(stmt)
  }
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

async function isApplied(client, id) {
  const result = await client.query(
    'SELECT 1 AS ok FROM schema_migrations WHERE id = $1 LIMIT 1',
    [id],
  )
  return result.rows.length > 0
}

async function markApplied(client, id) {
  await client.query(
    `INSERT INTO schema_migrations (id) VALUES ($1)
     ON CONFLICT (id) DO NOTHING`,
    [id],
  )
}

async function tableExists(client, table) {
  const result = await client.query(
    `SELECT 1 AS ok
     FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2
     LIMIT 1`,
    [pgSchema, table],
  )
  return result.rows.length > 0
}

async function main() {
  const client = new pg.Client(clientConfig())
  await client.connect()

  try {
    const host = pgDsn ? '(PG_DSN)' : (process.env.PG_HOST ?? 'localhost')
    const database = process.env.PG_DATABASE ?? 'postgres'
    console.log(
      `Env: ${envFile} | DB: ${database} @ ${host} | schema: ${pgSchema}`,
    )

    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(pgSchema)}`)
    await client.query(`SET search_path TO ${quoteIdent(pgSchema)}, public`)
    await ensureMigrationsTable(client)

    const schemaId = 'schema.pg.sql'
    const hasUsers = await tableExists(client, 'users')
    const already = await isApplied(client, schemaId)

    if (setupOnly || !hasUsers || !already) {
      await applySchema(client)
      await markApplied(client, schemaId)
    } else {
      console.log('Nada pendiente')
    }

    const tables = await client.query(
      `SELECT table_name AS name
       FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [pgSchema],
    )
    console.log(
      'OK — tablas:',
      tables.rows.map((t) => t.name).join(', '),
    )
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
