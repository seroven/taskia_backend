function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (value === undefined || value === '') {
    throw new Error(`Falta la variable de entorno ${name}`)
  }
  return value
}

const pgDsn = (process.env.PG_DSN ?? process.env.DATABASE_URL ?? '').trim()
const pgSchema = (process.env.PG_SCHEMA ?? 'taskia').trim() || 'taskia'

if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pgSchema)) {
  throw new Error('PG_SCHEMA inválido')
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3001),
  corsOrigin: required('CORS_ORIGIN', 'http://localhost:5173'),
  pg: {
    dsn: pgDsn,
    host: process.env.PG_HOST ?? 'localhost',
    port: Number(process.env.PG_PORT ?? 5432),
    user: process.env.PG_USER ?? 'postgres',
    password: process.env.PG_PASSWORD ?? '',
    database: process.env.PG_DATABASE ?? 'postgres',
    schema: pgSchema,
    sslmode: (process.env.PG_SSLMODE ?? (pgDsn ? 'require' : 'prefer')).toLowerCase(),
  },
  jwt: {
    secret: required('JWT_SECRET', 'dev-secret'),
    expiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  },
  cookie: {
    name: process.env.COOKIE_NAME ?? 'taskia_token',
    secure: (process.env.COOKIE_SECURE ?? 'false') === 'true',
    sameSite: (process.env.COOKIE_SAME_SITE ?? 'lax') as 'lax' | 'strict' | 'none',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
  },
}
