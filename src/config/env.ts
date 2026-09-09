function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (value === undefined || value === '') {
    throw new Error(`Falta la variable de entorno ${name}`)
  }
  return value
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3001),
  corsOrigin: required('CORS_ORIGIN', 'http://localhost:5173'),
  mysql: {
    host: required('MYSQL_HOST', 'localhost'),
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: required('MYSQL_USER', 'root'),
    password: process.env.MYSQL_PASSWORD ?? '',
    database: required('MYSQL_DATABASE', 'taskia'),
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
