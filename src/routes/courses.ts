import { Router } from 'express'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/error.js'

const router = Router()

router.get(
  '/',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, name FROM courses WHERE is_active = 1 ORDER BY name ASC`,
    )
    res.json(rows.map((r) => ({ id: Number(r.id), name: r.name })))
  }),
)

export default router
