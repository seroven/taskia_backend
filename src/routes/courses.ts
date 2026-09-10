import { Router } from 'express'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/pool.js'
import { requireAuth, requireStudent } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/error.js'

const router = Router()

router.get(
  '/',
  requireAuth,
  requireStudent,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, name FROM courses
       WHERE user_id = ? AND is_active = 1
       ORDER BY name ASC`,
      [userId],
    )
    res.json(rows.map((r) => ({ id: Number(r.id), name: r.name })))
  }),
)

export default router
