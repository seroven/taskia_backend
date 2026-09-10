import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { pool } from '../db/pool.js'
import { requireAuth, requireStudent } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/error.js'
import { callGemini } from '../services/gemini.js'
import {
  AppError,
  extractJson,
  formatMysqlDateTime,
  looksLikeAskingMoreTopicContent,
  looksLikeOfferingMorePractice,
  requiredChatTurns,
  soloBienCount,
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
    course_name:
      r.course_name == null || r.course_name === ''
        ? null
        : String(r.course_name),
    mission_title:
      r.mission_title == null || r.mission_title === ''
        ? null
        : String(r.mission_title),
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
    `SELECT wc.world_id, wc.course_id, c.name AS course_name, wc.sort_order,
            COUNT(m.id) AS mission_count,
            COALESCE(SUM(m.status = 'mastered'), 0) AS mastered_count,
            COALESCE(SUM(m.status = 'studying'), 0) AS studying_count,
            COALESCE(SUM(m.status = 'pending'), 0) AS pending_count
     FROM study_world_courses wc
     INNER JOIN courses c ON c.id = wc.course_id
     LEFT JOIN study_missions m
       ON m.world_id = wc.world_id AND m.course_id = wc.course_id
     WHERE wc.world_id = ?
     GROUP BY wc.world_id, wc.course_id, c.name, wc.sort_order
     ORDER BY wc.sort_order ASC, c.name ASC`,
    [worldId],
  )
  return rows.map((r) => ({
    world_id: Number(r.world_id),
    course_id: Number(r.course_id),
    course_name: r.course_name as string,
    sort_order: Number(r.sort_order),
    mission_count: Number(r.mission_count) || 0,
    mastered_count: Number(r.mastered_count) || 0,
    studying_count: Number(r.studying_count) || 0,
    pending_count: Number(r.pending_count) || 0,
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
  fromVoice = false,
) {
  let insertId = 0
  try {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO study_mission_messages (mission_id, role, content, from_voice)
       VALUES (?, ?, ?, ?)`,
      [missionId, role, content, fromVoice ? 1 : 0],
    )
    insertId = result.insertId
  } catch {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO study_mission_messages (mission_id, role, content)
       VALUES (?, ?, ?)`,
      [missionId, role, content],
    )
    insertId = result.insertId
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT created_at FROM study_mission_messages WHERE id = ? LIMIT 1',
    [insertId],
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

const CHALLENGE_BOARD_DRAW_OPS = `Pizarra del ENUNCIADO (SOLO si kind=board_prompt y requires_board=true):
- Esto NO es un tutor: no converses, no des pistas, no dibujes la solución.
- "prompt" = instrucción breve (qué hay que hacer).
- "draw_ops" = lo que el niño DEBE VER para resolver. Tiene que coincidir con el tema del prompt.
- Si la pregunta NO usa pizarra (requires_board=false): draw_ops SIEMPRE []. No dibujes nada.

Cómo elegir las ops (regla dura):
1) Ecuación, cálculo, despejar, completar un número: SOLO texto grande con la expresión EXACTA.
   PROHIBIDO square, rectangle, circle, triangle, stamps.
   Ejemplo: prompt "Resuelve la ecuación"
   [{"op":"clear_board"},{"op":"shape","type":"text","x":0,"y":0,"label":"x + 5 = 12"}]
2) Geometría (área, perímetro, figura): usa el stamp/shape de ESA figura + labels de las medidas.
   Un square SOLO si el problema es un cuadrado. Un triángulo SOLO si es un triángulo.
3) Recta numérica: stamp number_line + marcas/texto.
4) Frase o dato: texto del dato, sin recuadro.

NUNCA enmarques el problema con un rectángulo o cuadrado “de adorno”.
NUNCA dejes draw_ops vacío si requires_board=true. Empieza con {"op":"clear_board"}.
Stamps permitidos: right_triangle, circle, square, number_line, arrow.
Shapes: rectangle|ellipse|triangle|line|arrow|text (x,y,w,h,label?,color?).
`

function drawableOps(raw: unknown): unknown[] {
  return normalizeDrawOps(raw).filter((op) => {
    if (!op || typeof op !== 'object') return false
    const kind = String((op as { op?: string }).op ?? '')
    return kind !== 'clear_board' && kind !== 'clear_layer' && kind !== 'clear'
  })
}

function hasUsableDrawOps(raw: unknown) {
  return drawableOps(raw).length > 0
}

function looksLikeSymbolicPrompt(prompt: string) {
  const t = prompt.toLowerCase()
  return /ecuaci|inc[oó]gnit|despej|\bx\s*[=+\-]|[=+\-×x*/÷]\s*\d|\d+\s*[=+\-×x*/÷]/.test(
    t,
  )
}

function drawOpsHaveProblemText(ops: unknown) {
  return drawableOps(ops).some((op) => {
    if (!op || typeof op !== 'object') return false
    const rec = op as { op?: string; type?: string; label?: string; id?: string }
    if (rec.op === 'shape' && rec.type === 'text' && String(rec.label ?? '').trim()) {
      return true
    }
    return false
  })
}

function isFrameShape(op: unknown) {
  if (!op || typeof op !== 'object') return false
  const rec = op as { op?: string; type?: string; id?: string }
  if (rec.op === 'stamp' && rec.id === 'square') return true
  if (rec.op === 'shape' && (rec.type === 'rectangle' || rec.type === 'square')) {
    return true
  }
  return false
}

function sanitizeBoardDrawOps(prompt: string, ops: unknown): unknown[] {
  let next = normalizeDrawOps(ops)
  if (looksLikeSymbolicPrompt(prompt)) {
    next = next.filter((op) => !isFrameShape(op))
  }
  return next
}

function drawOpsAreGenericFrame(ops: unknown) {
  const drawable = drawableOps(ops)
  if (drawable.length === 0) return true
  return drawable.every(isFrameShape) && !drawOpsHaveProblemText(ops)
}

function itemWantsBoard(
  item: Record<string, unknown>,
  missionUsesBoard: boolean,
) {
  if (!missionUsesBoard) return false
  const kind = String(item.kind ?? '')
  if (
    kind === 'multiple_choice' ||
    kind === 'short_text' ||
    kind === 'fill_blank'
  ) {
    return false
  }
  if (kind === 'board_prompt') return true
  return item.requires_board === true || item.requires_board === 1
}

function drawOpsFitPrompt(prompt: string, ops: unknown) {
  if (!hasUsableDrawOps(ops)) return false
  if (drawOpsAreGenericFrame(ops)) return false
  if (looksLikeSymbolicPrompt(prompt) && !drawOpsHaveProblemText(ops)) return false
  return true
}

function fallbackDrawOpsForPrompt(prompt: string): unknown[] {
  const label = truncateChars(prompt.trim() || 'Resuelve en la pizarra', 80)
  return [
    { op: 'clear_board' },
    { op: 'shape', type: 'text', x: 0, y: 0, label },
  ]
}

function describeBoardJson(raw: unknown): string {
  if (raw == null) return ''
  let value: unknown = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return ''
    try {
      value = JSON.parse(trimmed) as unknown
    } catch {
      return truncateChars(trimmed, 800)
    }
  }
  if (!value || typeof value !== 'object') return ''
  const rec = value as { elements?: unknown }
  const elements = Array.isArray(rec.elements) ? rec.elements : []
  const alive = elements.filter((el) => {
    if (!el || typeof el !== 'object') return false
    return !(el as { isDeleted?: boolean }).isDeleted
  }) as Array<Record<string, unknown>>
  if (alive.length === 0) return 'La pizarra está vacía.'
  const lines = alive.slice(0, 40).map((el, index) => {
    const type = String(el.type ?? 'forma')
    const text = typeof el.text === 'string' ? el.text.trim() : ''
    const layer =
      el.customData && typeof el.customData === 'object'
        ? String((el.customData as { layer?: string }).layer ?? '')
        : ''
    const who = layer === 'ai' ? 'enunciado' : 'alumno'
    if (type === 'text' && text) return `${index + 1}. [${who}] texto "${text}"`
    if (text) return `${index + 1}. [${who}] ${type} "${text}"`
    return `${index + 1}. [${who}] ${type}`
  })
  const extra = alive.length > 40 ? `\n…y ${alive.length - 40} elementos más.` : ''
  return `La pizarra tiene ${alive.length} elemento(s):\n${lines.join('\n')}${extra}`
}

async function ensureChallengeBoardDrawOps(
  items: Array<Record<string, unknown>>,
  missions: MissionRow[],
  userId: number,
) {
  const byId = new Map(missions.map((m) => [m.id, m]))
  const boardItems: Array<{ item: Record<string, unknown>; prompt: string }> = []
  for (const item of items) {
    let mid =
      typeof item.mission_id === 'number'
        ? item.mission_id
        : Number(item.mission_id)
    if (!Number.isFinite(mid) || !byId.has(mid)) mid = missions[0]?.id ?? 0
    const mission = byId.get(mid)
    if (!itemWantsBoard(item, Boolean(mission?.uses_board))) continue
    boardItems.push({
      item,
      prompt: typeof item.prompt === 'string' ? item.prompt : '¿Listo?',
    })
  }
  if (boardItems.length === 0) return

  const toDraw = boardItems.filter(
    (row) => !drawOpsFitPrompt(row.prompt, row.item.draw_ops),
  )

  if (toDraw.length > 0) {
    try {
      const raw = await callGemini({
        system: `Dibujas el ENUNCIADO de problemas de pizarra para niños ~10 años.
NO dibujes la solución. NO enseñes. Responde SOLO un JSON array.
Cada ítem: {"index":0,"draw_ops":[...]}
${CHALLENGE_BOARD_DRAW_OPS}
Si el prompt menciona una ecuación o un cálculo, el label de texto DEBE ser esa expresión (ej. "x + 5 = 12"), no un cuadrado.
Incluye exactamente un objeto por cada problema recibido.`,
        user: JSON.stringify({
          problems: toDraw.map((row, index) => ({
            index,
            prompt: row.prompt,
            answer_key:
              typeof row.item.answer_key === 'string' ? row.item.answer_key : '',
          })),
        }),
        usage: { userId, kind: 'challenge_generate' },
      })
      const parsed = JSON.parse(extractJson(raw)) as unknown
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (!row || typeof row !== 'object') continue
          const rec = row as Record<string, unknown>
          const index = Number(rec.index)
          if (!Number.isFinite(index) || !toDraw[index]) continue
          if (drawOpsFitPrompt(toDraw[index]!.prompt, rec.draw_ops)) {
            toDraw[index]!.item.draw_ops = sanitizeBoardDrawOps(
              toDraw[index]!.prompt,
              rec.draw_ops,
            )
          }
        }
      }
    } catch (err) {
      console.error('[challenge:board-ops] no se pudieron completar draw_ops', err)
    }
  }

  for (const row of boardItems) {
    if (!drawOpsFitPrompt(row.prompt, row.item.draw_ops)) {
      row.item.draw_ops = fallbackDrawOpsForPrompt(row.prompt)
    }
  }
}

function missionTutorPrompt(allowAiDraw: boolean): string {
  let p = `Tutor amable para niño ~10 años. Español latinoamericano, claro y breve.
Enseñas un TEMA completo (misión), no una tarea escolar suelta. Guía con preguntas/pistas; no des la solución completa.
Recibes context_summary, last_tutor_message. Conserva coherencia con el ejercicio/ejemplo abierto.
Pizarra de entrada: si board_has_drawing=false, ignora lo que haya dibujado el niño.
Responde SOLO JSON (sin markdown):
{"phase":"understanding|practicing|reviewing","speak_to_child":"...","ask_questions":[],"topic_summary":"...","context_summary":"...","draw_ops":[],"hints_level":0,"study_eval":{"passed":false,"evidence":""}}
context_summary ≤ 400 chars; incluye "Ejercicio activo: …" si hay práctica abierta. Anota qué partes del tema ya cubrió el niño y cuáles faltan.

RECORRIDO OBLIGATORIO del tema (no saltes etapas):
1) Básico: nombres, definiciones, hechos claros del título/descripción y de lo que el niño contó.
2) Comprensión: que lo explique con sus palabras (qué, quién, cuándo, para qué).
3) Observación: preguntas que exigen fijarse en detalles (orden de hechos, diferencias, causas, “¿qué pasaría si…?”, un ejemplo propio, un detalle que mencionó antes).
Cubre el tema ENTERO. Si el material tiene varias ideas, recórrelas; no apruebes por un solo fragmento bien dicho.

Si mastered_already=true → passed=true y evidence "ya dominado".
Si message_source=voice: el niño habló (audio transcrito). Usa ese relato para afinar topic_summary (de qué trata el tema) y context_summary. En speak_to_child, resume en 1 frase lo que entendiste y sigue guiando; no menciones micrófonos ni transcripción.
`
  if (!allowAiDraw) {
    p += `draw_ops siempre []. No dibujes en la pizarra. Todo el recorrido (básico + observación) ocurre en el chat.
En context_summary lleva SIEMPRE "Errores: N" (N = veces que el niño se equivocó). Si se equivoca, la siguiente pregunta refuerza ese punto débil. Pregunta TODO lo posible del tema (hechos, causas, detalles, ejemplos).
Dominio (study_eval.passed=true) SOLO si TODOS se cumplen. Si falta uno → passed=false:
1) phase=reviewing (nunca en understanding ni practicing)
2) Piso de mensajes del niño: user_turns ≥ 10 + Errores. Si user_turns < 10+N → passed=false SIEMPRE. Cada error sube el piso.
3) Cubriste el tema de punta a punta (no un dato suelto). No basta “sí/ok/ya/listo”.
4) no regalaste las respuestas completas en esos turnos
5) Cuando el piso ya se cumple, NO marques passed=true en ese mismo turno. Primero, con tono cálido, pregunta si queda MÁS CONTENIDO de este tema que necesiten estudiar. En ese turno passed=false y anota en context_summary "Cierre: preguntado".
6) passed=true SOLO después, si dice que no / que ya está / que no hay más. Entonces celebra y dile que ya dominó el tema.
7) Si pide más, sigue recorriendo ese contenido (passed=false, quita "Cierre: preguntado"). Cuando cierre y no quiera más, passed=true.
8) evidence cita en 1–2 frases QUÉ demostró y qué partes cubrió; si no puedes citarlo → passed=false
Por defecto passed=false.
`
  } else {
    p += MISSION_DRAW_OPS_PROMPT
    p += `El recorrido básico → observación sirve para explicar el tema; NO exijas 7 turnos ni 3 aciertos de chat. El dominio se decide con los 2 problemas en pizarra.
Dominio CON PIZARRA (study_eval.passed=true) SOLO si TODOS se cumplen:
1) El niño resolvió 2 problemas DISTINTOS él solo: sin que le dictes la respuesta ni el paso clave, y sin errores. Si se equivoca o lo ayudas a resolverlo, ese intento NO cuenta; plantea otro para que lo intente solo.
2) En context_summary lleva SIEMPRE "Solo bien: N/2" (N = problemas resueltos solo).
3) Cuando N llega a 2, NO marques passed=true en ese mismo turno. Primero, con tono cálido de tutor, pregúntale si quiere practicar OTRO TIPO de ejercicio de este mismo tema (un formato distinto). En ese turno passed=false.
4) passed=true SOLO después, si dice que no / que ya está / que no quiere más. Entonces celebra y dile que ya dominó el tema.
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
       LEFT JOIN study_world_courses wc
         ON wc.world_id = m.world_id AND wc.course_id = m.course_id
       WHERE m.world_id = ? AND w.user_id = ?
       ORDER BY wc.sort_order ASC, c.name ASC, m.sort_order ASC`,
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

type MissionRow = ReturnType<typeof mapMission>

function shuffleArray<T>(items: T[]): T[] {
  const next = [...items]
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = next[i]!
    next[i] = next[j]!
    next[j] = tmp
  }
  return next
}

function groupMissionsByCourse(missions: MissionRow[]) {
  const groups: Array<{
    course_id: number
    course_name: string
    missions: MissionRow[]
  }> = []
  const index = new Map<number, (typeof groups)[number]>()
  for (const mission of missions) {
    let group = index.get(mission.course_id)
    if (!group) {
      group = {
        course_id: mission.course_id,
        course_name: mission.course_name,
        missions: [],
      }
      index.set(mission.course_id, group)
      groups.push(group)
    }
    group.missions.push(mission)
  }
  return groups
}

function distributeQuestionCounts(weights: number[], total: number): number[] {
  const sum = weights.reduce((acc, n) => acc + n, 0)
  if (sum <= 0 || total <= 0) return weights.map(() => 0)
  const raw = weights.map((w) => (total * w) / sum)
  const counts = raw.map((n) => Math.floor(n))
  let leftover = total - counts.reduce((acc, n) => acc + n, 0)
  const order = raw
    .map((n, i) => ({ i, frac: n - Math.floor(n) }))
    .sort((a, b) => b.frac - a.frac)
  for (const item of order) {
    if (leftover <= 0) break
    counts[item.i] += 1
    leftover -= 1
  }
  return counts
}

async function generateQuestionsBatch(
  missions: MissionRow[],
  count: number,
  batchOffset: number,
  options: {
    scope: string
    avoidPrompts?: string[]
    userId: number
  },
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

  const mixRule =
    options.scope === 'course'
      ? `- Alcance MATERIA: mezcla las misiones. NO agrupes por “tema 1, tema 2”. Intercala preguntas de distintos temas.`
      : options.scope === 'world'
        ? `- Alcance MUNDO: estas misiones son de UNA sola materia. Mezcla los temas DENTRO de esta materia.`
        : `- Alcance TEMA: todas las preguntas son de esta misión.`

  const boardMissionCount = missions.filter((m) => m.uses_board).length
  const maxTheoIfBoard = Math.round(count / 11)
  const minBoardIfBoard = Math.max(0, count - maxTheoIfBoard)
  const boardMixRules =
    boardMissionCount === 0
      ? `Reglas de tipo (SIN pizarra):
- NUNCA kind="board_prompt"; requires_board=false; draw_ops=[].
- La mayoría deben ser EJERCICIOS en texto (aplicar, elegir un caso concreto). Teóricas (definir, “qué es…”, nombrar SIN resolver) como máximo 1 o 2 en el lote, salvo que el material sea solo conceptual.`
      : `Reglas de tipo (PIZARRA):
- Primero decidí si el tema de cada misión REQUIERE pizarra para practicar.
  SÍ requiere: hay que calcular, despejar, construir, dibujar una figura/diagrama o mostrar un procedimiento en el lienzo.
  NO requiere: solo se nombra, define, fecha, clasifica o reconoce (aunque uses_board=true). Entonces NO uses pizarra: trátalo como teórico (MCQ/texto).
- Si SÍ requiere pizarra: priorizá ejercicios prácticos en el lienzo. Relación OBLIGATORIA ≈ 1 pregunta teórica por cada 10 de pizarra (unas 1 de cada 11 es teórica).
  Teórica = multiple_choice / short_text / fill_blank (definir o nombrar). El resto = kind="board_prompt".
  NO conviertas un cálculo o procedimiento en opción múltiple para evitar la pizarra.
${
  boardMissionCount === missions.length
    ? `  En ESTE lote de ${count}: máximo ${maxTheoIfBoard} teórica(s) y al menos ${minBoardIfBoard} board_prompt (si el tema sí se resuelve en el lienzo).`
    : `  Aplica esa proporción 1/10 a las preguntas de las misiones que sí se resuelven en el lienzo. Misiones uses_board=false: NUNCA board_prompt.`
}
- uses_board=false: NUNCA board_prompt; requires_board=false; draw_ops=[].`

  const system = `Generas preguntas de desafío para niños ~10 años. Español latinoamericano neutro.
NO enseñes y NO converses: solo enunciados evaluables. Responde SOLO un JSON array (sin markdown).

REGLA DE CONTENIDO (la más importante):
- Pregunta SOLO sobre hechos, nombres, fechas, ideas o ejemplos que aparezcan en studied_text, topic_summary, context_summary o description de la misión.
- studied_text = lo que el niño contó o escribió sobre el tema en el estudio. Es la fuente principal.
- PROHIBIDO usar conocimiento general del tema si no está en esas fuentes (aunque el título diga "Independencia del Perú" u otro tema amplio).
- Si studied_text está vacío o es muy corto, limita las preguntas a lo poco que sí esté en description/topic_summary/context_summary. No inventes batallas, fechas o personajes extras.
- Las opciones incorrectas de multiple_choice pueden ser plausibles, pero la respuesta correcta DEBE basarse en el material estudiado.

CUOTA (obligatorio):
- El objetivo es generar ${count} preguntas DISTINTAS. Intenta LLEGAR a esa cantidad.
- Cubre todos los hechos útiles del material. Si el tema se resuelve en pizarra, cubrí tipos de ejercicio distintos (números o casos distintos), no un rosario de definiciones.
- Si el tema es conceptual, cubrí personas, lugares, fechas, causas, consecuencias, ejemplos, definiciones, orden de eventos.
- Cambia el ángulo o el formato para aprovechar el mismo material SIN repetir ni parafrasear la misma pregunta.
- Solo devolvé MENOS de ${count} si de verdad ya no queda ningún hecho o detalle distinto. Un recorte grande está mal si el material aún da para más.
- NUNCA inventes datos que no estén en el material para rellenar (p. ej. no armes un examen de 80 con dos temas cortos).

${mixRule}

Formato EXACTO de cada ítem:
{
  "mission_id": <number de la lista>,
  "kind": "multiple_choice" | "short_text" | "fill_blank" | "board_prompt",
  "prompt": "texto de la pregunta / enunciado",
  "options": ["texto opción 1","texto opción 2","texto opción 3","texto opción 4"] | null,
  "answer_key": "A" | "B" | "C" | "D" | "respuesta breve o criterio",
  "requires_board": true | false,
  "draw_ops": [] | [ops de pizarra]
}

${boardMixRules}

Formato de cada tipo:
- kind="multiple_choice": options = exactamente 4 strings (sin prefijo "A)" / "B)"); answer_key = solo "A"|"B"|"C"|"D" (A=primera opción); nunca options=null ni []; requires_board=false; draw_ops=[].
- kind="short_text" o "fill_blank": options=null; answer_key=respuesta breve tomada del material; requires_board=false; draw_ops=[].
- kind="board_prompt": options=null; answer_key=criterio breve de corrección; requires_board=true; draw_ops=[] (el dibujo del enunciado se arma después).
- Si requires_board=false: draw_ops SIEMPRE [].
- Devolvé como máximo ${count} preguntas. mission_id debe existir en la lista.

Ejemplo teórica (solo si esos datos están en studied_text):
{"mission_id":1,"kind":"multiple_choice","prompt":"Según lo que estudiaste, ¿quién llegó desde el sur?","options":["José de San Martín","Simón Bolívar","Francisco Pizarro","Tupac Amaru"],"answer_key":"A","requires_board":false,"draw_ops":[]}
Ejemplo pizarra (solo si el tema se resuelve en el lienzo):
{"mission_id":1,"kind":"board_prompt","prompt":"Resuelve en la pizarra: 3/4 + 1/8","options":null,"answer_key":"7/8","requires_board":true,"draw_ops":[]}`

  const user = JSON.stringify({
    target_count: count,
    batch_offset: batchOffset,
    already_asked: options.avoidPrompts ?? [],
    missions: catalog,
    instruction:
      boardMissionCount === 0
        ? `Genera ${count} preguntas nuevas, distintas entre sí y distintas de already_asked. Casi todas EJERCICIOS en texto; teóricas como máximo 1 o 2 (salvo material solo conceptual). Sin pizarra. ÚNICAMENTE con base en studied_text / topic_summary / context_summary / description.`
        : boardMissionCount === missions.length
          ? `Genera ${count} preguntas nuevas, distintas entre sí y distintas de already_asked. Si el tema se resuelve en el lienzo: máximo ${maxTheoIfBoard} teórica(s) y al menos ${minBoardIfBoard} board_prompt (relación 1 teórica / 10 pizarra). Si el tema NO pide pizarra para practicar (solo nombrar/definir), no inventes board_prompt. ÚNICAMENTE con base en studied_text / topic_summary / context_summary / description.`
          : `Genera ${count} preguntas nuevas, distintas entre sí y distintas de already_asked. En misiones que sí se resuelven en pizarra: ~1 teórica por cada 10 board_prompt. En misiones conceptuales o uses_board=false: texto/MCQ, sin pizarra. ÚNICAMENTE con base en studied_text / topic_summary / context_summary / description.`,
  })

  const raw = await callGemini({
    system,
    user,
    usage: { userId: options.userId, kind: 'challenge_generate' },
  })
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

async function generateQuestionsUpTo(
  missions: MissionRow[],
  count: number,
  scope: string,
  userId: number,
): Promise<Array<Record<string, unknown>>> {
  if (count <= 0 || missions.length === 0) return []
  const collected: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  let emptyStreak = 0

  const takeNew = (part: Array<Record<string, unknown>>) => {
    let added = 0
    for (const item of part) {
      const prompt =
        typeof item.prompt === 'string' ? item.prompt.trim().toLowerCase() : ''
      if (!prompt || seen.has(prompt)) continue
      seen.add(prompt)
      collected.push(item)
      added += 1
      if (collected.length >= count) break
    }
    return added
  }

  while (collected.length < count && emptyStreak < 2) {
    const need = Math.min(12, count - collected.length)
    const part = await generateQuestionsBatch(missions, need, collected.length, {
      scope,
      avoidPrompts: [...seen],
      userId,
    })
    const added = takeNew(part)
    if (added === 0) emptyStreak += 1
    else emptyStreak = 0
  }

  return collected.slice(0, count)
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
    return Math.min(requested, 3)
  }

  // Más generoso: varios ángulos por hecho, sin abrir la puerta a 80 preguntas con poco texto.
  const fromChars = Math.floor(chars / 40)
  const fromMissions = withBody * 8
  const estimated = Math.max(fromChars, fromMissions)
  return Math.max(1, Math.min(requested, estimated))
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

export async function getChallengeDetail(challengeId: number, userId: number) {
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
            q.answer_key, q.requires_board, q.prompt_draw_ops,
            a.is_correct, a.user_answer,
            m.course_id, c.name AS course_name
     FROM study_challenge_questions q
     LEFT JOIN study_challenge_answers a ON a.question_id = q.id
     LEFT JOIN study_missions m ON m.id = q.mission_id
     LEFT JOIN courses c ON c.id = m.course_id
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
      course_id: q.course_id == null ? null : Number(q.course_id),
      course_name: q.course_name == null ? null : String(q.course_name),
      sort_order: Number(q.sort_order),
      kind,
      prompt: q.prompt as string,
      options,
      requires_board: Number(q.requires_board) !== 0,
      prompt_draw_ops:
        Number(q.requires_board) !== 0
          ? normalizeDrawOps(q.prompt_draw_ops)
          : [],
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
    board_description: string
  }>,
  userId: number,
  boardImages: Array<{ question_id: number; data: string }> = [],
): Promise<Map<number, boolean>> {
  const results = new Map<number, boolean>()
  if (items.length === 0) return results

  const images = boardImages.slice(0, 6).map((image) => ({
    data: image.data,
    caption: `Pizarra del alumno para question_id=${image.question_id}. Úsala para juzgar el dibujo, no el enunciado de la IA.`,
  }))

  const raw = await callGemini({
    system: `Juzgas si las respuestas del niño son correctas según answer_key.
NO des pistas ni enseñes. Sé razonable con variaciones de redacción.
Para preguntas de pizarra (requires_board=true):
- El niño NO conversó con un tutor. Solo dibujó la resolución y, a veces, dejó una nota breve.
- Juzga sobre todo board_description (y la imagen si viene). La nota es apoyo, no un chat.
- Distingue el enunciado dibujado por la IA ([enunciado]) de lo que agregó el alumno ([alumno]).
- correct=true solo si el alumno resolvió el problema, no por copiar el enunciado.
Responde SOLO un JSON array:
[{"question_id":1,"correct":true|false}]
Debes incluir exactamente un objeto por cada pregunta recibida.`,
    user: JSON.stringify({ items }),
    boardImages: images,
    usage: { userId, kind: 'challenge_grade' },
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
router.use(requireStudent)

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
      }. Empezamos por lo básico y luego te haré preguntas para fijarte bien en los detalles. Cuéntame qué sabes o qué te confunde.`
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
    const userMsg = await insertMissionMessage(
      missionId,
      'user',
      message,
      fromVoice,
    )
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
      ? 'Responde breve. Conserva ejercicio activo. Anota "Solo bien: N/2". Evalúa study_eval: 2 problemas resueltos solo; al llegar a 2 pregunta si quiere otro tipo de ejercicio (passed=false); passed=true solo si declina. Incluye draw_ops con clear_board + stamps/shapes (no dejes el ejercicio solo en texto).'
      : 'Responde breve. Enseña el tema completo (básico + observación). Conserva ejercicio activo. Anota "Errores: N". Piso user_turns ≥ 10+N. Pregunta todo lo posible del tema. Al cumplir el piso pregunta si queda más contenido (passed=false); passed=true solo si declina. Sin pizarra.'
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
      usage: { userId, kind: 'mission_tutor' },
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

    if (!allowAiDraw) {
      if (userTurns < requiredChatTurns(10, reply.context_summary)) {
        reply.study_eval.passed = false
      }
      const askingMoreContent =
        looksLikeAskingMoreTopicContent(reply.speak_to_child) ||
        reply.ask_questions.some((q) => looksLikeAskingMoreTopicContent(q))
      if (askingMoreContent) reply.study_eval.passed = false
      if (
        reply.study_eval.passed &&
        !looksLikeAskingMoreTopicContent(lastTutorMsg?.content ?? '') &&
        !/cierre:\s*preguntado/i.test(context.context_summary)
      ) {
        reply.study_eval.passed = false
      }
    }
    if (reply.phase !== 'reviewing') reply.study_eval.passed = false
    if (!reply.study_eval.evidence.trim()) reply.study_eval.passed = false
    if (allowAiDraw) {
      const offeringMore =
        looksLikeOfferingMorePractice(reply.speak_to_child) ||
        reply.ask_questions.some((q) => looksLikeOfferingMorePractice(q))
      if (offeringMore) reply.study_eval.passed = false
      const n = soloBienCount(reply.context_summary)
      if (n !== null && n < 2) reply.study_eval.passed = false
    }
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
      if (scope === 'world') {
        const groups = groupMissionsByCourse(missions)
        const counts = distributeQuestionCounts(
          groups.map((g) => g.missions.length),
          total,
        )
        for (let i = 0; i < groups.length; i += 1) {
          const group = groups[i]!
          const need = counts[i] ?? 0
          if (need <= 0) continue
          const part = await generateQuestionsUpTo(
            group.missions,
            need,
            'world',
            userId,
          )
          generated.push(...shuffleArray(part))
        }
      } else if (scope === 'course') {
        generated = shuffleArray(
          await generateQuestionsUpTo(missions, total, 'course', userId),
        )
      } else {
        generated = await generateQuestionsUpTo(missions, total, 'mission', userId)
      }
    } catch (err) {
      await pool.query('DELETE FROM study_challenges WHERE id = ?', [
        challengeId,
      ])
      throw err
    }

    try {
      await ensureChallengeBoardDrawOps(generated, missions, userId)
    } catch (err) {
      console.error('[challenge:start] ensure board draw_ops failed', err)
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
      const wantsBoard = itemWantsBoard(item, mission.uses_board)
      let requiresBoard = wantsBoard
      if (wantsBoard) {
        kind = 'board_prompt'
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
      const promptDrawOps = requiresBoard
        ? JSON.stringify(
            drawOpsFitPrompt(prompt, item.draw_ops)
              ? normalizeDrawOps(item.draw_ops)
              : fallbackDrawOpsForPrompt(prompt),
          )
        : null

      await pool.query(
        `INSERT INTO study_challenge_questions
           (challenge_id, mission_id, sort_order, kind, prompt, options_json, answer_key, requires_board, prompt_draw_ops)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          challengeId,
          mid,
          sortOrder,
          kind,
          prompt,
          optionsJson,
          answerKey,
          requiresBoard ? 1 : 0,
          promptDrawOps,
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
      {
        user_answer: string
        board_json: unknown
        board_description: string
        board_image_base64: string
      }
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
        board_description:
          typeof obj.board_description === 'string' ? obj.board_description : '',
        board_image_base64:
          typeof obj.board_image_base64 === 'string' ? obj.board_image_base64 : '',
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
      board_description: string
    }> = []
    const boardImages: Array<{ question_id: number; data: string }> = []
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
        const boardDescription =
          submitted.board_description.trim() ||
          describeBoardJson(submitted.board_json)
        openItems.push({
          question_id: qid,
          prompt: String(q.prompt ?? ''),
          answer_key: answerKey,
          child_answer: truncateChars(answerText, 800),
          requires_board: requiresBoard,
          board_description: truncateChars(boardDescription, 1600),
        })
        if (requiresBoard && submitted.board_image_base64.trim()) {
          boardImages.push({
            question_id: qid,
            data: submitted.board_image_base64,
          })
        }
      }
    }

    const openGrades = await gradeOpenAnswersBatch(openItems, userId, boardImages)
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
      'SELECT COUNT(*) AS c FROM courses WHERE id = ? AND user_id = ? AND is_active = 1',
      [courseId, userId],
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
      SELECT ch.id, ch.user_id, ch.world_id, ch.scope, ch.mission_id, ch.course_id,
             ch.difficulty, ch.question_count, ch.status, ch.score,
             ch.started_at, ch.completed_at,
             c.name AS course_name,
             m.title AS mission_title
      FROM study_challenges ch
      LEFT JOIN courses c ON c.id = ch.course_id
      LEFT JOIN study_missions m ON m.id = ch.mission_id
      WHERE ch.world_id = ? AND ch.user_id = ? AND ch.status = 'completed'
    `
    const params: unknown[] = [worldId, userId]

    if (missionId != null && Number.isFinite(missionId)) {
      sql += ' AND ch.mission_id = ?'
      params.push(missionId)
    } else if (courseId != null && Number.isFinite(courseId)) {
      sql += ' AND (ch.course_id = ? OR (ch.scope = \'course\' AND ch.course_id = ?))'
      params.push(courseId, courseId)
    }
    sql += ' ORDER BY ch.completed_at DESC, ch.id DESC LIMIT 50'

    const [rows] = await pool.query<RowDataPacket[]>(sql, params)
    res.json(rows.map(mapChallenge))
  }),
)

export default router
