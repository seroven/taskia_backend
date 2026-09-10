import { env } from '../config/env.js'
import { pool } from '../db/pool.js'
import { AppError } from '../utils/helpers.js'

export type LlmUsageKind =
  | 'task_tutor'
  | 'mission_tutor'
  | 'transcribe'
  | 'challenge_generate'
  | 'challenge_grade'

export interface LlmUsageContext {
  userId: number
  kind: LlmUsageKind
}

function stripImageDataUrl(raw: string) {
  return raw
    .replace(/^data:image\/png;base64,/, '')
    .replace(/^data:image\/jpeg;base64,/, '')
}

export async function callGemini(opts: {
  system: string
  user: string
  boardImageBase64?: string | null
  boardImages?: Array<{ data: string; caption?: string }>
  usage?: LlmUsageContext
}): Promise<string> {
  const apiKey = env.gemini.apiKey.trim().replace(/^["']|["']$/g, '')
  if (!apiKey) throw new AppError('Configura GEMINI_API_KEY en el archivo .env')
  const model = env.gemini.model.trim().replace(/^["']|["']$/g, '') || 'gemini-2.0-flash'

  const parts: Array<Record<string, unknown>> = [{ text: opts.user }]
  const images =
    opts.boardImages && opts.boardImages.length > 0
      ? opts.boardImages
      : opts.boardImageBase64?.trim()
        ? [
            {
              data: opts.boardImageBase64,
              caption: 'Imagen de la pizarra del niño. Úsala solo si aporta.',
            },
          ]
        : []
  for (const image of images) {
    const data = stripImageDataUrl(image.data.trim())
    if (!data) continue
    parts.push({ inline_data: { mime_type: 'image/png', data } })
    if (image.caption) {
      parts.push({ text: image.caption })
    }
  }

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: 4096,
    responseMimeType: 'application/json',
  }
  const modelL = model.toLowerCase()
  if (modelL.includes('gemini-3')) {
    generationConfig.thinkingConfig = { thinkingLevel: 'low' }
  } else if (modelL.includes('2.5')) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 }
    generationConfig.temperature = 0.6
  } else {
    generationConfig.temperature = 0.6
  }

  const generated = await generateGeminiText({
    apiKey,
    model,
    system: opts.system,
    parts,
    generationConfig,
  })
  if (opts.usage) {
    void recordLlmUsage(opts.usage, model, generated.usage)
  }
  return generated.text
}

const TRANSCRIBE_SYSTEM = `Eres un transcriptor fiel para una app de estudio infantil (español latinoamericano).
Tu ÚNICA tarea es transcribir el audio completo del niño o la niña.

Reglas:
- Devuelve SOLO el texto hablado, en español.
- Transcribe TODO el audio de principio a fin. No resumas. No omitas el final ni cortes a mitad de frase.
- Incluye citas o frases largas enteras si el niño las lee o las dice.
- No inventes contenido que no se escuche.
- No agregues títulos, comillas envolventes del bloque, markdown ni comentarios ("Aquí está la transcripción…").
- Corrige puntuación básica y mayúsculas para que se lea bien, sin cambiar el sentido.
- Si hay muletillas claras (eh, este, o sea), puedes suavizarlas solo si no aportan.
- Si el audio está vacío, es ruido o no se entiende casi nada, responde exactamente: (no se entendió)
- Si solo se entiende una parte, transcribe esa parte y no rellenes el resto; pero si se entiende el resto, inclúyelo completo.`

const MAX_AUDIO_BASE64_CHARS = 5_500_000

export async function callGeminiTranscribe(opts: {
  audioBase64: string
  mimeType: string
  durationSeconds?: number
  usage?: LlmUsageContext
}): Promise<{ text: string; truncated: boolean }> {
  const apiKey = env.gemini.apiKey.trim().replace(/^["']|["']$/g, '')
  if (!apiKey) throw new AppError('Configura GEMINI_API_KEY en el archivo .env')
  const model = env.gemini.model.trim().replace(/^["']|["']$/g, '') || 'gemini-2.0-flash'

  let data = opts.audioBase64.trim()
  const dataUrl = /^data:([^;]+);base64,(.+)$/s.exec(data)
  let mimeType = opts.mimeType.trim() || 'audio/webm'
  if (dataUrl) {
    mimeType = dataUrl[1] || mimeType
    data = dataUrl[2]
  }
  data = data.replace(/\s/g, '')

  if (!data) throw new AppError('No llegó audio para transcribir')
  if (data.length > MAX_AUDIO_BASE64_CHARS) {
    throw new AppError('El audio es demasiado largo. Máximo 90 segundos.')
  }

  const allowed = new Set([
    'audio/webm',
    'audio/webm;codecs=opus',
    'audio/mp4',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/ogg',
    'audio/ogg;codecs=opus',
  ])
  const mimeBase = mimeType.split(';')[0].trim().toLowerCase()
  if (!allowed.has(mimeType.toLowerCase()) && !allowed.has(mimeBase)) {
    throw new AppError('Formato de audio no soportado')
  }

  const durationHint =
    opts.durationSeconds != null && Number.isFinite(opts.durationSeconds)
      ? ` Duración aproximada: ${Math.round(opts.durationSeconds)} s.`
      : ''

  const parts: Array<Record<string, unknown>> = [
    {
      text: `Transcribe TODO este audio de un niño o niña explicando o leyendo un tema de estudio, de principio a fin, sin resumir ni cortar el final.${durationHint}`,
    },
    {
      inline_data: {
        mime_type: mimeBase === 'audio/mp3' ? 'audio/mpeg' : mimeBase,
        data,
      },
    },
  ]

  const { text, finishReason, usage } = await generateGeminiText({
    apiKey,
    model,
    system: TRANSCRIBE_SYSTEM,
    parts,
    generationConfig: {
      // Lecturas largas (~90s) necesitan margen amplio de salida
      maxOutputTokens: 8192,
      temperature: 0.1,
    },
  })
  if (opts.usage) {
    void recordLlmUsage(opts.usage, model, usage)
  }

  const cleaned = text
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  if (!cleaned) throw new AppError('No se pudo transcribir el audio')
  return {
    text: cleaned,
    truncated: finishReason === 'MAX_TOKENS',
  }
}

async function generateGeminiText(opts: {
  apiKey: string
  model: string
  system: string
  parts: Array<Record<string, unknown>>
  generationConfig: Record<string, unknown>
}): Promise<{
  text: string
  finishReason?: string
  usage: { prompt: number; output: number; total: number }
}> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${opts.apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: 'user', parts: opts.parts }],
      generationConfig: opts.generationConfig,
    }),
  })

  const payload = (await response.json()) as Record<string, unknown>
  if (!response.ok) {
    const err = payload.error as { message?: string } | undefined
    throw new AppError(err?.message ?? 'Error al llamar a Gemini')
  }

  const candidates = payload.candidates as
    | Array<{
        finishReason?: string
        content?: { parts?: Array<{ text?: string; thought?: boolean }> }
      }>
    | undefined
  const candidate = candidates?.[0]
  const partsOut = candidate?.content?.parts ?? []
  const texts = partsOut
    .filter((p) => !p.thought && p.text?.trim())
    .map((p) => p.text!.trim())
  const joined = texts.join('\n').trim()
  if (!joined) throw new AppError('Gemini no devolvió texto útil')
  const meta = payload.usageMetadata as
    | {
        promptTokenCount?: number
        candidatesTokenCount?: number
        totalTokenCount?: number
      }
    | undefined
  const prompt = Number(meta?.promptTokenCount ?? 0)
  const output = Number(meta?.candidatesTokenCount ?? 0)
  const total = Number(meta?.totalTokenCount ?? prompt + output)
  return {
    text: joined,
    finishReason: candidate?.finishReason,
    usage: { prompt, output, total },
  }
}

async function recordLlmUsage(
  ctx: LlmUsageContext,
  model: string,
  usage: { prompt: number; output: number; total: number },
) {
  try {
    await pool.query(
      `INSERT INTO llm_usage
         (user_id, kind, model, prompt_tokens, output_tokens, total_tokens)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        ctx.userId,
        ctx.kind,
        model,
        Math.max(0, usage.prompt),
        Math.max(0, usage.output),
        Math.max(0, usage.total),
      ],
    )
  } catch {
    /* la tabla puede no existir aún; no cortar la sesión del niño */
  }
}
