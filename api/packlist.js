import * as React from "react"

/**
 * PacklistAssistant — met geheugen (localStorage)
 * - Promptgedreven, multi-turn slot-filling
 * - Slaat 'contextOut' op in localStorage en stuurt dit elke beurt mee
 * - Reset-knop om gesprek/geheugen te wissen
 */

const API_BASE = "https://packlist-bot.vercel.app"
const CTX_STORAGE_KEY = "packlist_ctx_v1" // 🔑 hier bewaren we context

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
type ContextPayload = { products?: any[]; season?: string }

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

/* ---------- Formatter helpers (ongewijzigd) ---------- */
function escapeHtml(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
function inlineMd(s: string) {
  let out = s
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code class="ai-inline-code">${escapeHtml(c)}</code>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, (_m, pre, txt) => `${pre}<em>${txt}</em>`)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => `<a href="${u}" target="_blank" rel="noreferrer">${escapeHtml(t)}</a>`)
  return out
}
function normalizeLLMText(raw: string): string {
  if (!raw) return ""
  const blocks: string[] = []
  let t = raw.replace(/```([\s\S]*?)```/g, (_m, code) => { blocks.push(code); return `@@CODE_${blocks.length - 1}@@` })
  t = t
    .replace(/\r\n/g, "\n")
    .replace(/(^|\n)\s*[*-]\s*(Korte\s*samenvatting)/i, (_m, pre, w) => `${pre}${w}`)
    .replace(/(#{1,6})([^\s#])/g, (_m, h, rest) => `${h} ${rest}`)
    .replace(/(^|[^\n])(#{1,6})/g, (_m, pre, h) => `${pre}\n${h}`)
    .replace(/([.,:;!?])([^\s])/g, "$1 $2")
    .replace(/([a-zà-ÿ])([A-ZÀ-Ý])/g, "$1 $2")
    .replace(/([A-Za-zÀ-ÿ])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-zÀ-ÿ])/g, "$1 $2")
    .replace(/([A-Za-zÀ-ÿ0-9])-(?=[A-Za-zÀ-ÿ0-9])/g, "$1 - ")
    .replace(/(^|\n)\s*([-*+])(?=[^\s-])/g, (_m, pre, b) => `${pre}${b} `)
    .replace(/\n{3,}/g, "\n\n")
  t = t.replace(/@@CODE_(\d+)@@/g, (_m, i) => "```" + blocks[Number(i)] + "```")
  return t.trim()
}
function beautifySummary(text: string): string {
  const re =
    /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?\s*Korte\s*samenvatting\s*(?:\*\*)?\s*[:：]?\s*\n?([\s\S]*?)(?=\n\s*(?:\*\*(?:Kleding|Gear|Gadgets|Health|Tips)\*\*|(?:Kleding|Gear|Gadgets|Health|Tips)\s*[-:]|#{1,6}\s|\n{2,}|$))/i
  const m = text.match(re)
  if (!m) return text
  let body = (m[1] || "").trim()
  const hasBullets = /^[-*]\s+/m.test(body)
  let bullets: string[]
  if (hasBullets) bullets = body.split(/\n/).map((s) => s.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean)
  else {
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
    const blockRe = new RegExp(String.raw`(\*\*${sec}\*\*[\s\S]*?)(?=\n\*\*(?:${sections.join("|")})\*\*|\n{2,}|$)`, "g")
    out = out.replace(blockRe, (block) => {
      let b = block
      if (!/^[-*]\s+/m.test(b) && /\s[-–—]\s/.test(b)) {
        b = b.replace(new RegExp(String.raw`(\*\*${sec}\*\*\s*)`), (_m, head) => `${head}- `)
        b = b.replace(/\s[-–—]\s/g, "\n- ")
      }
      b = b.replace(new RegExp(String.raw`(\*\*${sec}\*\*)(?!\s*\n)`), `$1\n`)
      return b
    })
  }
  return out
}
function formatToChatUI(raw: string): string {
  if (!raw) return ""
  const normalized = structureSections(beautifySummary(normalizeLLMText(raw)))
  const lines = normalized.split("\n")
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
    if (fence) { if (!inCode) { flushList(); inCode = true; codeLang = fence[1] || ""; codeBuf = [] } else { flushCode() } ; continue }
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
  .ai-rich .ai-hr { border:none; border-top:1px solid rgba(0,0,0,.08); margin: 14px 0; }
  .ai-rich a { text-decoration: underline; text-underline-offset: 3px; }
</style>
<div class="ai-rich">${out.join("")}</div>`
}

/* ---------- LocalStorage helpers (geheugen) ---------- */
function loadContext(): any | null {
  try { return JSON.parse(localStorage.getItem(CTX_STORAGE_KEY) || "null") } catch { return null }
}
function saveContext(ctx: any) {
  try { localStorage.setItem(CTX_STORAGE_KEY, JSON.stringify(ctx)) } catch {}
}
function clearContext() {
  try { localStorage.removeItem(CTX_STORAGE_KEY) } catch {}
}
function deepMerge(a: any, b: any) {
  if (Array.isArray(a) && Array.isArray(b)) return Array.from(new Set([...a, ...b]))
  if (a && typeof a === "object" && b && typeof b === "object") {
    const out: any = { ...a }
    for (const k of Object.keys(b)) out[k] = deepMerge(a?.[k], b[k])
    return out
  }
  return b ?? a
}

/* ---------- UI bits ---------- */
const BrandIcon: React.FC<{ color?: string }> = ({ color = "currentColor" }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18" />
    <path d="M12 3a15 15 0 0 0 0 18" />
  </svg>
)

/* ---------- Component ---------- */
type Props = { initialPrompt?: string; showHint?: boolean }

export default function PacklistAssistant({
  initialPrompt = "ik ga 20 dagen naar Indonesië, maak een backpacklijst",
  showHint = true,
}: Props) {
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
  const [running, setRunning] = React.useState(false)
  const [prompt, setPrompt] = React.useState(initialPrompt)
  const [deltaText, setDeltaText] = React.useState("")
  const [products, setProducts] = React.useState<Product[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [needsMsg, setNeedsMsg] = React.useState<string | null>(null)
  const [seasonHint, setSeasonHint] = React.useState<string | null>(null)

  // geheugen in component
  const needsRef = React.useRef<NeedsPayload | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)

  // laad eventueel bestaand geheugen (1x)
  React.useEffect(() => {
    const stored = loadContext()
    if (stored) needsRef.current = { contextOut: stored, missing: [] }
  }, [])

  // selectie-state
  const [selected, setSelected] = React.useState<Record<string, boolean>>({})
  const productKey = (p: Product, i: number) => `${p.name ?? "item"}|${p.url ?? ""}|${i}`
  const toggleSelected = (key: string) => setSelected((s) => ({ ...s, [key]: !s[key] }))

  const resetView = React.useCallback(() => {
    setDeltaText("")
    setProducts([])
    setError(null)
    setSelected({})
    setNeedsMsg(null)
    // seizoen-hint mag blijven staan
  }, [])
  const handleStop = React.useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
  }, [])
  const formattedHTML = React.useMemo(() => formatToChatUI(deltaText), [deltaText])

  const submitPrompt = React.useCallback(async () => {
    if (running || !prompt.trim()) return
    resetView()
    setRunning(true)

    try {
      const ac = new AbortController()
      abortRef.current = ac

      // ⭐️ Prompt + samengevoegde context (geheugen)
      const stored = loadContext()
      const fromNeeds = needsRef.current?.contextOut
      const mergedContext = deepMerge(stored || {}, fromNeeds || {})
      if (Object.keys(mergedContext || {}).length) saveContext(mergedContext) // sync vóór call

      const body: any = { prompt: prompt.trim() }
      if (mergedContext && Object.keys(mergedContext).length) body.context = mergedContext

      const res = await fetch(`${API_BASE}/api/packlist?stream=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) throw new Error(`Stream response not OK (${res.status})`)

      const reader = res.body.getReader()
      for await (const chunk of sseLines(reader)) {
        let ev: string | null = null
        let dataRaw = ""
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim()
          else if (line.startsWith("data:")) dataRaw += line.slice(5)
        }

        if (ev === "start") {
          setNeedsMsg(null)
        } else if (ev === "delta") {
          try {
            const maybe = JSON.parse(dataRaw)
            if (typeof maybe === "string") setDeltaText((t) => t + maybe)
            else if (typeof (maybe as any)?.text === "string") setDeltaText((t) => t + (maybe as any).text)
            else setDeltaText((t) => t + dataRaw)
          } catch { setDeltaText((t) => t + dataRaw) }
        } else if (ev === "needs") {
          try {
            const payload = (JSON.parse(dataRaw) as NeedsPayload) || {}
            // 🔐 geheugen updaten en bewaren
            const newCtx = deepMerge(loadContext() || {}, payload.contextOut || {})
            saveContext(newCtx)
            needsRef.current = { missing: payload.missing || [], contextOut: newCtx }

            const labels = (payload.missing || []).map((m) =>
              m === "destination.country" ? "land/regio" :
              m === "period" ? "duur + (startdatum of maand)" : m
            )
            setNeedsMsg(labels.length ? `Ik mis nog: ${labels.join(" & ")}` : null)
          } catch {}
        } else if (ev === "context") {
          try {
            const ctx = JSON.parse(dataRaw) as ContextPayload
            if (ctx?.season) setSeasonHint(`Afgeleid seizoen: ${ctx.season}`)
          } catch {}
        } else if (ev === "products") {
          try { setProducts((JSON.parse(dataRaw) as ProductsEvent) || []) } catch {}
        } else if (ev === "error") {
          try { setError((JSON.parse(dataRaw) as any)?.message || "Onbekende fout uit stream") }
          catch { setError(dataRaw || "Onbekende fout uit stream") }
          break
        } else if (ev === "done") {
          // niks
          break
        }
      }

      setRunning(false)
      abortRef.current = null
    } catch (e: any) {
      setError(e?.message || "Onbekende fout")
      setRunning(false)
    }
  }, [running, prompt, resetView])

  // Submit op Cmd/Ctrl+Enter of Enter (zonder Shift)
  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    const isCmdEnter = (e.metaKey || e.ctrlKey) && e.key === "Enter"
    const isPlainEnter = e.key === "Enter" && !e.shiftKey
    if (isCmdEnter || isPlainEnter) { e.preventDefault(); submitPrompt() }
  }

  // Reset gesprek/geheugen
  const onResetConversation = () => {
    clearContext()
    needsRef.current = null
    setNeedsMsg(null)
    setSeasonHint(null)
    // Laat AI output staan of wis ook:
    setDeltaText("")
    setProducts([])
  }

  React.useEffect(() => () => abortRef.current?.abort(), [])
  const theme = darkMode ? dark : light

  return (
    <div style={{ ...container, background: theme.bg, color: theme.text }}>
      {/* Header + Dark mode */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>Packlist Assistant</h3>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button onClick={onResetConversation} style={btnSecondary(theme)} aria-label="Reset gesprek">
            Reset gesprek
          </button>
          <label style={{ fontSize: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={darkMode} onChange={() => setDarkMode((v) => !v)} style={{ marginRight: 6 }} />
            Dark mode
          </label>
        </div>
      </div>

      {/* Promptveld (geen knop) */}
      <div style={{ display: "grid", gap: 6 }}>
        <label style={label}>Beschrijf je trip</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder='bv. "20 dagen in juli naar Indonesië, hiken en duiken"'
          rows={3}
          style={{ ...textareaStyle, background: theme.inputBg, color: theme.text, borderColor: theme.border }}
        />
        {!needsMsg && showHint && (
          <div style={{ ...muted, marginTop: -2 }}>
            Druk <strong>Enter</strong> (zonder Shift) of <strong>Cmd/Ctrl + Enter</strong> om te starten.
          </div>
        )}
        {needsMsg && (
          <div style={{ ...muted, marginTop: -2 }}>
            {needsMsg}. Antwoord in het tekstveld en druk Enter.
          </div>
        )}
        {seasonHint && <div style={{ ...muted, marginTop: -2 }}>{seasonHint}</div>}
      </div>

      {/* Stop-knop tijdens streamen */}
      {running && (
        <div style={controlsRow}>
          <button onClick={handleStop} style={btnDanger} aria-label="Stop genereren">Stop</button>
        </div>
      )}

      {error && (
        <div style={{ ...errorBox, background: theme.errorBg, color: theme.errorText, borderColor: theme.errorBorder }}>
          <strong>Fout:</strong> {error}
        </div>
      )}

      {/* AI Output */}
      <div style={{ display: "grid", gap: 8 }}>
        <div style={sectionTitle}>AI Output</div>
        <div style={{ ...outputBox, background: theme.outputBg, borderColor: theme.border, color: theme.text }}
             dangerouslySetInnerHTML={{ __html: formattedHTML }} />
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
                ...productCard, position: "relative",
                borderColor: isSelected ? SELECTED.border : theme.border,
                background: isSelected ? SELECTED.bg : "transparent",
                color: isSelected ? "#ffffff" : theme.text,
                transition: "background .15s ease, border-color .15s ease, color .15s ease",
                cursor: "pointer",
              }
              const checkBox: React.CSSProperties = {
                position: "absolute", top: 10, right: 10, width: 22, height: 22, borderRadius: 8,
                border: `1px solid ${isSelected ? "#ffffff" : theme.border}`, display: "grid", placeItems: "center",
                fontSize: 14, lineHeight: 1, background: isSelected ? "rgba(255,255,255,0.22)" : "transparent",
                color: isSelected ? "#ffffff" : theme.text, pointerEvents: "none",
              }
              const brandBox: React.CSSProperties = {
                position: "absolute", top: 40, right: 10, display: "flex", alignItems: "center", justifyContent: "center",
                padding: 6, width: 34, height: 34, borderRadius: 10,
                border: `1px solid ${isSelected ? "rgba(255,255,255,0.6)" : theme.border}`,
                background: isSelected ? "rgba(255,255,255,0.20)" : darkMode ? "rgba(255,255,255,0.06)" : "rgba(15,23,42,0.03)",
                color: isSelected ? "#ffffff" : darkMode ? "#e5e7eb" : "#111827",
                boxShadow: darkMode ? "0 2px 8px rgba(0,0,0,.25)" : "0 2px 8px rgba(0,0,0,.08)",
                userSelect: "none",
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
          <div style={{ opacity: 0.6 }}>Nog geen suggesties…</div>
        )}
      </div>
    </div>
  )
}

/* ---------- Thema’s & Styles ---------- */
const light = { bg: "white", text: "#0b0f19", border: "rgba(0,0,0,0.12)", inputBg: "white", buttonBg: "black", buttonText: "white", outputBg: "rgba(0,0,0,0.02)", link: "#111827", errorBg: "rgba(239,68,68,.08)", errorText: "#7f1d1d", errorBorder: "rgba(239,68,68,.35)" }
const dark  = { bg: "#0f1117", text: "#f3f4f6", border: "rgba(255,255,255,0.15)", inputBg: "#1a1c23", buttonBg: "#f3f4f6", buttonText: "#0f1117", outputBg: "#1a1c23", link: "#93c5fd", errorBg: "rgba(239,68,68,.15)", errorText: "#fee2e2", errorBorder: "rgba(239,68,68,.35)" }

const container: React.CSSProperties = { fontFamily: "Poppins, Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif", display: "grid", gap: 14, padding: 16, width: "100%", boxSizing: "border-box", maxWidth: 720, margin: "0 auto", transition: "background 0.3s, color 0.3s" }
const label: React.CSSProperties = { fontSize: 12, opacity: 0.8 }
const textareaStyle: React.CSSProperties = { minHeight: 72, padding: "10px 12px", borderRadius: 10, border: "1px solid", outline: "none", fontSize: 14, width: "100%", resize: "vertical" }
const controlsRow: React.CSSProperties = { display: "flex", gap: 12, alignItems: "center" }
const btnBase: React.CSSProperties = { height: 36, padding: "0 14px", borderRadius: 10, border: "1px solid transparent", fontSize: 14, cursor: "pointer" }
const btnDanger: React.CSSProperties = { ...btnBase, background: "#ef4444", color: "white" }
const btnSecondary = (theme: any): React.CSSProperties => ({
  ...btnBase,
  background: theme.bg === "white" ? "#f3f4f6" : "#1f2430",
  color: theme.text,
  borderColor: theme.border,
})
const sectionTitle: React.CSSProperties = { fontWeight: 600 }
const outputBox: React.CSSProperties = { minHeight: 160, maxHeight: 520, overflowY: "auto", wordBreak: "break-word", lineHeight: 1.6, padding: 16, borderRadius: 16, border: "1px solid" }
const productsGrid: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }
const productCard: React.CSSProperties = { border: "1px solid", borderRadius: 12, padding: 12, display: "grid", gap: 4, minHeight: 84, overflow: "hidden" }
const muted: React.CSSProperties = { fontSize: 12, opacity: 0.8 }
const link: React.CSSProperties = { fontSize: 12, textDecoration: "underline" }
const errorBox: React.CSSProperties = { padding: 10, borderRadius: 10, border: "1px solid" }
const SELECTED = { bg: "#22c55e", border: "#16a34a" }
