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
Si message_source=voice: el niño habló (audio transcrito). Usa ese relato para afinar topic_summary (de qué trata el tema) y context_summary. En speak_to_child, resume en 1 frase lo que entendiste y sigue guiando; no menciones micrófonos ni transcripción.
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

async function loadMissionStudyMaterial(missionId: number) {
  const [sessionRows] = await pool.query<RowDataPacket[]>(
    `SELECT topic_summary, context_summary
     FROM study_mission_sessions WHERE mission_id = ? LIMIT 1`,
    [missionId],
  )
  const [msgRows] = await pool.query<RowDataPacket[]>(
    `SELECT content
     FROM study_mission_messages
     WHERE mission_id = ? AND role = 'user'
     ORDER BY created_at ASC, id ASC
     LIMIT 40`,
    [missionId],
  )

  const userExplanations = msgRows
    .map((m) => String(m.content ?? '').trim())
    .filter(Boolean)
    .map((c) => truncateChars(c, 900))

  return {
    topic_summary: truncateChars(
      String(sessionRows[0]?.topic_summary ?? ''),
      200,
    ),
    context_summary: truncateChars(
      String(sessionRows[0]?.context_summary ?? ''),
      500,
    ),
    user_explanations: userExplanations,
    studied_text: truncateChars(userExplanations.join('\n---\n'), 3500),
  }
}

async function generateQuestionsBatch(
  missions: ReturnType<typeof mapMission>[],
  count: number,
  batchOffset: number,
) {
  const catalog = []
  for (const m of missions) {
    const study = await loadMissionStudyMaterial(m.id)
    catalog.push({
      id: m.id,
      title: m.title,
      description: m.description,
      uses_board: m.uses_board,
      course: m.course_name,
      topic_summary: study.topic_summary,
      context_summary: study.context_summary,
      studied_text: study.studied_text,
      has_user_content: study.user_explanations.length > 0,
    })
  }

  const system = `Generas preguntas de desafío para niños ~10 años. Español latinoamericano neutro.
NO enseñes: solo preguntas evaluables. Responde SOLO un JSON array (sin markdown).

REGLA DE CONTENIDO (la más importante):
- Pregunta SOLO sobre hechos, nombres, fechas, ideas o ejemplos que aparezcan en studied_text, topic_summary, context_summary o description de la misión.
- studied_text = lo que el niño contó o escribió sobre el tema en el estudio. Es la fuente principal.
- PROHIBIDO usar conocimiento general del tema si no está en esas fuentes (aunque el título diga "Independencia del Perú" u otro tema amplio).
- Si studied_text está vacío o es muy corto, limita las preguntas a lo poco que sí esté en description/topic_summary/context_summary. No inventes batallas, fechas o personajes extras.
- Las opciones incorrectas de multiple_choice pueden ser plausibles, pero la respuesta correcta DEBE basarse en el material estudiado.

SUFICIENCIA DEL MATERIAL (obligatorio):
- Primero evalúa cuántas preguntas DISTINTAS y justas se pueden hacer con el material real (sin repetir la misma idea con otras palabras).
- "count" es un MÁXIMO pedido, no una meta a rellenar. Si el material solo sostiene 4–8 preguntas, devolvé esas; NUNCA inventes para llegar a 20, 40 u 80.
- Un tema corto o poco estudiado NO es un examen largo. Prefiere pocas preguntas claras a muchas inventadas.
- Si ya no hay hechos nuevos, DETENTE y devolvé menos ítems. Un array más corto es correcto y preferible.
- No reformules la misma pregunta. Cada ítem debe evaluar un hecho o idea distinta del material.

Formato EXACTO de cada ítem:
{
  "mission_id": <number de la lista>,
  "kind": "multiple_choice" | "short_text" | "fill_blank" | "board_prompt",
  "prompt": "texto de la pregunta",
  "options": ["texto opción 1","texto opción 2","texto opción 3","texto opción 4"] | null,
  "answer_key": "A" | "B" | "C" | "D" | "respuesta breve",
  "requires_board": true | false
}

Reglas de tipo:
1) Si uses_board=true → kind="board_prompt", requires_board=true, options=null, answer_key=criterio breve según el material estudiado.
2) Si uses_board=false → SOLO "multiple_choice", "short_text" o "fill_blank"; requires_board=false.
3) Si kind="multiple_choice":
   - options = exactamente 4 strings (sin prefijo "A)" / "B)").
   - answer_key = solo "A"|"B"|"C"|"D" (A=primera opción).
   - Nunca options=null ni [].
4) Si kind="short_text" o "fill_blank": options=null; answer_key=respuesta breve tomada del material.
5) Devolvé como máximo ${count} preguntas (pueden ser menos). mission_id debe existir en la lista.
6) Mezcla tipos cuando uses_board=false (incluye varias multiple_choice) SOLO si hay material suficiente.
7) Si hay poco material, haz pocas preguntas simples sobre ese mismo material; no rellenes con trivia externa.

Ejemplo (solo válido si esos datos están en studied_text):
{"mission_id":1,"kind":"multiple_choice","prompt":"Según lo que estudiaste, ¿quién llegó desde el sur?","options":["José de San Martín","Simón Bolívar","Francisco Pizarro","Tupac Amaru"],"answer_key":"A","requires_board":false}`

  const user = JSON.stringify({
    max_count: count,
    batch_offset: batchOffset,
    missions: catalog,
    instruction: `Genera HASTA ${count} preguntas nuevas (pueden ser menos). ÚNICAMENTE con base en studied_text / topic_summary / context_summary / description. Si el material no alcanza para ${count} preguntas distintas y justas, devolvé solo las que sí se puedan sostener. No inventes para completar el cupo.`,
  })

  const raw = await callGemini({ system, user })
  console.log('[challenge:generate] raw Gemini response:\n', raw)
  const jsonText = extractJson(raw)
  let value: unknown
  try {
    value = JSON.parse(jsonText)
  } catch (err) {
    console.error(
      '[challenge:generate] JSON parse failed. extractJson=\n',
      jsonText,
      err,
    )
    throw new AppError('No se pudieron generar las preguntas')
  }
  if (!Array.isArray(value)) {
    console.error('[challenge:generate] expected array, got:', value)
    throw new AppError('Gemini no devolvió un array de preguntas')
  }
  return value as Array<Record<string, unknown>>
}

/** Tope duro según riqueza del material: evita exámenes enormes con poco estudio. */
function estimateMaxQuestionsFromMaterial(
  missions: Array<{
    description: string | null
    topic_summary: string
    context_summary: string
    studied_text: string
  }>,
  requested: number,
): number {
  let chars = 0
  let withBody = 0
  for (const m of missions) {
    const body = [m.studied_text, m.topic_summary, m.context_summary, m.description ?? '']
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .join('\n')
    if (body.length < 24) continue
    withBody += 1
    chars += body.length
  }

  if (withBody === 0) {
    // Solo títulos/descripciones muy pobres: pocas preguntas como máximo
    return Math.min(requested, 3)
  }

  // ~1 pregunta por ~110 caracteres de material útil, con piso suave por misión
  const fromChars = Math.max(withBody, Math.floor(chars / 110))
  const capped = Math.min(requested, fromChars)
  return Math.max(1, Math.min(requested, capped))
}

/** mysql2 puede devolver JSON ya parseado; Gemini a veces manda shapes raros. */
function normalizeOptionsList(raw: unknown): string[] | null {
  if (raw == null) return null

  let value: unknown = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed || trimmed === 'null') return null
    try {
      value = JSON.parse(trimmed)
    } catch {
      return null
    }
  }

  if (Array.isArray(value)) {
    const texts = value
      .map((item) => {
        if (typeof item === 'string') return item.trim()
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>
          const candidate =
            obj.text ?? obj.label ?? obj.option ?? obj.value ?? obj.content
          return typeof candidate === 'string' ? candidate.trim() : ''
        }
        return ''
      })
      .filter(Boolean)
      .map((t) => t.replace(/^[A-D][).:\-]\s*/i, '').trim())
      .filter(Boolean)
    return texts.length > 0 ? texts : null
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const ordered = ['A', 'B', 'C', 'D', 'a', 'b', 'c', 'd', '1', '2', '3', '4']
    const fromKeys: string[] = []
    for (const key of ordered) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim()) {
        fromKeys.push(v.trim().replace(/^[A-D][).:\-]\s*/i, ''))
      }
    }
    if (fromKeys.length >= 2) return fromKeys
  }

  return null
}

function normalizeAnswerKey(
  kind: string,
  answerKey: string,
  options: string[] | null,
) {
  const raw = answerKey.trim()
  if (kind !== 'multiple_choice') return raw
  const letter = /^[A-D]/i.exec(raw)?.[0]?.toUpperCase()
  if (letter) return letter
  if (options) {
    const idx = options.findIndex((o) => o.toLowerCase() === raw.toLowerCase())
    if (idx >= 0 && idx < 4) return String.fromCharCode(65 + idx)
  }
  return raw || 'A'
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
  const isCompleted = challenge.status === 'completed'

  const [qrows] = await pool.query<RowDataPacket[]>(
    `SELECT q.id, q.mission_id, q.sort_order, q.kind, q.prompt, q.options_json,
            q.answer_key, q.requires_board,
            a.is_correct, a.user_answer
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
    let options = normalizeOptionsList(q.options_json)
    const kind = q.kind as string
    if (kind === 'multiple_choice' && (!options || options.length < 2)) {
      console.warn(
        '[challenge:detail] MCQ without usable options',
        Number(q.id),
        q.options_json,
      )
      options = null
    }
    const answerKey = String(q.answer_key ?? '')
    const base = {
      id: Number(q.id),
      mission_id: q.mission_id == null ? null : Number(q.mission_id),
      sort_order: Number(q.sort_order),
      kind,
      prompt: q.prompt as string,
      options,
      requires_board: Number(q.requires_board) !== 0,
      answered,
      is_correct: q.is_correct == null ? null : Number(q.is_correct) !== 0,
      user_answer: null as string | null,
      correct_answer: null as string | null,
    }
    if (isCompleted) {
      base.user_answer =
        q.user_answer == null ? null : String(q.user_answer)
      base.correct_answer = formatCorrectAnswer(kind, answerKey, options)
    }
    return base
  })

  if (currentIndex >= questions.length) {
    currentIndex = Math.max(0, questions.length - 1)
    if (questions.length > 0 && questions.every((q) => q.answered)) {
      currentIndex = questions.length
    }
  }

  return { challenge, questions, current_index: currentIndex }
}

function formatCorrectAnswer(
  kind: string,
  answerKey: string,
  options: string[] | null,
) {
  const key = answerKey.trim()
  if (kind === 'multiple_choice' && options && options.length > 0) {
    const letter = /^[A-D]/i.exec(key)?.[0]?.toUpperCase()
    if (letter) {
      const idx = letter.charCodeAt(0) - 65
      const text = options[idx]
      if (text) return `${letter}. ${text}`
      return letter
    }
  }
  return key || '—'
}

function gradeMultipleChoice(answerText: string, answerKey: string) {
  const normalized = answerText.trim().toUpperCase()
  const key = answerKey.trim().toUpperCase()
  const keyLetter = /^[A-D](?=$|[\s).:-])/.exec(key)?.[0]
  const answerLetter = /^[A-D](?=$|[\s).:-])/.exec(normalized)?.[0]
  return Boolean(
    normalized &&
      key &&
      (normalized === key ||
        (keyLetter != null && answerLetter === keyLetter)),
  )
}

async function gradeOpenAnswersBatch(
  items: Array<{
    question_id: number
    prompt: string
    answer_key: string
    child_answer: string
    requires_board: boolean
    board_json_snip: string
  }>,
): Promise<Map<number, boolean>> {
  const results = new Map<number, boolean>()
  if (items.length === 0) return results

  const raw = await callGemini({
    system: `Juzgas si las respuestas del niño son correctas según answer_key.
NO des pistas ni enseñes. Sé razonable con variaciones de redacción.
Responde SOLO un JSON array:
[{"question_id":1,"correct":true|false}]
Debes incluir exactamente un objeto por cada pregunta recibida.`,
    user: JSON.stringify({ items }),
  })
  console.log('[challenge:grade-batch] raw Gemini response:\n', raw)

  let value: unknown
  try {
    value = JSON.parse(extractJson(raw))
  } catch {
    console.error('[challenge:grade-batch] parse failed', raw)
    value = []
  }

  if (Array.isArray(value)) {
    for (const row of value) {
      if (!row || typeof row !== 'object') continue
      const obj = row as Record<string, unknown>
      const id = Number(obj.question_id)
      if (!Number.isFinite(id)) continue
      results.set(id, Boolean(obj.correct))
    }
  }

  // Si Gemini omitió alguna, marcar false (no quemar otro request)
  for (const item of items) {
    if (!results.has(item.question_id)) results.set(item.question_id, false)
  }
  return results
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
    const fromVoice = Boolean(req.body.from_voice)
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

    let instruction = allowAiDraw
      ? 'Responde breve. Enseña el tema. Conserva ejercicio activo. Evalúa study_eval. Incluye draw_ops con clear_board + stamps/shapes (no dejes el ejercicio solo en texto).'
      : 'Responde breve. Enseña el tema. Conserva ejercicio activo. Evalúa study_eval.'
    if (fromVoice) {
      instruction +=
        ' El mensaje viene de voz (transcrito): prioriza afinar topic_summary y context_summary con lo que explicó el niño.'
    }

    const payload = JSON.stringify({
      instruction,
      user_turns: userTurns,
      mastered_already: mission.status === 'mastered',
      message_source: fromVoice ? 'voice' : 'text',
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
      child_message: truncateChars(message, fromVoice ? 4000 : 800),
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

    // No acumular intentos a medias en el historial: limpia los incompletos previos
    await pool.query(
      `DELETE FROM study_challenges
       WHERE user_id = ? AND status = 'in_progress'`,
      [userId],
    )

    const questionCount = await presetCount(scope, difficulty)
    const missions = await missionsForChallenge(
      userId,
      worldId,
      scope,
      missionId,
      courseId,
    )

    const materialSnapshots = []
    for (const m of missions) {
      const study = await loadMissionStudyMaterial(m.id)
      materialSnapshots.push({
        description: m.description,
        topic_summary: study.topic_summary,
        context_summary: study.context_summary,
        studied_text: study.studied_text,
      })
    }
    const total = estimateMaxQuestionsFromMaterial(
      materialSnapshots,
      questionCount,
    )
    if (total < questionCount) {
      console.log(
        `[challenge:start] capped questions ${questionCount} → ${total} based on study material`,
      )
    }

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
        total,
      ],
    )
    const challengeId = result.insertId

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
          // El modelo devolvió menos: el material ya no alcanza
          if (part.length < batch) break
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
        if (
          !['multiple_choice', 'short_text', 'fill_blank'].includes(kind)
        ) {
          kind = 'multiple_choice'
        }
      }

      const prompt =
        typeof item.prompt === 'string' ? item.prompt : '¿Listo?'
      let options = normalizeOptionsList(item.options)
      if (kind === 'multiple_choice') {
        if (!options || options.length < 2) {
          console.warn(
            '[challenge:start] MCQ missing options; falling back to short_text. item=',
            JSON.stringify(item),
          )
          kind = 'short_text'
          options = null
        } else if (options.length > 4) {
          options = options.slice(0, 4)
        } else {
          while (options.length < 4) {
            options.push(`Opción ${String.fromCharCode(65 + options.length)}`)
          }
        }
      } else {
        options = null
      }

      const answerKey = normalizeAnswerKey(
        kind,
        typeof item.answer_key === 'string' ? item.answer_key : '',
        options,
      )
      const optionsJson = options == null ? null : JSON.stringify(options)

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
      throw new AppError(
        'Todavía no hay suficiente material estudiado para armar un desafío. Seguí estudiando un poquito más e intentá de nuevo.',
      )
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

/** Descarta un desafío incompleto (no entra al historial). */
router.delete(
  '/challenges/:challengeId',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const challengeId = Number(req.params.challengeId)

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, status FROM study_challenges
       WHERE id = ? AND user_id = ? LIMIT 1`,
      [challengeId, userId],
    )
    if (!rows[0]) throw new AppError('Desafío no encontrado', 404)

    if (rows[0].status === 'completed') {
      throw new AppError('No se puede descartar un desafío ya completado')
    }

    await pool.query('DELETE FROM study_challenges WHERE id = ? AND user_id = ?', [
      challengeId,
      userId,
    ])
    res.json({ ok: true })
  }),
)

router.post(
  '/challenges/:challengeId/complete',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const challengeId = Number(req.params.challengeId)

    const [crows] = await pool.query<RowDataPacket[]>(
      `SELECT id, status FROM study_challenges
       WHERE id = ? AND user_id = ? LIMIT 1`,
      [challengeId, userId],
    )
    if (!crows[0]) throw new AppError('Desafío no encontrado', 404)
    if (crows[0].status === 'completed') {
      res.json(await getChallengeDetail(challengeId, userId))
      return
    }

    const answersRaw = Array.isArray(req.body.answers) ? req.body.answers : []
    if (answersRaw.length === 0) {
      throw new AppError('Faltan las respuestas del desafío')
    }

    const answerMap = new Map<
      number,
      { user_answer: string; board_json: unknown }
    >()
    for (const row of answersRaw) {
      if (!row || typeof row !== 'object') continue
      const obj = row as Record<string, unknown>
      const qid = Number(obj.question_id)
      if (!Number.isFinite(qid)) continue
      answerMap.set(qid, {
        user_answer:
          typeof obj.user_answer === 'string' ? obj.user_answer : '',
        board_json: obj.board_json ?? null,
      })
    }

    const [qrows] = await pool.query<RowDataPacket[]>(
      `SELECT id, kind, prompt, options_json, answer_key, requires_board
       FROM study_challenge_questions
       WHERE challenge_id = ?
       ORDER BY sort_order ASC, id ASC`,
      [challengeId],
    )
    if (qrows.length === 0) throw new AppError('El desafío no tiene preguntas')

    for (const q of qrows) {
      if (!answerMap.has(Number(q.id))) {
        throw new AppError('Debes responder todas las preguntas antes de terminar')
      }
    }

    const openItems: Array<{
      question_id: number
      prompt: string
      answer_key: string
      child_answer: string
      requires_board: boolean
      board_json_snip: string
    }> = []
    const graded = new Map<number, boolean>()

    for (const q of qrows) {
      const qid = Number(q.id)
      const kind = q.kind as string
      const answerKey = String(q.answer_key ?? '')
      const submitted = answerMap.get(qid)!
      const answerText = submitted.user_answer
      const requiresBoard = Number(q.requires_board) !== 0

      if (kind === 'multiple_choice') {
        graded.set(qid, gradeMultipleChoice(answerText, answerKey))
      } else {
        const boardSnip = submitted.board_json
          ? truncateChars(JSON.stringify(submitted.board_json), 500)
          : ''
        openItems.push({
          question_id: qid,
          prompt: String(q.prompt ?? ''),
          answer_key: answerKey,
          child_answer: truncateChars(answerText, 800),
          requires_board: requiresBoard,
          board_json_snip: boardSnip,
        })
      }
    }

    const openGrades = await gradeOpenAnswersBatch(openItems)
    for (const [qid, correct] of openGrades) graded.set(qid, correct)

    // Limpia respuestas previas (por si reintento) y guarda todo de una vez
    await pool.query(
      `DELETE a FROM study_challenge_answers a
       INNER JOIN study_challenge_questions q ON q.id = a.question_id
       WHERE q.challenge_id = ?`,
      [challengeId],
    )

    let correctCount = 0
    for (const q of qrows) {
      const qid = Number(q.id)
      const submitted = answerMap.get(qid)!
      const isCorrect = Boolean(graded.get(qid))
      if (isCorrect) correctCount += 1
      const boardRaw =
        submitted.board_json != null
          ? JSON.stringify(submitted.board_json)
          : null
      await pool.query(
        `INSERT INTO study_challenge_answers (question_id, user_answer, board_json, is_correct)
         VALUES (?, ?, ?, ?)`,
        [qid, submitted.user_answer, boardRaw, isCorrect ? 1 : 0],
      )
    }

    const total = qrows.length
    const score = Math.round((correctCount / total) * 100)
    const completedAt = formatMysqlDateTime(new Date()) ?? ''
    await pool.query(
      `UPDATE study_challenges
       SET status = 'completed', score = ?, completed_at = ?
       WHERE id = ?`,
      [score, completedAt, challengeId],
    )

    res.json(await getChallengeDetail(challengeId, userId))
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
      WHERE world_id = ? AND user_id = ? AND status = 'completed'
    `
    const params: unknown[] = [worldId, userId]

    if (missionId != null && Number.isFinite(missionId)) {
      sql += ' AND mission_id = ?'
      params.push(missionId)
    } else if (courseId != null && Number.isFinite(courseId)) {
      sql += ' AND (course_id = ? OR (scope = \'course\' AND course_id = ?))'
      params.push(courseId, courseId)
    }
    sql += ' ORDER BY completed_at DESC, id DESC LIMIT 50'

    const [rows] = await pool.query<RowDataPacket[]>(sql, params)
    res.json(rows.map(mapChallenge))
  }),
)

export default router
