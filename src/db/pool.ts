import mysql from 'mysql2/promise'
import { env } from '../config/env.js'

export const pool = mysql.createPool({
  host: env.mysql.host,
  port: env.mysql.port,
  user: env.mysql.user,
  password: env.mysql.password,
  database: env.mysql.database,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  timezone: 'Z',
  dateStrings: false,
})

export async function initDb() {
  const conn = await pool.getConnection()
  try {
    await conn.query("SET time_zone = '+00:00'")
  } finally {
    conn.release()
  }
}
