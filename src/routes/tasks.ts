import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { pool } from '../db/pool.js'
import { requireAuth, requireStudent } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/error.js'
import {
  AppError,
  formatMysqlDate,
  formatMysqlDateTime,
  localDayUtcRange,
  todayISO,
} from '../utils/helpers.js'

const router = Router()

const TASK_SELECT = `
  SELECT
    t.id, t.user_id, t.course_id, c.name AS course_name,
    t.difficulty_id, d.code AS difficulty_code, d.name AS difficulty_name,
    t.title, t.description, t.task_kind, t.status, t.board_order,
    t.study_passed, t.uses_board, t.study_mode_chosen, t.due_date, t.created_at, t.updated_at
  FROM tasks t
  INNER JOIN courses c ON c.id = t.course_id
  INNER JOIN difficulties d ON d.id = t.difficulty_id
`

function mapTask(r: RowDataPacket) {
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    course_id: Number(r.course_id),
    course_name: r.course_name as string,
    difficulty_id: Number(r.difficulty_id),
    difficulty_code: r.difficulty_code as string,
    difficulty_name: r.difficulty_name as string,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    task_kind: r.task_kind as string,
    status: r.status as string,
    board_order: Number(r.board_order),
    study_passed: Boolean(r.study_passed),
    uses_board: Number(r.uses_board) !== 0,
    study_mode_chosen: Number(r.study_mode_chosen) !== 0,
    due_date: formatMysqlDate(r.due_date as Date | string),
    created_at: formatMysqlDateTime(r.created_at as Date) ?? '',
    updated_at: formatMysqlDateTime(r.updated_at as Date) ?? '',
  }
}

async function fetchTask(taskId: number, userId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${TASK_SELECT} WHERE t.id = ? AND t.user_id = ? LIMIT 1`,
    [taskId, userId],
  )
  if (!rows[0]) throw new AppError('Tarea no encontrada', 404)
  return mapTask(rows[0])
}

function parseStatus(status: string) {
  if (!['pending', 'in_progress', 'studying', 'done'].includes(status)) {
    throw new AppError('Estado no válido')
  }
  return status
}

function parseKind(kind: string) {
  if (kind !== 'daily' && kind !== 'project') throw new AppError('Tipo de tarea no válido')
  return kind
}

function resolveDueDate(kind: string, dueDate?: string | null) {
  if (kind === 'daily') return todayISO()
  if (!dueDate) throw new AppError('Elige hasta cuándo tienes para el proyecto')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new AppError('Fecha inválida en due_date. Usa YYYY-MM-DD')
  }
  return dueDate
}

function ensureCanMarkDone(
  difficultyCode: string,
  studyPassed: boolean,
  currentStatus: string,
  nextStatus: string,
) {
  if (nextStatus !== 'done') return
  if (currentStatus === 'done') return
  if (studyPassed) return
  if (difficultyCode === 'high' || currentStatus === 'studying') {
    throw new AppError(
      difficultyCode === 'high'
        ? 'Esta tarea es de dificultad Alta. Primero estudiala con el tutor hasta que diga que estás listo.'
        : 'Primero estudia con el tutor hasta que diga que estás listo para Terminado.',
    )
  }
}

async function ensureCourse(courseId: number, userId: number, mustBeActive = true) {
  const [rows] = await pool.query<RowDataPacket[]>(
    mustBeActive
      ? 'SELECT id FROM courses WHERE id = ? AND user_id = ? AND is_active = 1 LIMIT 1'
      : 'SELECT id FROM courses WHERE id = ? AND user_id = ? LIMIT 1',
    [courseId, userId],
  )
  if (!rows[0]) throw new AppError('Curso no válido')
}

async function ensureDifficulty(difficultyId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM difficulties WHERE id = ? LIMIT 1',
    [difficultyId],
  )
  if (!rows[0]) throw new AppError('Dificultad no válida')
}

router.use(requireAuth)
router.use(requireStudent)

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const params: unknown[] = [userId]
    let sql = `${TASK_SELECT} WHERE t.user_id = ?`

    const createdOn = req.query.created_on as string | undefined
    const dueOn = req.query.due_on as string | undefined
    const courseId = req.query.course_id ? Number(req.query.course_id) : undefined
    const status = req.query.status as string | undefined

    if (createdOn) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(createdOn)) {
        throw new AppError('Fecha inválida en created_on. Usa YYYY-MM-DD')
      }
      const { start, end } = localDayUtcRange(createdOn)
      sql += ' AND t.created_at >= ? AND t.created_at < ?'
      params.push(start, end)
    }
    if (dueOn) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
        throw new AppError('Fecha inválida en due_on. Usa YYYY-MM-DD')
      }
      sql += ' AND t.due_date = ?'
      params.push(dueOn)
    }
    if (courseId) {
      sql += ' AND t.course_id = ?'
      params.push(courseId)
    }
    if (status) {
      parseStatus(status)
      sql += ' AND t.status = ?'
      params.push(status)
    }
    sql += ' ORDER BY t.status ASC, t.board_order ASC, t.id ASC'

    const [rows] = await pool.query<RowDataPacket[]>(sql, params)
    res.json(rows.map(mapTask))
  }),
)

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const title = String(req.body.title ?? '').trim()
    if (!title) throw new AppError('El título es obligatorio')

    const kind = parseKind(String(req.body.task_kind ?? ''))
    const dueDate = resolveDueDate(kind, req.body.due_date)
    const description =
      typeof req.body.description === 'string' && req.body.description.trim()
        ? req.body.description.trim()
        : null
    const courseId = Number(req.body.course_id)
    const difficultyId = Number(req.body.difficulty_id)
    const usesBoard =
      req.body.uses_board === undefined ? false : Boolean(req.body.uses_board)

    await ensureCourse(courseId, userId)
    await ensureDifficulty(difficultyId)

    const [maxRows] = await pool.query<RowDataPacket[]>(
      `SELECT MAX(board_order) AS m FROM tasks WHERE user_id = ? AND status = 'pending'`,
      [userId],
    )
    const nextOrder = maxRows[0]?.m == null ? 0 : Number(maxRows[0].m) + 1

    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO tasks (
        user_id, course_id, difficulty_id, title, description,
        task_kind, status, board_order, uses_board, due_date
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        userId,
        courseId,
        difficultyId,
        title,
        description,
        kind,
        nextOrder,
        usesBoard ? 1 : 0,
        dueDate,
      ],
    )

    res.json(await fetchTask(result.insertId, userId))
  }),
)

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const taskId = Number(req.params.id)
    const title = String(req.body.title ?? '').trim()
    if (!title) throw new AppError('El título es obligatorio')

    const status = parseStatus(String(req.body.status ?? ''))
    const kind = parseKind(String(req.body.task_kind ?? ''))
    const dueDate = resolveDueDate(kind, req.body.due_date)
    const description =
      typeof req.body.description === 'string' && req.body.description.trim()
        ? req.body.description.trim()
        : null
    const courseId = Number(req.body.course_id)
    const difficultyId = Number(req.body.difficulty_id)
    const usesBoard =
      req.body.uses_board === undefined
        ? undefined
        : Boolean(req.body.uses_board)

    await ensureCourse(courseId, userId, false)
    await ensureDifficulty(difficultyId)

    const current = await fetchTask(taskId, userId)
    let nextDifficultyCode = current.difficulty_code
    if (difficultyId !== current.difficulty_id) {
      const [drows] = await pool.query<RowDataPacket[]>(
        'SELECT code FROM difficulties WHERE id = ? LIMIT 1',
        [difficultyId],
      )
      if (!drows[0]) throw new AppError('Dificultad no válida')
      nextDifficultyCode = drows[0].code as string
    }

    ensureCanMarkDone(nextDifficultyCode, current.study_passed, current.status, status)

    let boardOrder = current.board_order
    if (current.status !== status) {
      const [maxRows] = await pool.query<RowDataPacket[]>(
        `SELECT MAX(board_order) AS m FROM tasks WHERE user_id = ? AND status = ?`,
        [userId, status],
      )
      boardOrder = maxRows[0]?.m == null ? 0 : Number(maxRows[0].m) + 1
    }

    const nextUsesBoard = usesBoard === undefined ? current.uses_board : usesBoard
    const nextModeChosen =
      req.body.study_mode_chosen === undefined
        ? current.study_mode_chosen
        : Boolean(req.body.study_mode_chosen)

    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE tasks SET title = ?, description = ?, course_id = ?, difficulty_id = ?,
        task_kind = ?, due_date = ?, status = ?, board_order = ?, uses_board = ?,
        study_mode_chosen = ?
       WHERE id = ? AND user_id = ?`,
      [
        title,
        description,
        courseId,
        difficultyId,
        kind,
        dueDate,
        status,
        boardOrder,
        nextUsesBoard ? 1 : 0,
        nextModeChosen ? 1 : 0,
        taskId,
        userId,
      ],
    )
    if (result.affectedRows === 0) throw new AppError('Tarea no encontrada', 404)
    res.json(await fetchTask(taskId, userId))
  }),
)

router.post(
  '/move',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const taskId = Number(req.body.task_id)
    const status = parseStatus(String(req.body.status ?? ''))
    const boardOrder = Number(req.body.board_order)
    const current = await fetchTask(taskId, userId)
    ensureCanMarkDone(
      current.difficulty_code,
      current.study_passed,
      current.status,
      status,
    )

    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE tasks SET status = ?, board_order = ? WHERE id = ? AND user_id = ?`,
      [status, boardOrder, taskId, userId],
    )
    if (result.affectedRows === 0) throw new AppError('Tarea no encontrada', 404)
    res.json(await fetchTask(taskId, userId))
  }),
)

router.post(
  '/reorder',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const items = Array.isArray(req.body.items) ? req.body.items : req.body
    if (!Array.isArray(items)) throw new AppError('Lista de tareas inválida')

    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      for (const item of items) {
        const taskId = Number(item.task_id)
        const status = parseStatus(String(item.status ?? ''))
        const boardOrder = Number(item.board_order)
        const [rows] = await conn.query<RowDataPacket[]>(
          `${TASK_SELECT} WHERE t.id = ? AND t.user_id = ? LIMIT 1`,
          [taskId, userId],
        )
        if (!rows[0]) throw new AppError(`Tarea ${taskId} no encontrada`, 404)
        const current = mapTask(rows[0])
        ensureCanMarkDone(
          current.difficulty_code,
          current.study_passed,
          current.status,
          status,
        )
        await conn.query(
          `UPDATE tasks SET status = ?, board_order = ? WHERE id = ? AND user_id = ?`,
          [status, boardOrder, taskId, userId],
        )
      }
      await conn.commit()
      res.json({ ok: true })
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  }),
)

export { fetchTask, mapTask, TASK_SELECT }
export default router
