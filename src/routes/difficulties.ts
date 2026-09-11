import { Router } from 'express'
import type { RowDataPacket } from '../db/pool.js'
import { pool } from '../db/pool.js'
import { requireAuth, requireStudent } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/error.js'

const router = Router()

router.get(
  '/',
  requireAuth,
  requireStudent,
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, code, name, sort_order FROM difficulties ORDER BY sort_order ASC, id ASC`,
    )
    res.json(
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        sort_order: Number(r.sort_order),
      })),
    )
  }),
)

export default router
