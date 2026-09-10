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

/** El tutor está ofreciendo más práctica en vez de cerrar dominio. */
export function looksLikeOfferingMorePractice(text: string): boolean {
  const t = text.toLowerCase()
  return /otro tipo|otra clase de|más ejercicio|otro ejercicio|te gustaría practicar|quieres practicar|practicamos otro|quieres otro|otro formato|más práctica|otra forma de/.test(
    t,
  )
}

/** Contador "Solo bien: N/2" del context_summary (pizarra). */
export function soloBienCount(summary: string): number | null {
  const m = summary.match(/solo bien:\s*(\d+)\s*\/\s*2/i)
  return m ? Number(m[1]) : null
}

/** Errores anotados en context_summary ("Errores: N"). */
export function trackedErrorCount(summary: string): number {
  const m = summary.match(/errores:\s*(\d+)/i)
  if (!m) return 0
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function requiredChatTurns(base: number, summary: string): number {
  return base + trackedErrorCount(summary)
}

/** Misión teórica: el tutor pregunta si queda más contenido del tema. */
export function looksLikeAskingMoreTopicContent(text: string): boolean {
  const t = text.toLowerCase()
  const mentionsMore =
    /más contenido|mas contenido|más de este tema|mas de este tema|otra parte del tema|otro contenido|algo más de este|algo mas de este|falta por estudiar|se nos quedó|se nos quedo|necesitamos estudiar|queda algo/.test(
      t,
    )
  const looksQuestion =
    /[¿?]/.test(t) ||
    /te gustaría|quieres (estudiar|ver|repasar)|dime si|cuéntame si|cuentame si/.test(
      t,
    )
  return mentionsMore && looksQuestion
}
