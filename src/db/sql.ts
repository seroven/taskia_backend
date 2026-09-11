/** Traduce SQL estilo MySQL (?, ENUMs sueltos) a PostgreSQL. */

export function quoteIdent(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Identificador SQL inválido: ${name}`)
  }
  return `"${name}"`
}

export function mysqlToPg(sql: string): string {
  let s = sql

  s = s.replace(/\bCHAR_LENGTH\s*\(/gi, 'char_length(')

  s = s.replace(/\bis_active\s*=\s*1\b/gi, 'is_active = TRUE')
  s = s.replace(/\bis_active\s*=\s*0\b/gi, 'is_active = FALSE')
  s = s.replace(/\bfrom_voice\s*=\s*1\b/gi, 'from_voice = TRUE')
  s = s.replace(/\bstudy_passed\s*=\s*1\b/gi, 'study_passed = TRUE')
  s = s.replace(/\buses_board\s*=\s*1\b/gi, 'uses_board = TRUE')
  s = s.replace(/\buses_board\s*=\s*0\b/gi, 'uses_board = FALSE')

  s = s.replace(/\bSUM\s*\(([^)]+)\)/gi, (_m, inner: string) => {
    if (/[=<>]/.test(inner) || /\bTRUE\b|\bFALSE\b/.test(inner)) {
      return `SUM((${inner})::int)`
    }
    return `SUM(${inner})`
  })

  s = s.replace(/\brole\s*=/g, '"role" =')
  s = s.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\.role\b/g, '$1."role"')
  s = s.replace(/,\s*role,/g, ', "role",')
  s = s.replace(/\bSELECT role,/gi, 'SELECT "role",')
  s = s.replace(/\bpassword_hash,\s*role,/gi, 'password_hash, "role",')
  s = s.replace(/\(username, email, password_hash, role, is_active\)/gi, '(username, email, password_hash, "role", is_active)')
  s = s.replace(/\(mission_id, role,/gi, '(mission_id, "role",')
  s = s.replace(/\(task_id, role,/gi, '(task_id, "role",')
  s = s.replace(/\bAS role\b/gi, 'AS "role"')

  let n = 0
  s = s.replace(/\?/g, () => `$${++n}`)

  if (/^\s*insert\s+/i.test(s) && !/\breturning\b/i.test(s)) {
    s = `${s.replace(/;?\s*$/, '')} RETURNING *`
  }

  return s
}
