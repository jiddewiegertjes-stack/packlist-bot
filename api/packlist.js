export const runtime = "edge";

/**
 * Packlist SSE + Slot-Filling Chat Backend (Edge)
 * ------------------------------------------------
 * NL-code, maar output en gebruikers-IO worden geforceerd naar Engels.
 * Wijzigingen tov origineel:
 * - forceEnglishSystem(): systemregel om ALTIJD in Engels te antwoorden.
 * - evaluateAnswersLLM()/evaluateQASet(): LLM-extractie voor 4 velden.
 * - seasonsContextFor(): seizoensmeta.
 * - ✅ NIEUW: productsFromCSV(ctx, req, seasonsCtx) — gebruikt alleen bestaande CSV-kolommen
 *   (activities, seasons, tags, priority) + context (land/maand/duur/activiteiten).
 * - ✅ NIEUW: Google Sheets edit-link -> CSV export automatisch.
 */

const OPENAI_API_BASE = "https://api.openai.com/v1";
const OPENAI_MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-4o-mini";
const OPENAI_MODEL_JSON = process.env.OPENAI_MODEL_JSON || "gpt-4o-mini";
const enc = new TextEncoder();
const ALWAYS_GENERATE = true; // forceer altijd genereren, nooit blokkeren

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

      // Vrije-tekst invulvelden (optioneel) voor de 4 vragen
      const qaInput = (body?.qaInput && typeof body.qaInput === "object") ? body.qaInput : null;

      // Conversatiegeschiedenis en hints uit de frontend
      const history = sanitizeHistory(body?.history);
      let nluHints = body?.nluHints || null;

      try {
        /* ---------- ✨ NIEUW: LLM-analyse voor 4 vragen ---------- */
        if (qaInput && hasAnyNonEmptyString(qaInput)) {
          const qaFromForm = await evaluateQASet(qaInput);
          if (qaFromForm) {
            send("qa", { source: "form", ...qaFromForm });
            mergeQaIntoContext(safeContext, qaFromForm);
            nluHints = deriveHintsFromQa(qaFromForm, nluHints);
          }
        }

        if (!hasDirectPrompt && message) {
          const qaFromUtterance = await evaluateAnswersLLM(message);
          if (qaFromUtterance) {
            send("qa", { source: "utterance", ...qaFromUtterance });
            mergeQaIntoContext(safeContext, qaFromUtterance);
            nluHints = deriveHintsFromQa(qaFromUtterance, nluHints);
          }
        }

        if (!hasDirectPrompt && message) {
          const extracted = await extractSlots({ utterance: message, context: safeContext });
          mergeInto(safeContext, extracted?.context || {});
        }

        const missing = missingSlots(safeContext);

        // Signalen om "toch genereren" te doen ook als hard-miss
        const userLower = message.toLowerCase?.() || "";
        const hasDurationSignal =
          !!nluHints?.durationDays ||
          !!nluHints?.durationPhrase ||
          /\b(weekje|maandje|paar\s*weken|paar\s*maanden|few\s*weeks|few\s*months)\b/.test(userLower);
        const hasPeriodSignal =
          !!nluHints?.month ||
          !!nluHints?.startDate ||
          !!nluHints?.periodPhrase ||
          /\brond\s+de\s+jaarwisseling|rond\s+kerst|oud.*nieuw\b/.test(userLower);

        const HARD_MISS = ["destination.country", "durationDays", "period"];
        const allHardMissing = HARD_MISS.every(f => missing.includes(f));
        const hasAnySignal =
          !!nluHints?.durationDays ||
          !!nluHints?.month ||
          !!nluHints?.startDate ||
          !!safeContext?.destination?.country ||
          !!safeContext?.durationDays ||
          (Array.isArray(safeContext?.activities) && safeContext.activities.length > 0) ||
          hasPeriodSignal || hasDurationSignal;

        if (!ALWAYS_GENERATE && allHardMissing && !hasAnySignal) {
          const followupQ = followupQuestion({ missing, context: safeContext });
          send("needs", { missing, contextOut: {} });
          const derived = await derivedContext(safeContext);
          const seasonsCtx = await seasonsContextFor(safeContext);
          send("ask", { question: followupQ, missing });
          send("context", { ...derived, ...seasonsCtx });
          controller.close();
          return;
        }

        // 👉 Anders: ALTIJD genereren
        const prompt = hasDirectPrompt ? body.prompt.trim() : buildPromptFromContext(safeContext);

        await generateAndStream({
          controller,
          send,
          req,
          prompt,
          context: safeContext,
          history,
          lastUserMessage: message,
          nluHints,
        });
      } catch (e: any) {
        closeWithError(e?.message || "Onbekende fout");
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
  const when = ctx?.month ? `in ${ctx.month}` : `${ctx?.startDate || "?"} t/m ${ctx?.endDate || "?"}`;
  const acts =
    Array.isArray(ctx?.activities) && ctx.activities.length
      ? ` Activiteiten: ${ctx.activities.join(", ")}.`
      : "";
  const days = ctx?.durationDays || "?";
  // Prompt mag NL blijven; forceEnglishSystem zorgt voor Engelstalige output.
  return `Maak een backpack paklijst voor ${days} dagen naar ${where}, ${when}.${acts}`;
}

/* -------------------- ✨ NIEUW: LLM QA-extractie -------------------- */

function hasAnyNonEmptyString(obj: any) {
  return Object.values(obj).some(v => typeof v === "string" && v.trim().length > 0);
}

async function evaluateAnswersLLM(utterance: string) {
  if (!process.env.OPENAI_API_KEY || !utterance || typeof utterance !== "string") return null;

  const sys =
    "Je taak: lees 1 user-utterance en bepaal of er bruikbare informatie staat voor vier reisinvoer-velden: " +
    "(destination, duration, period, activities). Normaliseer naar compacte, machineleesbare velden. " +
    "Wees strikt: zet hasInfo=false als het niet expliciet of zeer aannemelijk is. Antwoord ALLEEN als JSON.";

  const user =
    `Utterance: "${utterance}"\n` +
    "Definities:\n" +
    "- destination: land en optioneel regio/streek/stad.\n" +
    "- duration: totaal aantal dagen (schatting toestaan bij 'paar weekjes'≈14d, 'few weeks'≈14d, '2-3 weken'≈17-21→kies 21 bij twijfel).\n" +
    "- period: ofwel maandnaam (NL/EN) of concreet startDate/endDate (YYYY-MM-DD). Bij 'rond de jaarwisseling'≈20 dec–10 jan.\n" +
    "- activities: lijst met woorden (hiking, surfing, diving, citytrip, etc.).\n" +
    "Let op: Vul ook 'phrase' velden als ruwe tekstindicatie nuttig is.";

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      destination: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          country: { type: ["string", "null"] },
          region:  { type: ["string", "null"] },
          evidence:{ type: ["string", "null"] }
        },
        required: ["hasInfo","country","region","evidence"]
      },
      duration: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          durationDays: { type: ["integer","null"] },
          phrase: { type: ["string","null"] },
          evidence:{ type: ["string","null"] }
        },
        required: ["hasInfo","durationDays","phrase","evidence"]
      },
      period: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          month: { type: ["string","null"] },
          startDate: { type: ["string","null"] },
          endDate: { type: ["string","null"] },
          phrase: { type: ["string","null"] },
          evidence:{ type: ["string","null"] }
        },
        required: ["hasInfo","month","startDate","endDate","phrase","evidence"]
      },
      activities: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          list: { type: "array", items: { type: "string" } },
          evidence:{ type: ["string","null"] }
        },
        required: ["hasInfo","list","evidence"]
      }
    },
    required: ["destination","duration","period","activities"]
  } as const;

  try {
    const json = await chatJSON(sys, user, schema as any);
    return json;
  } catch {
    return null;
  }
}

async function evaluateQASet(qaInput: any) {
  if (!process.env.OPENAI_API_KEY) return null;

  const { destination = "", duration = "", period = "", activities = "" } = qaInput || {};
  if (![destination, duration, period, activities].some((s: any) => typeof s === "string" && s.trim())) return null;

  const sys =
    "Lees vier user-invoer strings (destination, duration, period, activities). " +
    "Bepaal per veld of er bruikbare info in staat en extraheer genormaliseerde waarden. " +
    "Antwoord ALLEEN als JSON volgens schema.";

  const user =
    `destination="${destination || ""}"\n` +
    `duration="${duration || ""}"\n` +
    `period="${period || ""}"\n` +
    `activities="${activities || ""}"\n` +
    "Regels: duration in dagen, period als maand of start/end datum, activities als lijst. " +
    "Wees strikt met hasInfo; vul phrase en evidence waar zinnig.";

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      destination: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          country: { type: ["string","null"] },
          region:  { type: ["string","null"] },
          evidence:{ type: ["string","null"] }
        },
        required: ["hasInfo","country","region","evidence"]
      },
      duration: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          durationDays: { type: ["integer","null"] },
          phrase: { type: ["string","null"] },
          evidence:{ type: ["string","null"] }
        },
        required: ["hasInfo","durationDays","phrase","evidence"]
      },
      period: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          month: { type: ["string","null"] },
          startDate: { type: ["string","null"] },
          endDate: { type: ["string","null"] },
          phrase: { type: ["string","null"] },
          evidence:{ type: ["string","null"] }
        },
        required: ["hasInfo","month","startDate","endDate","phrase","evidence"]
      },
      activities: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          list: { type: "array", items: { type: "string" } },
          evidence:{ type: ["string","null"] }
        },
        required: ["hasInfo","list","evidence"]
      }
    },
    required: ["destination","duration","period","activities"]
  } as const;

  try {
    const json = await chatJSON(sys, user, schema as any);
    return json;
  } catch {
    return null;
  }
}

function mergeQaIntoContext(ctx: any, qa: any) {
  if (!ctx || !qa) return;

  if (qa.destination?.hasInfo) {
    ctx.destination = ctx.destination || {};
    if (qa.destination.country) ctx.destination.country = qa.destination.country;
    if (qa.destination.region)  ctx.destination.region  = qa.destination.region;
  }

  if (qa.duration?.hasInfo && Number.isFinite(qa.duration.durationDays || null)) {
    ctx.durationDays = qa.duration.durationDays;
  }

  if (qa.period?.hasInfo) {
    if (qa.period.month) {
      ctx.month = qa.period.month;
      ctx.startDate = ctx.startDate || null;
      ctx.endDate   = ctx.endDate   || null;
    } else if (qa.period.startDate && qa.period.endDate) {
      ctx.startDate = qa.period.startDate;
      ctx.endDate   = qa.period.endDate;
      ctx.month     = null;
    }
  }

  if (qa.activities?.hasInfo && Array.isArray(qa.activities.list)) {
    const normActs = qa.activities.list.map((s: string) => String(s).toLowerCase().trim()).filter(Boolean);
    const merged = new Set([...(ctx.activities || []), ...normActs]);
    ctx.activities = Array.from(merged);
  }
}

function deriveHintsFromQa(qa: any, hintsIn: any) {
  const hints = Object.assign({}, hintsIn || {});
  if (!qa) return hints;

  if (qa.duration?.hasInfo) {
    if (Number.isFinite(qa.duration.durationDays)) hints.durationDays = qa.duration.durationDays;
    if (qa.duration.phrase) hints.durationPhrase = qa.duration.phrase;
  }
  if (qa.period?.hasInfo) {
    if (qa.period.month) hints.month = qa.period.month;
    if (qa.period.startDate) hints.startDate = qa.period.startDate;
    if (qa.period.endDate) hints.endDate = qa.period.endDate;
    if (qa.period.phrase) hints.periodPhrase = qa.period.phrase;
  }
  if (qa.destination?.hasInfo) {
    if (qa.destination.country) hints.country = qa.destination.country;
    if (qa.destination.region) hints.region = qa.destination.region;
  }
  if (qa.activities?.hasInfo && Array.isArray(qa.activities.list)) {
    hints.activities = qa.activities.list;
  }
  return hints;
}

/* -------------------- Hybride slot-extractie -------------------- */

async function extractSlots({ utterance, context }: { utterance: string; context: any }) {
  const m = (utterance || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const baseline = {
    context: {
      durationDays: null as number | null,
      destination: { country: null as string | null, region: null as string | null },
      startDate: null as string | null,
      endDate: null as string | null,
      month: null as string | null,
      activities: [] as string[],
      preferences: null as any,
    },
  };

  const COUNTRY = [
    { re: /\bvietnam\b/,                 name: "Vietnam" },
    { re: /\bindonesie|indonesia\b/,     name: "Indonesië" },
    { re: /\bthailand\b/,                name: "Thailand" },
    { re: /\bmaleisie|malaysia\b/,       name: "Maleisië" },
    { re: /\bfilipijnen|philippines\b/,  name: "Filipijnen" },
    { re: /\blaos\b/,                    name: "Laos" },
    { re: /\bcambodja|cambodia\b/,       name: "Cambodja" },
  ];
  const hit = COUNTRY.find(c => c.re.test(m));
  if (hit) baseline.context.destination.country = hit.name;

  const MONTH = /(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|january|february|march|april|may|june|july|august|september|october|november|december)/;
  const mm = m.match(MONTH);
  if (mm) baseline.context.month = mm[1];

  const dDays = m.match(/(\d{1,3})\s*(dagen|dag|dgn|days?|d)\b/);
  const dWks  = m.match(/(\d{1,2})\s*(weken|weeks?|wk|w)\b/);
  if (dDays) baseline.context.durationDays = Number(dDays[1]);
  else if (dWks) baseline.context.durationDays = Number(dWks[1]) * 7;

  const dateRange = m.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4}).{0,30}?(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if (dateRange) {
    const [, d1, mo1, y1, d2, mo2, y2] = dateRange;
    baseline.context.startDate = toISO(y1, mo1, d1);
    baseline.context.endDate   = toISO(y2, mo2, d2);
  }

  const acts: string[] = [];
  if (/(duik|duiken|snorkel|scuba)/.test(m)) acts.push("duiken");
  if (/(hike|hiken|trek|wandelen|hiking)/.test(m)) acts.push("hiken");
  if (/(surf|surfen|surfing)/.test(m)) acts.push("surfen");
  if (/(city|stad|citytrip)/.test(m)) acts.push("citytrip");
  if (acts.length) baseline.context.activities = acts;

  if (process.env.OPENAI_API_KEY) {
    try {
      const schema = { type: "object", properties: { context: { type: "object" } }, required: ["context"], additionalProperties: true };
      const sys = "Verrijk onderstaande context met expliciet genoemde feiten. Geef ALLEEN JSON.";
      const user = `Huidige context: ${JSON.stringify(context)}\nZin: "${utterance}"\nVoeg genoemde velden toe; onbekend blijft null.`;
      const llm = await chatJSON(sys, user, schema as any);
      mergeInto(baseline, llm);
    } catch {}
  }

  return baseline;
}

function toISO(y: string, m: string, d: string) {
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

/* -------------------- Vervolgvraag (deterministisch) -------------------- */

function followupQuestion({ missing, context }: { missing: string[]; context: any }) {
  const labels: string[] = [];
  if (missing.includes("destination.country")) labels.push("bestemming (land, optioneel regio)");
  if (missing.includes("durationDays")) labels.push("hoeveel dagen");
  if (missing.includes("period")) labels.push("in welke periode (maand of exacte data)");
  const pref: string[] = [];
  if (context?.destination?.country) pref.push(`bestemming: ${context.destination.country}`);
  if (context?.durationDays) pref.push(`duur: ${context.durationDays} dagen`);
  if (context?.month) pref.push(`maand: ${context.month}`);
  if (context?.startDate && context?.endDate) pref.push(`data: ${context.startDate} t/m ${context.endDate}`);
  const hint = pref.length ? ` (bekend: ${pref.join(", ")})` : "";
  return `Kun je nog aangeven: ${labels.join(", " )}?${hint}`;
}

/* -------------------- Afgeleide context (LLM) -------------------- */

async function derivedContext(ctx: any) {
  const sys =
    "Bepaal, indien mogelijk, het seizoen (winter/lente/zomer/herfst of tropisch nat/droog) op basis van land/maand of data. Kort antwoord, alleen het veld 'season'. Geef JSON.";
  const user = `Context: ${JSON.stringify(ctx)}.`;
  const schema = { type: "object", properties: { season: { type: ["string", "null"] } }, required: ["season"] };
  const json = await chatJSON(sys, user, schema as any);
  return json;
}

/* -------------------- Seasons CSV integratie -------------------- */
const SEASONS_CSV_URL = (process.env.SEASONS_CSV_URL || "").trim();
const SEASONS_TTL_MS = 6 * 60 * 60 * 1000; // 6 uur
const MONTHS_EN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const NL2EN: Record<string,string> = {
  januari:"Jan", februari:"Feb", maart:"Mar", april:"Apr", mei:"May", juni:"Jun",
  juli:"Jul", augustus:"Aug", september:"Sep", oktober:"Oct", november:"Nov", december:"Dec"
};
let __SEASONS_CACHE__: any = { rows: null, at: 0 };

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
    return __SEASONS_CACHE__.rows;
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
    const m = String(ctx.month).toLowerCase().trim();
    return NL2EN[m] || MONTHS_EN.find(mm => mm.toLowerCase().startsWith(m.slice(0,3))) || null;
  }
  if (ctx?.startDate) {
    try {
      const d = new Date(ctx.startDate);
      return MONTHS_EN[d.getUTCMonth()];
    } catch {}
  }
  return null;
}

function normStr(s: any) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function inSeasonEN(monthAbbrev: string, start: string, end: string) {
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

  const hits = table.filter((r) => {
    const rc = normStr(r.country);
    const rr = normStr(r.region);
    const regionMatch = rr ? (rc === C && rr === R) : (rc === C);
    return regionMatch && inSeasonEN(monthAbbrev, r.start_month, r.end_month);
  });

  const climate = hits.find(h => String(h.type).toLowerCase() === "climate")?.label || null;

  const risks = hits
    .filter(h => String(h.type).toLowerCase() === "risk")
    .map(h => ({
      type: String(h.label || "").toLowerCase(),
      level: String(h.level || "unknown").toLowerCase(),
      note: h.note || ""
    }));

  const flags: Record<string, boolean> = {};
  const items = new Set<string>();
  for (const h of hits) {
    String(h.advice_flags || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((f) => (flags[f] = true));
    String(h.item_tags || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((t) => items.add(t));
  }

  return { season: climate, seasonalRisks: risks, adviceFlags: flags, itemTags: Array.from(items) };
}

/* -------------------- Prompt-injectie seizoenscontext -------------------- */

function seasonPromptLines(seasonsCtx: any) {
  const bits: string[] = [];
  if (seasonsCtx?.season) bits.push(`Seizoenscontext: ${seasonsCtx.season}.`);
  if (Array.isArray(seasonsCtx?.seasonalRisks) && seasonsCtx.seasonalRisks.length) {
    const top = seasonsCtx.seasonalRisks[0];
    const lvl = top.level ? ` (${top.level})` : "";
    bits.push(`Belangrijke risico's: ${top.type}${lvl}.`);
  }
  if (!bits.length) return [];
  return [
    {
      role: "system",
      content:
        `Gebruik deze seizoenscontext expliciet in de adviezen en paklijst (kleding/gear/health/tips). ` +
        bits.join(" "),
    },
  ];
}

/* -------------------- ✨ Prompt policy helpers -------------------- */

function forceEnglishSystem() {
  return {
    role: "system",
    content:
      "You must always write your final answer in clear, natural English. " +
      "Even if the user's message or the prompt is in another language (e.g., Dutch), reply in English only. " +
      "Do not apologize for switching language; just answer in English with a concise, practical tone."
  };
}

function unknownPolicySystem(ctx: any, _nluHints: any) {
  const unknowns: string[] = [];
  if (ctx?.unknownCountry) unknowns.push("land/bestemming");
  if (ctx?.unknownPeriod) unknowns.push("periode (maand of data)");
  if (ctx?.unknownDuration) unknowns.push("duur (aantal dagen)");
  if (!ctx?.destination?.country && !unknowns.includes("land/bestemming")) unknowns.push("land/bestemming");
  if (!ctx?.month && !(ctx?.startDate && ctx?.endDate) && !unknowns.includes("periode (maand of data)")) unknowns.push("periode (maand of data)");
  if (!ctx?.durationDays && !unknowns.includes("duur (aantal dagen)")) unknowns.push("duur (aantal dagen)");

  const lines = [
    "Ga door met antwoorden, ook als onderstaande velden onbekend zijn.",
    "Stel géén vervolgvraag; maak redelijke aannames en benoem ze kort in de tekst.",
    unknowns.length ? `Onbekend gemarkeerd: ${unknowns.join(", ")}.` : "Alle velden lijken bekend; aannames blijven toegestaan.",
  ];
  return { role: "system", content: lines.join(" ") };
}

/* -------------------- Generate & Stream -------------------- */

async function generateAndStream({ controller, send, req, prompt, context, history, lastUserMessage, nluHints }:{
  controller: ReadableStreamDefaultController<any>;
  send: (e:string,d?:any)=>void;
  req: Request;
  prompt: string;
  context: any;
  history: any;
  lastUserMessage: string;
  nluHints: any;
}) {
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
      onDelta: (chunk) => send("delta", chunk),
    });
  } catch (e: any) {
    send("error", { message: e?.message || "Fout bij genereren" });
    controller.close();
    return;
  }

  try {
    // ✅ Geef seasonsCtx door aan de productselectie
    const products = await productsFromCSV(context, req, seasonsCtx);
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

/* ---------- Context samenvatting (inject als system) ---------- */
function summarizeContext(ctx: any) {
  const parts: string[] = [];
  if (ctx?.destination?.country) parts.push(`land: ${ctx.destination.country}`);
  if (ctx?.destination?.region) parts.push(`regio: ${ctx.destination.region}`);
  if (ctx?.durationDays) parts.push(`duur: ${ctx.durationDays} dagen`);
  if (ctx?.month) parts.push(`maand: ${ctx.month}`);
  if (ctx?.startDate && ctx?.endDate) parts.push(`data: ${ctx.startDate} t/m ${ctx.endDate}`);
  if (Array.isArray(ctx?.activities) && ctx.activities.length) parts.push(`activiteiten: ${ctx.activities.join(", ")}`);
  if (!parts.length) return null;
  return `Bekende context (${parts.join(" • ")}). Gebruik dit impliciet bij je advies als het relevant is.`;
}

/* ---------- Bouw OpenAI messages (met nieuwe promptpolicy) ---------- */
function buildMessagesForOpenAI({ systemExtras = [], prompt, history, contextSummary, lastUserMessage, nluHints, _ctx }:{
  systemExtras:any[]; prompt:string; history:any; contextSummary:string|null; lastUserMessage:string; nluHints:any; _ctx:any;
}) {
  const baseSystem = {
    role: "system",
    content: [
      "Je schrijft altijd in helder Engels, direct en zonder disclaimers of excuses.",
      "Gebruik deze secties in onderstaande volgorde: Korte samenvatting, Kleding, Gear, Gadgets, Health, Tips.",
      "De eerste paragraaf is een verhalende, menselijke intro (2–4 zinnen) die de situatie van de gebruiker samenvat en aannames transparant benoemt.",
      "Behandel land, periode, duur en activiteiten als optioneel. Als iets ontbreekt of ‘onbekend’ is: ga door, maak redelijke aannames.",
      "Normaliseer spelfouten/varianten.",
      "Als activiteiten onbekend zijn: basislijst + optionele modules.",
      "Als duur onbekend is: kernlijst + uitbreidingen per extra week.",
      "Als periode onbekend is: scenario’s warm/koud/nat.",
      "Als land onbekend is: klimaat-agnostische adviezen.",
      "Als er seizoenscontext is meegegeven: gebruik die expliciet.",
      "Wees concreet en beknopt; bullets; geen codeblokken/tabellen."
    ].join("\n")
  };

  const policyUnknown = unknownPolicySystem(_ctx, nluHints);

  const approxSystem = [{
    role: "system",
    content:
      "Vage tijdsaanduidingen mag je interpreteren: ‘paar weekjes’≈14 dagen, ‘rond de jaarwisseling’≈20 dec–10 jan. Vul ontbrekende velden in zonder door te vragen."
  }];

  const fewShot = [{
    role: "system",
    content: [
      "Voorbeeld interpretaties:",
      "- User: 'ik ga miss mexcio paar weekjes over 2 mnd' → Normaliseer: land=Mexico; duur≈14 dagen; vertrek≈over 2 maanden.",
      "- User: 'rond de jaarwisseling naar japan' → Periode≈20 dec–10 jan; land=Japan."
    ].join("\n")
  }];

  const extras = (systemExtras || []).map((m) => ({ role: "system", content: (m as any).content || (m as any) }));
  const ctxMsg = contextSummary ? [{ role: "system", content: contextSummary }] : [];
  const english = [forceEnglishSystem()];

  if (history && history.length) {
    const hist = history.map((m: any) => ({ role: m.role, content: String(m.content || "").slice(0, 8000) }));
    const tail = lastUserMessage ? [{ role: "user", content: String(lastUserMessage).slice(0, 8000) }] : [];
    return [...english, policyUnknown, ...fewShot, ...approxSystem, ...extras, baseSystem, ...ctxMsg, ...hist, ...tail];
  }

  return [...english, policyUnknown, ...fewShot, ...approxSystem, ...extras, baseSystem, ...ctxMsg, { role: "user", content: prompt }];
}

/* -------------------- CSV producten -------------------- */
const CSV_PUBLIC_PATH = "/pack_products.csv"; // fallback-pad

// Herken Google Sheets edit-link en maak er CSV-export van
function normalizeSheetsUrl(u: string) {
  try {
    const url = new URL(u);
    if (url.hostname.includes("docs.google.com") && url.pathname.includes("/spreadsheets/")) {
      const gidMatch = url.searchParams.get("gid") || (url.hash.match(/gid=(\d+)/)?.[1] ?? "");
      const base = url.pathname.split("/edit")[0];
      const gid = gidMatch ? `&gid=${gidMatch}` : "";
      return `${url.origin}${base}/export?format=csv${gid}`;
    }
    return u;
  } catch { return u; }
}

function resolveCsvUrl(origin: string) {
  const envUrl = (process.env.PRODUCTS_CSV_URL && String(process.env.PRODUCTS_CSV_URL).trim()) || "";
  const url = envUrl || new URL(CSV_PUBLIC_PATH, origin).toString();
  return normalizeSheetsUrl(url);
}

function getCsvCache() {
  // @ts-ignore
  if (!globalThis.__PACKLIST_CSV__) {
    // @ts-ignore
    globalThis.__PACKLIST_CSV__ = { rows: null, at: 0 };
  }
  // @ts-ignore
  return globalThis.__PACKLIST_CSV__;
}

// ✅ Aangepaste signature: seasonsCtx meegeven
async function productsFromCSV(ctx: any, req: Request, seasonsCtx: any) {
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

  const acts   = (ctx?.activities || []).map((s: string) => String(s).toLowerCase());
  const month  = String(ctx?.month || "").toLowerCase();
  const days   = Number(ctx?.durationDays) || null;
  const country= String(ctx?.destination?.country || "").toLowerCase();

  // ruwe hint (zoals origineel) + climate uit seasonsCtx
  let seasonHint = "";
  if (["december","januari","februari"].includes(month)) seasonHint = "winter";
  else if (["juni","juli","augustus"].includes(month))   seasonHint = "zomer";
  const climate = String(seasonsCtx?.season || "").toLowerCase();

  const filtered = rows.filter((r: any) => {
    const prodActs     = splitCsvList(r.activities);
    const prodSeasons  = splitCsvList(r.seasons);
    const prodTags     = splitCsvList(r.tags);
    const prio         = r.priority ? Number(r.priority) : 999;

    // 1) Activiteiten: leeg = generiek; anders overlap
    const actsOk =
      prodActs.length === 0 ||
      acts.some((a) => prodActs.includes(a));

    // 2) Seizoen/maand: 'alle' of expliciete match of climate-hint
    const seasonOk =
      prodSeasons.length === 0 ||
      prodSeasons.includes("alle") ||
      (seasonHint && prodSeasons.includes(seasonHint)) ||
      (month && prodSeasons.includes(month));

    // 3) Land/regio/klimaat via vrije tags (geen CSV-wijziging nodig)
    const countryOk =
      !country || prodTags.length === 0 ||
      prodTags.includes(country) ||
      // simpele regio-heuristiek voorbeelden
      (country.includes("guatemala") &&
        (prodTags.includes("latam") || prodTags.includes("centraal-amerika")));

    const climateOk =
      prodTags.length === 0 ||
      !climate ||
      prodTags.some((t) =>
        climate.includes(t) || ["tropisch","tropical","warm","regen","wet","dry"].includes(t)
      );

    // 4) Duur: niet blokkeren (geen CSV-veld), eventueel voor sortering
    const durationOk = true;

    return actsOk && seasonOk && countryOk && climateOk && durationOk;
  });

  // Sorteer: priority eerst; kleine categorie-boost o.b.v. duur
  let outRows = filtered.sort((a: any, b: any) => {
    const ap = Number(a.priority || 999), bp = Number(b.priority || 999);
    if (ap !== bp) return ap - bp;
    const catScore = (row: any) => {
      const c = String(row.category || "").toLowerCase();
      if (!days) return 0;
      if (days > 21 && (c.includes("health") || c.includes("gadgets"))) return -0.5;
      if (days <= 10 && c.includes("kleding")) return -0.2;
      return 0;
    };
    return catScore(a) - catScore(b);
  });

  if (outRows.length === 0) {
    outRows = rows.filter((r: any) => {
      const a = splitCsvList(r.activities).length === 0;
      const s = splitCsvList(r.seasons);
      return a && (s.length === 0 || s.includes("alle"));
    });
  }

  const debugItem = {
    category: "DEBUG",
    name: `csv=${resolvedUrl} | total=${rows.length} | filtered=${filtered.length} | out=${outRows.length}`,
    weight_grams: null,
    activities: acts.join(","),
    seasons: seasonHint || month || "",
    url: resolvedUrl,
    image: ""
  };

  const mapped = outRows.map(mapCsvRow);
  const dedup  = dedupeBy(mapped, (p) => `${p.category}|${p.name}`).slice(0, 24);
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

function dedupeBy<T>(arr: T[], keyFn: (x:T)=>string) {
  const seen = new Set<string>();
  const out: T[] = [];
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
          { role: "system", content: "Geef ALLEEN geldige JSON terug, zonder tekst of uitleg." },
          { role: "user", content: `${system}\n\n${user}\n\nAntwoord uitsluitend met JSON.` },
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

async function streamOpenAI({ messages, onDelta }:{ messages:any[]; onDelta:(chunk:string)=>void }) {
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

  const reader = (res.body as any).getReader();
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
