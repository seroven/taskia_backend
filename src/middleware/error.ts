import type { NextFunction, Request, Response } from 'express'
import { AppError } from '../utils/helpers.js'

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error(err)
  const message = err instanceof Error ? err.message : 'Error interno'
  res.status(500).json({ error: message })
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next)
  }
}
