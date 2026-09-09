import { env } from '../config/env.js'
import { AppError } from '../utils/helpers.js'

export async function callGemini(opts: {
  system: string
  user: string
  boardImageBase64?: string | null
}): Promise<string> {
  const apiKey = env.gemini.apiKey.trim().replace(/^["']|["']$/g, '')
  if (!apiKey) throw new AppError('Configura GEMINI_API_KEY en el archivo .env')
  const model = env.gemini.model.trim().replace(/^["']|["']$/g, '') || 'gemini-2.0-flash'

  const parts: Array<Record<string, unknown>> = [{ text: opts.user }]
  const raw = opts.boardImageBase64?.trim()
  if (raw) {
    const data = raw
      .replace(/^data:image\/png;base64,/, '')
      .replace(/^data:image\/jpeg;base64,/, '')
    parts.push({ inline_data: { mime_type: 'image/png', data } })
    parts.push({ text: 'Imagen de la pizarra del niño. Úsala solo si aporta.' })
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig,
    }),
  })

  const payload = (await response.json()) as Record<string, unknown>
  if (!response.ok) {
    const err = payload.error as { message?: string } | undefined
    throw new AppError(err?.message ?? 'Error al llamar a Gemini')
  }

  const candidates = payload.candidates as Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> | undefined
  const partsOut = candidates?.[0]?.content?.parts ?? []
  const texts = partsOut
    .filter((p) => !p.thought && p.text?.trim())
    .map((p) => p.text!.trim())
  const joined = texts.join('\n').trim()
  if (!joined) throw new AppError('Gemini no devolvió texto útil')
  return joined
}
