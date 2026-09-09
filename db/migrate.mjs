/**
 * Taskia DB setup / migrations (MySQL).
 *
 *   npm run db:setup     → aplica schema.sql (instalación / sync idempotente)
 *   npm run db:migrate   → aplica migraciones pendientes en db/migrations/
 *
 * Env: usa MYSQL_* del --env-file del script npm (.env.development por defecto).
 * Override: TASKIA_ENV=qa|production o --env=qa
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const setupOnly = args.includes('--setup')
const envArg = args.find((a) => a.startsWith('--env='))?.slice('--env='.length)
const envName = envArg || process.env.TASKIA_ENV || 'development'
const envFile =
  envName === 'development'
    ? '.env.development'
    : envName === 'qa'
      ? '.env.qa'
      : envName === 'production'
        ? '.env.production'
        : `.env.${envName}`

const envPath = path.join(root, envFile)
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath })
} else if (fs.existsSync(path.join(root, '.env'))) {
  dotenv.config({ path: path.join(root, '.env') })
} else {
  console.error(`No se encontró ${envFile} ni .env en taskia_backend`)
  process.exit(1)
}

const {
  MYSQL_HOST = 'localhost',
  MYSQL_PORT = '3306',
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DATABASE = 'taskia',
} = process.env

if (!MYSQL_USER) {
  console.error('Falta MYSQL_USER en el env')
  process.exit(1)
}

const migrationsDir = path.join(__dirname, 'migrations')
const schemaPath = path.join(__dirname, 'schema.sql')

function listMigrationFiles() {
  if (!fs.existsSync(migrationsDir)) return []
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/i.test(f))
    .sort()
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT 1 AS ok
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     LIMIT 1`,
    [MYSQL_DATABASE, table],
  )
  return rows.length > 0
}

async function ensureMigrationsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(255) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

async function appliedIds(conn) {
  const [rows] = await conn.query(
    'SELECT id FROM schema_migrations ORDER BY id',
  )
  return new Set(rows.map((r) => r.id))
}

async function markApplied(conn, id) {
  await conn.query(
    'INSERT INTO schema_migrations (id) VALUES (?) ON DUPLICATE KEY UPDATE id = id',
    [id],
  )
}

async function runSqlFile(conn, filePath, label) {
  const sql = fs.readFileSync(filePath, 'utf8')
  console.log(`→ ${label}`)
  await conn.query(sql)
}

async function applySchema(conn) {
  await runSqlFile(conn, schemaPath, 'schema.sql')
}

async function baselineAll(conn, files) {
  for (const f of files) {
    await markApplied(conn, f)
  }
  console.log(`Baseline: ${files.length} migración(es) marcadas como aplicadas`)
}

async function main() {
  const connection = await mysql.createConnection({
    host: MYSQL_HOST,
    port: Number(MYSQL_PORT),
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    multipleStatements: true,
  })

  try {
    console.log(`Env: ${envFile} | DB: ${MYSQL_DATABASE} @ ${MYSQL_HOST}`)

    if (setupOnly) {
      await applySchema(connection)
      await connection.query(`USE \`${MYSQL_DATABASE}\``)
      await ensureMigrationsTable(connection)
      await baselineAll(connection, listMigrationFiles())
    } else {
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\`
        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      await connection.query(`USE \`${MYSQL_DATABASE}\``)
      await ensureMigrationsTable(connection)

      const files = listMigrationFiles()
      const done = await appliedIds(connection)
      const hasUsers = await tableExists(connection, 'users')
      const hasWorlds = await tableExists(connection, 'study_worlds')

      // DB vacía → schema completo + baseline de migraciones históricas
      if (!hasUsers) {
        await applySchema(connection)
        await connection.query(`USE \`${MYSQL_DATABASE}\``)
        await baselineAll(connection, files)
      } else if (done.size === 0 && hasWorlds) {
        // DB ya al día (p. ej. desde desktop) → solo registrar baseline
        await baselineAll(connection, files)
      } else {
        const pending = files.filter((f) => !done.has(f))
        if (pending.length === 0) {
          console.log('Nada pendiente')
        } else {
          for (const f of pending) {
            await runSqlFile(connection, path.join(migrationsDir, f), f)
            await markApplied(connection, f)
          }
          console.log(`Aplicadas: ${pending.length}`)
        }
      }
    }

    await connection.query(`USE \`${MYSQL_DATABASE}\``)
    const [tables] = await connection.query(
      `SELECT TABLE_NAME AS name
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [MYSQL_DATABASE],
    )
    console.log('OK — tablas:', tables.map((t) => t.name).join(', '))
  } finally {
    await connection.end()
  }
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
