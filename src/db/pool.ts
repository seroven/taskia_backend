import pg from 'pg'
import { env } from '../config/env.js'
import { mysqlToPg, quoteIdent } from './sql.js'

export type RowDataPacket = Record<string, unknown>

export interface ResultSetHeader {
  insertId: number
  affectedRows: number
}

pg.types.setTypeParser(20, (value: string) => Number(value))
pg.types.setTypeParser(1700, (value: string) => Number(value))
pg.types.setTypeParser(1082, (value: string) => value)

const pgPool = new pg.Pool({
  connectionString: env.pg.dsn || undefined,
  host: env.pg.dsn ? undefined : env.pg.host,
  port: env.pg.dsn ? undefined : env.pg.port,
  user: env.pg.dsn ? undefined : env.pg.user,
  password: env.pg.dsn ? undefined : env.pg.password,
  database: env.pg.dsn ? undefined : env.pg.database,
  ssl:
    env.pg.sslmode === 'require' || env.pg.sslmode === 'verify-full'
      ? { rejectUnauthorized: env.pg.sslmode === 'verify-full' }
      : undefined,
  max: 10,
})

async function prepareClient(client: pg.PoolClient) {
  await client.query(`SET search_path TO ${quoteIdent(env.pg.schema)}, public`)
}

async function runQuery(
  client: pg.PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<[RowDataPacket[], ResultSetHeader]> {
  const text = mysqlToPg(sql)
  const result = await client.query(text, params)
  const rows = (result.rows ?? []) as RowDataPacket[]
  const first = rows[0]
  const header: ResultSetHeader = {
    insertId: first?.id != null ? Number(first.id) : 0,
    affectedRows: result.rowCount ?? 0,
  }
  return [rows, header]
}

function isMutatingSql(sql: string) {
  return /^\s*(insert|update|delete)\s+/i.test(sql)
}

function queryResult<T>(
  sql: string,
  rows: RowDataPacket[],
  header: ResultSetHeader,
): [T, ResultSetHeader] {
  if (isMutatingSql(sql)) {
    return [header as T, header]
  }
  return [rows as T, header]
}

export const pool = {
  async query<T = RowDataPacket[]>(
    sql: string,
    params?: unknown[],
  ): Promise<[T, ResultSetHeader]> {
    const client = await pgPool.connect()
    try {
      await prepareClient(client)
      const [rows, header] = await runQuery(client, sql, params ?? [])
      return queryResult<T>(sql, rows, header)
    } finally {
      client.release()
    }
  },

  async getConnection() {
    const client = await pgPool.connect()
    await prepareClient(client)
    return {
      async query<T = RowDataPacket[]>(sql: string, params?: unknown[]) {
        const [rows, header] = await runQuery(client, sql, params ?? [])
        return queryResult<T>(sql, rows, header)
      },
      async beginTransaction() {
        await client.query('BEGIN')
      },
      async commit() {
        await client.query('COMMIT')
      },
      async rollback() {
        await client.query('ROLLBACK')
      },
      release() {
        client.release()
      },
    }
  },

  async end() {
    await pgPool.end()
  },
}

export async function initDb() {
  const client = await pgPool.connect()
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(env.pg.schema)}`)
    await prepareClient(client)
  } finally {
    client.release()
  }
}
