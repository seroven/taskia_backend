export type UserRole = 'user' | 'admin'

export interface PublicUser {
  id: number
  username: string
  email: string
  role: UserRole
}

export interface JwtPayload {
  sub: number
  role: UserRole
}

export class AppError extends Error {
  status: number

  constructor(message: string, status = 400) {
    super(message)
    this.status = status
    this.name = 'AppError'
  }
}

export function todayISO(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Inicio (incl.) y fin (excl.) del día civil local, en UTC ISO para MySQL. */
export function localDayUtcRange(dateStr: string): { start: string; end: string } {
  const [y, m, d] = dateStr.split('-').map(Number)
  const startLocal = new Date(y, m - 1, d, 0, 0, 0, 0)
  const endLocal = new Date(y, m - 1, d + 1, 0, 0, 0, 0)
  return {
    start: startLocal.toISOString().slice(0, 19).replace('T', ' '),
    end: endLocal.toISOString().slice(0, 19).replace('T', ' '),
  }
}

export function formatMysqlDateTime(value: Date | string | null): string | null {
  if (value == null) return null
  if (typeof value === 'string') {
    return value.length >= 19 ? value.slice(0, 19).replace('T', ' ') : value
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
}

export function formatMysqlDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

export function truncateChars(value: string, max: number): string {
  const chars = [...value]
  if (chars.length <= max) return value
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…'
}

export function extractJson(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed
  const match = trimmed.match(/[\{\[][\s\S]*[\}\]]/)
  if (!match) throw new AppError('La IA no devolvió JSON válido')
  return match[0]
}
