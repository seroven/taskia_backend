import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from '../db/pool.js'
import { pool } from '../db/pool.js'
import { requireAuth, requireStudent } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/error.js'
import { callGemini, callGeminiTranscribe } from '../services/gemini.js'
import {
  AppError,
  extractJson,
  formatMysqlDateTime,
  looksLikeOfferingMorePractice,
  requiredChatTurns,
  soloBienCount,
  truncateChars,
} from '../utils/helpers.js'
import { fetchTask } from './tasks.js'

const router = Router()
const MAX_CONTEXT = 400
const MAX_MEMORY = 600
const MAX_SPEAK = 450
const MAX_BOARD = 1600
const MAX_LAST_TUTOR = 320

function emptyBoard() {
  return {
    type: 'taskia-grid',
    version: 1,
    source: 'taskia-grid',
    cols: 160,
    rows: 100,
    items: [],
  }
}

function coerceBoard(raw: unknown) {
  if (raw && typeof raw === 'object') {
    const rec = raw as { type?: string; source?: string; items?: unknown }
    if (rec.type === 'taskia-grid' || rec.source === 'taskia-grid') {
      return raw
    }
  }
  return emptyBoard()
}

function canOpenStudy(task: { status: string; difficulty_code: string }) {
  return (
    task.status === 'studying' ||
    (task.status === 'done' && task.difficulty_code === 'high')
  )
}

/** Instrucciones de pizarra (mismo contrato que taskia_desktop/src-tauri/src/study.rs). */
const DRAW_OPS_PROMPT = `Pizarra de salida: allow_ai_draw=true. Grilla 160×100. Origen arriba-izquierda. SOLO enteros de celda. NUNCA píxeles.
El sistema pinta en violeta (ignorá color). Empieza con {"op":"clear_board"}.

COORDENADAS (exactitud):
- Dibujá SOLO en el marco central: col 56–104, fila 36–64. No uses el origen (0,0).
- 1 celda = 1 unidad. Si una etiqueta de medida es N, ESE lado/base/altura/radio debe medir N celdas (w, h o |endCol-col|+1).
- Las etiquetas van en la celda contigua al lado que describen (no adentro de la figura, no sueltas lejos).
- Preferí shape con w/h o line con endCol/endRow. Si usás stamp, pasá w y h (no te fíes solo de scale).
- El sistema puede CENTRAR el grupo; las DISTANCIAS entre tus ops no se estiran: tienen que nacer ya correctas.

CÓMO DIBUJAR:
A) Geometría: figura real (stamp/shape). PROHIBIDO ASCII. Medidas = texto h=1.
B) Ecuación/secuencia/cálculo: SOLO texto. Sin recuadros de adorno.
C) NUNCA enmarques el problema.

Stamps: right_triangle, circle, square, arrow.
Shapes: rectangle|ellipse|triangle|line|arrow|text.
Línea/flecha: de (col,row) a (endCol,endRow).
Texto: h=1, w = caracteres.

Ejemplo texto: [{"op":"clear_board"},{"op":"shape","type":"text","col":64,"row":48,"w":11,"h":1,"label":"x + 5 = 12"}]
Ejemplo figura+medidas: [{"op":"clear_board"},{"op":"shape","type":"rectangle","col":70,"row":42,"w":8,"h":5},{"op":"shape","type":"text","col":73,"row":48,"w":1,"h":1,"label":"8"},{"op":"shape","type":"text","col":68,"row":44,"w":1,"h":1,"label":"5"}]
Ejemplo segmento: [{"op":"clear_board"},{"op":"shape","type":"line","col":64,"row":50,"endCol":75,"endRow":50},{"op":"shape","type":"text","col":69,"row":51,"w":2,"h":1,"label":"12"}]
`

function tutorSystemPrompt(allowAiDraw: boolean) {
  let p = `Tutor amable para niño ~10 años. Español latinoamericano, claro y breve.
No des la solución completa: guía con preguntas/pistas. Prioriza la tarea actual.
Recibes context_summary (esta tarea), last_tutor_message (tu burbuja anterior) y user_memory_summary. No el chat entero.
Mantén coherencia con el ejercicio abierto: si last_tutor_message o context_summary citan un número/ejercicio, NO preguntes de qué número hablan.
Pizarra de entrada: si board_has_drawing=false, ignora lo que haya dibujado el niño.
Responde SOLO JSON (sin markdown):
{"phase":"understanding|practicing|reviewing","speak_to_child":"...","ask_questions":[],"topic_summary":"...","context_summary":"...","user_memory_summary":"...","exercise":null,"draw_ops":[],"hints_level":0,"study_eval":{"passed":false,"evidence":""}}
context_summary ≤ 400 chars. Debe incluir SIEMPRE, si hay ejercicio abierto: "Ejercicio activo: …" con el número/datos exactos; no lo borres hasta resolverlo o cambiarlo. Resume aciertos del niño.
user_memory_summary ≤ 600 chars (si update_user_memory=false, repite el recibido).
exercise: usa el objeto cuando planteas un ejercicio nuevo (también en reviewing); si sigues el mismo, puedes dejar null pero conserva "Ejercicio activo" en context_summary.
Si study_passed_already=true → study_eval.passed=true y evidence corta "ya aprobado".
Si message_source=voice: el niño habló (audio transcrito). Usa ese relato para afinar topic_summary (de qué trata el tema, ≤120 chars) y context_summary. En speak_to_child, resume en 1 frase lo que entendiste y sigue guiando; no digas que “transcribiste” ni hables de micrófonos.
`
  if (!allowAiDraw) {
    p += `Estudio GUIADO SIN pizarra: todo ocurre en el chat. Explica, pregunta y practica en el diálogo. draw_ops siempre []. No pidas dibujar ni uses la pizarra.
En context_summary lleva SIEMPRE "Errores: N" (N = veces que el niño se equivocó en una pregunta o idea). Si se equivoca, anota el punto débil y la siguiente pregunta refuerza ESE punto.
Dominio (study_eval): passed=true SOLO si TODOS se cumplen (si falta uno → passed=false):
1) phase=reviewing (nunca en understanding ni practicing)
2) Piso de mensajes del niño: user_turns ≥ 6 + Errores. Si user_turns < 6+N → passed=false SIEMPRE. Cada error sube el piso.
3) No basta “sí/ok/ya/listo”: tiene que haber respondido de verdad y haber reforzado los puntos débiles.
4) no regalaste la solución completa en esos turnos
5) evidence debe citar en 1 frase qué demostró el niño (si no puedes citarlo → passed=false)
Por defecto passed=false. NO preguntes si quiere más ejercicios: si ya cumple el piso, celebra y dile que ya puede mover la tarea a Terminado.
`
  } else {
    p += DRAW_OPS_PROMPT
    p += `Dominio CON PIZARRA (study_eval.passed=true) SOLO si TODOS se cumplen:
1) El niño resolvió 2 problemas DISTINTOS él solo: sin que le dictes la respuesta ni el paso clave, y sin errores. Si se equivoca o lo ayudas a resolverlo, ese intento NO cuenta; plantea otro para que lo intente solo.
2) En context_summary lleva SIEMPRE "Solo bien: N/2" (N = problemas resueltos solo).
3) Cuando N llega a 2, NO marques passed=true en ese mismo turno. Primero, con tono cálido de tutor, pregúntale si quiere practicar OTRO TIPO de ejercicio de este mismo tema (un formato distinto). En ese turno passed=false.
4) passed=true SOLO después, si dice que no / que ya está / que no quiere más. Entonces celebra y dile que ya puede mover la tarea a Terminado.
5) Si pide más, dale ese otro tipo (passed=false). Cuando cierre y no quiera más, passed=true (los 2 solos ya valen).
6) phase=reviewing. evidence cita los 2 problemas que resolvió solo. Si no puedes citarlos → passed=false.
Por defecto passed=false.
`
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

async function ensureSession(taskId: number) {
  await pool.query(
    `INSERT INTO study_sessions (task_id, tutor_phase, topic_summary, context_summary, hints_level)
     VALUES (?, 'understanding', '', '', 0)
     ON CONFLICT (task_id) DO NOTHING`,
    [taskId],
  )
}

async function loadContext(taskId: number) {
  await ensureSession(taskId)
  const [sess] = await pool.query<RowDataPacket[]>(
    `SELECT tutor_phase, topic_summary, context_summary, hints_level, updated_at
     FROM study_sessions WHERE task_id = ?`,
    [taskId],
  )
  const s = sess[0]
  const [msgs] = await pool.query<RowDataPacket[]>(
    `SELECT role, content, created_at FROM study_messages
     WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
    [taskId],
  )
  return {
    task_id: taskId,
    updated_at: formatMysqlDateTime(s.updated_at as Date) ?? '',
    tutor_phase: s.tutor_phase as string,
    topic_summary: s.topic_summary as string,
    context_summary: s.context_summary as string,
    hints_level: Number(s.hints_level),
    messages: msgs.map((m) => ({
      role: m.role as string,
      content: m.content as string,
      created_at: formatMysqlDateTime(m.created_at as Date) ?? '',
    })),
  }
}

async function loadBoard(taskId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT board_json FROM study_boards WHERE task_id = ?',
    [taskId],
  )
  if (rows[0]?.board_json) {
    try {
      const raw = rows[0].board_json
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      return coerceBoard(parsed)
    } catch {
      /* fallthrough */
    }
  }
  const board = emptyBoard()
  await saveBoard(taskId, board)
  return board
}

async function saveBoard(taskId: number, board: unknown) {
  await pool.query(
    `INSERT INTO study_boards (task_id, board_json) VALUES (?, ?)
     ON CONFLICT (task_id) DO UPDATE SET board_json = EXCLUDED.board_json`,
    [taskId, JSON.stringify(board)],
  )
}

async function insertMessage(
  taskId: number,
  role: string,
  content: string,
  fromVoice = false,
) {
  let insertId = 0
  try {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO study_messages (task_id, role, content, from_voice)
       VALUES (?, ?, ?, ?)`,
      [taskId, role, content, fromVoice],
    )
    insertId = result.insertId
  } catch {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO study_messages (task_id, role, content) VALUES (?, ?, ?)`,
      [taskId, role, content],
    )
    insertId = result.insertId
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT created_at FROM study_messages WHERE id = ?',
    [insertId],
  )
  return {
    role,
    content,
    created_at: formatMysqlDateTime(rows[0]?.created_at as Date) ?? '',
  }
}

async function loadUserMemory(userId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT memory_summary FROM user_study_memory WHERE user_id = ?',
    [userId],
  )
  return (rows[0]?.memory_summary as string) ?? ''
}

async function saveUserMemory(userId: number, summary: string) {
  await pool.query(
    `INSERT INTO user_study_memory (user_id, memory_summary) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET memory_summary = EXCLUDED.memory_summary`,
    [userId, summary],
  )
}

async function saveSessionMeta(ctx: {
  task_id: number
  tutor_phase: string
  topic_summary: string
  context_summary: string
  hints_level: number
}) {
  await pool.query(
    `UPDATE study_sessions
     SET tutor_phase = ?, topic_summary = ?, context_summary = ?, hints_level = ?
     WHERE task_id = ?`,
    [
      ctx.tutor_phase,
      ctx.topic_summary,
      ctx.context_summary,
      ctx.hints_level,
      ctx.task_id,
    ],
  )
}

function extractActiveExerciseLine(summary: string) {
  for (const line of summary.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.toLowerCase().startsWith('ejercicio activo:')) return truncateChars(trimmed, 180)
  }
  return null
}

function ensureActiveExercise(
  summary: string,
  exercise: { title: string; instructions: string } | null,
  previous: string,
) {
  let base = summary.trim()
  if (exercise) {
    const line = `Ejercicio activo: ${truncateChars(exercise.title, 60)} — ${truncateChars(exercise.instructions, 140)}`
    const old = extractActiveExerciseLine(base)
    base = old ? base.replace(old, line) : base ? `${line}\n${base}` : line
  } else if (!extractActiveExerciseLine(base)) {
    const prev = extractActiveExerciseLine(previous)
    if (prev) base = base ? `${prev}\n${base}` : prev
  }
  return truncateChars(base, MAX_CONTEXT)
}

router.use(requireAuth)
router.use(requireStudent)

const MAX_VOICE_SECONDS = 90

router.post(
  '/transcribe',
  asyncHandler(async (req, res) => {
    const audioBase64 = String(req.body.audio_base64 ?? '').trim()
    const mimeType = String(req.body.mime_type ?? 'audio/webm').trim()
    const durationSeconds = Number(req.body.duration_seconds)

    if (!audioBase64) throw new AppError('Falta el audio')
    if (Number.isFinite(durationSeconds) && durationSeconds > MAX_VOICE_SECONDS) {
      throw new AppError('El audio supera el máximo de 90 segundos')
    }

    const result = await callGeminiTranscribe({
      audioBase64,
      mimeType,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : undefined,
      usage: { userId: req.user!.id, kind: 'transcribe' },
    })

    res.json(result)
  }),
)

router.get(
  '/:taskId',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const taskId = Number(req.params.taskId)
    const task = await fetchTask(taskId, userId)
    if (!canOpenStudy(task)) {
      throw new AppError(
        'Solo puedes abrir el modo estudio en tareas En estudio, o Terminado si son de dificultad Alta',
      )
    }
    const context = await loadContext(taskId)
    const board = task.uses_board ? await loadBoard(taskId) : emptyBoard()
    const userMemory = await loadUserMemory(userId)

    if (context.messages.length === 0) {
      const desc = task.description?.trim()
      const memoryHint = userMemory.trim()
        ? ' Si ya practicamos algo antes, podemos retomar desde ahí.'
        : ''
      const speak = desc
        ? `¡Hola! Vi tu tarea "${task.title}": ${truncateChars(desc, 160)}. Estoy aquí para ayudarte paso a paso.${memoryHint} ¿Qué parte quieres practicar primero?`
        : `¡Hola! Vi tu tarea "${task.title}". Estoy aquí para ayudarte paso a paso.${memoryHint} ¿Qué quieres practicar hoy?`
      context.topic_summary = task.title
      context.context_summary = `Inicio local. Tarea: "${task.title}".`
      context.messages.push(await insertMessage(taskId, 'assistant', speak))
      await saveSessionMeta(context)
    }

    res.json({ context, board, task })
  }),
)

router.put(
  '/:taskId/board',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const taskId = Number(req.params.taskId)
    const task = await fetchTask(taskId, userId)
    if (!task.uses_board) throw new AppError('Esta tarea no usa pizarra')
    await saveBoard(taskId, req.body.board ?? req.body)
    res.json({ ok: true })
  }),
)

router.post(
  '/:taskId/chat',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const taskId = Number(req.params.taskId)
    const task = await fetchTask(taskId, userId)
    if (!canOpenStudy(task)) {
      throw new AppError(
        'Solo puedes chatear en modo estudio en tareas En estudio, o Terminado si son de dificultad Alta',
      )
    }

    const message = String(req.body.user_message ?? req.body.userMessage ?? '').trim()
    if (!message) throw new AppError('Escribe un mensaje')
    const allowAiDraw =
      Boolean(req.body.allow_ai_draw ?? req.body.allowAiDraw) && task.uses_board
    const boardDescription = task.uses_board
      ? ((req.body.board_description ?? req.body.boardDescription) as string | null)
      : null
    const fromVoice = Boolean(req.body.from_voice ?? req.body.fromVoice)

    const context = await loadContext(taskId)
    const userMemory = await loadUserMemory(userId)
    context.messages.push(await insertMessage(taskId, 'user', message, fromVoice))
    const userTurns = context.messages.filter((m) => m.role === 'user').length
    const updateUserMemory = userTurns % 3 === 0

    const lastTutor =
      [...context.messages]
        .reverse()
        .find((m) => m.role === 'assistant')
        ?.content ?? ''
    const boardHas = Boolean(boardDescription?.trim())

    const boardMasteryHint =
      ' Anota "Solo bien: N/2". Evalúa study_eval: 2 problemas resueltos solo; al llegar a 2 pregunta si quiere otro tipo de ejercicio (passed=false); passed=true solo si declina.'
    let instruction = allowAiDraw
      ? boardHas
        ? 'Responde breve. Usa context + last_tutor_message + mensaje + pizarra. Conserva el ejercicio activo.' +
          boardMasteryHint +
          ' Incluye draw_ops con clear_board + stamps/shapes.'
        : 'Responde breve. Usa context + last_tutor_message + mensaje. Conserva el ejercicio activo.' +
          boardMasteryHint +
          ' Incluye draw_ops con clear_board + stamps/shapes (no dejes el ejercicio solo en texto).'
      : boardHas
        ? 'Responde breve. Usa context + last_tutor_message + mensaje + pizarra. Conserva el ejercicio activo. Anota "Errores: N". Piso user_turns ≥ 6+N. Refuerza puntos débiles. Si ya cumple el piso, puedes passed=true y celebrar Terminado (no preguntes si quiere más).'
        : 'Responde breve. Usa context + last_tutor_message + mensaje. Conserva el ejercicio activo. Ignora pizarra. Anota "Errores: N". Piso user_turns ≥ 6+N. Refuerza puntos débiles. Si ya cumple el piso, puedes passed=true y celebrar Terminado (no preguntes si quiere más).'
    if (fromVoice) {
      instruction +=
        ' El mensaje viene de voz (transcrito): prioriza afinar topic_summary y context_summary con lo que explicó el niño.'
    }

    const payload = {
      instruction,
      update_user_memory: updateUserMemory,
      user_turns: userTurns,
      study_passed_already: task.study_passed,
      message_source: fromVoice ? 'voice' : 'text',
      task: {
        title: truncateChars(task.title, 120),
        description: truncateChars(task.description ?? '', 220),
        course: task.course_name,
        difficulty: task.difficulty_name,
        difficulty_code: task.difficulty_code,
      },
      phase: context.tutor_phase,
      topic_summary: truncateChars(context.topic_summary, 120),
      context_summary: truncateChars(context.context_summary, MAX_CONTEXT),
      last_tutor_message: truncateChars(lastTutor, MAX_LAST_TUTOR),
      user_memory_summary: truncateChars(userMemory, MAX_MEMORY),
      hints_level: context.hints_level,
      board_has_drawing: boardHas,
      child_message: truncateChars(message, fromVoice ? 4000 : 800),
      ...(allowAiDraw ? { allow_ai_draw: true } : {}),
      ...(boardHas
        ? { board_drawing: truncateChars(boardDescription ?? '', MAX_BOARD) }
        : {}),
    }

    const raw = await callGemini({
      system: tutorSystemPrompt(allowAiDraw),
      user: JSON.stringify(payload),
      usage: { userId, kind: 'task_tutor' },
    })

    let value: Record<string, unknown>
    try {
      value = JSON.parse(extractJson(raw)) as Record<string, unknown>
    } catch {
      throw new AppError(
        'La IA respondió, pero no en el formato esperado. Probá enviar de nuevo (no gastamos un segundo intento automático para cuidar tokens).',
      )
    }

    const exerciseRaw = value.exercise as Record<string, unknown> | null | undefined
    const exercise =
      exerciseRaw && typeof exerciseRaw === 'object'
        ? {
            id: String(exerciseRaw.id ?? ''),
            title: String(exerciseRaw.title ?? ''),
            instructions: String(exerciseRaw.instructions ?? ''),
            expected_interaction: String(exerciseRaw.expected_interaction ?? ''),
          }
        : null

    const phase = String(value.phase ?? 'understanding')
    const evidence = String(
      (value.study_eval as { evidence?: string } | undefined)?.evidence ?? '',
    ).trim()
    const speakToChild = truncateChars(
      String(value.speak_to_child ?? '¡Genial! Cuéntame un poquito más y seguimos juntos.'),
      MAX_SPEAK,
    )
    const contextSummaryDraft = String(
      value.context_summary ?? context.context_summary,
    )

    const askQuestions = Array.isArray(value.ask_questions)
      ? (value.ask_questions as unknown[]).map(String)
      : []
    const offeringMore =
      looksLikeOfferingMorePractice(speakToChild) ||
      askQuestions.some((q) => looksLikeOfferingMorePractice(q))

    // Red de seguridad: Gemini tiende a aprobar pronto; forzar criterios duros.
    let passed = Boolean(
      (value.study_eval as { passed?: boolean } | undefined)?.passed,
    )
    if (task.study_passed) {
      passed = true
    } else {
      if (!allowAiDraw) {
        if (userTurns < requiredChatTurns(6, contextSummaryDraft)) passed = false
      }
      if (phase !== 'reviewing') passed = false
      if (!evidence) passed = false
      if (allowAiDraw) {
        if (offeringMore) passed = false
        const n = soloBienCount(contextSummaryDraft)
        if (n !== null && n < 2) passed = false
      }
    }

    const reply = {
      phase,
      speak_to_child: speakToChild,
      ask_questions: askQuestions,
      topic_summary: String(value.topic_summary ?? ''),
      context_summary: ensureActiveExercise(
        String(value.context_summary ?? context.context_summary),
        exercise,
        context.context_summary,
      ),
      user_memory_summary: truncateChars(
        updateUserMemory && String(value.user_memory_summary ?? '').trim()
          ? String(value.user_memory_summary)
          : userMemory || `Estudia "${task.title}" (${task.course_name}).`,
        MAX_MEMORY,
      ),
      exercise,
      draw_ops: allowAiDraw ? normalizeDrawOps(value.draw_ops) : [],
      hints_level: Number(value.hints_level ?? 0),
      study_eval: {
        passed,
        evidence: task.study_passed && !evidence ? 'ya aprobado' : evidence,
      },
    }

    context.tutor_phase = reply.phase
    if (reply.topic_summary.trim()) {
      context.topic_summary = truncateChars(reply.topic_summary, 120)
    }
    context.context_summary = reply.context_summary
    context.hints_level = reply.hints_level

    let visible = reply.speak_to_child
    if (reply.ask_questions.length) {
      visible += '\n\n'
      reply.ask_questions.forEach((q, i) => {
        visible += `${i + 1}. ${q}\n`
      })
    }
    if (reply.exercise) {
      visible += `\nEjercicio: ${reply.exercise.title}\n${reply.exercise.instructions}`
    }
    context.messages.push(await insertMessage(taskId, 'assistant', visible))
    await saveSessionMeta(context)
    if (updateUserMemory) await saveUserMemory(userId, reply.user_memory_summary)
    if (reply.study_eval.passed) {
      await pool.query('UPDATE tasks SET study_passed = TRUE WHERE id = ? AND user_id = ?', [
        taskId,
        userId,
      ])
    }

    res.json({
      reply,
      context,
      study_passed: task.study_passed || reply.study_eval.passed,
    })
  }),
)

export default router
