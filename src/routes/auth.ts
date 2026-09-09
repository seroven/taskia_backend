import { Router } from 'express'
import bcrypt from 'bcryptjs'
import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import { pool } from '../db/pool.js'
import {
  clearAuthCookie,
  requireAuth,
  setAuthCookie,
  signToken,
} from '../middleware/auth.js'
import { asyncHandler } from '../middleware/error.js'
import { AppError, type PublicUser, type UserRole } from '../utils/helpers.js'

const router = Router()

function validateCredentials(username: string, password: string, email?: string) {
  const u = username.trim()
  if (u.length < 3) throw new AppError('El usuario debe tener al menos 3 caracteres')
  if (password.length < 6) throw new AppError('La contraseña debe tener al menos 6 caracteres')
  if (email !== undefined) {
    const e = email.trim()
    if (!e.includes('@') || e.length < 5) throw new AppError('Correo inválido')
  }
}

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const username = String(req.body.username ?? '')
    const email = String(req.body.email ?? '')
    const password = String(req.body.password ?? '')
    validateCredentials(username, password, email)

    const u = username.trim()
    const e = email.trim().toLowerCase()

    const [existingUser] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE username = ? LIMIT 1',
      [u],
    )
    if (existingUser.length > 0) throw new AppError('Ese nombre de usuario ya existe')

    const [existingEmail] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [e],
    )
    if (existingEmail.length > 0) throw new AppError('Ese correo ya está registrado')

    const passwordHash = await bcrypt.hash(password, 10)
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'user')`,
      [u, e, passwordHash],
    )

    const user: PublicUser = {
      id: result.insertId,
      username: u,
      email: e,
      role: 'user',
    }
    setAuthCookie(res, signToken(user))
    res.json(user)
  }),
)

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const username = String(req.body.username ?? '')
    const password = String(req.body.password ?? '')
    validateCredentials(username, password)

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, username, email, password_hash, role FROM users WHERE username = ? LIMIT 1',
      [username.trim()],
    )
    const row = rows[0]
    if (!row) throw new AppError('Usuario o contraseña incorrectos')

    const valid = await bcrypt.compare(password, row.password_hash as string)
    if (!valid) throw new AppError('Usuario o contraseña incorrectos')

    const user: PublicUser = {
      id: Number(row.id),
      username: row.username as string,
      email: row.email as string,
      role: row.role as UserRole,
    }
    setAuthCookie(res, signToken(user))
    res.json(user)
  }),
)

router.post(
  '/logout',
  asyncHandler(async (_req, res) => {
    clearAuthCookie(res)
    res.json({ ok: true })
  }),
)

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(req.user ?? null)
  }),
)

export default router
