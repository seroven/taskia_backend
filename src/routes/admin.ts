import { Router } from 'express'
import bcrypt from 'bcryptjs'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { pool } from '../db/pool.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/error.js'
import {
  AppError,
  formatMysqlDate,
  formatMysqlDateTime,
  todayISO,
} from '../utils/helpers.js'
import { getChallengeDetail } from './worlds.js'

const router = Router()

router.use(requireAuth)
router.use(requireAdmin)

function validateStudentInput(username: string, password?: string, email?: string) {
  const u = username.trim()
  if (u.length < 3) throw new AppError('El usuario debe tener al menos 3 caracteres')
  if (password !== undefined && password.length < 6) {
    throw new AppError('La contraseña debe tener al menos 6 caracteres')
  }
  if (email !== undefined) {
    const e = email.trim()
    if (!e.includes('@') || e.length < 5) throw new AppError('Correo inválido')
  }
}

function mapStudent(r: RowDataPacket) {
  return {
    id: Number(r.id),
    username: r.username as string,
    email: r.email as string,
    is_active: Number(r.is_active) !== 0,
    created_at: formatMysqlDateTime(r.created_at as Date | string) ?? '',
    course_count: r.course_count == null ? undefined : Number(r.course_count),
  }
}

function mapCourse(r: RowDataPacket) {
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    name: r.name as string,
    is_active: Number(r.is_active) !== 0,
    created_at: formatMysqlDateTime(r.created_at as Date | string) ?? '',
  }
}

async function requireStudent(studentId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, username, email, is_active, created_at
     FROM users WHERE id = ? AND role = 'user' LIMIT 1`,
    [studentId],
  )
  if (!rows[0]) throw new AppError('Alumno no encontrado', 404)
  return mapStudent(rows[0])
}

async function requireStudentCourse(studentId: number, courseId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, user_id, name, is_active, created_at
     FROM courses WHERE id = ? AND user_id = ? LIMIT 1`,
    [courseId, studentId],
  )
  if (!rows[0]) throw new AppError('Materia no encontrada', 404)
  return mapCourse(rows[0])
}

function parseIsoDate(value: unknown): string | null {
  const s = String(value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function parseStudentId(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function andDate(
  sqlCol: string,
  from: string | null,
  to: string | null,
  params: unknown[],
) {
  let sql = ''
  if (from) {
    sql += ` AND DATE(${sqlCol}) >= ?`
    params.push(from)
  }
  if (to) {
    sql += ` AND DATE(${sqlCol}) <= ?`
    params.push(to)
  }
  return sql
}

function andStudent(sqlCol: string, studentId: number | null, params: unknown[]) {
  if (studentId == null) return ''
  params.push(studentId)
  return ` AND ${sqlCol} = ?`
}

function addDaysISO(iso: string, days: number) {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d + days)
  const yy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function seriesRange(from: string | null, to: string | null, today: string) {
  let end = to ?? today
  let start = from ?? addDaysISO(end, -29)
  if (start > end) {
    const swap = start
    start = end
    end = swap
  }
  const startDate = new Date(`${start}T12:00:00`)
  const endDate = new Date(`${end}T12:00:00`)
  const span = Math.round((endDate.getTime() - startDate.getTime()) / 86400000)
  if (span > 89) start = addDaysISO(end, -89)
  const days: string[] = []
  let cursor = start
  while (cursor <= end) {
    days.push(cursor)
    cursor = addDaysISO(cursor, 1)
  }
  return { start, end, days }
}

function dayKey(value: unknown) {
  if (value instanceof Date) return formatMysqlDate(value)
  return String(value ?? '').slice(0, 10)
}

function countByDay(rows: RowDataPacket[]) {
  const map = new Map<string, number>()
  for (const row of rows) {
    const key = dayKey(row.day)
    if (!key) continue
    map.set(key, Number(row.c ?? 0))
  }
  return map
}

function countByUser(rows: RowDataPacket[]) {
  const map = new Map<number, number>()
  for (const row of rows) {
    const id = Number(row.user_id)
    if (!id) continue
    map.set(id, Number(row.c ?? 0))
  }
  return map
}

const FLASH_IN_USD = 0.1
const FLASH_OUT_USD = 0.4

function usdFromTokens(prompt: number, output: number) {
  return (
    Math.round(((prompt * FLASH_IN_USD + output * FLASH_OUT_USD) / 1_000_000) * 10_000) /
    10_000
  )
}

function addNum(map: Map<string, number>, key: string, n: number) {
  if (!key) return
  map.set(key, (map.get(key) ?? 0) + n)
}

function mapTaskRow(r: RowDataPacket) {
  return {
    id: Number(r.id),
    title: r.title as string,
    status: r.status as string,
    due_date: formatMysqlDate(r.due_date as Date | string),
    study_passed: Number(r.study_passed) !== 0,
    course_id: Number(r.course_id),
    course_name: r.course_name as string,
    created_at: formatMysqlDateTime(r.created_at as Date | string) ?? '',
    updated_at: formatMysqlDateTime(r.updated_at as Date | string) ?? '',
  }
}

function inDateRange(value: string | null, from: string | null, to: string | null) {
  if (!from && !to) return true
  if (!value) return false
  const day = value.slice(0, 10)
  if (from && day < from) return false
  if (to && day > to) return false
  return true
}

function mapChallengeRow(r: RowDataPacket) {
  return {
    id: Number(r.id),
    scope: r.scope as string,
    difficulty: r.difficulty as string,
    status: r.status as string,
    score: r.score == null ? null : Number(r.score),
    question_count: Number(r.question_count),
    world_id: r.world_id == null ? undefined : Number(r.world_id),
    course_id: r.course_id == null ? null : Number(r.course_id),
    mission_id: r.mission_id == null ? null : Number(r.mission_id),
    world_title: r.world_title as string,
    course_name: (r.course_name as string | null) ?? null,
    mission_title: (r.mission_title as string | null) ?? null,
    started_at: formatMysqlDateTime(r.started_at as Date | string) ?? '',
    completed_at: formatMysqlDateTime(r.completed_at as Date | string) ?? null,
  }
}

async function listStudentCourses(studentId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, user_id, name, is_active, created_at
     FROM courses WHERE user_id = ?
     ORDER BY is_active DESC, name ASC`,
    [studentId],
  )
  return rows.map(mapCourse)
}

router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const from = parseIsoDate(req.query.from)
    const to = parseIsoDate(req.query.to)
    const studentId = parseStudentId(req.query.student_id)
    if (studentId != null) await requireStudent(studentId)
    const today = todayISO()

    const studentParams: unknown[] = []
    const studentSql = andStudent('id', studentId, studentParams)
    const [studentRows] = await pool.query<RowDataPacket[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(is_active = 1) AS active,
         SUM(is_active = 0) AS paused
       FROM users WHERE role = 'user'${studentSql}`,
      studentParams,
    )
    const studentStats = studentRows[0]

    const taskParams: unknown[] = [today]
    const taskPeriodSql = andDate('created_at', from, to, taskParams)
    const taskStudentSql = andStudent('t.user_id', studentId, taskParams)
    const [taskRows] = await pool.query<RowDataPacket[]>(
      `SELECT
         SUM(status = 'pending') AS pending,
         SUM(status = 'in_progress') AS in_progress,
         SUM(status = 'studying') AS studying,
         SUM(status = 'done') AS done,
         SUM(status <> 'done' AND due_date < ?) AS overdue,
         COUNT(*) AS total
       FROM tasks t
       INNER JOIN users u ON u.id = t.user_id AND u.role = 'user'
       WHERE 1=1${taskPeriodSql}${taskStudentSql}`,
      taskParams,
    )
    const taskStats = taskRows[0]

    const worldParams: unknown[] = []
    const worldSql = andStudent('w.user_id', studentId, worldParams)
    const [worldRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c
       FROM study_worlds w
       INNER JOIN users u ON u.id = w.user_id AND u.role = 'user'
       WHERE 1=1${worldSql}`,
      worldParams,
    )

    const missionParams: unknown[] = []
    const missionSql = andStudent('w.user_id', studentId, missionParams)
    const [missionRows] = await pool.query<RowDataPacket[]>(
      `SELECT
         SUM(m.status = 'pending') AS pending,
         SUM(m.status = 'studying') AS studying,
         SUM(m.status = 'mastered') AS mastered,
         COUNT(*) AS total
       FROM study_missions m
       INNER JOIN study_worlds w ON w.id = m.world_id
       INNER JOIN users u ON u.id = w.user_id AND u.role = 'user'
       WHERE 1=1${missionSql}`,
      missionParams,
    )
    const missionStats = missionRows[0]

    const challengeParams: unknown[] = []
    const challengePeriodSql = andDate('ch.completed_at', from, to, challengeParams)
    const challengeStudentSql = andStudent('ch.user_id', studentId, challengeParams)
    const [challengeRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS completed_count, AVG(ch.score) AS avg_score
       FROM study_challenges ch
       INNER JOIN users u ON u.id = ch.user_id AND u.role = 'user'
       WHERE ch.status = 'completed'${challengePeriodSql}${challengeStudentSql}`,
      challengeParams,
    )
    const challengeStats = challengeRows[0]

    const rosterParams: unknown[] = [today]
    const rosterSql = andStudent('u.id', studentId, rosterParams)
    const [roster] = await pool.query<RowDataPacket[]>(
      `SELECT u.id, u.username, u.email, u.is_active, u.created_at,
              (SELECT COUNT(*) FROM courses c WHERE c.user_id = u.id AND c.is_active = 1) AS course_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id) AS tasks_total,
              (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id AND t.status = 'done') AS tasks_done,
              (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id AND t.status <> 'done' AND t.due_date < ?) AS tasks_overdue,
              (SELECT COUNT(*) FROM study_challenges ch WHERE ch.user_id = u.id AND ch.status = 'completed') AS challenges_completed,
              (SELECT AVG(ch.score) FROM study_challenges ch WHERE ch.user_id = u.id AND ch.status = 'completed') AS avg_score,
              (SELECT MAX(ts) FROM (
                 SELECT ss.updated_at AS ts FROM study_sessions ss
                 INNER JOIN tasks t ON t.id = ss.task_id WHERE t.user_id = u.id
                 UNION ALL
                 SELECT ms.updated_at FROM study_mission_sessions ms
                 INNER JOIN study_missions m ON m.id = ms.mission_id
                 INNER JOIN study_worlds w ON w.id = m.world_id WHERE w.user_id = u.id
               ) act) AS last_study_at
       FROM users u
       WHERE u.role = 'user'${rosterSql}
       ORDER BY u.username ASC`,
      rosterParams,
    )

    const series = seriesRange(from, to, today)

    const taskDayParams: unknown[] = []
    const taskDaySql = andDate(
      't.created_at',
      series.start,
      series.end,
      taskDayParams,
    )
    const taskDayStudentSql = andStudent('t.user_id', studentId, taskDayParams)
    const [taskDays] = await pool.query<RowDataPacket[]>(
      `SELECT DATE(t.created_at) AS day, COUNT(*) AS c
       FROM tasks t
       INNER JOIN users u ON u.id = t.user_id AND u.role = 'user'
       WHERE 1=1${taskDaySql}${taskDayStudentSql}
       GROUP BY DATE(t.created_at)`,
      taskDayParams,
    )

    const challengeDayParams: unknown[] = []
    const challengeDaySql = andDate(
      'ch.completed_at',
      series.start,
      series.end,
      challengeDayParams,
    )
    const challengeDayStudentSql = andStudent(
      'ch.user_id',
      studentId,
      challengeDayParams,
    )
    const [challengeDays] = await pool.query<RowDataPacket[]>(
      `SELECT DATE(ch.completed_at) AS day, COUNT(*) AS c
       FROM study_challenges ch
       INNER JOIN users u ON u.id = ch.user_id AND u.role = 'user'
       WHERE ch.status = 'completed'${challengeDaySql}${challengeDayStudentSql}
       GROUP BY DATE(ch.completed_at)`,
      challengeDayParams,
    )

    const studyTaskParams: unknown[] = []
    const studyTaskFilter = andDate(
      'ss.updated_at',
      series.start,
      series.end,
      studyTaskParams,
    )
    const studyTaskStudentSql = andStudent('t.user_id', studentId, studyTaskParams)
    const [studyTaskDays] = await pool.query<RowDataPacket[]>(
      `SELECT DATE(ss.updated_at) AS day, COUNT(*) AS c
       FROM study_sessions ss
       INNER JOIN tasks t ON t.id = ss.task_id
       INNER JOIN users u ON u.id = t.user_id AND u.role = 'user'
       WHERE 1=1${studyTaskFilter}${studyTaskStudentSql}
       GROUP BY DATE(ss.updated_at)`,
      studyTaskParams,
    )

    const studyMissionParams: unknown[] = []
    const studyMissionFilter = andDate(
      'ms.updated_at',
      series.start,
      series.end,
      studyMissionParams,
    )
    const studyMissionStudentSql = andStudent(
      'w.user_id',
      studentId,
      studyMissionParams,
    )
    const [studyMissionDays] = await pool.query<RowDataPacket[]>(
      `SELECT DATE(ms.updated_at) AS day, COUNT(*) AS c
       FROM study_mission_sessions ms
       INNER JOIN study_missions m ON m.id = ms.mission_id
       INNER JOIN study_worlds w ON w.id = m.world_id
       INNER JOIN users u ON u.id = w.user_id AND u.role = 'user'
       WHERE 1=1${studyMissionFilter}${studyMissionStudentSql}
       GROUP BY DATE(ms.updated_at)`,
      studyMissionParams,
    )

    const tasksByDay = countByDay(taskDays)
    const challengesByDay = countByDay(challengeDays)
    const studyByDay = countByDay(studyTaskDays)
    for (const [key, value] of countByDay(studyMissionDays)) {
      studyByDay.set(key, (studyByDay.get(key) ?? 0) + value)
    }

    const studyUserTaskParams: unknown[] = []
    const studyUserTaskSql = andDate(
      'ss.updated_at',
      series.start,
      series.end,
      studyUserTaskParams,
    )
    const studyUserTaskStudentSql = andStudent(
      't.user_id',
      studentId,
      studyUserTaskParams,
    )
    const [studyUserTaskRows] = await pool.query<RowDataPacket[]>(
      `SELECT t.user_id AS user_id, COUNT(*) AS c
       FROM study_sessions ss
       INNER JOIN tasks t ON t.id = ss.task_id
       INNER JOIN users u ON u.id = t.user_id AND u.role = 'user'
       WHERE 1=1${studyUserTaskSql}${studyUserTaskStudentSql}
       GROUP BY t.user_id`,
      studyUserTaskParams,
    )

    const studyUserMissionParams: unknown[] = []
    const studyUserMissionSql = andDate(
      'ms.updated_at',
      series.start,
      series.end,
      studyUserMissionParams,
    )
    const studyUserMissionStudentSql = andStudent(
      'w.user_id',
      studentId,
      studyUserMissionParams,
    )
    const [studyUserMissionRows] = await pool.query<RowDataPacket[]>(
      `SELECT w.user_id AS user_id, COUNT(*) AS c
       FROM study_mission_sessions ms
       INNER JOIN study_missions m ON m.id = ms.mission_id
       INNER JOIN study_worlds w ON w.id = m.world_id
       INNER JOIN users u ON u.id = w.user_id AND u.role = 'user'
       WHERE 1=1${studyUserMissionSql}${studyUserMissionStudentSql}
       GROUP BY w.user_id`,
      studyUserMissionParams,
    )

    const tasksDoneUserParams: unknown[] = []
    const tasksDoneUserSql = andDate(
      't.updated_at',
      series.start,
      series.end,
      tasksDoneUserParams,
    )
    const tasksDoneUserStudentSql = andStudent(
      't.user_id',
      studentId,
      tasksDoneUserParams,
    )
    const [tasksDoneUserRows] = await pool.query<RowDataPacket[]>(
      `SELECT t.user_id AS user_id, COUNT(*) AS c
       FROM tasks t
       INNER JOIN users u ON u.id = t.user_id AND u.role = 'user'
       WHERE t.status = 'done'${tasksDoneUserSql}${tasksDoneUserStudentSql}
       GROUP BY t.user_id`,
      tasksDoneUserParams,
    )

    const challengeUserParams: unknown[] = []
    const challengeUserSql = andDate(
      'ch.completed_at',
      series.start,
      series.end,
      challengeUserParams,
    )
    const challengeUserStudentSql = andStudent(
      'ch.user_id',
      studentId,
      challengeUserParams,
    )
    const [challengeUserRows] = await pool.query<RowDataPacket[]>(
      `SELECT ch.user_id AS user_id, COUNT(*) AS c, AVG(ch.score) AS avg_score
       FROM study_challenges ch
       INNER JOIN users u ON u.id = ch.user_id AND u.role = 'user'
       WHERE ch.status = 'completed'${challengeUserSql}${challengeUserStudentSql}
       GROUP BY ch.user_id`,
      challengeUserParams,
    )

    const studyByUser = countByUser(studyUserTaskRows)
    for (const [id, value] of countByUser(studyUserMissionRows)) {
      studyByUser.set(id, (studyByUser.get(id) ?? 0) + value)
    }
    const tasksDoneByUser = countByUser(tasksDoneUserRows)
    const challengesByUser = countByUser(challengeUserRows)
    const scoreByUser = new Map<number, number>()
    for (const row of challengeUserRows) {
      if (row.avg_score == null) continue
      scoreByUser.set(Number(row.user_id), Math.round(Number(row.avg_score)))
    }

    const byStudent = roster.map((r) => {
      const id = Number(r.id)
      return {
        id,
        username: r.username as string,
        study: studyByUser.get(id) ?? 0,
        tasks_done: tasksDoneByUser.get(id) ?? 0,
        challenges: challengesByUser.get(id) ?? 0,
        avg_score: scoreByUser.get(id) ?? null,
      }
    })

    const usageDate = (col: string, params: unknown[]) =>
      andDate(col, series.start, series.end, params)

    const taskAssistParams: unknown[] = []
    const taskAssistSql = `${usageDate('sm.created_at', taskAssistParams)}${andStudent('t.user_id', studentId, taskAssistParams)}`
    const [taskAssistRows] = await pool.query<RowDataPacket[]>(
      `SELECT t.user_id AS user_id, DATE(sm.created_at) AS day, sm.role AS role,
              COUNT(*) AS c, SUM(CHAR_LENGTH(sm.content)) AS chars
       FROM study_messages sm
       INNER JOIN tasks t ON t.id = sm.task_id
       INNER JOIN users u ON u.id = t.user_id AND u.role = 'user'
       WHERE 1=1${taskAssistSql}
       GROUP BY t.user_id, DATE(sm.created_at), sm.role`,
      taskAssistParams,
    )

    const missionMsgParams: unknown[] = []
    const missionMsgSql = `${usageDate('mm.created_at', missionMsgParams)}${andStudent('w.user_id', studentId, missionMsgParams)}`
    const [missionMsgRows] = await pool.query<RowDataPacket[]>(
      `SELECT w.user_id AS user_id, DATE(mm.created_at) AS day, mm.role AS role,
              COUNT(*) AS c, SUM(CHAR_LENGTH(mm.content)) AS chars
       FROM study_mission_messages mm
       INNER JOIN study_missions m ON m.id = mm.mission_id
       INNER JOIN study_worlds w ON w.id = m.world_id
       INNER JOIN users u ON u.id = w.user_id AND u.role = 'user'
       WHERE 1=1${missionMsgSql}
       GROUP BY w.user_id, DATE(mm.created_at), mm.role`,
      missionMsgParams,
    )

    const chStartParams: unknown[] = []
    const chStartSql = `${usageDate('ch.started_at', chStartParams)}${andStudent('ch.user_id', studentId, chStartParams)}`
    const [chStartRows] = await pool.query<RowDataPacket[]>(
      `SELECT ch.user_id AS user_id, DATE(ch.started_at) AS day,
              COUNT(*) AS c, SUM(ch.question_count) AS q
       FROM study_challenges ch
       INNER JOIN users u ON u.id = ch.user_id AND u.role = 'user'
       WHERE 1=1${chStartSql}
       GROUP BY ch.user_id, DATE(ch.started_at)`,
      chStartParams,
    )

    const chDoneParams: unknown[] = []
    const chDoneSql = `${usageDate('ch.completed_at', chDoneParams)}${andStudent('ch.user_id', studentId, chDoneParams)}`
    const [chDoneRows] = await pool.query<RowDataPacket[]>(
      `SELECT ch.user_id AS user_id, DATE(ch.completed_at) AS day,
              COUNT(*) AS c, SUM(ch.question_count) AS q
       FROM study_challenges ch
       INNER JOIN users u ON u.id = ch.user_id AND u.role = 'user'
       WHERE ch.status = 'completed'${chDoneSql}
       GROUP BY ch.user_id, DATE(ch.completed_at)`,
      chDoneParams,
    )

    let realUsageRows: RowDataPacket[] = []
    try {
      const realParams: unknown[] = []
      const realSql = `${usageDate('lu.created_at', realParams)}${andStudent('lu.user_id', studentId, realParams)}`
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT lu.user_id AS user_id, DATE(lu.created_at) AS day, lu.kind AS kind,
                COUNT(*) AS c,
                SUM(lu.prompt_tokens) AS prompt,
                SUM(lu.output_tokens) AS output,
                SUM(lu.total_tokens) AS tokens
         FROM llm_usage lu
         INNER JOIN users u ON u.id = lu.user_id AND u.role = 'user'
         WHERE 1=1${realSql}
         GROUP BY lu.user_id, DATE(lu.created_at), lu.kind`,
        realParams,
      )
      realUsageRows = rows
    } catch {
      realUsageRows = []
    }

    let voiceMsgRows: RowDataPacket[] = []
    try {
      const taskVoiceParams: unknown[] = []
      const taskVoiceSql = `${usageDate('sm.created_at', taskVoiceParams)}${andStudent('t.user_id', studentId, taskVoiceParams)}`
      const [taskVoice] = await pool.query<RowDataPacket[]>(
        `SELECT t.user_id AS user_id, DATE(sm.created_at) AS day,
                COUNT(*) AS c, SUM(CHAR_LENGTH(sm.content)) AS chars
         FROM study_messages sm
         INNER JOIN tasks t ON t.id = sm.task_id
         INNER JOIN users u ON u.id = t.user_id AND u.role = 'user'
         WHERE sm.role = 'user' AND sm.from_voice = 1${taskVoiceSql}
         GROUP BY t.user_id, DATE(sm.created_at)`,
        taskVoiceParams,
      )
      const missionVoiceParams: unknown[] = []
      const missionVoiceSql = `${usageDate('mm.created_at', missionVoiceParams)}${andStudent('w.user_id', studentId, missionVoiceParams)}`
      const [missionVoice] = await pool.query<RowDataPacket[]>(
        `SELECT w.user_id AS user_id, DATE(mm.created_at) AS day,
                COUNT(*) AS c, SUM(CHAR_LENGTH(mm.content)) AS chars
         FROM study_mission_messages mm
         INNER JOIN study_missions m ON m.id = mm.mission_id
         INNER JOIN study_worlds w ON w.id = m.world_id
         INNER JOIN users u ON u.id = w.user_id AND u.role = 'user'
         WHERE mm.role = 'user' AND mm.from_voice = 1${missionVoiceSql}
         GROUP BY w.user_id, DATE(mm.created_at)`,
        missionVoiceParams,
      )
      voiceMsgRows = [...taskVoice, ...missionVoice]
    } catch {
      voiceMsgRows = []
    }

    const tutorByDay = new Map<string, number>()
    const challengeByDay = new Map<string, number>()
    const voiceByDay = new Map<string, number>()
    const childByDay = new Map<string, number>()
    const tokensByDay = new Map<string, number>()
    type UserUse = {
      tutor: number
      challenges: number
      created: number
      voice: number
      child: number
      prompt: number
      output: number
      tutorPrompt: number
      tutorOutput: number
      challengesPrompt: number
      challengesOutput: number
      voicePrompt: number
      voiceOutput: number
    }
    const emptyUse = (): UserUse => ({
      tutor: 0,
      challenges: 0,
      created: 0,
      voice: 0,
      child: 0,
      prompt: 0,
      output: 0,
      tutorPrompt: 0,
      tutorOutput: 0,
      challengesPrompt: 0,
      challengesOutput: 0,
      voicePrompt: 0,
      voiceOutput: 0,
    })
    const userUse = new Map<number, UserUse>()
    const bumpUser = (id: number, patch: Partial<UserUse>) => {
      const cur = userUse.get(id) ?? emptyUse()
      const prompt = patch.prompt ?? 0
      const output = patch.output ?? 0
      const next: UserUse = {
        tutor: cur.tutor + (patch.tutor ?? 0),
        challenges: cur.challenges + (patch.challenges ?? 0),
        created: cur.created + (patch.created ?? 0),
        voice: cur.voice + (patch.voice ?? 0),
        child: cur.child + (patch.child ?? 0),
        prompt: cur.prompt + prompt,
        output: cur.output + output,
        tutorPrompt: cur.tutorPrompt,
        tutorOutput: cur.tutorOutput,
        challengesPrompt: cur.challengesPrompt,
        challengesOutput: cur.challengesOutput,
        voicePrompt: cur.voicePrompt,
        voiceOutput: cur.voiceOutput,
      }
      if ((patch.tutor ?? 0) > 0) {
        next.tutorPrompt += prompt
        next.tutorOutput += output
      } else if ((patch.challenges ?? 0) > 0) {
        next.challengesPrompt += prompt
        next.challengesOutput += output
      } else if ((patch.voice ?? 0) > 0) {
        next.voicePrompt += prompt
        next.voiceOutput += output
      }
      userUse.set(id, next)
    }

    const measured = realUsageRows.length > 0

    for (const row of [...taskAssistRows, ...missionMsgRows]) {
      const id = Number(row.user_id)
      const day = dayKey(row.day)
      const count = Number(row.c ?? 0)
      const chars = Number(row.chars ?? 0)
      if (row.role === 'assistant') {
        if (measured) continue
        addNum(tutorByDay, day, count)
        const output = Math.max(80, Math.ceil(chars / 4))
        bumpUser(id, {
          tutor: count,
          prompt: 1800 * count,
          output,
        })
        addNum(tokensByDay, day, 1800 * count + output)
      } else {
        addNum(childByDay, day, count)
        bumpUser(id, { child: count })
      }
    }

    if (!measured) {
      for (const row of chStartRows) {
        const id = Number(row.user_id)
        const day = dayKey(row.day)
        const count = Number(row.c ?? 0)
        const questions = Number(row.q ?? 0)
        addNum(challengeByDay, day, count)
        const output = 400 + questions * 100
        bumpUser(id, {
          challenges: count,
          prompt: 3000 * count,
          output,
        })
        addNum(tokensByDay, day, 3000 * count + output)
      }

      for (const row of chDoneRows) {
        const id = Number(row.user_id)
        const day = dayKey(row.day)
        const count = Number(row.c ?? 0)
        addNum(challengeByDay, day, count)
        bumpUser(id, {
          challenges: count,
          prompt: 1800 * count,
          output: 250 * count,
        })
        addNum(tokensByDay, day, 2050 * count)
      }
    }

    const hasTranscribeLog = realUsageRows.some(
      (row) => String(row.kind ?? '') === 'transcribe',
    )
    if (measured) {
      for (const row of realUsageRows) {
        const id = Number(row.user_id)
        const day = dayKey(row.day)
        const count = Number(row.c ?? 0)
        const prompt = Number(row.prompt ?? 0)
        const output = Number(row.output ?? 0)
        const tokens = Number(row.tokens ?? prompt + output)
        const kind = String(row.kind ?? '')
        addNum(tokensByDay, day, tokens)
        if (kind === 'transcribe') {
          addNum(voiceByDay, day, count)
          bumpUser(id, { voice: count, prompt, output })
        } else if (kind === 'challenge_generate' || kind === 'challenge_grade') {
          addNum(challengeByDay, day, count)
          bumpUser(id, { challenges: count, prompt, output })
        } else {
          addNum(tutorByDay, day, count)
          bumpUser(id, { tutor: count, prompt, output })
        }
      }
    }

    if (!hasTranscribeLog) {
      for (const row of voiceMsgRows) {
        const id = Number(row.user_id)
        const day = dayKey(row.day)
        const count = Number(row.c ?? 0)
        const chars = Number(row.chars ?? 0)
        const output = Math.max(20, Math.ceil(chars / 4))
        const prompt = 2000 * count
        addNum(voiceByDay, day, count)
        bumpUser(id, { voice: count, prompt, output })
        addNum(tokensByDay, day, prompt + output)
      }
    }

    for (const row of chStartRows) {
      bumpUser(Number(row.user_id), { created: Number(row.c ?? 0) })
    }

    const names = new Map(
      roster.map((r) => [Number(r.id), r.username as string]),
    )
    const usageByStudent = [...userUse.entries()]
      .map(([id, row]) => ({
        id,
        username: names.get(id) ?? `#${id}`,
        tutor: row.tutor,
        challenges: row.challenges,
        challenges_created: row.created,
        voice: row.voice,
        child_messages: row.child,
        calls: row.tutor + row.challenges + row.voice,
        tokens: row.prompt + row.output,
        estimated_usd: usdFromTokens(row.prompt, row.output),
        usd_tutor: usdFromTokens(row.tutorPrompt, row.tutorOutput),
        usd_challenges: usdFromTokens(row.challengesPrompt, row.challengesOutput),
        usd_voice: usdFromTokens(row.voicePrompt, row.voiceOutput),
      }))
      .filter(
        (row) =>
          row.calls > 0 ||
          row.child_messages > 0 ||
          row.challenges_created > 0,
      )
      .sort((a, b) => b.estimated_usd - a.estimated_usd || b.calls - a.calls)

    const usageDays = series.days.map((date) => ({
      date,
      tutor: tutorByDay.get(date) ?? 0,
      challenges: challengeByDay.get(date) ?? 0,
      voice: voiceByDay.get(date) ?? 0,
      child_messages: childByDay.get(date) ?? 0,
      tokens: tokensByDay.get(date) ?? 0,
    }))

    const usageTotals = usageByStudent.reduce(
      (acc, row) => ({
        calls: acc.calls + row.calls,
        tokens: acc.tokens + row.tokens,
        estimated_usd: acc.estimated_usd + row.estimated_usd,
        child_messages: acc.child_messages + row.child_messages,
      }),
      { calls: 0, tokens: 0, estimated_usd: 0, child_messages: 0 },
    )
    usageTotals.estimated_usd =
      Math.round(usageTotals.estimated_usd * 10_000) / 10_000

    const usage = {
      from: series.start,
      to: series.end,
      measured,
      totals: usageTotals,
      days: usageDays,
      by_student: usageByStudent,
      by_kind: (() => {
        const totals = {
          tutor: { calls: 0, prompt: 0, output: 0 },
          challenges: { calls: 0, prompt: 0, output: 0 },
          voice: { calls: 0, prompt: 0, output: 0 },
        }
        for (const row of userUse.values()) {
          totals.tutor.calls += row.tutor
          totals.tutor.prompt += row.tutorPrompt
          totals.tutor.output += row.tutorOutput
          totals.challenges.calls += row.challenges
          totals.challenges.prompt += row.challengesPrompt
          totals.challenges.output += row.challengesOutput
          totals.voice.calls += row.voice
          totals.voice.prompt += row.voicePrompt
          totals.voice.output += row.voiceOutput
        }
        return [
          {
            kind: 'tutor',
            label: 'Mensajes',
            calls: totals.tutor.calls,
            tokens: totals.tutor.prompt + totals.tutor.output,
            estimated_usd: usdFromTokens(totals.tutor.prompt, totals.tutor.output),
          },
          {
            kind: 'challenges',
            label: 'Desafíos',
            calls: totals.challenges.calls,
            tokens: totals.challenges.prompt + totals.challenges.output,
            estimated_usd: usdFromTokens(
              totals.challenges.prompt,
              totals.challenges.output,
            ),
          },
          {
            kind: 'voice',
            label: 'Transcripciones',
            calls: totals.voice.calls,
            tokens: totals.voice.prompt + totals.voice.output,
            estimated_usd: usdFromTokens(totals.voice.prompt, totals.voice.output),
          },
        ]
      })(),
    }

    res.json({
      period: { from, to, student_id: studentId },
      students: {
        total: Number(studentStats?.total ?? 0),
        active: Number(studentStats?.active ?? 0),
        paused: Number(studentStats?.paused ?? 0),
      },
      tasks: {
        total: Number(taskStats?.total ?? 0),
        pending: Number(taskStats?.pending ?? 0),
        in_progress: Number(taskStats?.in_progress ?? 0),
        studying: Number(taskStats?.studying ?? 0),
        done: Number(taskStats?.done ?? 0),
        overdue: Number(taskStats?.overdue ?? 0),
      },
      worlds: { count: Number(worldRows[0]?.c ?? 0) },
      missions: {
        total: Number(missionStats?.total ?? 0),
        pending: Number(missionStats?.pending ?? 0),
        studying: Number(missionStats?.studying ?? 0),
        mastered: Number(missionStats?.mastered ?? 0),
      },
      challenges: {
        completed_count: Number(challengeStats?.completed_count ?? 0),
        avg_score:
          challengeStats?.avg_score == null
            ? null
            : Math.round(Number(challengeStats.avg_score)),
      },
      roster: roster.map((r) => ({
        id: Number(r.id),
        username: r.username as string,
        email: r.email as string,
        is_active: Number(r.is_active) !== 0,
        created_at: formatMysqlDateTime(r.created_at as Date | string) ?? '',
        course_count: Number(r.course_count ?? 0),
        tasks_total: Number(r.tasks_total ?? 0),
        tasks_done: Number(r.tasks_done ?? 0),
        tasks_overdue: Number(r.tasks_overdue ?? 0),
        challenges_completed: Number(r.challenges_completed ?? 0),
        avg_score: r.avg_score == null ? null : Math.round(Number(r.avg_score)),
        last_study_at: formatMysqlDateTime(
          (r.last_study_at as Date | string | null) ?? null,
        ),
      })),
      series: {
        from: series.start,
        to: series.end,
        days: series.days.map((date) => ({
          date,
          tasks: tasksByDay.get(date) ?? 0,
          study: studyByDay.get(date) ?? 0,
          challenges: challengesByDay.get(date) ?? 0,
        })),
      },
      by_student: byStudent,
      usage,
    })
  }),
)

router.get(
  '/students',
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT u.id, u.username, u.email, u.is_active, u.created_at,
              COUNT(c.id) AS course_count
       FROM users u
       LEFT JOIN courses c ON c.user_id = u.id AND c.is_active = 1
       WHERE u.role = 'user'
       GROUP BY u.id, u.username, u.email, u.is_active, u.created_at
       ORDER BY u.username ASC`,
    )
    res.json(rows.map(mapStudent))
  }),
)

router.post(
  '/students',
  asyncHandler(async (req, res) => {
    const username = String(req.body.username ?? '')
    const email = String(req.body.email ?? '')
    const password = String(req.body.password ?? '')
    validateStudentInput(username, password, email)

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
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES (?, ?, ?, 'user', 1)`,
      [u, e, passwordHash],
    )
    res.json(await requireStudent(result.insertId))
  }),
)

router.patch(
  '/students/:studentId',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    const current = await requireStudent(studentId)

    const username =
      req.body.username === undefined
        ? current.username
        : String(req.body.username)
    const email =
      req.body.email === undefined ? current.email : String(req.body.email)
    const password =
      req.body.password === undefined || req.body.password === ''
        ? undefined
        : String(req.body.password)
    const isActive =
      req.body.is_active === undefined
        ? current.is_active
        : Boolean(req.body.is_active)

    validateStudentInput(username, password, email)

    const u = username.trim()
    const e = email.trim().toLowerCase()

    const [existingUser] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE username = ? AND id <> ? LIMIT 1',
      [u, studentId],
    )
    if (existingUser.length > 0) throw new AppError('Ese nombre de usuario ya existe')

    const [existingEmail] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1',
      [e, studentId],
    )
    if (existingEmail.length > 0) throw new AppError('Ese correo ya está registrado')

    if (password) {
      const passwordHash = await bcrypt.hash(password, 10)
      await pool.query(
        `UPDATE users SET username = ?, email = ?, is_active = ?, password_hash = ?
         WHERE id = ? AND role = 'user'`,
        [u, e, isActive ? 1 : 0, passwordHash, studentId],
      )
    } else {
      await pool.query(
        `UPDATE users SET username = ?, email = ?, is_active = ?
         WHERE id = ? AND role = 'user'`,
        [u, e, isActive ? 1 : 0, studentId],
      )
    }

    res.json(await requireStudent(studentId))
  }),
)

router.get(
  '/students/:studentId/courses',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    await requireStudent(studentId)
    res.json(await listStudentCourses(studentId))
  }),
)

router.post(
  '/students/:studentId/courses',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    await requireStudent(studentId)
    const name = String(req.body.name ?? '').trim()
    if (!name) throw new AppError('Ponle un nombre a la materia')
    if (name.length > 120) throw new AppError('El nombre es demasiado largo')

    const [dup] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM courses WHERE user_id = ? AND name = ? LIMIT 1',
      [studentId, name],
    )
    if (dup[0]) {
      const existing = await requireStudentCourse(studentId, Number(dup[0].id))
      if (!existing.is_active) {
        await pool.query(
          'UPDATE courses SET is_active = 1 WHERE id = ? AND user_id = ?',
          [existing.id, studentId],
        )
        res.json(await requireStudentCourse(studentId, existing.id))
        return
      }
      throw new AppError('Ese alumno ya tiene una materia con ese nombre')
    }

    const [result] = await pool.query<ResultSetHeader>(
      'INSERT INTO courses (user_id, name, is_active) VALUES (?, ?, 1)',
      [studentId, name],
    )
    res.json(await requireStudentCourse(studentId, result.insertId))
  }),
)

router.post(
  '/students/:studentId/courses/import',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    await requireStudent(studentId)
    const fromId = Number(req.body.from_student_id)
    if (!Number.isFinite(fromId) || fromId <= 0) {
      throw new AppError('Elige un alumno de origen')
    }
    if (fromId === studentId) {
      throw new AppError('No puedes importar desde el mismo alumno')
    }
    await requireStudent(fromId)

    const requestedIds = Array.isArray(req.body.course_ids)
      ? (req.body.course_ids as unknown[])
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0)
      : []

    let sql = `SELECT id, name FROM courses WHERE user_id = ? AND is_active = 1`
    const params: unknown[] = [fromId]
    if (requestedIds.length > 0) {
      sql += ` AND id IN (${requestedIds.map(() => '?').join(',')})`
      params.push(...requestedIds)
    }
    sql += ' ORDER BY name ASC'
    const [source] = await pool.query<RowDataPacket[]>(sql, params)
    if (source.length === 0) {
      throw new AppError('No hay materias para importar')
    }

    const created: ReturnType<typeof mapCourse>[] = []
    const reactivated: ReturnType<typeof mapCourse>[] = []
    const skipped: string[] = []

    for (const row of source) {
      const name = String(row.name)
      const [dup] = await pool.query<RowDataPacket[]>(
        'SELECT id, is_active FROM courses WHERE user_id = ? AND name = ? LIMIT 1',
        [studentId, name],
      )
      if (dup[0]) {
        const existingId = Number(dup[0].id)
        if (Number(dup[0].is_active) === 0) {
          await pool.query(
            'UPDATE courses SET is_active = 1 WHERE id = ? AND user_id = ?',
            [existingId, studentId],
          )
          reactivated.push(await requireStudentCourse(studentId, existingId))
        } else {
          skipped.push(name)
        }
        continue
      }
      const [result] = await pool.query<ResultSetHeader>(
        'INSERT INTO courses (user_id, name, is_active) VALUES (?, ?, 1)',
        [studentId, name],
      )
      created.push(await requireStudentCourse(studentId, result.insertId))
    }

    res.json({ created, reactivated, skipped })
  }),
)

router.patch(
  '/students/:studentId/courses/:courseId',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    const courseId = Number(req.params.courseId)
    const current = await requireStudentCourse(studentId, courseId)
    const name =
      req.body.name === undefined ? current.name : String(req.body.name).trim()
    if (!name) throw new AppError('Ponle un nombre a la materia')
    const isActive =
      req.body.is_active === undefined
        ? current.is_active
        : Boolean(req.body.is_active)

    const [dup] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM courses WHERE user_id = ? AND name = ? AND id <> ? LIMIT 1',
      [studentId, name, courseId],
    )
    if (dup.length > 0) throw new AppError('Ese alumno ya tiene una materia con ese nombre')

    await pool.query(
      'UPDATE courses SET name = ?, is_active = ? WHERE id = ? AND user_id = ?',
      [name, isActive ? 1 : 0, courseId, studentId],
    )
    res.json(await requireStudentCourse(studentId, courseId))
  }),
)

router.delete(
  '/students/:studentId/courses/:courseId',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    const courseId = Number(req.params.courseId)
    await requireStudentCourse(studentId, courseId)
    await pool.query(
      'UPDATE courses SET is_active = 0 WHERE id = ? AND user_id = ?',
      [courseId, studentId],
    )
    res.json({ ok: true })
  }),
)

router.get(
  '/students/:studentId/overview',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    const student = await requireStudent(studentId)
    const today = todayISO()

    const [taskRows] = await pool.query<RowDataPacket[]>(
      `SELECT
         SUM(status = 'pending') AS pending,
         SUM(status = 'in_progress') AS in_progress,
         SUM(status = 'studying') AS studying,
         SUM(status = 'done') AS done,
         SUM(status <> 'done' AND due_date < ?) AS overdue,
         COUNT(*) AS total
       FROM tasks WHERE user_id = ?`,
      [today, studentId],
    )
    const taskStats = taskRows[0]

    const [taskList] = await pool.query<RowDataPacket[]>(
      `SELECT t.id, t.title, t.status, t.due_date, t.study_passed, t.course_id,
              t.created_at, t.updated_at, c.name AS course_name
       FROM tasks t
       INNER JOIN courses c ON c.id = t.course_id
       WHERE t.user_id = ?
       ORDER BY t.updated_at DESC, t.id DESC
       LIMIT 40`,
      [studentId],
    )

    const [worldCountRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM study_worlds WHERE user_id = ?',
      [studentId],
    )

    const [missionRows] = await pool.query<RowDataPacket[]>(
      `SELECT
         SUM(m.status = 'pending') AS pending,
         SUM(m.status = 'studying') AS studying,
         SUM(m.status = 'mastered') AS mastered,
         COUNT(*) AS total
       FROM study_missions m
       INNER JOIN study_worlds w ON w.id = m.world_id
       WHERE w.user_id = ?`,
      [studentId],
    )
    const missionStats = missionRows[0]

    const [worldList] = await pool.query<RowDataPacket[]>(
      `SELECT w.id, w.title,
              COUNT(m.id) AS mission_total,
              SUM(m.status = 'mastered') AS mission_mastered,
              SUM(m.status = 'studying') AS mission_studying
       FROM study_worlds w
       LEFT JOIN study_missions m ON m.world_id = w.id
       WHERE w.user_id = ?
       GROUP BY w.id, w.title, w.updated_at
       ORDER BY w.updated_at DESC, w.id DESC`,
      [studentId],
    )

    const [challengeStatsRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS completed_count, AVG(score) AS avg_score
       FROM study_challenges
       WHERE user_id = ? AND status = 'completed'`,
      [studentId],
    )
    const challengeStats = challengeStatsRows[0]

    const [recentChallenges] = await pool.query<RowDataPacket[]>(
      `SELECT ch.id, ch.scope, ch.difficulty, ch.status, ch.score, ch.question_count,
              ch.started_at, ch.completed_at, w.title AS world_title,
              c.name AS course_name, m.title AS mission_title
       FROM study_challenges ch
       INNER JOIN study_worlds w ON w.id = ch.world_id
       LEFT JOIN courses c ON c.id = ch.course_id
       LEFT JOIN study_missions m ON m.id = ch.mission_id
       WHERE ch.user_id = ? AND ch.status = 'completed'
       ORDER BY ch.completed_at DESC, ch.id DESC
       LIMIT 5`,
      [studentId],
    )

    const [lastStudyRows] = await pool.query<RowDataPacket[]>(
      `SELECT MAX(ts) AS last_at FROM (
         SELECT ss.updated_at AS ts
         FROM study_sessions ss
         INNER JOIN tasks t ON t.id = ss.task_id
         WHERE t.user_id = ?
         UNION ALL
         SELECT ms.updated_at AS ts
         FROM study_mission_sessions ms
         INNER JOIN study_missions m ON m.id = ms.mission_id
         INNER JOIN study_worlds w ON w.id = m.world_id
         WHERE w.user_id = ?
       ) activity`,
      [studentId, studentId],
    )

    const courses = await listStudentCourses(studentId)

    res.json({
      student,
      courses,
      tasks: {
        total: Number(taskStats?.total ?? 0),
        pending: Number(taskStats?.pending ?? 0),
        in_progress: Number(taskStats?.in_progress ?? 0),
        studying: Number(taskStats?.studying ?? 0),
        done: Number(taskStats?.done ?? 0),
        overdue: Number(taskStats?.overdue ?? 0),
        items: taskList.map(mapTaskRow),
      },
      worlds: {
        count: Number(worldCountRows[0]?.c ?? 0),
        items: worldList.map((r) => ({
          id: Number(r.id),
          title: r.title as string,
          mission_total: Number(r.mission_total ?? 0),
          mission_mastered: Number(r.mission_mastered ?? 0),
          mission_studying: Number(r.mission_studying ?? 0),
        })),
      },
      missions: {
        total: Number(missionStats?.total ?? 0),
        pending: Number(missionStats?.pending ?? 0),
        studying: Number(missionStats?.studying ?? 0),
        mastered: Number(missionStats?.mastered ?? 0),
      },
      challenges: {
        completed_count: Number(challengeStats?.completed_count ?? 0),
        avg_score:
          challengeStats?.avg_score == null
            ? null
            : Math.round(Number(challengeStats.avg_score)),
        recent: recentChallenges.map(mapChallengeRow),
      },
      last_study_at: formatMysqlDateTime(
        (lastStudyRows[0]?.last_at as Date | string | null) ?? null,
      ),
    })
  }),
)

router.get(
  '/students/:studentId/tasks',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    await requireStudent(studentId)
    const createdFrom = parseIsoDate(req.query.created_from)
    const createdTo = parseIsoDate(req.query.created_to)
    const dueFrom = parseIsoDate(req.query.due_from)
    const dueTo = parseIsoDate(req.query.due_to)
    const status = String(req.query.status ?? '').trim()
    const courseId = Number(req.query.course_id)
    const params: unknown[] = [studentId]
    let sql = `SELECT t.id, t.title, t.status, t.due_date, t.study_passed, t.course_id,
                      t.created_at, t.updated_at, c.name AS course_name
               FROM tasks t
               INNER JOIN courses c ON c.id = t.course_id
               WHERE t.user_id = ?`
    sql += andDate('t.created_at', createdFrom, createdTo, params)
    sql += andDate('t.due_date', dueFrom, dueTo, params)
    if (
      status &&
      ['pending', 'in_progress', 'studying', 'done'].includes(status)
    ) {
      sql += ' AND t.status = ?'
      params.push(status)
    }
    if (Number.isFinite(courseId) && courseId > 0) {
      sql += ' AND t.course_id = ?'
      params.push(courseId)
    }
    sql += ' ORDER BY t.due_date DESC, t.id DESC LIMIT 200'
    const [rows] = await pool.query<RowDataPacket[]>(sql, params)
    res.json(rows.map(mapTaskRow))
  }),
)

router.get(
  '/students/:studentId/study',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    await requireStudent(studentId)
    const from = parseIsoDate(req.query.from)
    const to = parseIsoDate(req.query.to)
    const kind = String(req.query.kind ?? '').trim()
    const includeTask = kind !== 'mission'
    const includeMission = kind !== 'task'

    const parts: string[] = []
    const params: unknown[] = []
    if (includeTask) {
      params.push(studentId)
      const taskSql = andDate('ss.updated_at', from, to, params)
      parts.push(`(
         SELECT 'task' AS kind, t.id AS ref_id, t.title AS title, c.name AS course_name,
                ss.tutor_phase AS phase, ss.topic_summary AS summary, ss.updated_at
         FROM study_sessions ss
         INNER JOIN tasks t ON t.id = ss.task_id
         INNER JOIN courses c ON c.id = t.course_id
         WHERE t.user_id = ?${taskSql}
       )`)
    }
    if (includeMission) {
      params.push(studentId)
      const missionSql = andDate('ms.updated_at', from, to, params)
      parts.push(`(
         SELECT 'mission' AS kind, m.id AS ref_id, m.title AS title, c.name AS course_name,
                ms.tutor_phase AS phase, ms.topic_summary AS summary, ms.updated_at
         FROM study_mission_sessions ms
         INNER JOIN study_missions m ON m.id = ms.mission_id
         INNER JOIN study_worlds w ON w.id = m.world_id
         INNER JOIN courses c ON c.id = m.course_id
         WHERE w.user_id = ?${missionSql}
       )`)
    }
    if (parts.length === 0) {
      res.json([])
      return
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `${parts.join('\n       UNION ALL\n')}
       ORDER BY updated_at DESC
       LIMIT 200`,
      params,
    )
    res.json(
      rows.map((r) => ({
        kind: r.kind as string,
        ref_id: Number(r.ref_id),
        title: r.title as string,
        course_name: r.course_name as string,
        phase: r.phase as string,
        summary: (r.summary as string | null) ?? '',
        updated_at: formatMysqlDateTime(r.updated_at as Date | string) ?? '',
      })),
    )
  }),
)

router.get(
  '/students/:studentId/challenges',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    await requireStudent(studentId)
    const from = parseIsoDate(req.query.from)
    const to = parseIsoDate(req.query.to)
    const params: unknown[] = [studentId]
    let sql = `SELECT ch.id, ch.scope, ch.difficulty, ch.status, ch.score, ch.question_count,
                      ch.started_at, ch.completed_at, w.title AS world_title,
                      c.name AS course_name, m.title AS mission_title
               FROM study_challenges ch
               INNER JOIN study_worlds w ON w.id = ch.world_id
               LEFT JOIN courses c ON c.id = ch.course_id
               LEFT JOIN study_missions m ON m.id = ch.mission_id
               WHERE ch.user_id = ? AND ch.status = 'completed'`
    sql += andDate('ch.completed_at', from, to, params)
    sql += ' ORDER BY ch.completed_at DESC, ch.id DESC LIMIT 200'
    const [rows] = await pool.query<RowDataPacket[]>(sql, params)
    res.json(rows.map(mapChallengeRow))
  }),
)

router.get(
  '/students/:studentId/challenges/:challengeId',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    await requireStudent(studentId)
    const challengeId = Number(req.params.challengeId)
    res.json(await getChallengeDetail(challengeId, studentId))
  }),
)

router.get(
  '/students/:studentId/worlds-tree',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    await requireStudent(studentId)
    const from = parseIsoDate(req.query.from)
    const to = parseIsoDate(req.query.to)
    const status = String(req.query.status ?? '').trim()
    const courseId = Number(req.query.course_id)
    const difficulty = String(req.query.difficulty ?? '').trim()
    const courseFilter =
      Number.isFinite(courseId) && courseId > 0 ? courseId : null
    const statusFilter = ['pending', 'studying', 'mastered'].includes(status)
      ? status
      : null
    const difficultyFilter = ['warm', 'quest', 'boss'].includes(difficulty)
      ? difficulty
      : null
    const hasDate = Boolean(from || to)
    const hasFilter = Boolean(
      hasDate || statusFilter || courseFilter || difficultyFilter,
    )

    const [worldRows] = await pool.query<RowDataPacket[]>(
      `SELECT w.id, w.title, w.description, w.updated_at
       FROM study_worlds w
       WHERE w.user_id = ?
       ORDER BY w.updated_at DESC, w.id DESC`,
      [studentId],
    )

    const [courseRows] = await pool.query<RowDataPacket[]>(
      `SELECT wc.world_id, c.id, c.name, wc.sort_order
       FROM study_world_courses wc
       INNER JOIN study_worlds w ON w.id = wc.world_id
       INNER JOIN courses c ON c.id = wc.course_id
       WHERE w.user_id = ?
       ORDER BY wc.sort_order ASC, c.name ASC`,
      [studentId],
    )

    const [missionRows] = await pool.query<RowDataPacket[]>(
      `SELECT m.id, m.world_id, m.course_id, m.title, m.status, m.uses_board,
              m.sort_order, m.updated_at, c.name AS course_name,
              ms.tutor_phase AS phase, ms.topic_summary AS summary,
              ms.updated_at AS study_updated_at
       FROM study_missions m
       INNER JOIN study_worlds w ON w.id = m.world_id
       INNER JOIN courses c ON c.id = m.course_id
       LEFT JOIN study_mission_sessions ms ON ms.mission_id = m.id
       WHERE w.user_id = ?
       ORDER BY c.name ASC, m.sort_order ASC, m.id ASC`,
      [studentId],
    )

    const challengeParams: unknown[] = [studentId]
    let challengeSql = `SELECT ch.id, ch.world_id, ch.course_id, ch.mission_id,
                               ch.scope, ch.difficulty, ch.status, ch.score,
                               ch.question_count, ch.started_at, ch.completed_at,
                               w.title AS world_title, c.name AS course_name,
                               m.title AS mission_title
                        FROM study_challenges ch
                        INNER JOIN study_worlds w ON w.id = ch.world_id
                        LEFT JOIN courses c ON c.id = ch.course_id
                        LEFT JOIN study_missions m ON m.id = ch.mission_id
                        WHERE ch.user_id = ?
                          AND ch.status IN ('completed', 'in_progress')`
    challengeSql += andDate(
      'COALESCE(ch.completed_at, ch.started_at)',
      from,
      to,
      challengeParams,
    )
    if (difficultyFilter) {
      challengeSql += ' AND ch.difficulty = ?'
      challengeParams.push(difficultyFilter)
    }
    challengeSql += ' ORDER BY ch.completed_at DESC, ch.started_at DESC, ch.id DESC'
    const [challengeRows] = await pool.query<RowDataPacket[]>(
      challengeSql,
      challengeParams,
    )

    type TreeChallenge = ReturnType<typeof mapChallengeRow>
    type TreeMission = {
      id: number
      title: string
      status: string
      uses_board: boolean
      updated_at: string
      study: { phase: string; summary: string; updated_at: string } | null
      challenges: TreeChallenge[]
    }
    type TreeCourse = {
      id: number
      name: string
      sort_order: number
      missions: TreeMission[]
      challenges: TreeChallenge[]
    }
    type TreeWorld = {
      id: number
      title: string
      description: string | null
      updated_at: string
      courses: TreeCourse[]
      challenges: TreeChallenge[]
    }

    const worlds: TreeWorld[] = worldRows.map((w) => ({
      id: Number(w.id),
      title: w.title as string,
      description: (w.description as string | null) ?? null,
      updated_at: formatMysqlDateTime(w.updated_at as Date | string) ?? '',
      courses: [],
      challenges: [],
    }))
    const worldMap = new Map(worlds.map((w) => [w.id, w]))
    const courseMap = new Map<string, TreeCourse>()
    const courseOptions = new Map<number, string>()

    function courseKey(worldId: number, id: number) {
      return `${worldId}:${id}`
    }

    function ensureCourse(
      worldId: number,
      id: number,
      name: string,
      sortOrder = 999,
    ) {
      const key = courseKey(worldId, id)
      let course = courseMap.get(key)
      if (!course) {
        course = { id, name, sort_order: sortOrder, missions: [], challenges: [] }
        courseMap.set(key, course)
        worldMap.get(worldId)?.courses.push(course)
      }
      courseOptions.set(id, name)
      return course
    }

    for (const row of courseRows) {
      ensureCourse(
        Number(row.world_id),
        Number(row.id),
        row.name as string,
        Number(row.sort_order ?? 0),
      )
    }

    const missionMap = new Map<number, TreeMission>()
    const missionCourse = new Map<number, { worldId: number; courseId: number }>()

    for (const row of missionRows) {
      const missionStatus = row.status as string
      if (statusFilter && missionStatus !== statusFilter) continue
      const worldId = Number(row.world_id)
      const cid = Number(row.course_id)
      if (courseFilter && cid !== courseFilter) continue
      const studyAt =
        formatMysqlDateTime(
          (row.study_updated_at as Date | string | null) ?? null,
        ) ?? null
      const studyInRange = inDateRange(studyAt, from, to)
      const study =
        row.phase && studyAt && studyInRange
          ? {
              phase: row.phase as string,
              summary: (row.summary as string | null) ?? '',
              updated_at: studyAt,
            }
          : null
      const mission: TreeMission = {
        id: Number(row.id),
        title: row.title as string,
        status: missionStatus,
        uses_board: Number(row.uses_board) !== 0,
        updated_at: formatMysqlDateTime(row.updated_at as Date | string) ?? '',
        study,
        challenges: [],
      }
      ensureCourse(worldId, cid, row.course_name as string).missions.push(mission)
      missionMap.set(mission.id, mission)
      missionCourse.set(mission.id, { worldId, courseId: cid })
    }

    for (const row of challengeRows) {
      const mapped = mapChallengeRow(row)
      const worldId = Number(row.world_id)
      const cid = row.course_id == null ? null : Number(row.course_id)
      const mid = row.mission_id == null ? null : Number(row.mission_id)
      const scope = row.scope as string

      if (courseFilter) {
        if (scope === 'world') continue
        if (scope === 'course' && cid !== courseFilter) continue
        if (scope === 'mission') {
          const loc = mid != null ? missionCourse.get(mid) : undefined
          if (!loc || loc.courseId !== courseFilter) continue
        }
      }

      if (scope === 'mission') {
        if (mid != null && missionMap.has(mid)) {
          missionMap.get(mid)!.challenges.push(mapped)
        }
        continue
      }
      if (scope === 'course' && cid != null) {
        const name = (row.course_name as string | null) ?? 'Materia'
        ensureCourse(worldId, cid, name).challenges.push(mapped)
        continue
      }
      if (!courseFilter) {
        worldMap.get(worldId)?.challenges.push(mapped)
      }
    }

    if (hasDate || difficultyFilter) {
      for (const world of worlds) {
        for (const course of world.courses) {
          course.missions = course.missions.filter((mission) => {
            if (difficultyFilter) return mission.challenges.length > 0
            if (hasDate) return Boolean(mission.study) || mission.challenges.length > 0
            return true
          })
        }
      }
    }

    if (hasFilter) {
      for (const world of worlds) {
        world.courses = world.courses.filter(
          (course) => course.missions.length > 0 || course.challenges.length > 0,
        )
      }
    }

    for (const world of worlds) {
      world.courses.sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'es'),
      )
    }

    const pruned = hasFilter
      ? worlds.filter(
          (world) => world.courses.length > 0 || world.challenges.length > 0,
        )
      : worlds

    res.json({
      courses: [...courseOptions.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
      worlds: pruned.map((world) => ({
        id: world.id,
        title: world.title,
        description: world.description,
        updated_at: world.updated_at,
        challenges: world.challenges,
        courses: world.courses.map((course) => ({
          id: course.id,
          name: course.name,
          missions: course.missions,
          challenges: course.challenges,
        })),
      })),
    })
  }),
)

router.get(
  '/students/:studentId/worlds',
  asyncHandler(async (req, res) => {
    const studentId = Number(req.params.studentId)
    await requireStudent(studentId)
    const [worlds] = await pool.query<RowDataPacket[]>(
      `SELECT w.id, w.title, w.description, w.updated_at
       FROM study_worlds w
       WHERE w.user_id = ?
       ORDER BY w.updated_at DESC, w.id DESC`,
      [studentId],
    )
    const [missions] = await pool.query<RowDataPacket[]>(
      `SELECT m.id, m.world_id, m.title, m.status, m.uses_board, m.updated_at,
              c.name AS course_name
       FROM study_missions m
       INNER JOIN study_worlds w ON w.id = m.world_id
       INNER JOIN courses c ON c.id = m.course_id
       WHERE w.user_id = ?
       ORDER BY c.name ASC, m.sort_order ASC, m.id ASC`,
      [studentId],
    )
    const byWorld = new Map<number, typeof missions>()
    for (const m of missions) {
      const wid = Number(m.world_id)
      const list = byWorld.get(wid) ?? []
      list.push(m)
      byWorld.set(wid, list)
    }
    res.json(
      worlds.map((w) => {
        const wid = Number(w.id)
        return {
          id: wid,
          title: w.title as string,
          description: (w.description as string | null) ?? null,
          updated_at: formatMysqlDateTime(w.updated_at as Date | string) ?? '',
          missions: (byWorld.get(wid) ?? []).map((m) => ({
            id: Number(m.id),
            title: m.title as string,
            status: m.status as string,
            uses_board: Number(m.uses_board) !== 0,
            course_name: m.course_name as string,
            updated_at: formatMysqlDateTime(m.updated_at as Date | string) ?? '',
          })),
        }
      }),
    )
  }),
)

export default router
