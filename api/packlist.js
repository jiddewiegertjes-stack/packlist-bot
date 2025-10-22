// app/api/packlist/route.js
import { NextResponse } from "next/server"

// === CORS ===
// Wil je strakker afschermen? Zet ALLOWED_ORIGIN op bv. "https://trekvice.com"
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

// Kleine util om SSE te sturen
function sseWrite(writer, event, data) {
  const enc = typeof data === "string" ? data : JSON.stringify(data)
  const chunk = `event: ${event}\n` + `data: ${enc}\n\n`
  writer.write(chunk)
}

function pickSeasonHint(ctx = {}) {
  if (ctx?.unknownPeriod || (!ctx?.month && !ctx?.startDate)) {
    return {
      season: "all-season",
      seasonalRisks: [{ type: "onzeker klimaat", level: "laag", note: "Neem laagjes mee" }],
      adviceFlags: { layering: true, rainShell: true },
    }
  }
  return {
    season: "afhankelijk van bestemming/periode",
    seasonalRisks: [],
    adviceFlags: {},
  }
}

function computeMissing(context = {}) {
  const missing = []
  const { destination, durationDays, month, startDate, endDate } = context || {}
  const uCountry = !!context.unknownCountry
  const uPeriod = !!context.unknownPeriod
  const uDuration = !!context.unknownDuration

  if (!uCountry) {
    const hasCountry = !!(destination && destination.country)
    if (!hasCountry) missing.push({ field: "countries", question: "Naar welk(e) land(en) ga je?" })
  }
  if (!uPeriod) {
    const hasPeriod = !!(month || startDate || endDate)
    if (!hasPeriod) missing.push({ field: "period", question: "Wanneer ongeveer ga je op reis?" })
  }
  if (!uDuration) {
    const hasDur = Number.isFinite(Number(durationDays)) && durationDays > 0
    if (!hasDur) missing.push({ field: "duration", question: "Hoe lang ben je ongeveer weg?" })
  }
  return missing
}

function basePacklist(context = {}) {
  return [
    { category: "Kleding", name: "T-shirt (merino/synthetisch)", weight_grams: 150 },
    { category: "Kleding", name: "Lichte trui / midlayer", weight_grams: 300 },
    { category: "Kleding", name: "Regenjas (shell)", weight_grams: 280 },
    { category: "Gear", name: "Dagrugzak 20-30L", weight_grams: 700 },
    { category: "Gadgets", name: "Universele stekker + usb-lader", weight_grams: 120 },
    { category: "Health", name: "EHBO-kitje compact", weight_grams: 90 },
  ]
}

// ---- CORS preflight ----
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

// ---- Event stream POST ----
export async function POST(req) {
  try {
    const { message, context: incomingContext = {}, nluHints = {}, history = [] } = await req.json()

    const context = {
      ...incomingContext,
      unknownCountry: !!(incomingContext.unknownCountry || nluHints.unknownCountry),
      unknownPeriod: !!(incomingContext.unknownPeriod || nluHints.unknownPeriod),
      unknownDuration: !!(incomingContext.unknownDuration || nluHints.unknownDuration),
      destination: {
        country: incomingContext?.destination?.country ?? nluHints.country ?? null,
        region: incomingContext?.destination?.region ?? null,
      },
      durationDays: incomingContext?.durationDays ?? nluHints.durationDays ?? null,
      month: incomingContext?.month ?? nluHints.month ?? null,
      startDate: incomingContext?.startDate ?? nluHints.startDate ?? null,
      endDate: incomingContext?.endDate ?? nluHints.endDate ?? null,
      activities: Array.isArray(incomingContext?.activities) ? incomingContext.activities : [],
      preferences: incomingContext?.preferences ?? null,
    }

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        const writer = {
          write: (str) => controller.enqueue(encoder.encode(str)),
          close: () => controller.close(),
        }

        // 1) Context/meta
        const meta = pickSeasonHint(context)
        sseWrite(writer, "context", meta)

        // 2) Needs/missing (respecteer unknown*)
        const missing = computeMissing(context)
        if (missing.length) {
          sseWrite(writer, "needs", { missing: missing.map((m) => m.field), contextOut: {} })
          const first = missing[0]
          sseWrite(writer, "ask", { field: first.field, question: first.question })
        } else {
          sseWrite(writer, "needs", { missing: [], contextOut: {} })
        }

        // 3) Start streaming body
        sseWrite(writer, "start", { ok: true })

        const countryTxt = context?.destination?.country
          ? `**Bestemming:** ${context.destination.country}\n`
          : (context.unknownCountry ? `**Bestemming:** onbepaald\n` : ``)

        const whenTxt =
          context.month || context.startDate
            ? `**Periode:** ${context.month ?? `${context.startDate}${context.endDate ? ` → ${context.endDate}` : ""}`}\n`
            : (context.unknownPeriod ? `**Periode:** onbepaald\n` : ``)

        const durTxt =
          Number.isFinite(context.durationDays) && context.durationDays > 0
            ? `**Duur:** ~${context.durationDays} dagen\n`
            : (context.unknownDuration ? `**Duur:** onbepaald\n` : ``)

        const opening =
          `**Korte samenvatting**\n\n` +
          `- We starten met een flexibele basis-packlist.\n` +
          (context.unknownCountry || !context?.destination?.country ? "- Land nog open → all-season basics.\n" : "") +
          (context.unknownPeriod || (!context.month && !context.startDate) ? "- Periode nog open → laagjes + regenbescherming.\n" : "") +
          (context.unknownDuration || !context.durationDays ? "- Duur nog open → focus op wasbaar & multifunctioneel.\n" : "")

        sseWrite(writer, "delta", opening + "\n")

        const useOpenAI = !!process.env.OPENAI_API_KEY
        const seedText =
          `${countryTxt}${whenTxt}${durTxt}\n` +
          `**Kleding** - laagjes, sneldrogend, basic kleuren.\n` +
          `**Gear** - compacte rugzak, regenhoes, packing cubes.\n` +
          `**Gadgets** - powerbank, wereldstekker, kabels.\n` +
          `**Health** - pleisters, pijnstiller, ORS.\n` +
          `**Tips** - verzekering check, kopieën documenten, pin+cash.\n`

        const finish = async () => {
          sseWrite(writer, "products", basePacklist(context))
          sseWrite(writer, "done", { ok: true })
          writer.close()
        }

        const openAiFallback = async () => {
          sseWrite(writer, "delta", seedText)
          await finish()
        }

        const openAiFancy = async () => {
          try {
            const prompt = [
              `Je bent een packlist-assistent. Maak een korte, praktische output met secties Kleding, Gear, Gadgets, Health, Tips.`,
              `Respecteer dat onbekende velden NIET doorgeduwd hoeven te worden.`,
              `Gebruik maximaal 8-12 bullets totaal.`,
              `Context:\n${JSON.stringify(context).slice(0, 1400)}`,
              `Bericht:\n${message}`,
            ].join("\n\n")

            const res = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
              },
              body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                  { role: "system", content: "Jij bent een behulpzame Nederlandse packlist-assistent." },
                  ...(Array.isArray(history) ? history : []),
                  { role: "user", content: prompt },
                ],
                temperature: 0.5,
                max_tokens: 500,
                stream: false,
              }),
            })

            if (!res.ok) throw new Error(`OpenAI ${res.status}`)
            const json = await res.json()
            const text = json?.choices?.[0]?.message?.content || seedText
            sseWrite(writer, "delta", text)
          } catch {
            sseWrite(writer, "delta", seedText)
          } finally {
            await finish()
          }
        }

        if (useOpenAI) openAiFancy()
        else openAiFallback()
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...CORS_HEADERS, // << CORS headers on stream response
      },
    })
  } catch (err) {
    const msg = (err && err.message) || "Unknown server error"
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS_HEADERS })
  }
}

// Streaming werkt het stabielst op Node.js runtime op Vercel
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
