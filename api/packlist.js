import * as React from "react"

/**
 * PacklistAssistant — Advies óók bij ontbrekende info
 * - UI: per veld een "Weet ik niet" knop (cleart context + onderdrukt vragen)
 * - Herkent "weet ik (nog) niet" in vrije tekst (blijft bestaan)
 * - Zodra user later wél info geeft, wordt de 'onbekend' vlag voor dat slot gewist
 * - Dedupe/throttle van 'ask' SSE-events + advies-first policy
 */

const API_BASE = "https://packlist-bot.vercel.app" // jouw backend

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
type NeedsPayload = { missing?: string[]; contextOut?: any }

type SeasonalRisk = { type: string; level?: string; note?: string }
type ContextPayload = {
  season?: string | null
  seasonalRisks?: SeasonalRisk[]
  adviceFlags?: Record<string, boolean>
  itemTags?: string[]
  [k: string]: any
}

type ChatMsg = { role: "user" | "assistant"; html?: string; text?: string }
type OpenAIHistoryMsg = { role: "user" | "assistant"; content: string }

type StepId = "countries" | "period" | "duration" | "activities"
const ASK_ORDER: readonly StepId[] = ["countries", "period", "duration", "activities"]

/* ---------- Policy voor 'partial advice' ---------- */
type GuidancePolicy = {
  allowPartial: boolean
  preferAdviceOverQuestions: boolean
  questionsOnlyWhenBlocking: boolean
  showAlternatives: boolean
  assumptions: { allowed: boolean; mustBeExplicit: boolean; max: number }
}
const DEFAULT_POLICY: GuidancePolicy = {
  allowPartial: true,
  preferAdviceOverQuestions: true,
  questionsOnlyWhenBlocking: true,
  showAlternatives: true,
  assumptions: { allowed: true, mustBeExplicit: true, max: 5 },
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

/* ---------- Formatter helpers ---------- */
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
function normalizeLLMText(raw: string): string {
  if (!raw) return ""
  return raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim()
}
function beautifySummary(text: string): string {
  const re =
    /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?\s*Korte\s*samenvatting\s*(?:\*\*)?\s*[:：]?\s*\n?([\s\S]*?)(?=\n\s*(?:\*\*(?:Kleding|Gear|Gadgets|Health|Tips)\*\*|(?:Kleding|Gear|Gadgets|Health|Tips)\s*[-:]|#{1,6}\s|\n{2,}|$))/i
  const m = text.match(re)
  if (!m) return text
  let body = (m[1] || "").trim()
  const hasBullets = /^[-*]\s+/m.test(body)
  let bullets: string[]
  if (hasBullets) {
    bullets = body.split(/\n/).map((s) => s.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean)
  } else {
    body = body.replace(/\s[-–—]\s/g, ". ")
    bullets = body.replace(/([.!?])\s+(?=[A-ZÀ-Ý0-9])/g, "$1\n").split(/\n|•/).map((s) => s.trim()).filter(Boolean)
  }
  bullets = bullets.slice(0, 5)
  if (!bullets.length) return text
  const pretty = `**Korte samenvatting**\n\n${bullets.map((b) => `- ${b}`).join("\n")}\n\n`
  return text.replace(re, `\n${pretty}`)
}
function structureSections(text: string): string {
  const sections = ["Kleding", "Gear", "Gadgets", "Health", "Tips"]
  let out = text
  for (const sec of sections) {
    const titleRe = new RegExp(String.raw`(^|\n)\s*(?:\*\*)?\s*${sec}\s*(?:\*\*)?\s*[-:]\s*`, "gi")
    out = out.replace(titleRe, (_m, pre) => `${pre}**${sec}**\n`)
  }
  for (const sec of sections) {
    const blockRe = new RegExp(String.raw`\*\*${sec}\*\*[\s\S]*?(?=\n\*\*(?:${sections.join("|")})\*\*|\n{2,}|$)`, "g")
    out = out.replace(blockRe, (block) => {
      let b = block
      if (!/^[-*]\s+/m.test(b) && /\s[-–—]\s/.test(b)) {
        b = b.replace(new RegExp(String.raw`\*\*${sec}\*\*\s*`), ($1) => `${$1}- `)
        b = b.replace(/\s[-–—]\s/g, "\n- ")
      }
      b = b.replace(new RegExp(String.raw`(\*\*${sec}\*\*)(?!\s*\n)`), "$1\n")
      return b
    })
  }
  return out
}
function extractSummaryMarkdown(normalized: string): string {
  const m = normalized.match(/(\*\*Korte\s*samenvatting\*\*[\s\S]*?)(?=\s*\*\*(?:Kleding|Gear|Gadgets|Health|Tips)\*\*|\n{2,}|$)/i)
  if (m) return m[1].trim()
  const sectionRe = /\*\*(Kleding|Gear|Gadgets|Health|Tips)\*\*/i
  const sec = sectionRe.exec(normalized)
  if (sec && sec.index >= 0) {
    const head = normalized.slice(0, sec.index).trim()
    if (head) return head
  }
  const firstBreak = normalized.search(/[.!?]\s|\n{2,}|\n/)
  const sliceEnd = firstBreak > 0 ? firstBreak + 1 : Math.min(280, normalized.length)
  return normalized.slice(0, sliceEnd).trim()
}
function formatToChatUI(raw: string, opts?: { summaryOnly?: boolean }): string {
  if (!raw) return ""
  const normalized = structureSections(beautifySummary(normalizeLLMText(raw)))
  const source = opts?.summaryOnly ? extractSummaryMarkdown(normalized) : normalized
  const lines = source.split("\n")
  const out: string[] = []
  let inCode = false
  let codeLang = ""
  let codeBuf: string[] = []
  let listType: "ul" | "ol" | null = null
  const flushList = () => { if (listType) { out.push(`</${listType}>`); listType = null } }
  const startList = (type: "ul" | "ol") => { if (listType !== type) { flushList(); listType = type; out.push(`<${type} class="ai-list">`) } }
  const flushCode = () => {
    if (!inCode) return
    const codeHtml = escapeHtml(codeBuf.join("\n"))
    const langClass = codeLang ? ` language-${codeLang}` : ""
    out.push(`<div class="ai-codeblock"><pre class="ai-pre"><code class="ai-code${langClass}">${codeHtml}</code></pre></div>`)
    inCode = false; codeLang = ""; codeBuf = []
  }
  for (const lineRaw of lines) {
    const line = lineRaw
    const fence = line.match(/^```(\w+)?\s*$/)
    if (fence) { if (!inCode) { flushList(); inCode = true; codeLang = fence[1] || ""; codeBuf = [] } else { flushCode() } continue }
    if (inCode) { codeBuf.push(line); continue }
    if (!line.trim()) { flushList(); continue }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { flushList(); out.push(`<p class="ai-heading">${inlineMd(h[2].trim())}</p>`); continue }
    const bq = line.match(/^>\s?(.*)$/)
    if (bq) { flushList(); out.push(`<blockquote class="ai-quote">${inlineMd(bq[1])}</blockquote>`); continue }
    if (/^\s*\d+\.\s+/.test(line)) { startList("ol"); out.push(`<li>${inlineMd(line.replace(/^\s*\d+\.\s+/, ""))}</li>`); continue }
    if (/^\s*[-*]\s+/.test(line)) { startList("ul"); out.push(`<li>${inlineMd(line.replace(/^\s*[-*]\s+/, ""))}</li>`); continue }
    if (/^\s*---+\s*$/.test(line)) { flushList(); out.push(`<hr class="ai-hr" />`); continue }
    flushList(); out.push(`<p>${inlineMd(line.trim())}</p>`)
  }
  flushList(); flushCode()
  return `
<style>
  .ai-rich { font-size: 15px; line-height: 1.75; }
  .ai-rich p { margin: 10px 0; }
  .ai-rich .ai-heading { font-weight: 600; margin: 14px 0 6px; }
  .ai-rich .ai-list { padding-left: 22px; margin: 8px 0; }
  .ai-rich .ai-list li { margin: 6px 0; }
  .ai-rich .ai-quote { border-left: 3px solid rgba(0,0,0,.12); margin: 12px 0; padding: 6px 12px; background: rgba(0,0,0,.03); border-radius: 8px; }
  .ai-rich code.ai-inline-code { font-family: ui-monospace,Menlo,Consolas,monospace; font-size: .92em; padding: 1px 6px; border-radius: 6px; background: rgba(15,23,42,.06); }
  .ai-rich .ai-codeblock { border: 1px solid rgba(0,0,0,.08); border-radius: 12px; overflow: hidden; margin: 12px 0; }
  .ai-rich .ai-pre { margin:0; padding:10px; background: rgba(15,23,42,.03); overflow:auto; }
  .ai-rich .ai-code { font-family: ui-monospace,Menlo,Consolas,monospace; font-size: 12.8px; white-space: pre; }
  .ai-rich .ai-hr { border:none; border-top:1px solid rgba(0,0,0,.08); margin: 14px 0; }
  .ai-rich a { text-decoration: underline; text-underline-offset: 3px; }
</style>
<div class="ai-rich">${out.join("")}</div>`
}

/* ---------- Helpers ---------- */
function deepMerge<T>(target: T, source: any): T {
  if (source === null || typeof source !== "object") return target
  const out: any = Array.isArray(target) ? [...(target as any)] : { ...(target as any) }
  for (const k of Object.keys(source)) {
    const sv = (source as any)[k]
    const tv = (out as any)[k]
    if (sv && typeof sv === "object" && !Array.isArray(sv)) { (out as any)[k] = deepMerge(tv ?? {}, sv) }
    else if (sv !== null && sv !== undefined) { (out as any)[k] = sv }
  }
  return out
}
function simplifyAskQuestion(q: string): string {
  if (!q) return q
  let t = q.replace(/\s*\((?:bekend|known)\s*:[^)]+\)\s*/gi, " ")
  t = t.replace(/\s{2,}/g, " ").replace(/\s+\?/g, "?").trim()
  return t
}
function isBlockedProduct(p: Product): boolean {
  const u = (p.url || "").toLowerCase()
  if (!u) return false
  return (
    /\.csv(\?|$)/.test(u) ||
    u.includes("export=download&format=csv") ||
    u.includes("docs.google.com/spreadsheets") ||
    (u.includes("sheet") && u.includes("gid=")) ||
    /debug|dbg|test/.test((p.name || "").toLowerCase())
  )
}
function dedupeProducts(list: ProductsEvent): ProductsEvent {
  const seen = new Set<string>()
  const out: ProductsEvent = []
  for (const p of list) { if (isBlockedProduct(p)) continue; const key = `${p.name ?? ""}|${p.url ?? ""}`.toLowerCase(); if (!seen.has(key)) { seen.add(key); out.push(p) } }
  return out
}

/* ---------- Lichte NLU ---------- */
type NLUHints = {
  lang: "nl" | "en"
  country?: string | null
  durationDays?: number | null
  startDate?: string | null
  endDate?: string | null
  month?: string | null
  confidence: number
  paraphrase?: string
}
const strip = (s = "") => s.normalize("NFD").replace(/\p{Diacritic}+/gu, "").toLowerCase()
const COUNTRY_LIST =
  "vietnam|filipijnen|indonesie|indonesië|thailand|cambodja|laos|spanje|portugal|italie|italië|frankrijk|griekenland|turkije|marokko|mexico|peru|argentinie|argentinë|chili|japan|korea|australie|australië|nieuw-zeeland|canada|verenigde staten|vs|noorwegen|zweden|finland".split("|")
const MONTHS: Record<string, number> = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5, juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}
function iso(d: Date) { const z = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); return z.toISOString().slice(0,10) }
function parseFlexibleDuration(t: string): number | null {
  const s = strip(t)
  const m = s.match(/\b(\d{1,3})\s*(dagen|dag|weken|week|maanden|maand|d|w|m)\b/i)
  if (m) { const n = parseInt(m[1], 10); const u = m[2][0].toLowerCase(); return u==="w"?n*7:u==="m"?n*30:n }
  if (/\b(paar|enkele)\s*maanden?\b/.test(s)) return 90
  if (/\b(maandje)\b/.test(s)) return 30
  if (/\b(weekje)\b/.test(s)) return 7
  if (/\b(paar|enkele)\s*weken?\b/.test(s)) return 14
  return null
}
function parseFlexiblePeriod(t: string): { month?: string | null; startDate?: string | null; endDate?: string | null } {
  const s = strip(t)
  const range = s.match(/\b(\d{1,2})\s*(?:-|t\/m|tot)\s*(\d{1,2})\s*(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s*(\d{4})?\b/)
  if (range) {
    const d1 = parseInt(range[1],10), d2 = parseInt(range[2],10)
    const monthTxt = range[3]
    const mIdx = MONTHS[monthTxt as keyof typeof MONTHS]
    const y = range[4] ? parseInt(range[4],10) : new Date().getFullYear()
    return { startDate: iso(new Date(Date.UTC(y,mIdx,d1))), endDate: iso(new Date(Date.UTC(y,mIdx,d2))), month: null }
  }
  const vanaf = s.match(/vanaf\s+(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)/)
  if (vanaf) { const d = parseInt(vanaf[1],10), mIdx = MONTHS[vanaf[2] as keyof typeof MONTHS], y = new Date().getFullYear(); return { startDate: iso(new Date(Date.UTC(y,mIdx,d))), endDate: null, month: null } }
  const rel = s.match(/over\s+(\d{1,2})\s*(weken|maanden|dagen)/)
  if (rel) {
    const n = parseInt(rel[1],10), unit = rel[2]; const now = new Date(), sd = new Date(now)
    if (/weken/.test(unit)) sd.setUTCDate(sd.getUTCDate()+n*7)
    else if (/maanden/.test(unit)) sd.setUTCMonth(sd.getUTCMonth()+n)
    else sd.setUTCDate(sd.getUTCDate()+n)
    return { startDate: iso(sd), endDate: null, month: null }
  }
  if (/\b(jaarwisseling|kerst)\b/.test(s)) return { month: "december", startDate: null, endDate: null }
  const m = s.match(/\b(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|january|february|march|april|may|june|july|august|september|october|november|december)\b/)
  if (m) return { month: m[0].toLowerCase(), startDate: null, endDate: null }
  return { month: null, startDate: null, endDate: null }
}
function detectCountry(t: string): string | null {
  const s = strip(t)
  const re = new RegExp(`\\b(${COUNTRY_LIST.join("|")})\\b`, "i")
  return s.match(re)?.[0] ?? null
}
function nluHintsFrom(message: string, prev: { destination?: { country?: string | null }, durationDays?: number | null, month?: string | null, startDate?: string | null, endDate?: string | null }): NLUHints {
  const country = detectCountry(message) ?? prev?.destination?.country ?? null
  const durationDays = parseFlexibleDuration(message) ?? prev.durationDays ?? null
  const per = parseFlexiblePeriod(message)
  const month = per.month ?? prev.month ?? null
  const startDate = per.startDate ?? prev.startDate ?? null
  const endDate = per.endDate ?? prev.endDate ?? null
  let conf = 0; if (country) conf += 0.3; if (durationDays) conf += 0.25; if (month || startDate) conf += 0.25; conf = Math.min(1, conf)
  const bits: string[] = []
  if (country) bits.push(`land: ${country}`)
  if (month) bits.push(`periode: ${month}`); else if (startDate) bits.push(`periode: ${startDate}${endDate ? ` → ${endDate}` : ""}`)
  if (durationDays) bits.push(`duur: ${durationDays} dagen`)
  const paraphrase = bits.length ? `Als ik je goed begrijp: ${bits.join(" • ")}.` : undefined
  return { lang: "nl", country, durationDays, month, startDate, endDate, confidence: conf, paraphrase }
}

/* ---------- History helpers ---------- */
function stripHtmlTags(html = "") { return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }
function buildHistoryForBackend(msgs: ChatMsg[]): OpenAIHistoryMsg[] {
  const last = msgs.slice(-12).map((m) => {
    const raw = (m.text ?? (m.html ? stripHtmlTags(m.html) : "")).trim()
    return { role: m.role, content: raw.slice(0, 2000) }
  })
  return last.filter((m) => m.content && !/^AI is aan het nadenken/i.test(m.content))
}

/* ---------- Vragen-onderdrukking ---------- */
const DONT_KNOW_RE = /\b(weet ik (nog )?niet|geen idee|idk|niet zeker|nog onzeker)\b/i
function classifyAskSlot(q: string): StepId | null {
  const s = q.toLowerCase()
  if (/(hoeveel|duur|dagen)/.test(s)) return "duration"
  if (/(periode|maand|exacte data|wanneer)/.test(s)) return "period"
  if (/(bestemming|land|regio)/.test(s)) return "countries"
  if (/(activiteit)/.test(s)) return "activities"
  return null
}

/* ---------- Brand-icoon ---------- */
const BrandIcon: React.FC<{ color?: string }> = ({ color = "currentColor" }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18" />
    <path d="M12 3a15 15 0 0 0 0 18" />
  </svg>
)

/* ---------- Component (Chat) ---------- */
type Props = { showHint?: boolean }

export default function PacklistAssistant({ showHint = true }: Props) {
  // font
  React.useEffect(() => {
    const id = "poppins-font-link"
    if (!document.getElementById(id)) {
      const link = document.createElement("link")
      link.id = id
      link.rel = "stylesheet"
      link.href = "https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap"
      document.head.appendChild(link)
    }
  }, [])

  const [darkMode, setDarkMode] = React.useState(false)

  // Conversatie state
  const [messages, setMessages] = React.useState<ChatMsg[]>([
    { role: "assistant", text: "Hoi! 👋 Vertel in je eigen woorden je plannen (landen, duur, periode, activiteiten). Ik kan alvast advies geven als nog niet alles bekend is." },
  ])
  const [input, setInput] = React.useState("")
  const [running, setRunning] = React.useState(false)
  const [thinking, setThinking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Meta
  const [seasonHint, setSeasonHint] = React.useState<string | null>(null)
  const [seasonMeta, setSeasonMeta] = React.useState<{ risks?: SeasonalRisk[]; adviceFlags?: Record<string, boolean> } | null>(null)
  const [assumptions, setAssumptions] = React.useState<string[]>([]) // optioneel vanuit backend

  const [products, setProducts] = React.useState<Product[]>([])
  const [selected, setSelected] = React.useState<Record<string, boolean>>({})
  const abortRef = React.useRef<AbortController | null>(null)

  // Context
  const [context, setContext] = React.useState<{
    destination: { country: string | null; region: string | null }
    durationDays: number | null
    startDate: string | null
    endDate: string | null
    month: string | null
    activities: string[]
    preferences: any | null
  }>({
    destination: { country: null, region: null },
    durationDays: null,
    startDate: null,
    endDate: null,
    month: null,
    activities: [],
    preferences: null,
  })

  // Slots die user expliciet "onbekend" heeft gezet
  const [slotsUserDoesNotKnow, setSlotsUserDoesNotKnow] = React.useState<Set<StepId>>(new Set())

  // Per-beurt throttling van 'ask'
  const askedThisTurnRef = React.useRef<{ seenTexts: Set<string>; perSlot: Record<StepId, number>; total: number }>({
    seenTexts: new Set(),
    perSlot: { countries: 0, period: 0, duration: 0, activities: 0 },
    total: 0,
  })

  const theme = darkMode ? dark : light

  const pushAssistantText = (t: string) => setMessages((m) => [...m, { role: "assistant", text: t }])
  const pushAssistantHTML = (h: string) => setMessages((m) => [...m, { role: "assistant", html: h }])

  const productKey = (p: Product, i: number) => `${p.name ?? "item"}|${p.url ?? ""}|${i}`
  const toggleSelected = (key: string) => setSelected((s) => ({ ...s, [key]: !s[key] }))

  const resetTurnSideEffects = React.useCallback(() => {
    setError(null); setProducts([]); setSelected({}); setAssumptions([])
    askedThisTurnRef.current = { seenTexts: new Set(), perSlot: { countries: 0, period: 0, duration: 0, activities: 0 }, total: 0 }
  }, [])

  const handleStop = React.useCallback(() => {
    abortRef.current?.abort(); abortRef.current = null; setRunning(false); setThinking(false)
  }, [])

  function formatSeasonNote(season: string | null | undefined, risks?: SeasonalRisk[]) {
    if (!season) return null
    const top = (risks || [])[0]
    if (top) { const lvl = top.level ? ` (${top.level})` : ""; return `Seizoen: ${season} • Risico: ${top.type}${lvl}` }
    return `Seizoen: ${season}`
  }

  /* ---------- Optimistisch updaten + 'unknown' resetten als user alsnog info geeft ---------- */
  function extractFromText(t: string) {
    if (!t) return
    let updated = { ...context }

    // LAND
    const cRx = new RegExp(`\\b(${COUNTRY_LIST.join("|")})\\b`, "i")
    const country = t.match(cRx)?.[0]
    if (country) {
      updated = deepMerge(updated, { destination: { country, region: null } })
      setSlotsUserDoesNotKnow((prev) => { const n = new Set(prev); n.delete("countries"); return n })
    }

    // DUUR
    const dur = t.match(/\b(\d{1,3})\s*(dagen|dag|weken|week|maanden|maand|d|w|m)\b/i)
    if (dur) {
      const [, nStr, unitRaw] = dur
      const n = parseInt(nStr, 10)
      const unit = unitRaw.toLowerCase()
      const days = unit.startsWith("w") ? n * 7 : unit.startsWith("m") ? n * 30 : n
      updated = deepMerge(updated, { durationDays: Number.isFinite(days) ? days : null })
      setSlotsUserDoesNotKnow((prev) => { const nset = new Set(prev); nset.delete("duration"); return nset })
    }

    // PERIODE (maand)
    const month = t.match(/\b(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\b/i)?.[0]
    if (month) {
      updated = deepMerge(updated, { month: month.toLowerCase() })
      setSlotsUserDoesNotKnow((prev) => { const n = new Set(prev); n.delete("period"); return n })
    }

    setContext(updated)
  }

  /* ---------- Backend trigger (policy + history + nluHints) ---------- */
  async function sendToBackend(message: string, history?: OpenAIHistoryMsg[], nluHints?: NLUHints) {
    resetTurnSideEffects()
    setRunning(true); setThinking(true)
    try {
      const ac = new AbortController(); abortRef.current = ac
      const res = await fetch(`${API_BASE}/api/packlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, context, history, nluHints, policy: DEFAULT_POLICY }),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) throw new Error(`Stream response not OK (${res.status})`)

      let streamedText = ""
      let hasStarted = false

      const reader = res.body.getReader()
      for await (const chunk of sseLines(reader)) {
        let ev: string | null = null
        let dataRaw = ""
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim()
          else if (line.startsWith("data:")) dataRaw += line.slice(5)
        }

        if (ev === "ask") {
          try {
            const payload = JSON.parse(dataRaw) as { question?: string }
            const q = simplifyAskQuestion(payload?.question || "")
            const slot = classifyAskSlot(q)
            const askedState = askedThisTurnRef.current

            // Dedupe/throttle/onderdrukken
            const exceedGlobal = askedState.total >= 1
            const seenBefore = askedState.seenTexts.has(q)
            const blockedByDontKnow = slot ? slotsUserDoesNotKnow.has(slot) : false

            if (!q || seenBefore || exceedGlobal || blockedByDontKnow || DEFAULT_POLICY.preferAdviceOverQuestions) {
              // sla deze vraag over; backend blijft toch doorgaan met advies
            } else {
              askedState.total += 1
              askedState.seenTexts.add(q)
              if (slot) askedState.perSlot[slot] = (askedState.perSlot[slot] || 0) + 1
              pushAssistantText(q)
            }
          } catch {}
        } else if (ev === "assumptions") {
          try {
            const arr = JSON.parse(dataRaw) as string[] | undefined
            if (Array.isArray(arr) && arr.length) setAssumptions(arr.slice(0, DEFAULT_POLICY.assumptions.max))
          } catch {}
        } else if (ev === "needs") {
          try {
            const payload = (JSON.parse(dataRaw) as NeedsPayload) || {}
            if (payload?.contextOut) setContext((c) => deepMerge(c, payload.contextOut))
          } catch {}
        } else if (ev === "context") {
          try {
            const ctx = JSON.parse(dataRaw) as ContextPayload
            const nice = formatSeasonNote(ctx?.season ?? null, ctx?.seasonalRisks)
            if (nice) setSeasonHint(nice)
            setSeasonMeta({ risks: ctx?.seasonalRisks || [], adviceFlags: ctx?.adviceFlags || {} })
            const { season, seasonalRisks, adviceFlags, itemTags, ...rest } = ctx || {}
            if (Object.keys(rest).length) setContext((c) => deepMerge(c, rest))
          } catch {}
        } else if (ev === "start") {
          hasStarted = true
          streamedText = ""
          pushAssistantHTML(formatToChatUI("", { summaryOnly: true }))
        } else if (ev === "delta" && hasStarted) {
          let add = ""
          try {
            const maybe = JSON.parse(dataRaw)
            if (typeof maybe === "string") add = maybe
            else if (typeof (maybe as any)?.text === "string") add = (maybe as any).text
            else add = dataRaw
          } catch { add = dataRaw }
          streamedText += add
          setMessages((msgs) => {
            const copy = [...msgs]
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === "assistant" && "html" in copy[i]) {
                copy[i] = { role: "assistant", html: formatToChatUI(streamedText, { summaryOnly: true }) }
                break
              }
            }
            return copy
          })
        } else if (ev === "products") {
          try {
            const incoming = (JSON.parse(dataRaw) as ProductsEvent) || []
            const clean = dedupeProducts(incoming)
            setProducts((prev) => dedupeProducts([...(prev || []), ...clean]))
          } catch {}
        } else if (ev === "error") {
          try { setError((JSON.parse(dataRaw) as any)?.message || "Onbekende fout uit stream") } catch { setError(dataRaw || "Onbekende fout uit stream") }
          break
        } else if (ev === "done") {
          break
        }
      }

      setRunning(false); setThinking(false); abortRef.current = null
    } catch (e: any) {
      setError(e?.message || "Onbekende fout")
      setRunning(false); setThinking(false)
    }
  }

  /* ---------- Input handlers ---------- */
  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleUserSend(input) }
  }

  function handleUserSend(message: string) {
    if (!message.trim() || running) return
    setMessages((m) => [...m, { role: "user", text: message }])
    setInput("")
    resetTurnSideEffects()

    // User zegt "weet ik niet" → markeer alle huidige missende slots als unknown
    if (DONT_KNOW_RE.test(message)) {
      const missingNow: StepId[] = []
      if (!context.destination?.country) missingNow.push("countries")
      if (!context.month && !context.startDate) missingNow.push("period")
      if (!context.durationDays) missingNow.push("duration")
      if (!context.activities?.length) missingNow.push("activities")
      setSlotsUserDoesNotKnow(new Set(missingNow))
      pushAssistantText("Geen probleem — ik geef alvast concreet advies met aannames. Vul aan zodra je meer weet.")
    }

    // Optimistisch bijwerken & hints (en unknown-vlaggen resetten als er info binnenkomt)
    extractFromText(message)
    const hints = nluHintsFrom(message, context)
    if (hints.paraphrase) pushAssistantText(`${hints.paraphrase} Ik geef alvast advies met aannames waar nodig.`)

    // Altijd backend laten adviseren (policy regelt vragen vs advies)
    const history = buildHistoryForBackend([...messages, { role: "user", text: message }])
    return sendToBackend(message, history, hints)
  }

  /* ---------- Chip-acties: expliciet "Weet ik niet" ---------- */
  function clearSlotAndMarkUnknown(slot: StepId) {
    setContext((c) => {
      const n = { ...c }
      if (slot === "countries") n.destination = { country: null, region: null }
      if (slot === "period") { n.month = null; n.startDate = null; n.endDate = null }
      if (slot === "duration") n.durationDays = null
      if (slot === "activities") n.activities = []
      return n
    })
    setSlotsUserDoesNotKnow((prev) => new Set(prev).add(slot))
    pushAssistantText("Top, ik negeer dit onderdeel voorlopig en geef advies met aannames.")
  }

  /* ---------- UI ---------- */
  const chips = [
    { slot: "countries" as StepId, label: "Land", value: context.destination?.country || undefined, onEdit: () => setInput("Ik ga naar …") },
    { slot: "period" as StepId, label: "Periode", value: context.month || context.startDate || undefined, onEdit: () => setInput("Ik ga in …") },
    { slot: "duration" as StepId, label: "Duur", value: context.durationDays ? `${context.durationDays} dagen` : undefined, onEdit: () => setInput("Ik ga ongeveer … dagen weg") },
    { slot: "activities" as StepId, label: "Activiteiten", value: context.activities?.length ? context.activities.join(", ") : undefined, onEdit: () => setInput("Ik wil o.a. hiken/surfen/…") },
  ]

  const missing = [
    !context.destination?.country && "bestemming",
    !(context.month || context.startDate) && "periode",
    !context.durationDays && "duur",
    !(context.activities?.length) && "activiteiten",
  ].filter(Boolean) as string[]

  return (
    <div style={{ ...container, background: theme.bg, color: theme.text }}>
      {/* Header + Dark mode */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>Packlist Assistant</h3>
        <label style={{ fontSize: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={darkMode} onChange={() => setDarkMode((v) => !v)} style={{ marginRight: 6 }} />
          Dark mode
        </label>
      </div>

      {showHint && (
        <div style={{ ...muted }}>
          Tip: typ vrijuit (bv. “45 dagen Vietnam in juli, hiken &amp; duiken”). Ik kan ook alvast advies geven als nog niet alles bekend is.
        </div>
      )}

      {/* Partial info banner */}
      {!!missing.length && (
        <div style={{ ...muted, padding: "6px 8px", border: `1px dashed ${theme.border}`, borderRadius: 8 }}>
          Niet alles is ingevuld ({missing.join(", ")}). Ik geef voorlopig advies met aannames. Pas gerust later aan.
        </div>
      )}

      {/* Assumptions (optioneel vanuit backend) */}
      {!!assumptions.length && (
        <div style={{ ...muted }}>
          Aannames: {assumptions.map((a, i) => <span key={i} style={{ display:"inline-block", marginRight:8 }}>• {a}</span>)}
        </div>
      )}

      {seasonHint && <div style={{ ...muted }}>{seasonHint}</div>}
      {error && (
        <div style={{ ...errorBox, background: theme.errorBg, color: theme.errorText, borderColor: theme.errorBorder }}>
          <strong>Fout:</strong> {error}
        </div>
      )}

      {/* Chat */}
      <div style={chatScroll(theme)}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{ ...bubbleBase, ...(m.role === "user" ? bubbleUser(theme) : bubbleAssistant(theme)) }}>
              {"html" in m && m.html ? <div dangerouslySetInnerHTML={{ __html: m.html }} /> : <div>{m.text}</div>}
            </div>
          </div>
        ))}
      </div>

      {/* Samenvattingschips + "Weet ik niet" */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {chips.map((c, idx) => {
          const unknown = slotsUserDoesNotKnow.has(c.slot)
          return (
            <div
              key={idx}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 999,
                border: `1px solid ${theme.border}`,
                background: theme.cardBg,
                fontSize: 12,
              }}
              title="Klik om te bewerken of markeer als 'Weet ik niet'"
            >
              <span style={{ opacity: 0.75 }}>{c.label}:</span>
              <span>{c.value || (unknown ? "— (onbekend)" : "—")}</span>

              {/* Bewerken */}
              <button
                onClick={c.onEdit}
                style={{
                  ...btnBase,
                  height: 24,
                  padding: "0 8px",
                  borderRadius: 999,
                  background: "transparent",
                  border: `1px solid ${theme.border}`,
                  fontSize: 12,
                }}
              >
                ✎
              </button>

              {/* Weet ik niet */}
              <button
                onClick={() => clearSlotAndMarkUnknown(c.slot)}
                style={{
                  ...btnBase,
                  height: 24,
                  padding: "0 10px",
                  borderRadius: 999,
                  background: "transparent",
                  border: `1px dashed ${theme.border}`,
                  fontSize: 12,
                  opacity: 0.85,
                }}
                title="Markeer als 'Weet ik niet' (wordt tijdelijk genegeerd)"
              >
                Weet ik niet
              </button>
            </div>
          )
        })}
      </div>

      {/* Input */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Schrijf hier… bv. 'januari Azië, paar maanden, surfen' of 'weet ik nog niet'"
          style={{ ...inputStyle, background: theme.inputBg, color: theme.text, borderColor: theme.border }}
          disabled={running}
        />
        <button onClick={() => handleUserSend(input)} disabled={!input.trim() || running} style={{ ...btnPrimary, background: theme.buttonBg, color: theme.buttonText }}>
          Verstuur
        </button>
        {running && (
          <button onClick={handleStop} style={btnDanger} aria-label="Stop genereren">
            Stop
          </button>
        )}
      </div>

      {/* Suggested Products */}
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
                boxShadow: isSelected ? "0 6px 18px rgba(34,197,94,.35)" : darkMode ? "0 2px 10px rgba(0,0,0,.35)" : "0 2px 10px rgba(0,0,0,.06)",
                transition: "background .15s ease, border-color .15s ease, color .15s ease, box-shadow .15s ease",
                cursor: "pointer",
              }
              const checkBox: React.CSSProperties = {
                position: "absolute", top: 10, right: 10, width: 22, height: 22, borderRadius: 8, border: `1px solid ${isSelected ? "#ffffff" : theme.border}`,
                display: "grid", placeItems: "center", fontSize: 14, lineHeight: 1, background: isSelected ? "rgba(255,255,255,0.22)" : "transparent", color: isSelected ? "#ffffff" : theme.text, pointerEvents: "none",
              }
              const brandBox: React.CSSProperties = {
                position: "absolute", top: 40, right: 10, display: "flex", alignItems: "center", justifyContent: "center", padding: 6, width: 34, height: 34, borderRadius: 10,
                border: `1px solid ${isSelected ? "rgba(255,255,255,0.6)" : theme.border}`,
                background: isSelected ? "rgba(255,255,255,0.20)" : darkMode ? "rgba(255,255,255,0.06)" : "rgba(15,23,42,0.03)",
                color: isSelected ? "#ffffff" : darkMode ? "#e5e7eb" : "#111827",
                boxShadow: darkMode ? "0 2px 8px rgba(0,0,0,.25)" : "0 2px 8px rgba(0,0,0,.08)", userSelect: "none",
              }
              const linkStyle: React.CSSProperties = { ...link, color: isSelected ? "#ffffff" : theme.link }

              return (
                <li key={key} style={card} onClick={() => toggleSelected(key)} aria-pressed={isSelected}>
                  <div style={checkBox}>{isSelected ? "✓" : ""}</div>
                  <div style={brandBox} title="Externe website (binnenkort)" onClick={(e) => e.stopPropagation()}>
                    <BrandIcon color={isSelected ? "#ffffff" : darkMode ? "#e5e7eb" : "#111827"} />
                  </div>
                  <div style={{ fontWeight: 600 }}>{p.name || "Product"}</div>
                  <div style={{ ...muted, color: isSelected ? "rgba(255,255,255,0.9)" : undefined }}>
                    {p.category ? `${p.category} • ` : ""}{p.weight_grams ? `${p.weight_grams}g` : "—"}
                  </div>
                  {p.url && (
                    <a href={p.url} target="_blank" rel="noreferrer" style={linkStyle} onClick={(e) => e.stopPropagation()}>
                      Bekijk product →
                    </a>
                  )}
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

/* ---------- Thema’s ---------- */
const light = { bg: "white", text: "#0b0f19", border: "rgba(0,0,0,0.12)", inputBg: "white", buttonBg: "black", buttonText: "white", outputBg: "rgba(0,0,0,0.02)", link: "#111827", errorBg: "rgba(239,68,68,.08)", errorText: "#7f1d1d", errorBorder: "rgba(239,68,68,.35)", cardBg: "#ffffff" }
const dark = { bg: "#0f1117", text: "#f3f4f6", border: "rgba(255,255,255,0.15)", inputBg: "#1a1c23", buttonBg: "#f3f4f6", buttonText: "#0f1117", outputBg: "#1a1c23", link: "#93c5fd", errorBg: "rgba(239,68,68,.15)", errorText: "#fee2e2", errorBorder: "rgba(239,68,68,.35)", cardBg: "#171a23" }

/* ---------- Styles ---------- */
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
