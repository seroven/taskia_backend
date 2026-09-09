import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { pool } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/error.js'
import { callGemini } from '../services/gemini.js'
import {
  AppError,
  extractJson,
  formatMysqlDateTime,
  truncateChars,
} from '../utils/helpers.js'

const router = Router()

const MISSION_SELECT = `
  SELECT m.id, m.world_id, m.course_id, c.name AS course_name,
         m.title, m.description, m.status, m.uses_board,
         m.source_mission_id, m.sort_order, m.created_at, m.updated_at
  FROM study_missions m
  INNER JOIN courses c ON c.id = m.course_id
`

function emptyBoard() {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'taskia',
    elements: [],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  }
}

function mapWorld(r: RowDataPacket) {
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    created_at: formatMysqlDateTime(r.created_at as Date | string) ?? '',
    updated_at: formatMysqlDateTime(r.updated_at as Date | string) ?? '',
  }
}

function mapMission(r: RowDataPacket) {
  return {
    id: Number(r.id),
    world_id: Number(r.world_id),
    course_id: Number(r.course_id),
    course_name: r.course_name as string,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    status: r.status as string,
    uses_board: Number(r.uses_board) !== 0,
    source_mission_id:
      r.source_mission_id == null ? null : Number(r.source_mission_id),
    sort_order: Number(r.sort_order),
    created_at: formatMysqlDateTime(r.created_at as Date | string) ?? '',
    updated_at: formatMysqlDateTime(r.updated_at as Date | string) ?? '',
  }
}

function mapChallenge(r: RowDataPacket) {
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    world_id: Number(r.world_id),
    scope: r.scope as string,
    mission_id: r.mission_id == null ? null : Number(r.mission_id),
    course_id: r.course_id == null ? null : Number(r.course_id),
    difficulty: r.difficulty as string,
    question_count: Number(r.question_count),
    status: r.status as string,
    score: r.score == null ? null : Number(r.score),
    started_at: formatMysqlDateTime(r.started_at as Date | string) ?? '',
    completed_at: formatMysqlDateTime(r.completed_at as Date | string | null),
  }
}

async function requireWorld(worldId: number, userId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, user_id, title, description, created_at, updated_at
     FROM study_worlds WHERE id = ? AND user_id = ? LIMIT 1`,
    [worldId, userId],
  )
  if (!rows[0]) throw new AppError('Mundo no encontrado', 404)
  return mapWorld(rows[0])
}

async function fetchMission(missionId: number, userId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${MISSION_SELECT}
     INNER JOIN study_worlds w ON w.id = m.world_id
     WHERE m.id = ? AND w.user_id = ? LIMIT 1`,
    [missionId, userId],
  )
  if (!rows[0]) throw new AppError('Misión no encontrada', 404)
  return mapMission(rows[0])
}

async function listWorldCourses(worldId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT wc.world_id, wc.course_id, c.name AS course_name, wc.sort_order
     FROM study_world_courses wc
     INNER JOIN courses c ON c.id = wc.course_id
     WHERE wc.world_id = ?
     ORDER BY wc.sort_order ASC, c.name ASC`,
    [worldId],
  )
  return rows.map((r) => ({
    world_id: Number(r.world_id),
    course_id: Number(r.course_id),
    course_name: r.course_name as string,
    sort_order: Number(r.sort_order),
  }))
}

async function listMissions(worldId: number, courseId: number, userId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${MISSION_SELECT}
     INNER JOIN study_worlds w ON w.id = m.world_id
     WHERE m.world_id = ? AND m.course_id = ? AND w.user_id = ?
     ORDER BY m.sort_order ASC, m.id ASC`,
    [worldId, courseId, userId],
  )
  return rows.map(mapMission)
}

async function ensureMissionSession(missionId: number) {
  await pool.query(
    `INSERT INTO study_mission_sessions
       (mission_id, tutor_phase, topic_summary, context_summary, hints_level)
     VALUES (?, 'understanding', '', '', 0)
     ON DUPLICATE KEY UPDATE mission_id = mission_id`,
    [missionId],
  )
}

async function loadMissionContext(missionId: number) {
  await ensureMissionSession(missionId)
  const [sessionRows] = await pool.query<RowDataPacket[]>(
    `SELECT tutor_phase, topic_summary, context_summary, hints_level, updated_at
     FROM study_mission_sessions WHERE mission_id = ? LIMIT 1`,
    [missionId],
  )
  const session = sessionRows[0]
  const [msgRows] = await pool.query<RowDataPacket[]>(
    `SELECT role, content, created_at
     FROM study_mission_messages
     WHERE mission_id = ?
     ORDER BY created_at ASC, id ASC`,
    [missionId],
  )
  return {
    mission_id: missionId,
    tutor_phase: session.tutor_phase as string,
    topic_summary: session.topic_summary as string,
    context_summary: session.context_summary as string,
    hints_level: Number(session.hints_level),
    messages: msgRows.map((m) => ({
      role: m.role as string,
      content: m.content as string,
      created_at: formatMysqlDateTime(m.created_at as Date | string) ?? '',
    })),
  }
}

async function saveMissionBoardDb(missionId: number, board: unknown) {
  const raw = JSON.stringify(board)
  await pool.query(
    `INSERT INTO study_mission_boards (mission_id, board_json)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE board_json = VALUES(board_json)`,
    [missionId, raw],
  )
}

async function loadMissionBoard(missionId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT board_json FROM study_mission_boards WHERE mission_id = ? LIMIT 1',
    [missionId],
  )
  if (rows[0]?.board_json) {
    try {
      return JSON.parse(rows[0].board_json as string)
    } catch {
      /* fall through */
    }
  }
  const board = emptyBoard()
  await saveMissionBoardDb(missionId, board)
  return board
}

async function insertMissionMessage(
  missionId: number,
  role: string,
  content: string,
) {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO study_mission_messages (mission_id, role, content)
     VALUES (?, ?, ?)`,
    [missionId, role, content],
  )
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT created_at FROM study_mission_messages WHERE id = ? LIMIT 1',
    [result.insertId],
  )
  return {
    role,
    content,
    created_at: formatMysqlDateTime(rows[0]?.created_at as Date | string) ?? '',
  }
}

const MISSION_DRAW_OPS_PROMPT = `Pizarra de salida: allow_ai_draw=true. Si el niño pide ejercicio nuevo, practica, o conviene visualizar:
1) Empieza con {"op":"clear_board"} (la app borra toda la pizarra y centra tu dibujo grande).
2) Dibuja con 3–8 ops. Preferí stamps con scale≈2; luego shape/text con labels.
3) No dejes números/figuras solo en speak_to_child: deben ir en draw_ops.
4) Coordenadas relativas libres (la app re-centra). Labels claros (base, altura, lados).
Stamps: right_triangle, circle, square, number_line, arrow.
Shapes: rectangle|ellipse|triangle|line|arrow|text (x,y,w,h,label?,color?).
Ejemplo (triángulo base 8 altura 4):
[{"op":"clear_board"},{"op":"stamp","id":"right_triangle","x":0,"y":0,"scale":2},{"op":"shape","type":"text","x":110,"y":175,"label":"8"},{"op":"shape","type":"text","x":-30,"y":70,"label":"4"}]
`

function missionTutorPrompt(allowAiDraw: boolean): string {
  let p = `Tutor amable para niño ~10 años. Español latinoamericano, claro y breve.
Enseñas un TEMA (misión), no una tarea escolar concreta. Guía con preguntas/pistas; no des la solución completa.
Recibes context_summary, last_tutor_message. Conserva coherencia con el ejercicio/ejemplo abierto.
Pizarra de entrada: si board_has_drawing=false, ignora lo que haya dibujado el niño.
Responde SOLO JSON (sin markdown):
{"phase":"understanding|practicing|reviewing","speak_to_child":"...","ask_questions":[],"topic_summary":"...","context_summary":"...","draw_ops":[],"hints_level":0,"study_eval":{"passed":false,"evidence":""}}
context_summary ≤ 400 chars; incluye "Ejercicio activo: …" si hay práctica abierta.
Dominio (study_eval.passed=true) solo si phase=reviewing, ≥2 aciertos reales, variación distinta, user_turns≥3.
Si mastered_already=true → passed=true.
`
  if (!allowAiDraw) {
    p += 'draw_ops siempre []. No dibujes en la pizarra.'
  } else {
    p += MISSION_DRAW_OPS_PROMPT
  }
  return p
}

function normalizeDrawOps(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

async function presetCount(scope: string, difficulty: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT question_count FROM study_challenge_presets WHERE scope = ? AND difficulty = ? LIMIT 1',
    [scope, difficulty],
  )
  if (!rows[0]) throw new AppError('Dificultad o alcance no válido')
  return Number(rows[0].question_count)
}

async function missionsForChallenge(
  userId: number,
  worldId: number,
  scope: string,
  missionId: number | null,
  courseId: number | null,
) {
  if (scope === 'mission') {
    if (missionId == null) throw new AppError('Falta la misión')
    return [await fetchMission(missionId, userId)]
  }
  if (scope === 'course') {
    if (courseId == null) throw new AppError('Falta la materia')
    const [rows] = await pool.query<RowDataPacket[]>(
      `${MISSION_SELECT}
       INNER JOIN study_worlds w ON w.id = m.world_id
       WHERE m.world_id = ? AND m.course_id = ? AND w.user_id = ?
       ORDER BY m.sort_order ASC`,
      [worldId, courseId, userId],
    )
    const list = rows.map(mapMission)
    if (list.length === 0) throw new AppError('No hay misiones en esta materia')
    return list
  }
  if (scope === 'world') {
    const [rows] = await pool.query<RowDataPacket[]>(
      `${MISSION_SELECT}
       INNER JOIN study_worlds w ON w.id = m.world_id
       WHERE m.world_id = ? AND w.user_id = ?
       ORDER BY m.course_id ASC, m.sort_order ASC`,
      [worldId, userId],
    )
    const list = rows.map(mapMission)
    if (list.length === 0) throw new AppError('No hay misiones en este mundo')
    return list
  }
  throw new AppError('Alcance no válido')
}

async function generateQuestionsBatch(
  missions: ReturnType<typeof mapMission>[],
  count: number,
  batchOffset: number,
) {
  const catalog = missions.map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    uses_board: m.uses_board,
    course: m.course_name,
  }))

  const system = `Generas preguntas de desafío para niños ~10 años. Español latinoamericano.
NO enseñes: solo preguntas evaluables.
Responde SOLO un JSON array:
[{"mission_id":1,"kind":"multiple_choice|short_text|fill_blank|board_prompt","prompt":"...","options":["A","B","C","D"]|null,"answer_key":"...","requires_board":false}]
Reglas:
- Si uses_board=true en la misión → kind=board_prompt, requires_board=true, options=null.
- Si uses_board=false → multiple_choice (options 4), short_text o fill_blank; requires_board=false.
- answer_key: letra A-D para MCQ, o respuesta breve esperada.
- Variadas y claras. mission_id debe ser de la lista.`

  const user = JSON.stringify({
    count,
    batch_offset: batchOffset,
    missions: catalog,
    instruction: `Genera exactamente ${count} preguntas nuevas.`,
  })

  const raw = await callGemini({ system, user })
  const jsonText = extractJson(raw)
  let value: unknown
  try {
    value = JSON.parse(jsonText)
  } catch {
    throw new AppError('No se pudieron generar las preguntas')
  }
  if (!Array.isArray(value)) {
    throw new AppError('Gemini no devolvió un array de preguntas')
  }
  return value as Array<Record<string, unknown>>
}

async function getChallengeDetail(challengeId: number, userId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, user_id, world_id, scope, mission_id, course_id, difficulty,
            question_count, status, score, started_at, completed_at
     FROM study_challenges
     WHERE id = ? AND user_id = ? LIMIT 1`,
    [challengeId, userId],
  )
  if (!rows[0]) throw new AppError('Desafío no encontrado', 404)
  const challenge = mapChallenge(rows[0])

  const [qrows] = await pool.query<RowDataPacket[]>(
    `SELECT q.id, q.mission_id, q.sort_order, q.kind, q.prompt, q.options_json, q.requires_board,
            a.is_correct
     FROM study_challenge_questions q
     LEFT JOIN study_challenge_answers a ON a.question_id = q.id
     WHERE q.challenge_id = ?
     ORDER BY q.sort_order ASC, q.id ASC`,
    [challengeId],
  )

  let currentIndex = 0
  const questions = qrows.map((q, i) => {
    const answered = q.is_correct != null
    if (answered) currentIndex = i + 1
    let options: string[] | null = null
    if (q.options_json) {
      try {
        const parsed = JSON.parse(q.options_json as string)
        if (Array.isArray(parsed)) {
          options = parsed.filter((x): x is string => typeof x === 'string')
        }
      } catch {
        options = null
      }
    }
    return {
      id: Number(q.id),
      mission_id: q.mission_id == null ? null : Number(q.mission_id),
      sort_order: Number(q.sort_order),
      kind: q.kind as string,
      prompt: q.prompt as string,
      options,
      requires_board: Number(q.requires_board) !== 0,
      answered,
      is_correct: q.is_correct == null ? null : Number(q.is_correct) !== 0,
    }
  })

  if (currentIndex >= questions.length) {
    currentIndex = Math.max(0, questions.length - 1)
    if (questions.length > 0 && questions.every((q) => q.answered)) {
      currentIndex = questions.length
    }
  }

  return { challenge, questions, current_index: currentIndex }
}

router.use(requireAuth)

// ---------------------------------------------------------------------------
// Static / nested paths (before /:worldId)
// ---------------------------------------------------------------------------

router.get(
  '/challenge-presets',
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT scope, difficulty, question_count, label FROM study_challenge_presets',
    )
    res.json(
      rows.map((r) => ({
        scope: r.scope as string,
        difficulty: r.difficulty as string,
        question_count: Number(r.question_count),
        label: r.label as string,
      })),
    )
  }),
)

router.patch(
  '/missions/:missionId',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const missionId = Number(req.params.missionId)
    const current = await fetchMission(missionId, userId)
    const title = String(req.body.title ?? '').trim()
    if (!title) throw new AppError('El título de la misión es obligatorio')
    const description =
      typeof req.body.description === 'string' && req.body.description.trim()
        ? req.body.description.trim()
        : null
    const usesBoard = Boolean(req.body.uses_board)

    await pool.query(
      `UPDATE study_missions
       SET title = ?, description = ?, uses_board = ?
       WHERE id = ?`,
      [title, description, usesBoard ? 1 : 0, current.id],
    )
    res.json(await fetchMission(missionId, userId))
  }),
)

router.delete(
  '/missions/:missionId',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const missionId = Number(req.params.missionId)
    await fetchMission(missionId, userId)
    await pool.query('DELETE FROM study_missions WHERE id = ?', [missionId])
    res.json({ ok: true })
  }),
)

router.get(
  '/missions/:missionId/session',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const missionId = Number(req.params.missionId)
    const mission = await fetchMission(missionId, userId)

    if (mission.status === 'pending') {
      await pool.query(
        `UPDATE study_missions SET status = 'studying' WHERE id = ?`,
        [missionId],
      )
      mission.status = 'studying'
    }

    const context = await loadMissionContext(missionId)
    const board = mission.uses_board
      ? await loadMissionBoard(missionId)
      : emptyBoard()

    if (context.messages.length === 0) {
      const speak = `¡Hola! Vamos a estudiar "${mission.title}"${
        mission.uses_board ? ' (puedes usar la pizarra)' : ''
      }. Cuéntame qué sabes o qué te confunde y lo vemos juntos.`
      context.topic_summary = mission.title
      context.context_summary = `Inicio local. Misión: "${mission.title}".`
      try {
        const msg = await insertMissionMessage(missionId, 'assistant', speak)
        context.messages.push(msg)
      } catch {
        /* ignore local greeting failure */
      }
      await pool.query(
        `UPDATE study_mission_sessions
         SET topic_summary = ?, context_summary = ?
         WHERE mission_id = ?`,
        [context.topic_summary, context.context_summary, missionId],
      )
    }

    res.json({ context, board, mission })
  }),
)

router.put(
  '/missions/:missionId/board',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const missionId = Number(req.params.missionId)
    const mission = await fetchMission(missionId, userId)
    if (!mission.uses_board) throw new AppError('Esta misión no usa pizarra')
    await saveMissionBoardDb(missionId, req.body.board ?? req.body)
    res.json({ ok: true })
  }),
)

router.post(
  '/missions/:missionId/chat',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const missionId = Number(req.params.missionId)
    const mission = await fetchMission(missionId, userId)
    const message = String(req.body.user_message ?? '').trim()
    if (!message) throw new AppError('Escribe un mensaje')

    if (mission.status === 'pending') {
      await pool.query(
        `UPDATE study_missions SET status = 'studying' WHERE id = ?`,
        [missionId],
      )
      mission.status = 'studying'
    }

    const allowAiDraw =
      Boolean(req.body.allow_ai_draw) && mission.uses_board
    const context = await loadMissionContext(missionId)
    const userMsg = await insertMissionMessage(missionId, 'user', message)
    context.messages.push(userMsg)
    const userTurns = context.messages.filter((m) => m.role === 'user').length

    const lastTutorMsg = [...context.messages]
      .reverse()
      .find((m) => m.role === 'assistant')
    const lastTutor = lastTutorMsg
      ? truncateChars(lastTutorMsg.content, 320)
      : ''

    const boardDescription =
      typeof req.body.board_description === 'string'
        ? req.body.board_description
        : null
    const boardHas = Boolean(boardDescription?.trim())

    const payload = JSON.stringify({
      instruction: allowAiDraw
        ? 'Responde breve. Enseña el tema. Conserva ejercicio activo. Evalúa study_eval. Incluye draw_ops con clear_board + stamps/shapes (no dejes el ejercicio solo en texto).'
        : 'Responde breve. Enseña el tema. Conserva ejercicio activo. Evalúa study_eval.',
      user_turns: userTurns,
      mastered_already: mission.status === 'mastered',
      mission: {
        title: truncateChars(mission.title, 120),
        description: truncateChars(mission.description ?? '', 220),
        course: mission.course_name,
        uses_board: mission.uses_board,
      },
      phase: context.tutor_phase,
      topic_summary: truncateChars(context.topic_summary, 120),
      context_summary: truncateChars(context.context_summary, 400),
      last_tutor_message: lastTutor,
      hints_level: context.hints_level,
      ...(allowAiDraw ? { allow_ai_draw: true } : {}),
      board_has_drawing: boardHas,
      ...(boardHas
        ? { board_drawing: truncateChars(boardDescription ?? '', 500) }
        : {}),
      child_message: truncateChars(message, 800),
    })

    const raw = await callGemini({
      system: missionTutorPrompt(allowAiDraw),
      user: payload,
      boardImageBase64: boardHas
        ? (req.body.board_image_base64 as string | null | undefined) ?? null
        : null,
    })

    let value: Record<string, unknown>
    try {
      value = JSON.parse(extractJson(raw)) as Record<string, unknown>
    } catch {
      throw new AppError('La IA no devolvió el formato esperado')
    }

    const studyEvalRaw = (value.study_eval ?? {}) as Record<string, unknown>
    const askQuestions = Array.isArray(value.ask_questions)
      ? value.ask_questions.filter((x): x is string => typeof x === 'string')
      : []

    const reply = {
      phase:
        typeof value.phase === 'string' ? value.phase : 'understanding',
      speak_to_child: truncateChars(
        typeof value.speak_to_child === 'string'
          ? value.speak_to_child
          : '¡Sigue! Cuéntame más.',
        450,
      ),
      ask_questions: askQuestions,
      topic_summary:
        typeof value.topic_summary === 'string' ? value.topic_summary : '',
      context_summary: truncateChars(
        typeof value.context_summary === 'string'
          ? value.context_summary
          : context.context_summary,
        400,
      ),
      draw_ops: allowAiDraw ? normalizeDrawOps(value.draw_ops) : [],
      hints_level:
        typeof value.hints_level === 'number' ? value.hints_level : 0,
      study_eval: {
        passed: Boolean(studyEvalRaw.passed),
        evidence:
          typeof studyEvalRaw.evidence === 'string'
            ? studyEvalRaw.evidence
            : '',
      },
    }

    if (userTurns < 3) reply.study_eval.passed = false
    if (mission.status === 'mastered') reply.study_eval.passed = true

    let visible = reply.speak_to_child
    if (reply.ask_questions.length > 0) {
      visible += '\n\n'
      reply.ask_questions.forEach((q, i) => {
        visible += `${i + 1}. ${q}\n`
      })
    }

    const saved = await insertMissionMessage(missionId, 'assistant', visible)
    context.messages.push(saved)
    context.tutor_phase = reply.phase
    if (reply.topic_summary.trim()) {
      context.topic_summary = truncateChars(reply.topic_summary, 120)
    }
    context.context_summary = reply.context_summary
    context.hints_level = reply.hints_level

    await pool.query(
      `UPDATE study_mission_sessions
       SET tutor_phase = ?, topic_summary = ?, context_summary = ?, hints_level = ?
       WHERE mission_id = ?`,
      [
        context.tutor_phase,
        context.topic_summary,
        context.context_summary,
        context.hints_level,
        missionId,
      ],
    )

    if (reply.study_eval.passed && mission.status !== 'mastered') {
      await pool.query(
        `UPDATE study_missions SET status = 'mastered' WHERE id = ?`,
        [missionId],
      )
      mission.status = 'mastered'
    }

    res.json({ reply, context, mission })
  }),
)

router.post(
  '/challenges/start',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const worldId = Number(req.body.world_id)
    const scope = String(req.body.scope ?? '').trim()
    const difficulty = String(req.body.difficulty ?? '').trim()
    const missionId =
      req.body.mission_id != null ? Number(req.body.mission_id) : null
    const courseId =
      req.body.course_id != null ? Number(req.body.course_id) : null

    await requireWorld(worldId, userId)
    if (!['mission', 'course', 'world'].includes(scope)) {
      throw new AppError('Alcance no válido')
    }
    if (!['warm', 'quest', 'boss'].includes(difficulty)) {
      throw new AppError('Dificultad no válida')
    }

    const questionCount = await presetCount(scope, difficulty)
    const missions = await missionsForChallenge(
      userId,
      worldId,
      scope,
      missionId,
      courseId,
    )

    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO study_challenges
         (user_id, world_id, scope, mission_id, course_id, difficulty, question_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress')`,
      [
        userId,
        worldId,
        scope,
        missionId,
        courseId,
        difficulty,
        questionCount,
      ],
    )
    const challengeId = result.insertId

    const total = questionCount
    let generated: Array<Record<string, unknown>> = []
    try {
      if (total <= 15) {
        generated = await generateQuestionsBatch(missions, total, 0)
      } else {
        let offset = 0
        while (offset < total) {
          const batch = Math.min(10, total - offset)
          const part = await generateQuestionsBatch(missions, batch, offset)
          generated.push(...part)
          offset += batch
        }
      }
    } catch (err) {
      await pool.query('DELETE FROM study_challenges WHERE id = ?', [
        challengeId,
      ])
      throw err
    }

    const missionIds = new Set(missions.map((m) => m.id))
    let sortOrder = 0
    for (const item of generated.slice(0, total)) {
      let mid =
        typeof item.mission_id === 'number'
          ? item.mission_id
          : Number(item.mission_id)
      if (!Number.isFinite(mid) || !missionIds.has(mid)) {
        mid = missions[0]!.id
      }
      const mission =
        missions.find((m) => m.id === mid) ?? missions[0]!

      let kind =
        typeof item.kind === 'string' ? item.kind : 'short_text'
      let requiresBoard: boolean
      if (mission.uses_board) {
        kind = 'board_prompt'
        requiresBoard = true
      } else {
        requiresBoard = false
        if (kind === 'board_prompt') kind = 'multiple_choice'
      }

      const prompt =
        typeof item.prompt === 'string' ? item.prompt : '¿Listo?'
      const answerKey =
        typeof item.answer_key === 'string' ? item.answer_key : ''
      const optionsJson = JSON.stringify(
        item.options === undefined ? null : item.options,
      )

      await pool.query(
        `INSERT INTO study_challenge_questions
           (challenge_id, mission_id, sort_order, kind, prompt, options_json, answer_key, requires_board)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          challengeId,
          mid,
          sortOrder,
          kind,
          prompt,
          optionsJson,
          answerKey,
          requiresBoard ? 1 : 0,
        ],
      )
      sortOrder += 1
    }

    if (sortOrder === 0) {
      await pool.query('DELETE FROM study_challenges WHERE id = ?', [
        challengeId,
      ])
      throw new AppError('No se generaron preguntas. Probá de nuevo.')
    }

    await pool.query(
      'UPDATE study_challenges SET question_count = ? WHERE id = ?',
      [sortOrder, challengeId],
    )

    res.json(await getChallengeDetail(challengeId, userId))
  }),
)

router.get(
  '/challenges/:challengeId',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const challengeId = Number(req.params.challengeId)
    res.json(await getChallengeDetail(challengeId, userId))
  }),
)

router.post(
  '/challenges/questions/:questionId/answer',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const questionId = Number(req.params.questionId)

    const [qrows] = await pool.query<RowDataPacket[]>(
      `SELECT q.id, q.challenge_id, q.kind, q.prompt, q.answer_key, q.requires_board
       FROM study_challenge_questions q
       INNER JOIN study_challenges c ON c.id = q.challenge_id
       WHERE q.id = ? AND c.user_id = ? LIMIT 1`,
      [questionId, userId],
    )
    if (!qrows[0]) throw new AppError('Pregunta no encontrada', 404)

    const challengeId = Number(qrows[0].challenge_id)
    const kind = qrows[0].kind as string
    const prompt = qrows[0].prompt as string
    const answerKey = qrows[0].answer_key as string
    const requiresBoard = Number(qrows[0].requires_board) !== 0

    const [alreadyRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM study_challenge_answers WHERE question_id = ?',
      [questionId],
    )
    if (Number(alreadyRows[0]?.c) > 0) {
      throw new AppError('Esta pregunta ya fue respondida')
    }

    const answerText =
      typeof req.body.user_answer === 'string' ? req.body.user_answer : ''
    const boardJson = req.body.board_json ?? null

    let isCorrect = false
    if (kind === 'multiple_choice') {
      const normalized = answerText.trim().toUpperCase()
      const key = answerKey.trim().toUpperCase()
      const keyLetter = /^[A-D](?=$|[\s).:-])/.exec(key)?.[0]
      const answerLetter = /^[A-D](?=$|[\s).:-])/.exec(normalized)?.[0]
      isCorrect = Boolean(
        normalized &&
          key &&
          (normalized === key ||
            (keyLetter != null && answerLetter === keyLetter)),
      )
    } else {
      const boardSnip = boardJson
        ? truncateChars(JSON.stringify(boardJson), 800)
        : ''
      const gradeUser = JSON.stringify({
        prompt,
        answer_key: answerKey,
        child_answer: truncateChars(answerText, 800),
        board_json_snip: boardSnip,
        requires_board: requiresBoard,
      })
      const raw = await callGemini({
        system:
          'Juzgas si la respuesta del niño es correcta. NO des pistas ni enseñes.\nResponde SOLO JSON: {"correct":true|false,"evidence":"breve"}',
        user: gradeUser,
      })
      let value: Record<string, unknown> = {}
      try {
        value = JSON.parse(extractJson(raw)) as Record<string, unknown>
      } catch {
        value = {}
      }
      isCorrect = Boolean(value.correct)
    }

    const boardRaw =
      boardJson != null ? JSON.stringify(boardJson) : null

    await pool.query(
      `INSERT INTO study_challenge_answers (question_id, user_answer, board_json, is_correct)
       VALUES (?, ?, ?, ?)`,
      [questionId, answerText, boardRaw, isCorrect ? 1 : 0],
    )

    const [totalRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM study_challenge_questions WHERE challenge_id = ?',
      [challengeId],
    )
    const total = Number(totalRows[0]?.c ?? 0)

    const [answeredRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c
       FROM study_challenge_answers a
       INNER JOIN study_challenge_questions q ON q.id = a.question_id
       WHERE q.challenge_id = ?`,
      [challengeId],
    )
    const answered = Number(answeredRows[0]?.c ?? 0)

    const completed = answered >= total && total > 0
    let score: number | null = null
    let nextIndex: number | null = null

    if (completed) {
      const [correctRows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS c
         FROM study_challenge_answers a
         INNER JOIN study_challenge_questions q ON q.id = a.question_id
         WHERE q.challenge_id = ? AND a.is_correct = 1`,
        [challengeId],
      )
      const correct = Number(correctRows[0]?.c ?? 0)
      score = Math.round((correct / total) * 100)
      const completedAt = formatMysqlDateTime(new Date()) ?? ''
      await pool.query(
        `UPDATE study_challenges
         SET status = 'completed', score = ?, completed_at = ?
         WHERE id = ?`,
        [score, completedAt, challengeId],
      )
    } else {
      nextIndex = answered
    }

    res.json({
      is_correct: isCorrect,
      completed,
      score,
      next_index: nextIndex,
    })
  }),
)

// ---------------------------------------------------------------------------
// Worlds CRUD
// ---------------------------------------------------------------------------

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, user_id, title, description, created_at, updated_at
       FROM study_worlds
       WHERE user_id = ?
       ORDER BY updated_at DESC, id DESC`,
      [userId],
    )
    res.json(rows.map(mapWorld))
  }),
)

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const title = String(req.body.title ?? '').trim()
    if (!title) throw new AppError('El título del mundo es obligatorio')
    const description =
      typeof req.body.description === 'string' && req.body.description.trim()
        ? req.body.description.trim()
        : null

    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO study_worlds (user_id, title, description) VALUES (?, ?, ?)`,
      [userId, title, description],
    )
    res.json(await requireWorld(result.insertId, userId))
  }),
)

router.patch(
  '/:worldId',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const worldId = Number(req.params.worldId)
    await requireWorld(worldId, userId)
    const title = String(req.body.title ?? '').trim()
    if (!title) throw new AppError('El título del mundo es obligatorio')
    const description =
      typeof req.body.description === 'string' && req.body.description.trim()
        ? req.body.description.trim()
        : null

    await pool.query(
      `UPDATE study_worlds SET title = ?, description = ?
       WHERE id = ? AND user_id = ?`,
      [title, description, worldId, userId],
    )
    res.json(await requireWorld(worldId, userId))
  }),
)

router.delete(
  '/:worldId',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const worldId = Number(req.params.worldId)
    await requireWorld(worldId, userId)
    await pool.query('DELETE FROM study_worlds WHERE id = ? AND user_id = ?', [
      worldId,
      userId,
    ])
    res.json({ ok: true })
  }),
)

router.get(
  '/:worldId/courses',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const worldId = Number(req.params.worldId)
    await requireWorld(worldId, userId)
    res.json(await listWorldCourses(worldId))
  }),
)

router.post(
  '/:worldId/courses',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const worldId = Number(req.params.worldId)
    const courseId = Number(req.body.course_id)
    await requireWorld(worldId, userId)

    const [existsRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM courses WHERE id = ? AND is_active = 1',
      [courseId],
    )
    if (Number(existsRows[0]?.c) === 0) throw new AppError('Curso no válido')

    const [maxRows] = await pool.query<RowDataPacket[]>(
      'SELECT MAX(sort_order) AS m FROM study_world_courses WHERE world_id = ?',
      [worldId],
    )
    const maxOrder = maxRows[0]?.m == null ? -1 : Number(maxRows[0].m)

    await pool.query(
      `INSERT INTO study_world_courses (world_id, course_id, sort_order)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE sort_order = sort_order`,
      [worldId, courseId, maxOrder + 1],
    )
    res.json(await listWorldCourses(worldId))
  }),
)

router.delete(
  '/:worldId/courses/:courseId',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const worldId = Number(req.params.worldId)
    const courseId = Number(req.params.courseId)
    await requireWorld(worldId, userId)
    await pool.query(
      'DELETE FROM study_world_courses WHERE world_id = ? AND course_id = ?',
      [worldId, courseId],
    )
    res.json(await listWorldCourses(worldId))
  }),
)

router.get(
  '/:worldId/courses/:courseId/missions',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const worldId = Number(req.params.worldId)
    const courseId = Number(req.params.courseId)
    await requireWorld(worldId, userId)
    res.json(await listMissions(worldId, courseId, userId))
  }),
)

router.post(
  '/:worldId/courses/:courseId/missions',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const worldId = Number(req.params.worldId)
    const courseId = Number(req.params.courseId)
    await requireWorld(worldId, userId)

    const [linkedRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM study_world_courses WHERE world_id = ? AND course_id = ?',
      [worldId, courseId],
    )
    if (Number(linkedRows[0]?.c) === 0) {
      throw new AppError('Primero agrega la materia a este mundo')
    }

    const title = String(req.body.title ?? '').trim()
    if (!title) throw new AppError('El título de la misión es obligatorio')
    const description =
      typeof req.body.description === 'string' && req.body.description.trim()
        ? req.body.description.trim()
        : null
    const usesBoard = Boolean(req.body.uses_board)

    const [maxRows] = await pool.query<RowDataPacket[]>(
      'SELECT MAX(sort_order) AS m FROM study_missions WHERE world_id = ? AND course_id = ?',
      [worldId, courseId],
    )
    const maxOrder = maxRows[0]?.m == null ? -1 : Number(maxRows[0].m)

    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO study_missions
         (world_id, course_id, title, description, status, uses_board, sort_order)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [worldId, courseId, title, description, usesBoard ? 1 : 0, maxOrder + 1],
    )
    res.json(await fetchMission(result.insertId, userId))
  }),
)

router.get(
  '/:worldId/courses/:courseId/importable',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const worldId = Number(req.params.worldId)
    const courseId = Number(req.params.courseId)
    await requireWorld(worldId, userId)

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT m.id, m.title, m.description, m.uses_board,
              m.world_id, w.title AS world_title, m.status
       FROM study_missions m
       INNER JOIN study_worlds w ON w.id = m.world_id
       WHERE w.user_id = ? AND m.course_id = ? AND m.world_id <> ?
       ORDER BY w.title ASC, m.title ASC`,
      [userId, courseId, worldId],
    )
    res.json(
      rows.map((r) => ({
        id: Number(r.id),
        title: r.title as string,
        description: (r.description as string | null) ?? null,
        uses_board: Number(r.uses_board) !== 0,
        world_id: Number(r.world_id),
        world_title: r.world_title as string,
        status: r.status as string,
      })),
    )
  }),
)

router.post(
  '/:worldId/courses/:courseId/import',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const worldId = Number(req.params.worldId)
    const courseId = Number(req.params.courseId)
    await requireWorld(worldId, userId)

    const missionIds = Array.isArray(req.body.mission_ids)
      ? (req.body.mission_ids as unknown[]).map(Number).filter(Number.isFinite)
      : []

    if (missionIds.length === 0) {
      res.json(await listMissions(worldId, courseId, userId))
      return
    }

    const [linkedRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM study_world_courses WHERE world_id = ? AND course_id = ?',
      [worldId, courseId],
    )
    if (Number(linkedRows[0]?.c) === 0) {
      throw new AppError('Primero agrega la materia a este mundo')
    }

    const [maxRows] = await pool.query<RowDataPacket[]>(
      'SELECT MAX(sort_order) AS m FROM study_missions WHERE world_id = ? AND course_id = ?',
      [worldId, courseId],
    )
    let maxOrder = maxRows[0]?.m == null ? -1 : Number(maxRows[0].m)

    for (const sourceId of missionIds) {
      const source = await fetchMission(sourceId, userId)
      if (source.course_id !== courseId) {
        throw new AppError('Solo puedes importar misiones de la misma materia')
      }
      if (source.world_id === worldId) continue
      maxOrder += 1
      await pool.query(
        `INSERT INTO study_missions
           (world_id, course_id, title, description, status, uses_board, source_mission_id, sort_order)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [
          worldId,
          courseId,
          source.title,
          source.description,
          source.uses_board ? 1 : 0,
          source.id,
          maxOrder,
        ],
      )
    }

    res.json(await listMissions(worldId, courseId, userId))
  }),
)

router.get(
  '/:worldId/challenges',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const worldId = Number(req.params.worldId)
    await requireWorld(worldId, userId)

    const missionId = req.query.mission_id
      ? Number(req.query.mission_id)
      : undefined
    const courseId = req.query.course_id
      ? Number(req.query.course_id)
      : undefined

    let sql = `
      SELECT id, user_id, world_id, scope, mission_id, course_id, difficulty,
             question_count, status, score, started_at, completed_at
      FROM study_challenges
      WHERE world_id = ? AND user_id = ?
    `
    const params: unknown[] = [worldId, userId]

    if (missionId != null && Number.isFinite(missionId)) {
      sql += ' AND mission_id = ?'
      params.push(missionId)
    } else if (courseId != null && Number.isFinite(courseId)) {
      sql += ' AND (course_id = ? OR (scope = \'course\' AND course_id = ?))'
      params.push(courseId, courseId)
    }
    sql += ' ORDER BY started_at DESC, id DESC LIMIT 50'

    const [rows] = await pool.query<RowDataPacket[]>(sql, params)
    res.json(rows.map(mapChallenge))
  }),
)

export default router
