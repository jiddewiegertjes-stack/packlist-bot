export const runtime = "edge";

/**
 * Packlist SSE + Slot-Filling Chat Backend (Edge) — EN version
 * ------------------------------------------------------------
 * - Accepts `history` and `nluHints` from the frontend.
 * - Allows the model to interpret vague language (e.g., "couple of weeks", "around New Year").
 * - Breaks the ask-loop as soon as there is enough signal (duration/period).
 * - Injects season context as an extra system rule.
 * - NEW: Prompt policy to always answer (even if info is missing), avoid follow-up questions,
 *   and normalize typos/variants.
 */

const OPENAI_API_BASE = "https://api.openai.com/v1";
const OPENAI_MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-4o-mini";
const OPENAI_MODEL_JSON = process.env.OPENAI_MODEL_JSON || "gpt-4o-mini";
const enc = new TextEncoder();

/* --------------------------- CORS helpers --------------------------- */

const ALLOWED_ORIGINS = [
  "https://*.framer.website",
  "https://*.framer.app",
  "https://*.framer.media",
  "https://*.vercel.app",
  "https://trekvice.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function originAllowed(origin = "") {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some((pat) => {
    if (pat.includes("*")) {
      const rx = new RegExp("^" + pat.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      return rx.test(origin);
    }
    return origin === pat;
  });
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowOrigin = originAllowed(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-session-id",
    "Access-Control-Allow-Credentials": "true",
  };
}

export async function OPTIONS(req: Request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(req),
      "Cache-Control": "no-store",
      "Content-Length": "0",
    },
  });
}

export async function GET(req: Request) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(req),
    },
  });
}

/* ------------------------------ POST ------------------------------- */

export async function POST(req: Request) {
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data?: any) => {
        const payload =
          data === undefined
            ? `event: ${event}\n\n`
            : `event: ${event}\n` +
              `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
        controller.enqueue(enc.encode(payload));
      };
      const closeWithError = (msg: string) => {
        try { send("error", { message: msg }); } catch {}
        controller.close();
      };

      let body: any;
      try {
        body = await req.json();
      } catch {
        return closeWithError("Invalid JSON body");
      }

      const safeContext = normalizeContext(body?.context);
      const message = (body?.message || "").trim();
      const hasDirectPrompt = typeof body?.prompt === "string" && body.prompt.trim().length > 0;

      // Conversation history and hints from the frontend
      const history = sanitizeHistory(body?.history);
      const nluHints = body?.nluHints || null;

      try {
        // Free text path (slot-filling)
        if (!hasDirectPrompt && message) {
          const extracted = await extractSlots({ utterance: message, context: safeContext });
          mergeInto(safeContext, extracted?.context || {});
          const missing = missingSlots(safeContext);

          // See if there is language signal so we DON'T need to ask
          const userLower = message.toLowerCase();
          const hasDurationSignal =
            !!nluHints?.durationDays ||
            !!nluHints?.durationPhrase ||
            /\b(week|weeks|couple\s*of\s*weeks|month|months)\b/.test(userLower) ||
            /\b(weekje|maandje|paar\s*weken|paar\s*maanden)\b/.test(userLower);
          const hasPeriodSignal =
            !!nluHints?.month ||
            !!nluHints?.startDate ||
            !!nluHints?.periodPhrase ||
            /\baround\s+new\s*year|around\s+christmas\b/.test(userLower) ||
            /\brond\s+de\s+jaarwisseling|rond\s+kerst|oud.*nieuw\b/.test(userLower);

          // Only ask if EVERYTHING is missing (country, duration AND period) and there is zero signal
          const HARD_MISS = ["destination.country", "durationDays", "period"] as const;
          const allHardMissing = HARD_MISS.every(f => missing.includes(f));
          const hasAnySignal =
            !!nluHints?.durationDays ||
            !!nluHints?.month ||
            !!nluHints?.startDate ||
            !!safeContext?.destination?.country ||
            !!safeContext?.durationDays ||
            (Array.isArray(safeContext?.activities) && safeContext.activities.length > 0) ||
            hasPeriodSignal || hasDurationSignal;

          if (allHardMissing && !hasAnySignal) {
            const followupQ = followupQuestion({ missing, context: safeContext });
            send("needs", { missing, contextOut: extracted?.context || {} });
            const derived = await derivedContext(safeContext);
            const seasonsCtx = await seasonsContextFor(safeContext);
            send("ask", { question: followupQ, missing });
            send("context", { ...derived, ...seasonsCtx });
            controller.close();
            return;
          }

          // Otherwise: ALWAYS generate, even if 'period' or something else is still missing
          await generateAndStream({
            controller,
            send,
            req,
            prompt: buildPromptFromContext(safeContext),
            context: safeContext,
            history,
            lastUserMessage: message,
            nluHints,
          });
          return;
        }

        // Wizard back-compat (direct generate)
        const prompt = hasDirectPrompt ? body.prompt.trim() : buildPromptFromContext(safeContext);
        const missing = missingSlots(safeContext);

        // Same policy: only ask if absolutely everything is missing
        const HARD_MISS = ["destination.country", "durationDays", "period"] as const;
        const allHardMissing = HARD_MISS.every(f => missing.includes(f));
        const hasAnySignal =
          !!safeContext?.destination?.country ||
          !!safeContext?.durationDays ||
          !!safeContext?.month || (safeContext?.startDate && safeContext?.endDate);

        if (!hasDirectPrompt && allHardMissing && !hasAnySignal) {
          const followupQ = followupQuestion({ missing, context: safeContext });
          const derived = await derivedContext(safeContext);
          const seasonsCtx = await seasonsContextFor(safeContext);
          send("needs", { missing, contextOut: {} });
          send("ask", { question: followupQ, missing });
          send("context", { ...derived, ...seasonsCtx });
          controller.close();
          return;
        }

        // Otherwise: ALWAYS generate
        await generateAndStream({ controller, send, req, prompt, context: safeContext, history, nluHints });
      } catch (e: any) {
        closeWithError(e?.message || "Unknown error");
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...corsHeaders(req),
    },
  });
}

/* -------------------- Context helpers -------------------- */

function normalizeContext(ctx: any = {}) {
  const c = typeof ctx === "object" && ctx ? structuredClone(ctx) : {};
  c.destination = c.destination || {};
  if (c.activities && !Array.isArray(c.activities)) {
    c.activities = String(c.activities)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  ensureKeys(c, ["durationDays", "startDate", "endDate", "month", "preferences"]);
  ensureKeys(c.destination, ["country", "region"]);
  c.activities = Array.isArray(c.activities) ? c.activities : [];
  return c;
}
function ensureKeys(o: any, keys: string[]) { for (const k of keys) if (!(k in o)) o[k] = null; }

function missingSlots(ctx: any) {
  const missing: string[] = [];
  if (!ctx?.destination?.country) missing.push("destination.country");
  if (!ctx?.durationDays || ctx.durationDays < 1) missing.push("durationDays");
  if (!ctx?.month && !(ctx?.startDate && ctx?.endDate)) missing.push("period");
  return missing;
}

function buildPromptFromContext(ctx: any) {
  const where = [ctx?.destination?.country, ctx?.destination?.region].filter(Boolean).join(" - ") || "?";
  const when = ctx?.month ? `in ${ctx.month}` : `${ctx?.startDate || "?"} to ${ctx?.endDate || "?"}`;
  const acts =
    Array.isArray(ctx?.activities) && ctx.activities.length
      ? ` Activities: ${ctx.activities.join(", ")}.`
      : "";
  const days = ctx?.durationDays || "?";
  return `Create a backpacking packing list for ${days} days to ${where}, ${when}.${acts}`;
}

/* -------------------- Hybrid slot extraction -------------------- */

async function extractSlots({ utterance, context }: { utterance: string, context: any }) {
  // 1) Regex baseline (works without API key)
  const m = (utterance || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const baseline: any = {
    context: {
      durationDays: null,
      destination: { country: null, region: null },
      startDate: null,
      endDate: null,
      month: null,
      activities: [],
      preferences: null,
    },
  };

  // Countries (minimal offline fallback)
  const COUNTRY = [
    { re: /\bvietnam\b/,                 name: "Vietnam" },
    { re: /\bindonesia|indonesie\b/,     name: "Indonesia" },
    { re: /\bthailand\b/,                name: "Thailand" },
    { re: /\bmalaysia|maleisie\b/,       name: "Malaysia" },
    { re: /\bphilippines|filipijnen\b/,  name: "Philippines" },
    { re: /\blaos\b/,                    name: "Laos" },
    { re: /\bcambodia|cambodja\b/,       name: "Cambodia" },
  ];
  const hit = COUNTRY.find(c => c.re.test(m));
  if (hit) baseline.context.destination.country = hit.name;

  // Month (support EN + NL)
  const MONTH_EN = /(january|february|march|april|may|june|july|august|september|october|november|december)/;
  const MONTH_NL = /(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)/;
  const mm = m.match(MONTH_EN) || m.match(MONTH_NL);
  if (mm) baseline.context.month = capitalize(mm[1]);

  // Duration (EN + NL)
  const dDays = m.match(/(\d{1,3})\s*(days|day|dgn|dagen|dag|d)\b/);
  const dWks  = m.match(/(\d{1,2})\s*(weeks|week|wk|w|weken)\b/);
  if (dDays) baseline.context.durationDays = Number(dDays[1]);
  else if (dWks) baseline.context.durationDays = Number(dWks[1]) * 7;
  // vague EN phrases
  if (!baseline.context.durationDays) {
    if (/\bcouple\s+of\s+weeks\b/.test(m) || /\bpaar\s*weken\b/.test(m)) baseline.context.durationDays = 14;
    else if (/\bcouple\s+of\s+months\b/.test(m) || /\bpaar\s*maanden\b/.test(m)) baseline.context.durationDays = 90; // bias high
  }

  // Date range (optional) dd/mm/yyyy ... dd/mm/yyyy
  const dateRange = m.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4}).{0,30}?(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if (dateRange) {
    const [, d1, mo1, y1, d2, mo2, y2] = dateRange;
    baseline.context.startDate = toISO(y1, mo1, d1);
    baseline.context.endDate   = toISO(y2, mo2, d2);
  }

  // Activities (EN + NL)
  const acts: string[] = [];
  if (/(dive|diving|snorkel|scuba|duik|duiken)/.test(m)) acts.push("diving");
  if (/(hike|hiking|trek|walk|wandelen|hiken)/.test(m)) acts.push("hiking");
  if (/(surf|surfing|surfen)/.test(m)) acts.push("surfing");
  if (/(city|citytrip|stad)/.test(m)) acts.push("city");
  if (acts.length) baseline.context.activities = acts;

  // 2) Optional: LLM enrichment
  if (process.env.OPENAI_API_KEY) {
    try {
      const schema = { type: "object", properties: { context: { type: "object" } }, required: ["context"], additionalProperties: true };
      const sys = "Enrich the given context with explicitly mentioned facts. Return JSON ONLY.";
      const user = `Current context: ${JSON.stringify(context)}\nUtterance: "${utterance}"\nAdd mentioned fields; keep unknown as null.`;
      const llm = await chatJSON(sys, user, schema);
      mergeInto(baseline, llm);
    } catch {}
  }

  return baseline;
}

function toISO(y: string | number, m: string | number, d: string | number) {
  const year = (+y < 100 ? 2000 + (+y) : +y);
  const month = String(+m).padStart(2, "0");
  const day = String(+d).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function mergeInto(target: any, src: any) {
  if (!src || typeof src !== "object") return;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== "object") target[k] = {};
      mergeInto(target[k], v);
    } else if (v !== undefined && v !== null) {
      target[k] = v;
    }
  }
}

/* -------------------- Follow-up question (deterministic) -------------------- */

function followupQuestion({ missing, context }: { missing: string[], context: any }) {
  const labels: string[] = [];
  if (missing.includes("destination.country")) labels.push("destination (country, optional region)");
  if (missing.includes("durationDays")) labels.push("how many days");
  if (missing.includes("period")) labels.push("which period (month or exact dates)");
  const pref: string[] = [];
  if (context?.destination?.country) pref.push(`destination: ${context.destination.country}`);
  if (context?.durationDays) pref.push(`duration: ${context.durationDays} days`);
  if (context?.month) pref.push(`month: ${context.month}`);
  if (context?.startDate && context?.endDate) pref.push(`dates: ${context.startDate} to ${context.endDate}`);
  const hint = pref.length ? ` (known: ${pref.join(", ")})` : "";
  return `Could you also specify: ${labels.join(", ")}?${hint}`;
}

/* -------------------- Derived context (LLM) -------------------- */

async function derivedContext(ctx: any) {
  const sys =
    "Determine, if possible, the season (winter/spring/summer/fall or tropical wet/dry) based on country/month or dates. Short answer, only field 'season'. Return JSON.";
  const user = `Context: ${JSON.stringify(ctx)}.`;
  const schema = { type: "object", properties: { season: { type: ["string", "null"] } }, required: ["season"] };
  const json = await chatJSON(sys, user, schema);
  return json;
}

/* -------------------- Seasons CSV integration -------------------- */
const SEASONS_CSV_URL = (process.env.SEASONS_CSV_URL || "").trim();
const SEASONS_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MONTHS_EN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const NL2EN: Record<string, string> = {
  januari:"Jan", februari:"Feb", maart:"Mar", april:"Apr", mei:"May", juni:"Jun",
  juli:"Jul", augustus:"Aug", september:"Sep", oktober:"Oct", november:"Nov", december:"Dec"
};
let __SEASONS_CACHE__: { rows: any[] | null, at: number } = { rows: null, at: 0 };

async function seasonsContextFor(ctx: any) {
  try {
    const tbl = await loadSeasonsTable();
    if (!tbl || !tbl.length) return {};
    const out = computeSeasonInfoForContext(ctx, tbl);
    return out || {};
  } catch {
    return {};
  }
}

async function loadSeasonsTable() {
  if (!SEASONS_CSV_URL) return [];
  if (__SEASONS_CACHE__.rows && Date.now() - __SEASONS_CACHE__.at < SEASONS_TTL_MS) {
    return __SEASONS_CACHE__.rows!;
  }
  const res = await fetch(SEASONS_CSV_URL, { cache: "no-store" });
  if (!res.ok) return [];
  const text = await res.text();
  const rows = parseCsv(text);
  __SEASONS_CACHE__ = { rows, at: Date.now() };
  return rows;
}

function monthAbbrevFromContext(ctx: any) {
  if (ctx?.month) {
    const raw = String(ctx.month).toLowerCase().trim();
    // accept EN or NL month names
    const en = MONTHS_EN.find(mm => mm.toLowerCase().startsWith(raw.slice(0,3)));
    return NL2EN[raw] || en || null;
  }
  if (ctx?.startDate) {
    try {
      const d = new Date(ctx.startDate);
      return MONTHS_EN[d.getUTCMonth()];
    } catch {}
  }
  return null;
}

function normStr(s: string) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function inSeasonEN(monthAbbrev: string | null, start: string, end: string) {
  if (!monthAbbrev || !start || !end) return false;
  const idx = (m: string) => MONTHS_EN.indexOf(m) + 1;
  const m = idx(monthAbbrev), a = idx(start), b = idx(end);
  if (!m || !a || !b) return false;
  return a <= b ? (m >= a && m <= b) : (m >= a || m <= b);
}

function computeSeasonInfoForContext(ctx: any, table: any[]) {
  const country = ctx?.destination?.country;
  const region = ctx?.destination?.region;
  const monthAbbrev = monthAbbrevFromContext(ctx);
  if (!country || !monthAbbrev) return null;

  const C = normStr(country);
  const R = normStr(region);

  const hits = table.filter((r: any) => {
    const rc = normStr(r.country);
    const rr = normStr(r.region);
    const regionMatch = rr ? (rc === C && rr === R) : (rc === C);
    return regionMatch && inSeasonEN(monthAbbrev, r.start_month, r.end_month);
  });

  const climate = hits.find((h: any) => String(h.type).toLowerCase() === "climate")?.label || null;

  const risks = hits
    .filter((h: any) => String(h.type).toLowerCase() === "risk")
    .map((h: any) => ({
      type: String(h.label || "").toLowerCase(),
      level: String(h.level || "unknown").toLowerCase(),
      note: h.note || ""
    }));

  const flags: Record<string, boolean> = {};
  const items = new Set<string>();
  for (const h of hits) {
    String((h as any).advice_flags || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((f) => (flags[f] = true));
    String((h as any).item_tags || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((t) => items.add(t));
  }

  return { season: climate, seasonalRisks: risks, adviceFlags: flags, itemTags: Array.from(items) };
}

/* -------------------- Season prompt injection -------------------- */

function seasonPromptLines(seasonsCtx: any) {
  const bits: string[] = [];
  if (seasonsCtx?.season) {
    bits.push(`Season context: ${seasonsCtx.season}.`);
  }
  if (Array.isArray(seasonsCtx?.seasonalRisks) && seasonsCtx.seasonalRisks.length) {
    const top = seasonsCtx.seasonalRisks[0];
    const lvl = top.level ? ` (${top.level})` : "";
    bits.push(`Key risks: ${top.type}${lvl}.`);
  }
  if (!bits.length) return [];
  return [
    {
      role: "system",
      content:
        `Use this season context explicitly in advice and packing list (clothing/gear/health/tips). ` +
        bits.join(" "),
    },
  ];
}

/* -------------------- Prompt policy helpers -------------------- */

/** Force: proceed with answers (even if unknown), don't ask follow-ups, normalize variants */
function unknownPolicySystem(ctx: any, nluHints: any) {
  const unknowns: string[] = [];
  if (ctx?.unknownCountry) unknowns.push("country/destination");
  if (ctx?.unknownPeriod) unknowns.push("period (month or dates)");
  if (ctx?.unknownDuration) unknowns.push("duration (days)");
  if (!ctx?.destination?.country && !unknowns.includes("country/destination")) unknowns.push("country/destination");
  if (!ctx?.month && !(ctx?.startDate && ctx?.endDate) && !unknowns.includes("period (month or dates)")) unknowns.push("period (month or dates)");
  if (!ctx?.durationDays && !unknowns.includes("duration (days)")) unknowns.push("duration (days)");

  const lines = [
    "Proceed with answers even if the following fields are unknown.",
    "Do NOT ask follow-up questions; make reasonable assumptions and state them briefly.",
    unknowns.length ? `Marked as unknown: ${unknowns.join(", ")}.` : "All fields seem known; assumptions still allowed.",
  ];
  return { role: "system", content: lines.join(" ") };
}

/* -------------------- Generate & Stream -------------------- */

async function generateAndStream({ controller, send, req, prompt, context, history, lastUserMessage, nluHints }:
  { controller: ReadableStreamDefaultController, send: Function, req: Request, prompt: string, context: any, history: any, lastUserMessage?: string, nluHints?: any }) {
  const derived = await derivedContext(context);
  const seasonsCtx = await seasonsContextFor(context);

  send("context", { ...derived, ...seasonsCtx });

  const systemExtras = seasonPromptLines(seasonsCtx);

  send("start", {});
  try {
    const messages = buildMessagesForOpenAI({
      systemExtras,
      prompt,
      history,
      contextSummary: summarizeContext(context),
      lastUserMessage,
      nluHints,
      _ctx: context
    });

    await streamOpenAI({
      messages,
      onDelta: (chunk: string) => send("delta", chunk),
    });
  } catch (e: any) {
    send("error", { message: e?.message || "Generation error" });
    controller.close();
    return;
  }

  try {
    const products = await productsFromCSV(context, req);
    if (Array.isArray(products) && products.length) {
      const batch = 6;
      for (let i = 0; i < Math.min(products.length, 24); i += batch) {
        send("products", products.slice(i, i + batch));
      }
    }
  } catch (e: any) {
    send("products", [{
      category: "DEBUG",
      name: `products error: ${(e && e.message) || "unknown"}`,
      weight_grams: null,
      activities: "",
      seasons: "",
      url: "",
      image: ""
    }]);
  }

  send("context", { ...derived, ...seasonsCtx });
  send("done", {});
  controller.close();
}

/* ---------- Context summary (inject as system) ---------- */
function summarizeContext(ctx: any) {
  const parts: string[] = [];
  if (ctx?.destination?.country) parts.push(`country: ${ctx.destination.country}`);
  if (ctx?.destination?.region) parts.push(`region: ${ctx.destination.region}`);
  if (ctx?.durationDays) parts.push(`duration: ${ctx.durationDays} days`);
  if (ctx?.month) parts.push(`month: ${ctx.month}`);
  if (ctx?.startDate && ctx?.endDate) parts.push(`dates: ${ctx.startDate} to ${ctx.endDate}`);
  if (Array.isArray(ctx?.activities) && ctx.activities.length) parts.push(`activities: ${ctx.activities.join(", ")}`);
  if (!parts.length) return null;
  return `Known context (${parts.join(" • ")}). Use this implicitly in your advice if relevant.`;
}

/* ---------- Build OpenAI messages (with new prompt policy) ---------- */
function buildMessagesForOpenAI({ systemExtras = [], prompt, history, contextSummary, lastUserMessage, nluHints, _ctx }:
  { systemExtras?: any[], prompt: string, history: any, contextSummary?: string | null, lastUserMessage?: string, nluHints?: any, _ctx: any }) {

  const baseSystem = {
    role: "system",
    content: [
      // Goal & language
      "You are an assistant that writes concise, practical backpacking packing lists in English. Write clearly, directly, with no disclaimers or apologies.",
      // Structure
      "Use these sections in this exact order: Short summary, Clothing, Gear, Gadgets, Health, Tips.",
      "Start with a short, human intro (2–4 sentences) that summarizes the user's situation and states assumptions transparently.",
      // Missing input must NOT block output
      "Treat country, period, duration and activities as optional. If something is unknown: proceed, make reasonable assumptions, and mention them briefly (e.g., “If you're going to warm/humid areas…”, “For winter…”, “Per extra week…”). Do not ask follow-up questions instead of answering.",
      // Normalization/interpretation
      "Normalize typos and variants (e.g., “mexcio”→“Mexico”, “couple of weeks”≈14 days, “around New Year”≈Dec 20–Jan 10).",
      // Activities modules
      "If activities are unknown: provide a base list + optional modules (hiking, city, beach, diving, etc.).",
      // Unknown duration
      "If duration is unknown: provide a minimal core list and add scalable items per extra week (e.g., +3 T-shirts, +1 underwear per 3–4 days).",
      // Unknown period
      "If period is unknown: provide guidance for warm/hot, cool/cold and wet (rain) with short pointers per scenario.",
      // Unknown country
      "If country is unknown: give climate-agnostic advice and branch where helpful by climate.",
      // Season context
      "If season context is provided, incorporate it explicitly in advice and sections.",
      // Machine-readable hints
      "Any machine-readable hints (seasonalRisks, adviceFlags, itemTags, interpreted fields) should be out-of-band; do NOT place JSON in the main text.",
      // Style/compactness
      "Be concrete and brief. Use bullets in sections; avoid long irrelevant lists. No code blocks, no tables."
    ].join("\n")
  };

  // Policy: proceed, no follow-ups, even if unknown
  const policyUnknown = unknownPolicySystem(_ctx, nluHints);

  // Interpretation of vague time phrases (few-shot + rule)
  const approxSystem = (nluHints?.policy?.allowApproximate || nluHints?.durationPhrase || nluHints?.periodPhrase)
    ? [{
        role: "system",
        content:
          "You may interpret vague time phrases. Examples: “couple of months”≈60–90 days (pick 90 if unsure), “around New Year”≈Dec 20–Jan 10. " +
          "Fill missing fields without re-asking; only ask in case of true ambiguity (not applicable when fields are marked as unknown)."
      }]
    : [{
        role: "system",
        content:
          "You may interpret vague time phrases: “couple of weeks”≈14 days, “around New Year”≈Dec 20–Jan 10. " +
          "Fill missing fields without asking again."
      }];

  // Short few-shot interpretations to force normalization
  const fewShot = [{
    role: "system",
    content: [
      "Interpretation examples:",
      `- User: "i'll go to mexcio couple weeks in 2 months" → Normalize: country=Mexico; duration≈14 days; departure≈in 2 months.`,
      `- User: "around new year to japan" → Period≈Dec 20–Jan 10; country=Japan.`
    ].join("\n")
  }];

  const extras = (systemExtras || []).map((m: any) => ({ role: "system", content: m.content || m }));
  const ctxMsg = contextSummary ? [{ role: "system", content: contextSummary }] : [];

  if (history && history.length) {
    const hist = history.map((m: any) => ({ role: m.role, content: String(m.content || "").slice(0, 8000) }));
    const tail = lastUserMessage ? [{ role: "user", content: String(lastUserMessage).slice(0, 8000) }] : [];
    return [policyUnknown, ...fewShot, ...approxSystem, ...extras, baseSystem, ...ctxMsg, ...hist, ...tail];
  }

  return [policyUnknown, ...fewShot, ...approxSystem, ...extras, baseSystem, ...ctxMsg, { role: "user", content: prompt }];
}

/* -------------------- CSV products -------------------- */
const CSV_PUBLIC_PATH = "/pack_products.csv"; // fallback path

function resolveCsvUrl(origin: string) {
  const url = (process.env.PRODUCTS_CSV_URL && String(process.env.PRODUCTS_CSV_URL).trim()) || "";
  return url || new URL(CSV_PUBLIC_PATH, origin).toString();
}

function getCsvCache() {
  if (!(globalThis as any).__PACKLIST_CSV__) {
    (globalThis as any).__PACKLIST_CSV__ = { rows: null, at: 0 };
  }
  return (globalThis as any).__PACKLIST_CSV__;
}

async function productsFromCSV(ctx: any, req: Request) {
  const origin = new URL(req.url).origin;
  const resolvedUrl = resolveCsvUrl(origin);

  let rows: any[];
  try {
    rows = await loadCsvOnce(origin);
  } catch (e: any) {
    return [{
      category: "DEBUG",
      name: `CSV load error: ${(e && e.message) || "unknown"}`,
      weight_grams: null,
      activities: "",
      seasons: "",
      url: resolvedUrl,
      image: ""
    }];
  }

  const acts  = (ctx?.activities || []).map((s: string) => String(s).toLowerCase());
  const rawMonth = (ctx?.month || "").toLowerCase();

  let seasonHint = "";
  // Support EN and NL month names for basic winter/summer buckets
  const monthToSeason: Record<string, string> = {
    december: "winter", januari: "winter", februari: "winter",
    january: "winter", february: "winter", march: "",
    june: "summer", july: "summer", august: "summer",
    juni: "summer", juli: "summer", augustus: "summer"
  };
  seasonHint = monthToSeason[rawMonth] || "";

  const filtered = rows.filter((r: any) => {
    const prodActs    = splitCsvList(r.activities);
    const prodSeasons = splitCsvList(r.seasons);

    const actsOk =
      prodActs.length === 0 ||
      acts.some((a: string) => prodActs.includes(a));

    const seasonOk =
      prodSeasons.length === 0 ||
      prodSeasons.includes("all") || // EN
      prodSeasons.includes("alle") || // NL (compat)
      (seasonHint && prodSeasons.includes(seasonHint)) ||
      (rawMonth && prodSeasons.includes(rawMonth));

    return actsOk && seasonOk;
  });

  let outRows = filtered;
  if (outRows.length === 0) {
    outRows = rows.filter((r: any) => {
      const a = splitCsvList(r.activities).length === 0;
      const s = splitCsvList(r.seasons);
      return a && (s.length === 0 || s.includes("all") || s.includes("alle"));
    });
  }

  const debugItem = {
    category: "DEBUG",
    name: `csv=${resolvedUrl} | total=${rows.length} | filtered=${filtered.length} | out=${outRows.length}`,
    weight_grams: null,
    activities: acts.join(","),
    seasons: seasonHint || rawMonth || "",
    url: resolvedUrl,
    image: ""
  };

  const mapped = outRows.map(mapCsvRow);
  const dedup  = dedupeBy(mapped, (p: any) => `${p.category}|${p.name}`).slice(0, 24);
  return [debugItem, ...dedup];
}

function splitCsvList(v: any) {
  if (!v) return [];
  return String(v)
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function mapCsvRow(r: any) {
  return {
    category: r.category || "",
    name: r.name || "",
    weight_grams: r.weight_grams ? Number(String(r.weight_grams).replace(",", ".")) : null,
    activities: r.activities || "",
    seasons: r.seasons || "",
    url: r.url || "",
    image: r.image || "",
  };
}

function dedupeBy(arr: any[], keyFn: (x: any) => string) {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

async function loadCsvOnce(origin: string) {
  const cache = getCsvCache();
  if (cache.rows && Date.now() - cache.at < 1000 * 60 * 10) {
    return cache.rows; // 10 min cache
  }

  const url = resolveCsvUrl(origin);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`CSV fetch failed ${res.status} @ ${url}`);

  const text = await res.text();
  const rows = parseCsv(text);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`CSV parsed empty @ ${url}`);
  }

  cache.rows = rows;
  cache.at = Date.now();
  return rows;
}

function parseCsv(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const out: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row: any = {};
    headers.forEach((h, idx) => (row[h] = cells[idx] ?? ""));
    if ("weight" in row && !("weight_grams" in row)) row.weight_grams = row.weight;
    out.push(row);
  }
  return out;
}

function splitCsvLine(line: string) {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ",") { out.push(cur); cur = ""; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/* -------------------- OpenAI helpers -------------------- */

function sanitizeHistory(raw: any) {
  if (!Array.isArray(raw)) return null;
  const ok: any[] = [];
  for (const m of raw) {
    const role = (m && m.role) || "";
    const content = (m && m.content) || "";
    if (!content) continue;
    if (role !== "user" && role !== "assistant") continue;
    ok.push({ role, content: String(content).slice(0, 8000) });
    if (ok.length >= 24) break;
  }
  return ok.length ? ok : null;
}

async function chatJSON(system: string, user: string, jsonSchema: any) {
  let res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL_JSON,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "extraction", schema: jsonSchema, strict: true } },
    }),
  });

  if (!res.ok && res.status === 400) {
    res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL_JSON,
        messages: [
          { role: "system", content: "Return ONLY valid JSON, with no text or explanation." },
          { role: "user", content: `${system}\n\n${user}\n\nAnswer strictly with JSON.` },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
  }

  if (!res.ok) {
    const err = await safeErrorText(res);
    throw new Error(`OpenAI json error: ${res.status}${err ? ` — ${err}` : ""}`);
  }

  const j = await res.json();
  const txt = j?.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(txt); } catch { return {}; }
}

async function safeErrorText(res: Response) {
  try { return (await res.text())?.slice(0, 400); } catch { return ""; }
}

async function streamOpenAI({ messages, onDelta }: { messages: any[], onDelta: (chunk: string) => void }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Missing messages for OpenAI");
  }

  const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL_TEXT,
      stream: true,
      temperature: 0.4,
      messages,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`OpenAI stream error: ${res.status}`);

  const reader = (res as any).body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    for (let i = 0; i < parts.length - 1; i++) {
      const block = parts[i];
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch {}
    }
    buffer = parts[parts.length - 1];
  }
}

/* -------------------- small utils -------------------- */
function capitalize(s: string) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
