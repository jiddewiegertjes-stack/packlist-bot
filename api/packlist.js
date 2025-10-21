import * as React from "react"

/**
 * PacklistAssistant — Conversational NLU upgrade
 * ------------------------------------------------
 * Goals
 * - Make free‑form chat feel natural (understands paraphrases, corrections, add/remove)
 * - Keep slot‑filling, but drive follow‑ups with confidence + paraphrase
 * - Send richer "nluHints" + "history" to backend so the LLM can infer rest
 * - Zero extra deps; pure TS + a tiny fuzzy/regex layer for NL/EN
 *
 * How to use
 * - Drop‑in replacement for your current component
 * - API contract: POST { message, context, history, nluHints }
 */

const API_BASE = "https://packlist-bot.vercel.app"

/* ---------- Types ---------- */
type Product = {
  category?: string
  name?: string
  weight_grams?: number
  activities?: string
  seasons?: string
  url?: string
  image?: string
}

type ProductsEvent = Product[]

type SeasonalRisk = { type: string; level?: string; note?: string }

type ContextPayload = {
  season?: string | null
  seasonalRisks?: SeasonalRisk[]
  adviceFlags?: Record<string, boolean>
  itemTags?: string[]
  [k: string]: any
}

type StepId = "countries" | "period" | "duration" | "activities"

const ASK_ORDER: readonly StepId[] = ["countries", "period", "duration", "activities"]

type ChatMsg = { role: "user" | "assistant"; html?: string; text?: string }

/**
 * ===== Natural Language Layer =====
 * Minimal, dependency‑free NLU that extracts:
 * - countries (with simple fuzzy & synonyms)
 * - duration (days/weeks/months)
 * - date ranges and months (incl. NL idioms like "t/m", "vanaf", "over 2 weken")
 * - activities (add/remove, negation aware)
 * - intent (correction/update vs new info vs meta like "maak compacter")
 */

/* --- Utils --- */
const stripDiacritics = (s = "") => s
  .normalize("NFD")
  .replace(/\p{Diacritic}+/gu, "")
  .toLowerCase()

const within = (v: number, target: number, tol = 2) => Math.abs(v - target) <= tol

// very tiny fuzzy: accepts token if at least 70% of chars match in correct order
function fuzzyIncludes(hay: string, needle: string) {
  hay = stripDiacritics(hay)
  needle = stripDiacritics(needle)
  if (hay.includes(needle)) return true
  if (needle.length < 4) return false
  let i = 0
  for (const ch of hay) if (ch === needle[i]) i++
  return i / needle.length >= 0.7
}

/* --- Lexicons --- */
const COUNTRY_SYNS: Record<string, string[]> = {
  nederland: ["nl", "netherlands", "holland"],
  portugal: [],
  spanje: ["spanje", "spain"],
  italie: ["italië", "italie", "italy"],
  frankrijk: ["france"],
  griekenland: ["greece"],
  turkije: ["turkey"],
  marokko: ["morocco"],
  mexico: [],
  peru: [],
  argentinie: ["argentina", "argentinië"],
  chili: ["chile"],
  japan: ["japan"],
  korea: ["zuid-korea", "south korea", "korea"],
  vietnam: [],
  filipijnen: ["philippines", "philippijnen"],
  indonesie: ["indonesië", "bali", "java", "lombok"],
  thailand: ["thailand", "thai"],
  cambodja: ["cambodia"],
  laos: [],
  noorwegen: ["norway"],
  zweden: ["sweden"],
  finland: ["finland"],
  canada: [],
  "verenigde staten": ["vs", "usa", "united states", "amerika"],
  australie: ["australië", "australia"],
  "nieuw-zeeland": ["new zealand", "nz"]
}

const ACT_SYNS: Record<string, string[]> = {
  hiken: ["wandelen", "trekking", "bergen in"],
  duiken: ["scuba", "duik", "padi"],
  snorkelen: ["snorkel"],
  surfen: ["surf", "golfsurfen"],
  skien: ["skiën", "ski", "snowboarden"],
  kamperen: ["kamperen", "tent", "wildkamperen"],
  klimmen: ["boulderen", "alpinisme"],
  fietsen: ["bikepacking", "mtb", "wielrennen"],
  hardlopen: ["trailrun", "rennen"],
}

const MONTHS: Record<string, number> = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
  january: 0, february: 1, march: 2, may: 4, june: 5, july: 6, august: 7,
}

/* --- Parsing helpers --- */
function detectLanguage(t: string): "nl" | "en" {
  return /\b(de|het|een|ik|en|naar|tot|t\/m|weken|maanden)\b/i.test(t) ? "nl" : "en"
}

function findCountry(t: string): string | null {
  for (const [canon, syns] of Object.entries(COUNTRY_SYNS)) {
    const candidates = [canon, ...syns]
    if (candidates.some(s => fuzzyIncludes(t, s))) return canon
  }
  return null
}

function parseDuration(t: string): number | null {
  const m = t.match(/\b(\d{1,3})\s*(dagen|dag|weken|week|maanden|maand|d|w|m)\b/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  const unit = m[2].toLowerCase()
  if (unit.startsWith("w")) return n * 7
  if (unit.startsWith("m")) return n * 30
  return n
}

function toISO(d: Date) {
  const z = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  return z.toISOString().slice(0, 10)
}

function parsePeriod(t: string): { startDate?: string|null; endDate?: string|null; month?: string|null } {
  const lower = stripDiacritics(t)
  // explicit ranges: 5-12 juni / 5 tot 12 juni / 1 t/m 10 mei / 12-26 aug 2026
  const range = lower.match(/\b(\d{1,2})\s*(?:-|t\/m|tot)\s*(\d{1,2})\s*(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|jan|feb|mrt|apr|aug|sep|oct|okt|nov|dec|mei)\s*(\d{4})?\b/)
  if (range) {
    const d1 = parseInt(range[1], 10)
    const d2 = parseInt(range[2], 10)
    const monthTxt = range[3].startsWith("okt") ? "oktober" : range[3]
    const mIdx = MONTHS[monthTxt as keyof typeof MONTHS] ?? MONTHS[monthTxt as any]
    const year = range[4] ? parseInt(range[4], 10) : new Date().getFullYear()
    const s = new Date(Date.UTC(year, mIdx, d1))
    const e = new Date(Date.UTC(year, mIdx, d2))
    return { startDate: toISO(s), endDate: toISO(e), month: null }
  }
  // vanaf 12 juli, tot 3 september
  const vanaf = lower.match(/vanaf\s+(\d{1,2})\s+(\w+)/)
  if (vanaf) {
    const d = parseInt(vanaf[1], 10)
    const mIdx = MONTHS[vanaf[2] as keyof typeof MONTHS]
    const y = new Date().getFullYear()
    return { startDate: toISO(new Date(Date.UTC(y, mIdx, d))), endDate: null, month: null }
  }
  // month only
  const m = lower.match(/\b(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|january|february|march|may|june|july|august|september|october|november|december)\b/)
  if (m) return { month: m[0], startDate: null, endDate: null }
  // relative: over 2 weken/maanden
  const rel = lower.match(/over\s+(\d{1,2})\s*(weken|maanden|dagen|weeks|months|days)/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const unit = rel[2]
    const now = new Date()
    const start = new Date(now)
    if (/week/i.test(unit)) start.setUTCDate(start.getUTCDate() + n * 7)
    else if (/maand|month/i.test(unit)) start.setUTCMonth(start.getUTCMonth() + n)
    else start.setUTCDate(start.getUTCDate() + n)
    return { startDate: toISO(start), endDate: null, month: null }
  }
  return { startDate: null, endDate: null, month: null }
}

function extractActivities(t: string) {
  const neg = /\b(geen|niet|no)\b/i
  const removes: string[] = []
  const adds: string[] = []
  for (const [canon, syns] of Object.entries(ACT_SYNS)) {
    const hits = [canon, ...syns].some(s => fuzzyIncludes(t, s))
    if (hits) (neg.test(t) ? removes : adds).push(canon)
  }
  return { adds: Array.from(new Set(adds)), removes: Array.from(new Set(removes)) }
}

function detectIntent(t: string): "update" | "ask" | "meta" {
  if (/^(toch|pas.*aan|oh\b|nee\b|corrigeer|verander|update)/i.test(t.trim())) return "update"
  if (/^(maak.*(korter|compacter)|leg.*(uit)|toon.*(producten|alles)|herhaal|samenvat)/i.test(t)) return "meta"
  return "ask"
}

type NLUHints = {
  lang: "nl"|"en"
  country?: string|null
  durationDays?: number|null
  startDate?: string|null
  endDate?: string|null
  month?: string|null
  activitiesAdd?: string[]
  activitiesRemove?: string[]
  confidence: number // 0..1
  paraphrase?: string // "If I understood you correctly …"
}

function nlu(t: string, prev: Ctx): NLUHints {
  const lang = detectLanguage(t)
  const c = findCountry(t)
  const dur = parseDuration(t)
  const per = parsePeriod(t)
  const acts = extractActivities(t)

  // confidence heuristic
  let score = 0
  if (c) score += .3
  if (dur) score += .25
  if (per.month || per.startDate) score += .25
  if (acts.adds.length) score += .2
  score = Math.min(1, score)

  const pieces: string[] = []
  if (c) pieces.push(`land: ${c}`)
  if (per.month) pieces.push(`periode: ${per.month}`)
  else if (per.startDate) pieces.push(`periode: ${per.startDate}${per.endDate ? ` → ${per.endDate}`: ""}`)
  if (dur) pieces.push(`duur: ${dur} dagen`)
  if (acts.adds.length) pieces.push(`activiteiten: ${acts.adds.join(", ")}`)
  if (acts.removes.length) pieces.push(`(zonder: ${acts.removes.join(", ")})`)

  const paraphrase = pieces.length ? `Als ik je goed begrijp: ${pieces.join(" • ")}.` : undefined

  return {
    lang,
    country: c ?? prev.destination?.country ?? null,
    durationDays: dur ?? prev.durationDays ?? null,
    startDate: per.startDate ?? prev.startDate ?? null,
    endDate: per.endDate ?? prev.endDate ?? null,
    month: per.month ?? prev.month ?? null,
    activitiesAdd: acts.adds,
    activitiesRemove: acts.removes,
    confidence: score,
    paraphrase
  }
}

/* ---------- UI helpers from your original file (trimmed & reused) ---------- */
function escapeHtml(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
function inlineMd(s: string) {
  let out = s
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code class="ai-inline-code">${escapeHtml(c)}</code>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => `<a href="${u}" target="_blank" rel="noreferrer">${escapeHtml(t)}</a>`)
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, (_m, pre, txt) => `${pre}<em>${txt}</em>`)
  return out
}
function formatToChatUI(raw: string) {
  const lines = raw.trim().split("\n")
  const out: string[] = []
  for (const line of lines) out.push(`<p>${inlineMd(line)}</p>`)
  return `<div class="ai-rich">${out.join("")}</div>`
}

/* ---------- Minimal deep merge ---------- */
function deepMerge<T>(target: T, source: any): T {
  if (source === null || typeof source !== "object") return target
  const out: any = Array.isArray(target) ? [...(target as any)] : { ...(target as any) }
  for (const k of Object.keys(source)) {
    const sv = (source as any)[k]
    const tv = (out as any)[k]
    if (sv && typeof sv === "object" && !Array.isArray(sv)) out[k] = deepMerge(tv ?? {}, sv)
    else if (sv !== null && sv !== undefined) out[k] = sv
  }
  return out
}

/* ---------- Types for context ---------- */
type Ctx = {
  destination: { country: string | null; region: string | null }
  durationDays: number | null
  startDate: string | null
  endDate: string | null
  month: string | null
  activities: string[]
  preferences: any | null
}

/* ---------- SSE helper ---------- */
async function* sseLines(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx).trimEnd()
      buffer = buffer.slice(idx + 2)
      if (raw.length) yield raw
    }
  }
  if (buffer.trim().length) yield buffer
}

/* ---------- Component ---------- */
export default function PacklistAssistant({ showHint = true }: { showHint?: boolean }) {
  const [darkMode, setDarkMode] = React.useState(false)
  const [messages, setMessages] = React.useState<ChatMsg[]>([
    { role: "assistant", text: "Hoi! 👋 Vertel in je eigen woorden je plannen (landen, duur, periode, activiteiten). Ik haal eruit wat ik kan en vraag alleen door wat nog ontbreekt." }
  ])
  const [input, setInput] = React.useState("")
  const [running, setRunning] = React.useState(false)
  const [thinking, setThinking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [products, setProducts] = React.useState<Product[]>([])
  const [selected, setSelected] = React.useState<Record<string, boolean>>({})
  const abortRef = React.useRef<AbortController | null>(null)

  const [context, setContext] = React.useState<Ctx>({
    destination: { country: null, region: null },
    durationDays: null,
    startDate: null,
    endDate: null,
    month: null,
    activities: [],
    preferences: null
  })

  const pushAssistantText = (t: string) => setMessages(m => [...m, { role: "assistant", text: t }])
  const pushAssistantHTML = (h: string) => setMessages(m => [...m, { role: "assistant", html: h }])

  const productKey = (p: Product, i: number) => `${p.name ?? "item"}|${p.url ?? ""}|${i}`
  const toggleSelected = (key: string) => setSelected(s => ({ ...s, [key]: !s[key] }))

  const resetTurnSideEffects = React.useCallback(() => { setError(null); setProducts([]); setSelected({}) }, [])
  const handleStop = React.useCallback(() => { abortRef.current?.abort(); abortRef.current = null; setRunning(false); setThinking(false) }, [])

  function buildHistory(msgs: ChatMsg[]) {
    const last = msgs.slice(-12).map(m => ({ role: m.role, content: (m.text ?? (m.html ? m.html.replace(/<[^>]+>/g, " ") : "")).trim().slice(0, 1500) }))
    return last.filter(m => m.content)
  }

  function missingSlots(ctx = context): StepId[] {
    const missing: StepId[] = []
    if (!ctx.destination?.country) missing.push("countries")
    if (!ctx.month && !ctx.startDate) missing.push("period")
    if (!ctx.durationDays) missing.push("duration")
    if (!ctx.activities?.length) missing.push("activities")
    return missing
  }

  function nextQuestion(ctx = context): string | null {
    const miss = missingSlots(ctx)
    const order = ASK_ORDER.find(k => miss.includes(k as StepId))
    if (!order) return null
    return {
      countries: "Waar ga je naartoe (land/landen)?",
      period: "In welke periode denk je weg te gaan (bijv. 5–12 juni of ‘augustus’)?",
      duration: "Hoe lang ga je ongeveer weg (dagen/weken/maanden)?",
      activities: "Welke activiteiten denk je te doen (bijv. hiken, surfen, snorkelen)?"
    }[order]
  }

  /* ---------- Backend trigger with nluHints ---------- */
  async function sendToBackend(message: string, nluHints: NLUHints, history: any[]) {
    setRunning(true); setThinking(true)
    try {
      const ac = new AbortController(); abortRef.current = ac
      const res = await fetch(`${API_BASE}/api/packlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, context, history, nluHints }),
        signal: ac.signal
      })
      if (!res.ok || !res.body) throw new Error(`Stream response not OK (${res.status})`)

      let streamedText = ""; let hasStarted = false
      const reader = res.body.getReader()
      for await (const chunk of sseLines(reader)) {
        let ev: string | null = null
        let dataRaw = ""
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim()
          else if (line.startsWith("data:")) dataRaw += line.slice(5)
        }
        if (ev === "needs") {
          try { const payload = JSON.parse(dataRaw) as ContextPayload
            const { season, seasonalRisks, adviceFlags, itemTags, ...rest } = payload || {}
            if (Object.keys(rest).length) setContext(c => deepMerge(c, rest))
          } catch {}
        } else if (ev === "start") {
          hasStarted = true; streamedText = ""; pushAssistantHTML(formatToChatUI(""))
        } else if (ev === "delta" && hasStarted) {
          let add = ""; try { const maybe = JSON.parse(dataRaw); add = typeof maybe === "string" ? maybe : (maybe as any)?.text ?? dataRaw } catch { add = dataRaw }
          streamedText += add
          setMessages(msgs => {
            const copy = [...msgs]
            for (let i = copy.length - 1; i >= 0; i--) if (copy[i].role === "assistant" && "html" in copy[i]) { copy[i] = { role: "assistant", html: formatToChatUI(streamedText) }; break }
            return copy
          })
        } else if (ev === "products") {
          try { const incoming = (JSON.parse(dataRaw) as ProductsEvent) || []
            setProducts(prev => {
              const seen = new Set<string>()
              const out: Product[] = []
              for (const p of [...(prev||[]), ...incoming]) {
                const key = `${(p.name||"")}|${(p.url||"")}`.toLowerCase()
                if (!seen.has(key) && !/(\.csv($|\?)|docs.google.com\/spreadsheets|export=download&format=csv)/.test((p.url||"").toLowerCase())) { seen.add(key); out.push(p) }
              }
              return out
            })
          } catch {}
        } else if (ev === "error") {
          try { setError((JSON.parse(dataRaw) as any)?.message || "Onbekende fout uit stream") } catch { setError(dataRaw || "Onbekende fout uit stream") }
          break
        } else if (ev === "done") { break }
      }
    } catch (e: any) {
      setError(e?.message || "Onbekende fout")
    } finally {
      setRunning(false); setThinking(false); abortRef.current = null
    }
  }

  /* ---------- Input handlers ---------- */
  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleUserSend(input) }
  }

  function handleUserSend(message: string) {
    if (!message.trim() || running) return
    setMessages(m => [...m, { role: "user", text: message }])
    setInput("")
    resetTurnSideEffects()

    // NLU pass
    const hints = nlu(message, context)
    const intent = detectIntent(message)

    // Apply local context updates optimistically
    if (hints.country) setContext(c => deepMerge(c, { destination: { country: hints.country, region: null } }))
    if (hints.durationDays) setContext(c => deepMerge(c, { durationDays: hints.durationDays }))
    if (hints.month || hints.startDate) setContext(c => deepMerge(c, { month: hints.month ?? null, startDate: hints.startDate ?? null, endDate: hints.endDate ?? null }))
    if (hints.activitiesAdd?.length || hints.activitiesRemove?.length) setContext(c => ({
      ...c,
      activities: Array.from(new Set([...
        (c.activities||[]).filter(a => !(hints.activitiesRemove||[]).includes(a)),
        ...(hints.activitiesAdd||[])
      ]))
    }))

    const miss = missingSlots()

    // Conversational follow‑up
    if (intent === "update" && hints.paraphrase) {
      pushAssistantText(`${hints.paraphrase} Aangepast! Ik denk mee…`)
      return sendToBackend("Update door gebruiker", hints, buildHistory([...messages, { role: "user", text: message }]))
    }

    // If high confidence or nothing missing → stream backend answer
    if (hints.confidence >= 0.6 || miss.length === 0) {
      if (hints.paraphrase) pushAssistantText(`${hints.paraphrase} Top, ik heb genoeg info. Ik denk mee…`)
      else pushAssistantText("Top, ik heb genoeg info. Ik denk mee…")
      return sendToBackend(message, hints, buildHistory([...messages, { role: "user", text: message }]))
    }

    // Otherwise ask the next best question, but with a paraphrase to feel human
    const follow = nextQuestion()
    if (follow) {
      pushAssistantText(hints.paraphrase ? `${hints.paraphrase}\n${follow}` : follow)
    }
  }

  /* ---------- UI (trimmed) ---------- */
  const theme = darkMode ? dark : light
  const chips = [
    { label: "Land", value: context.destination?.country || undefined, onEdit: () => setInput("Ik ga naar …") },
    { label: "Periode", value: context.month || context.startDate || undefined, onEdit: () => setInput("Ik ga in …") },
    { label: "Duur", value: context.durationDays ? `${context.durationDays} dagen` : undefined, onEdit: () => setInput("Ik ga ongeveer … dagen weg") },
    { label: "Activiteiten", value: context.activities?.length ? context.activities.join(", ") : undefined, onEdit: () => setInput("Ik wil o.a. hiken/surfen/…") }
  ]
  const done = 4 - missingSlots().length

  return (
    <div style={{ ...container, background: theme.bg, color: theme.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>Packlist Assistant</h3>
        <label style={{ fontSize: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={darkMode} onChange={() => setDarkMode(v => !v)} style={{ marginRight: 6 }} />
          Dark mode
        </label>
      </div>

      {showHint && <div style={{ ...muted }}>Tip: typ vrijuit (bv. “45 dagen Vietnam van 5–12 juli, hiken & duiken”). Ik haal eruit wat ik kan en vraag alleen door wat nog ontbreekt.</div>}

      {done < 4 && <div style={{ ...muted }}>Ik heb {done}/4 onderdelen ✔︎</div>}

      {(thinking || running) && (
        <div style={{ ...muted, padding: "6px 8px", border: `1px dashed ${theme.border}`, borderRadius: 8 }} aria-live="polite">AI is aan het nadenken…</div>
      )}

      {error && (
        <div style={{ ...errorBox, background: theme.errorBg, color: theme.errorText, borderColor: theme.errorBorder }}>
          <strong>Fout:</strong> {error}
        </div>
      )}

      <div style={chatScroll(theme)}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{ ...bubbleBase, ...(m.role === "user" ? bubbleUser(theme) : bubbleAssistant(theme)) }}>
              {"html" in m && m.html ? <div dangerouslySetInnerHTML={{ __html: m.html }} /> : <div>{m.text}</div>}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {chips.map((c, idx) => (
          <div key={idx} style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 999, border: `1px solid ${theme.border}`, background: theme.cardBg, fontSize: 12 }} title="Klik om te bewerken">
            <span style={{ opacity: 0.75 }}>{c.label}:</span>
            <span>{c.value || "—"}</span>
            <button onClick={c.onEdit} style={{ ...btnBase, height: 24, padding: "0 8px", borderRadius: 999, background: "transparent", border: `1px solid ${theme.border}`, fontSize: 12 }}>✎</button>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Schrijf hier… bv. '45 dagen Vietnam 5–12 juli, hiken & duiken'"
          style={{ ...inputStyle, background: theme.inputBg, color: theme.text, borderColor: theme.border }}
          disabled={running}
        />
        <button onClick={() => handleUserSend(input)} disabled={!input.trim() || running} style={{ ...btnPrimary, background: theme.buttonBg, color: theme.buttonText }}>Verstuur</button>
        {running && <button onClick={handleStop} style={btnDanger} aria-label="Stop genereren">Stop</button>}
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <div style={sectionTitle}>Suggested Products</div>
        {products?.length ? (
          <ul style={productsGrid}>
            {products.map((p, i) => {
              const key = productKey(p, i)
              const isSelected = !!selected[key]
              const card: React.CSSProperties = {
                ...productCard,
                position: "relative",
                borderColor: isSelected ? SELECTED.border : theme.border,
                background: isSelected ? SELECTED.bg : theme.cardBg,
                color: isSelected ? "#ffffff" : theme.text,
                boxShadow: isSelected ? "0 6px 18px rgba(34,197,94,.35)" : "0 2px 10px rgba(0,0,0,.06)",
                transition: "background .15s ease, border-color .15s ease, color .15s ease, box-shadow .15s ease",
                cursor: "pointer"
              }
              const checkBox: React.CSSProperties = {
                position: "absolute", top: 10, right: 10, width: 22, height: 22, borderRadius: 8, border: `1px solid ${isSelected ? "#ffffff" : theme.border}`,
                display: "grid", placeItems: "center", fontSize: 14, lineHeight: 1, background: isSelected ? "rgba(255,255,255,0.22)" : "transparent", color: isSelected ? "#ffffff" : theme.text, pointerEvents: "none"
              }
              return (
                <li key={key} style={card} onClick={() => toggleSelected(key)} aria-pressed={isSelected}>
                  <div style={checkBox}>{isSelected ? "✓" : ""}</div>
                  <div style={{ fontWeight: 600 }}>{p.name || "Product"}</div>
                  <div style={{ ...muted, color: isSelected ? "rgba(255,255,255,0.9)" : undefined }}>{p.category ? `${p.category} • ` : ""}{p.weight_grams ? `${p.weight_grams}g` : "—"}</div>
                  {p.url && <a href={p.url} target="_blank" rel="noreferrer" style={link}>Bekijk product →</a>}
                </li>
              )
            })}
          </ul>
        ) : (
          <div style={{ opacity: 0.8 }}>Nog geen suggesties…</div>
        )}
      </div>
    </div>
  )
}

/* ---------- Theme & styles (same as your original) ---------- */
const light = { bg: "white", text: "#0b0f19", border: "rgba(0,0,0,0.12)", inputBg: "white", buttonBg: "black", buttonText: "white", outputBg: "rgba(0,0,0,0.02)", link: "#111827", errorBg: "rgba(239,68,68,.08)", errorText: "#7f1d1d", errorBorder: "rgba(239,68,68,.35)", cardBg: "#ffffff" }
const dark = { bg: "#0f1117", text: "#f3f4f6", border: "rgba(255,255,255,0.15)", inputBg: "#1a1c23", buttonBg: "#f3f4f6", buttonText: "#0f1117", outputBg: "#1a1c23", link: "#93c5fd", errorBg: "rgba(239,68,68,.15)", errorText: "#fee2e2", errorBorder: "rgba(239,68,68,.35)", cardBg: "#171a23" }

const container: React.CSSProperties = { fontFamily: "Poppins, Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif", display: "grid", gap: 14, padding: 16, width: "100%", boxSizing: "border-box", maxWidth: 720, margin: "0 auto", transition: "background 0.3s, color 0.3s" }
const inputStyle: React.CSSProperties = { height: 36, padding: "0 12px", borderRadius: 10, border: "1px solid", outline: "none", fontSize: 14, width: "100%" }
const btnBase: React.CSSProperties = { height: 36, padding: "0 14px", borderRadius: 10, border: "1px solid transparent", fontSize: 14, cursor: "pointer" }
const btnPrimary: React.CSSProperties = { ...btnBase }
const btnDanger: React.CSSProperties = { ...btnBase, background: "#ef4444", color: "white" }
const sectionTitle: React.CSSProperties = { fontWeight: 600 }
const chatScroll = (theme: any): React.CSSProperties => ({ border: "1px solid", borderColor: theme.border, borderRadius: 16, padding: 12, maxHeight: 520, minHeight: 200, overflowY: "auto", background: theme.outputBg })
const bubbleBase: React.CSSProperties = { borderRadius: 14, padding: "8px 12px", margin: "6px 0", maxWidth: "84%", lineHeight: 1.6, wordBreak: "break-word" }
const bubbleUser = (theme: any): React.CSSProperties => ({ background: theme.buttonBg, color: theme.buttonText })
const bubbleAssistant = (_theme: any): React.CSSProperties => ({ background: "rgba(0,0,0,.04)" })
const productsGrid: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }
const productCard: React.CSSProperties = { border: "1px solid", borderRadius: 12, padding: 12, display: "grid", gap: 6, minHeight: 96, overflow: "hidden" }
const muted: React.CSSProperties = { fontSize: 12, opacity: 0.8 }
const link: React.CSSProperties = { fontSize: 12, textDecoration: "underline" }
const errorBox: React.CSSProperties = { padding: 10, borderRadius: 10, border: "1px solid" }
const SELECTED = { bg: "#22c55e", border: "#16a34a" }
