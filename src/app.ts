import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { env } from './config/env.js'
import { errorHandler } from './middleware/error.js'
import authRoutes from './routes/auth.js'
import coursesRoutes from './routes/courses.js'
import difficultiesRoutes from './routes/difficulties.js'
import tasksRoutes from './routes/tasks.js'
import studyRoutes from './routes/study.js'
import worldsRoutes from './routes/worlds.js'

export function createApp() {
  const app = express()
  app.use(helmet({ crossOriginResourcePolicy: false }))
  app.use(
    cors({
      origin: env.corsOrigin,
      credentials: true,
    }),
  )
  app.use(express.json({ limit: '8mb' }))
  app.use(cookieParser())

  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.use('/auth', authRoutes)
  app.use('/courses', coursesRoutes)
  app.use('/difficulties', difficultiesRoutes)
  app.use('/tasks', tasksRoutes)
  app.use('/study', studyRoutes)
  app.use('/worlds', worldsRoutes)

  app.use(errorHandler)
  return app
}
