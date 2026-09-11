import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { pool } from '../db/pool.js'
import { AppError, type JwtPayload, type PublicUser, type UserRole } from '../utils/helpers.js'

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser
    }
  }
}

export function signToken(user: PublicUser): string {
  const payload: JwtPayload = { sub: user.id, role: user.role }
  return jwt.sign(payload, env.jwt.secret, { expiresIn: env.jwt.expiresIn as jwt.SignOptions['expiresIn'] })
}

export function setAuthCookie(res: Response, token: string) {
  res.cookie(env.cookie.name, token, {
    httpOnly: true,
    secure: env.cookie.secure,
    sameSite: env.cookie.sameSite,
    path: '/',
    maxAge: 12 * 60 * 60 * 1000,
  })
}

export function clearAuthCookie(res: Response) {
  res.clearCookie(env.cookie.name, {
    httpOnly: true,
    secure: env.cookie.secure,
    sameSite: env.cookie.sameSite,
    path: '/',
  })
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[env.cookie.name] as string | undefined
    if (!token) throw new AppError('Debes iniciar sesión', 401)

    let decoded: string | jwt.JwtPayload
    try {
      decoded = jwt.verify(token, env.jwt.secret)
    } catch {
      throw new AppError('Sesión inválida o expirada', 401)
    }
    if (
      typeof decoded === 'string' ||
      typeof decoded.sub !== 'number' ||
      (decoded.role !== 'user' && decoded.role !== 'admin')
    ) {
      throw new AppError('Sesión inválida o expirada', 401)
    }
    const payload: JwtPayload = { sub: decoded.sub, role: decoded.role }

    const [rows] = await pool.query<
      Array<{
        id: number
        username: string
        email: string
        role: UserRole
        is_active: number | boolean
      }>
    >(
      'SELECT id, username, email, role, is_active FROM users WHERE id = ? LIMIT 1',
      [payload.sub],
    )

    const user = (
      rows as unknown as Array<{
        id: number
        username: string
        email: string
        role: UserRole
        is_active: number
      }>
    )[0]
    if (!user) throw new AppError('Debes iniciar sesión', 401)
    if (Number(user.is_active) === 0) {
      throw new AppError('Tu cuenta está pausada. Pídele ayuda a un adulto.', 403)
    }

    req.user = {
      id: Number(user.id),
      username: user.username,
      email: user.email,
      role: user.role,
    }
    next()
  } catch (err) {
    next(err)
  }
}

export function requireStudent(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(new AppError('Debes iniciar sesión', 401))
    return
  }
  if (req.user.role !== 'user') {
    next(new AppError('Esta zona es solo para alumnos', 403))
    return
  }
  next()
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(new AppError('Debes iniciar sesión', 401))
    return
  }
  if (req.user.role !== 'admin') {
    next(new AppError('Solo el administrador puede entrar aquí', 403))
    return
  }
  next()
}
