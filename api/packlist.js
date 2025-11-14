export const runtime = "edge";

/**
 * Packlist SSE + Slot-Filling Chat Backend (Edge) — JS-only
 * ---------------------------------------------------------
 * - Output en gebruikers-IO geforceerd naar Engels.
 * - CSV komt uit PRODUCTS_CSV_URL (Google Sheets URL wordt automatisch naar CSV export omgezet).
 * - Producten: generiek ALTIJD tonen + extra’s op basis van activiteiten (NL/EN synoniemen).
 * - ✨ Updates:
 *   - Meerdere landen via context.destinations[] (prompt + seizoenscontext + missingSlots).
 *   - Rationale-tekst als vroeg SSE-event ("rationale") o.b.v. landen + seizoen + duur.
 */

const OPENAI_API_BASE = "https://api.openai.com/v1";
const OPENAI_MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-4o-mini";
const OPENAI_MODEL_JSON = process.env.OPENAI_MODEL_JSON || "gpt-4o-mini";
const enc = new TextEncoder();
const ALWAYS_GENERATE = true;

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

function corsHeaders(req) {
  const origin = req.headers.get("origin") || "";
  const allowOrigin = originAllowed(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-session-id",
    "Access-Control-Allow-Credentials": "true",
  };
}

export async function OPTIONS(req) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(req),
      "Cache-Control": "no-store",
      "Content-Length": "0",
    },
  });
}

export async function GET(req) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(req),
    },
  });
}

/* ------------------------------ POST ------------------------------- */

export async function POST(req) {
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        const payload =
          data === undefined
            ? `event: ${event}\n\n`
            : `event: ${event}\n` +
              `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
        controller.enqueue(enc.encode(payload));
      };
      const closeWithError = (msg) => {
        try { send("error", { message: msg }); } catch {}
        controller.close();
      };

      let body;
      try {
        body = await req.json();
      } catch {
        return closeWithError("Invalid JSON body");
      }

      const safeContext = normalizeContext(body?.context);
      const message = (body?.message || "").trim();
      const hasDirectPrompt = typeof body?.prompt === "string" && body.prompt.trim().length > 0;

      const qaInput = (body?.qaInput && typeof body.qaInput === "object") ? body.qaInput : null;

      const history = sanitizeHistory(body?.history);
      let nluHints = body?.nluHints || null;

      try {
        // 1) Wizard: vier velden in één keer analyseren
        if (qaInput && hasAnyNonEmptyString(qaInput)) {
          const qaFromForm = await evaluateQASet(qaInput);
          if (qaFromForm) {
            send("qa", { source: "form", ...qaFromForm });
            mergeQaIntoContext(safeContext, qaFromForm);
            nluHints = deriveHintsFromQa(qaFromForm, nluHints);
          }
        }

        // 2) Losse utterance analyseren
        if (!hasDirectPrompt && message) {
          const qaFromUtterance = await evaluateAnswersLLM(message);
          if (qaFromUtterance) {
            send("qa", { source: "utterance", ...qaFromUtterance });
            mergeQaIntoContext(safeContext, qaFromUtterance);
            nluHints = deriveHintsFromQa(qaFromUtterance, nluHints);
          }
        }

        // 3) Regex/LLM slot-extractie
        if (!hasDirectPrompt && message) {
          const extracted = await extractSlots({ utterance: message, context: safeContext });
          mergeInto(safeContext, extracted?.context || {});
        }

        const missing = missingSlots(safeContext);

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
      } catch (e) {
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

// ✨ UPDATED: ondersteunt nu context.destinations[] en back-compat met context.destination
function normalizeContext(ctx = {}) {
  const c = typeof ctx === "object" && ctx ? structuredClone(ctx) : {};

  // bestaande velden
  c.destination = c.destination || {};
  if (c.activities && !Array.isArray(c.activities)) {
    c.activities = String(c.activities)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  ensureKeys(c, ["durationDays", "startDate", "endDate", "month", "preferences"]);

  // nieuw: meervoudige landen
  if (!Array.isArray(c.destinations)) c.destinations = [];
  // back-compat: promote enkelvoud naar array als array leeg is
  if (c.destination?.country && c.destinations.length === 0) {
    c.destinations = [{ country: c.destination.country, region: c.destination.region || null }];
  }

  ensureKeys(c.destination, ["country", "region"]);
  c.activities = Array.isArray(c.activities) ? c.activities : [];
  return c;
}
function ensureKeys(o, keys) { for (const k of keys) if (!(k in o)) o[k] = null; }

// ✨ UPDATED: land mag nu óók uit destinations[] komen
function missingSlots(ctx) {
  const missing = [];
  const hasAnyCountry =
    (ctx?.destination?.country) ||
    (Array.isArray(ctx?.destinations) && ctx.destinations.some(d => d?.country));
  if (!hasAnyCountry) missing.push("destination.country");
  if (!ctx?.durationDays || ctx.durationDays < 1) missing.push("durationDays");
  if (!ctx?.month && !(ctx?.startDate && ctx?.endDate)) missing.push("period");
  return missing;
}

// ✨ UPDATED: prompt noemt nu meerdere landen in 1 zin
function buildPromptFromContext(ctx) {
  const legs = Array.isArray(ctx?.destinations) && ctx.destinations.length
    ? ctx.destinations
    : (ctx?.destination?.country ? [ctx.destination] : []);

  const where = legs.length
    ? legs.map(l => [l.country, l.region].filter(Boolean).join(" - ")).join(", ")
    : "?";

  const when = ctx?.month ? `in ${ctx.month}` : `${ctx?.startDate || "?"} t/m ${ctx?.endDate || "?"}`;
  const acts =
    Array.isArray(ctx?.activities) && ctx.activities.length
      ? ` Activiteiten: ${ctx.activities.join(", ")}.`
      : "";
  const days = ctx?.durationDays || "?";
  return `Maak een backpack paklijst voor ${days} dagen langs ${where}, ${when}.${acts}`;
}

/* -------------------- LLM QA-extractie -------------------- */

function hasAnyNonEmptyString(obj) {
  return Object.values(obj).some(v => typeof v === "string" && v.trim().length > 0);
}

async function evaluateAnswersLLM(utterance) {
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
  };

  try {
    const json = await chatJSON(sys, user, schema);
    return json;
  } catch {
    return null;
  }
}

async function evaluateQASet(qaInput) {
  if (!process.env.OPENAI_API_KEY) return null;

  const { destination = "", duration = "", period = "", activities = "" } = qaInput || {};
  if (![destination, duration, period, activities].some(s => typeof s === "string" && s.trim())) return null;

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
  };

  try {
    const json = await chatJSON(sys, user, schema);
    return json;
  } catch {
    return null;
  }
}

function mergeQaIntoContext(ctx, qa) {
  if (!ctx || !qa) return;

  if (qa.destination?.hasInfo) {
    ctx.destination = ctx.destination || {};
    if (qa.destination.country) ctx.destination.country = qa.destination.country;
    if (qa.destination.region)  ctx.destination.region  = qa.destination.region;
    // ✨ align met destinations[]
    if (!Array.isArray(ctx.destinations)) ctx.destinations = [];
    const first = { country: ctx.destination.country || null, region: ctx.destination.region || null };
    if (first.country && ctx.destinations.length === 0) ctx.destinations = [first];
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
    const normActs = qa.activities.list.map(s => String(s).toLowerCase().trim()).filter(Boolean);
    const merged = new Set([...(ctx.activities || []), ...normActs]);
    ctx.activities = Array.from(merged);
  }
}

function deriveHintsFromQa(qa, hintsIn) {
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

async function extractSlots({ utterance, context }) {
  const m = (utterance || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const baseline = {
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

  const acts = [];
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
      const llm = await chatJSON(sys, user, schema);
      mergeInto(baseline, llm);
    } catch {}
  }

  return baseline;
}

function toISO(y, m, d) {
  const year = (+y < 100 ? 2000 + (+y) : +y);
  const month = String(+m).padStart(2, "0");
  const day = String(+d).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function mergeInto(target, src) {
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

/* -------------------- Vervolgvraag -------------------- */

function followupQuestion({ missing, context }) {
  const labels = [];
  if (missing.includes("destination.country")) labels.push("bestemming (land, optioneel regio)");
  if (missing.includes("durationDays")) labels.push("hoeveel dagen");
  if (missing.includes("period")) labels.push("in welke periode (maand of exacte data)");
  const pref = [];
  if (context?.destination?.country) pref.push(`bestemming: ${context.destination.country}`);
  if (context?.durationDays) pref.push(`duur: ${context.durationDays} dagen`);
  if (context?.month) pref.push(`maand: ${context.month}`);
  if (context?.startDate && context?.endDate) pref.push(`data: ${context.startDate} t/m ${context.endDate}`);
  const hint = pref.length ? ` (bekend: ${pref.join(", ")})` : "";
  return `Kun je nog aangeven: ${labels.join(", " )}?${hint}`;
}

/* -------------------- Afgeleide context (LLM) -------------------- */

async function derivedContext(ctx) {
  const sys =
    "Bepaal, indien mogelijk, het seizoen (winter/lente/zomer/herfst of tropisch nat/droog) op basis van land/maand of data. Kort antwoord, alleen het veld 'season'. Geef JSON.";
  const user = `Context: ${JSON.stringify(ctx)}.`;
  const schema = { type: "object", properties: { season: { type: ["string", "null"] } }, required: ["season"] };
  const json = await chatJSON(sys, user, schema);
  return json;
}

/* -------------------- Seasons CSV integratie -------------------- */
const SEASONS_CSV_URL = (process.env.SEASONS_CSV_URL || "").trim();
const SEASONS_TTL_MS = 6 * 60 * 60 * 1000;
const MONTHS_EN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const NL2EN = {
  januari:"Jan", februari:"Feb", maart:"Mar", april:"Apr", mei:"May", juni:"Jun",
  juli:"Jul", augustus:"Aug", september:"Sep", oktober:"Oct", november:"Nov", december:"Dec"
};
let __SEASONS_CACHE__ = { rows: null, at: 0 };

// ✨ UPDATED: merge seizoensinfo over meerdere landen (destinations[])
async function seasonsContextFor(ctx) {
  try {
    const tbl = await loadSeasonsTable();
    if (!tbl || !tbl.length) return {};
    const legs = (Array.isArray(ctx?.destinations) && ctx.destinations.length)
      ? ctx.destinations
      : (ctx?.destination?.country ? [ctx.destination] : []);

    if (!legs.length) return {};

    const merged = { season: null, seasonalRisks: [], adviceFlags: {}, itemTags: [] };

    for (const leg of legs) {
      const legCtx = {
        ...ctx,
        destination: { country: leg.country || null, region: leg.region || null },
        month: leg.month || ctx.month || null,
        startDate: leg.startDate || ctx.startDate || null,
        endDate: leg.endDate || ctx.endDate || null,
      };
      const out = computeSeasonInfoForContext(legCtx, tbl);
      if (!out) continue;

      if (!merged.season && out.season) merged.season = out.season;

      if (Array.isArray(out.seasonalRisks)) merged.seasonalRisks.push(...out.seasonalRisks);
      Object.assign(merged.adviceFlags, out.adviceFlags || {});
      if (Array.isArray(out.itemTags)) merged.itemTags.push(...out.itemTags);
    }

    // dedupe
    const dedupBy = (arr, key) => {
      const seen = new Set(); const out = [];
      for (const x of arr || []) {
        const k = key(x);
        if (!seen.has(k)) { seen.add(k); out.push(x); }
      }
      return out;
    };
    merged.seasonalRisks = dedupBy(merged.seasonalRisks, r => `${r.type}|${r.level||""}|${r.note||""}`);
    merged.itemTags = Array.from(new Set(merged.itemTags));

    return merged;
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

function monthAbbrevFromContext(ctx) {
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

function normStr(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function inSeasonEN(monthAbbrev, start, end) {
  if (!monthAbbrev || !start || !end) return false;
  const idx = (m) => MONTHS_EN.indexOf(m) + 1;
  const m = idx(monthAbbrev), a = idx(start), b = idx(end);
  if (!m || !a || !b) return false;
  return a <= b ? (m >= a && m <= b) : (m >= a || m <= b);
}

function computeSeasonInfoForContext(ctx, table) {
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

  const flags = {};
  const items = new Set();
  for (const h of hits) {
    String(h.advice_flags || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(f => flags[f] = true);
    String(h.item_tags || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(t => items.add(t));
  }

  return { season: climate, seasonalRisks: risks, adviceFlags: flags, itemTags: Array.from(items) };
}

function seasonPromptLines(seasonsCtx) {
  const bits = [];
  if (seasonsCtx?.season) bits.push(`Seizoenscontext: ${seasonsCtx.season}.`);
  if (Array.isArray(seasonsCtx?.seasonalRisks) && seasonsCtx.seasonalRisks.length) {
    const top = seasonsCtx.seasonalRisks[0];
    const lvl = top.level ? ` (${top.level})` : "";
    bits.push(`Belangrijke risico's: ${top.type}${lvl}.`);
  }
  if (!bits.length) return [];
  return [{ role: "system", content: `Gebruik deze seizoenscontext expliciet in de adviezen en paklijst (kleding/gear/health/tips). ${bits.join(" ")}` }];
}

/* -------------------- Prompt policy helpers -------------------- */

function forceEnglishSystem() {
  return {
    role: "system",
    content:
      "You must always write your final answer in clear, natural English. " +
      "Even if the user's message or the prompt is in another language (e.g., Dutch), reply in English only. " +
      "Do not apologize for switching language; just answer in English with a concise, practical tone."
  };
}

function unknownPolicySystem(ctx, nluHints) {
  const unknowns = [];
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

// ✨ Helpers voor rationale
function listCountries(ctx) {
  const legs = (ctx?.destinations && ctx.destinations.length)
    ? ctx.destinations
    : (ctx?.destination?.country ? [ctx.destination] : []);
  const names = legs.map(l => l?.country).filter(Boolean);
  return Array.from(new Set(names)).join(", ");
}

function generateRationale(ctx, seasonsCtx) {
  const countries = listCountries(ctx) || "unknown country";
  const days = ctx?.durationDays ? `${ctx.durationDays} days` : "an unspecified duration";
  const season = seasonsCtx?.season || null;

  const reasons = [];
  if (seasonsCtx?.adviceFlags?.rain) reasons.push("rain protection");
  if (seasonsCtx?.adviceFlags?.mosquito) reasons.push("mosquito prevention");
  if (seasonsCtx?.adviceFlags?.sun) reasons.push("sun exposure");
  if ((seasonsCtx?.itemTags || []).includes("humidity")) reasons.push("humidity & quick-dry fabrics");

  const because = reasons.length ? ` We prioritized ${reasons.join(", ")} based on seasonal conditions.` : "";
  const seasonBit = season ? ` during ${season}` : "";

  return `Tailored for ${countries}${seasonBit}, for ${days}.${because}`;
}

async function generateTripSummary(ctx, seasonsCtx, history) {
  if (!process.env.OPENAI_API_KEY) return null;

  // --- Basis uit de “wizard” context ---
  const countries = listCountries(ctx) || "an unknown destination";
  const days = ctx?.durationDays
    ? `${ctx.durationDays} days`
    : "an open-ended amount of time";
  const period = ctx?.month
    ? `in ${ctx.month}`
    : (ctx?.startDate && ctx?.endDate)
      ? `from ${ctx.startDate} to ${ctx.endDate}`
      : "at an unspecified time of year";
  const activities = Array.isArray(ctx?.activities) && ctx.activities.length
    ? ctx.activities.join(", ")
    : "no specific activities yet";

  const seasonLine = seasonsCtx?.season
    ? `Seasonal context: ${seasonsCtx.season}.`
    : "";

  // --- Voorkeuren uit de chips (travelStyle/budget/accommodation/workMode) ---
  const prefs = ctx?.preferences || {};
  const travelStyleLabel = prefs?.travelStyle
    ? {
        ultralight: "ultralight, carrying only the bare essentials",
        light: "light and flexible, with a compact setup",
        comfort: "comfort-focused, with extra outfits and gear",
        luxury: "more luxurious, with extra comfort items",
      }[prefs.travelStyle] || prefs.travelStyle
    : "no specific travel style";

  const budgetLabel = prefs?.budgetLevel
    ? {
        low: "budget-friendly",
        mid: "mid-range",
        high: "higher-end",
      }[prefs.budgetLevel] || prefs.budgetLevel
    : "no clear budget preference";

  const accommodationLabel = prefs?.accommodation
    ? {
        hostels: "mostly hostels and social stays",
        hotels: "mainly hotels and guesthouses",
        mixed: "a mix of hostels and simple hotels",
      }[prefs.accommodation] || prefs.accommodation
    : "no specific accommodation type";

  const workModeLabel = prefs?.workMode
    ? {
        travel_only: "purely traveling for leisure",
        travel_plus_work: "combining travel with remote work",
      }[prefs.workMode] || prefs.workMode
    : "no work vs. holiday preference";

  // --- Laatste stukjes van de chat zelf (toon & extra details) ---
  const convoSnippet = Array.isArray(history)
    ? history
        .slice(-8) // laatste paar berichten
        .filter((m) => m.role === "user")
        .map((m) => `User: ${m.content}`)
        .join("\n")
    : "";

    const messages = [
    forceEnglishSystem(),
    {
      role: "system",
      content:
        "You write short, vivid trip summaries in clear, natural English.\n" +
        "- Always write in the SECOND person (‘you’, ‘your trip’). Never use ‘I’ or ‘we’.\n" +
        "- Tone: warm, enthusiastic and motivating – it should make the reader excited about their own trip.\n" +
        "- Output: exactly ONE paragraph, 4–6 sentences, roughly 70–140 words.\n" +
        "- Describe the experience of the trip: what the days feel like, typical moments, atmosphere, and vibe.\n" +
        "- Briefly weave in travel style, budget, accommodation and work situation as context, not as a dry list.\n" +
        "- If there is seasonal or climate information, explicitly mention why that period is special (e.g. less rain, green rice fields, cooler evenings).\n" +
        "- Never mention packing, packing lists, gear, checklists, or advice.\n" +
        "- Do not add a title or headings."
    },
    {
      role: "user",
      content:
        `Write an exciting, second-person summary of this backpacking trip.\n\n` +
        `Facts about the trip:\n` +
        `- Destinations: ${countries}\n` +
        `- Duration: ${days}\n` +
        `- Period: ${period}\n` +
        `- Activities: ${activities}\n` +
        `- Travel style: ${travelStyleLabel}\n` +
        `- Budget: ${budgetLabel}\n` +
        `- Accommodation: ${accommodationLabel}\n` +
        `- Work mode: ${workModeLabel}\n` +
        `${seasonLine ? `- ${seasonLine}\n` : ""}` +
        (convoSnippet
          ? `\nExtra hints from the conversation (do NOT quote literally, only use as inspiration):\n${convoSnippet}\n`
          : "") +
        "\nStart with something like “Your trip to … in …” or “On your trip you…” and then describe what their days roughly look like, " +
        "why this period in these destinations is special (e.g. weather, landscape, atmosphere), and how their style/budget/accommodation/work situation shape the experience. " +
        "Write as if you are talking directly to them about their own upcoming adventure."
    }
  ];

  const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL_TEXT,
      temperature: 0.7,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await safeErrorText(res);
    throw new Error(
      `OpenAI tripSummary error: ${res.status}${err ? ` — ${err}` : ""}`
    );
  }

  const j = await res.json();
  const txt = j?.choices?.[0]?.message?.content || "";
  return txt.trim();
}

async function generateAndStream({ controller, send, req, prompt, context, history, lastUserMessage, nluHints }) {
  const derived = await derivedContext(context);
  const seasonsCtx = await seasonsContextFor(context);

  // zend seizoenscontext zoals voorheen
  send("context", { ...derived, ...seasonsCtx });

  // ✨ nieuw: trip-verhaal (LLM) zo vroeg mogelijk uitsturen
  try {
    const summaryText = await generateTripSummary(context, seasonsCtx, history);
    if (summaryText) {
      send("tripSummary", { text: summaryText });
    }
  } catch (e) {
    // stil falen – we willen de rest van de stream niet breken
  }

  // ✨ bestaand: rationale voor intern debug/extra context
  try {
    const rationaleText = generateRationale(context, seasonsCtx);
    if (rationaleText) send("rationale", { text: rationaleText });
  } catch {}

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
  } catch (e) {
    send("error", { message: e?.message || "Fout bij genereren" });
    controller.close();
    return;
  }

  try {
    const products = await productsFromCSV(context, req);
    if (Array.isArray(products) && products.length) {
      const batch = 6;
      for (let i = 0; i < Math.min(products.length, 100); i += batch) {
        send("products", products.slice(i, i + batch));
      }
    }
  } catch (e) {
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

function summarizeContext(ctx) {
  const parts = [];
  if (ctx?.destination?.country) parts.push(`land: ${ctx.destination.country}`);
  if (ctx?.destination?.region) parts.push(`regio: ${ctx.destination.region}`);
  if (Array.isArray(ctx?.destinations) && ctx.destinations.length) {
    const countries = Array.from(new Set(ctx.destinations.map(d => d.country).filter(Boolean)));
    if (countries.length) parts.push(`landen: ${countries.join(", ")}`);
  }
  if (ctx?.durationDays) parts.push(`duur: ${ctx.durationDays} dagen`);
  if (ctx?.month) parts.push(`maand: ${ctx.month}`);
  if (ctx?.startDate && ctx?.endDate) parts.push(`data: ${ctx.startDate} t/m ${ctx.endDate}`);
  if (Array.isArray(ctx?.activities) && ctx.activities.length) parts.push(`activiteiten: ${ctx.activities.join(", ")}`);
  if (!parts.length) return null;
  return `Bekende context (${parts.join(" • ")}). Gebruik dit impliciet bij je advies als het relevant is.`;
}

function buildMessagesForOpenAI({ systemExtras = [], prompt, history, contextSummary, lastUserMessage, nluHints, _ctx }) {
  const baseSystem = {
    role: "system",
    content: [
      "Je schrijft altijd in helder Engels, direct en zonder disclaimers of excuses.",
      "Gebruik deze secties in onderstaande volgorde: Korte samenvatting, Kleding, Gear, Gadgets, Health, Tips.",
      "De eerste paragraaf is een verhalende, menselijke intro (2–4 zinnen) die de situatie van de gebruiker samenvat en aannames transparant benoemt.",
      "Behandel land, periode, duur en activiteiten als optioneel. Als iets ontbreekt of ‘onbekend’ is: ga door, maak redelijke aannames, en benoem die kort.",
      "Normaliseer spelfouten en varianten.",
      "Als activiteiten onbekend zijn: bied een basislijst + optionele modules.",
      "Als duur onbekend is: geef kernlijst en uitbreidingen per extra week.",
      "Als periode onbekend is: geef scenario’s voor warm/koel/nat.",
      "Als land onbekend is: geef klimaat-agnostische adviezen.",
      "Gebruik seizoenscontext als aanwezig.",
      "Geen JSON/code in hoofdtekst. Wees concreet en beknopt; bullets oké."
    ].join("\n")
  };

  const policyUnknown = unknownPolicySystem(_ctx, nluHints);

  const approxSystem = (nluHints?.policy?.allowApproximate || nluHints?.durationPhrase || nluHints?.periodPhrase)
    ? [{ role: "system", content: "Je mag vage tijdsaanduidingen interpreteren (bijv. ‘paar maanden’≈60–90d; ‘rond de jaarwisseling’≈20 dec–10 jan). Vul ontbrekende velden in zonder door te vragen." }]
    : [{ role: "system", content: "Vage tijdsaanduidingen mag je interpreteren (bijv. ‘paar weekjes’≈14d). Vul ontbrekende velden in zonder door te vragen." }];

  const fewShot = [{
    role: "system",
    content: [
      "Voorbeeld interpretaties:",
      "- User: 'ik ga miss mexcio paar weekjes over 2 mnd' → land=Mexico; duur≈14d; vertrek≈over 2 mnd.",
      "- User: 'rond de jaarwisseling naar japan' → periode≈20 dec–10 jan; land=Japan."
    ].join("\n")
  }];

  const extras = (systemExtras || []).map((m) => ({ role: "system", content: m.content || m }));
  const ctxMsg = contextSummary ? [{ role: "system", content: contextSummary }] : [];
  const english = [forceEnglishSystem()];

  if (history && history.length) {
    const hist = history.map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 8000) }));
    const tail = lastUserMessage ? [{ role: "user", content: String(lastUserMessage).slice(0, 8000) }] : [];
    return [...english, policyUnknown, ...fewShot, ...approxSystem, ...extras, baseSystem, ...ctxMsg, ...hist, ...tail];
  }

  return [...english, policyUnknown, ...fewShot, ...approxSystem, ...extras, baseSystem, ...ctxMsg, { role: "user", content: prompt }];
}

/* -------------------- CSV producten -------------------- */
const CSV_PUBLIC_PATH = "/pack_products.csv"; // fallback-pad

function googleSheetToCsv(url) {
  try {
    const u = new URL(url);
    if (!/docs\.google\.com/.test(u.host)) return url;
    // van /edit?gid=... naar /export?format=csv&gid=...
    const parts = u.pathname.split("/");
    const fileIdIdx = parts.indexOf("d") + 1;
    const fileId = parts[fileIdIdx];
    const gid = u.searchParams.get("gid") || "";
    const base = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`;
    return gid ? `${base}&gid=${gid}` : base;
  } catch { return url; }
}

function resolveCsvUrl(origin) {
  const raw = (process.env.PRODUCTS_CSV_URL && String(process.env.PRODUCTS_CSV_URL).trim()) || "";
  if (raw) return googleSheetToCsv(raw);
  return new URL(CSV_PUBLIC_PATH, origin).toString();
}

function getCsvCache() {
  if (!globalThis.__PACKLIST_CSV__) {
    globalThis.__PACKLIST_CSV__ = { rows: null, at: 0 };
  }
  return globalThis.__PACKLIST_CSV__;
}

/* ---------- Activities NL/EN normalisatie ---------- */

const ACT_SYNONYMS = {
  surfing: ["surf", "surfen", "surfing"],
  hiking: ["hike", "hiken", "wandelen", "trek", "trekking", "hiking"],
  diving: ["duik", "duiken", "scuba", "diving", "snorkel", "snorkeling"],
  city: ["city", "stad", "citytrip", "urban"],
  camping: ["camping", "kamperen"],
  snow: ["snow", "ski", "skiën", "skien", "snowboard", "winterspor"],
  swimming: ["zwem", "zwemmen", "swim"],
  running: ["hardlopen", "run", "running"],
  climbing: ["klim", "klimmen", "climb", "climbing", "boulder", "boulderen"],
};

function norm(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function tokenizeCsvList(v) {
  if (!v) return [];
  return String(v)
    .split(/[,;|/]+/)
    .map((s) => norm(s))
    .filter(Boolean);
}

function canonActivity(tok) {
  const t = norm(tok);
  for (const [canon, syns] of Object.entries(ACT_SYNONYMS)) {
    if (syns.some((w) => t.includes(w))) return canon;
  }
  return t;
}

function canonActivities(list) {
  const set = new Set();
  for (const t of list) {
    const c = canonActivity(t);
    if (c) set.add(c);
  }
  return set; // Set<canon>
}

function anyIntersect(aSet, bSet) {
  for (const a of aSet) if (bSet.has(a)) return true;
  return false;
}

async function productsFromCSV(ctx, req) {
  const origin = new URL(req.url).origin;
  const resolvedUrl = resolveCsvUrl(origin);

  // Load CSV once (cached)
  let rows;
  try {
    rows = await loadCsvOnce(origin);
  } catch (e) {
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

  // Context → canon activities
  const ctxActs = canonActivities((ctx?.activities || []).map(String));

  // Score & select: generiek ALTIJD mee, activity-match als extra
  const scored = rows.map((r) => {
    const prodActsArr = tokenizeCsvList(r.activities);
    const prodActs = canonActivities(prodActsArr);
    const isGeneric = prodActs.size === 0 || prodActs.has("alle") || prodActs.has("generic");
    const matchesActivity = ctxActs.size > 0 && anyIntersect(prodActs, ctxActs);

    // score: activity-match boven generiek; lichter gewicht eerst bij gelijke score
    let score = 0;
    if (matchesActivity) score += 2;
    if (isGeneric) score += 0;

    const weight =
      Number(String(r.weight_grams ?? r.weight ?? "").toString().replace(",", ".")) || 999999;

    return { row: r, score, isGeneric, matchesActivity, weight };
  });

  // Filter: alleen meenemen als generiek OF activity-match
  const selected = scored.filter(s => s.isGeneric || s.matchesActivity);

  // Sort: eerst activity-matches (hoogste score), dan generiek; binnen groep lichtste eerst, dan naam
  selected.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.weight !== b.weight) return a.weight - b.weight;
    return String(a.row.name || "").localeCompare(String(b.row.name || ""));
  });

  const mapped = selected.map(({ row }) => mapCsvRow(row));
  const dedup  = dedupeBy(mapped, (p) => `${p.category}|${p.name}`).slice(0, 72);

  const debugItem = {
    category: "DEBUG",
    name: `csv=${resolvedUrl} | total=${rows.length} | ctxActs=${[...ctxActs].join(",")} | out=${dedup.length} (activity+generic)`,
    weight_grams: null,
    activities: "",
    seasons: "",
    url: resolvedUrl,
    image: ""
  };

  return [debugItem, ...dedup];
}

function mapCsvRow(r) {
  return {
    category: r.category || "",
    name: r.name || "",
    weight_grams: r.weight_grams
      ? Number(String(r.weight_grams).replace(",", "."))
      : null,
    activities: r.activities || "",
    seasons: r.seasons || "",
    url: r.url || "",
    image: r.image || "",

    // 🔹 geef de prioriteit mee (verschillende mogelijke kolomnamen)
    priority: r.priority ?? r.prio ?? r.importance ?? r.tier ?? r.priority_level ?? "",
    // (optioneel) booleans als je die ooit in de CSV zet:
    must_have: r.must_have ?? r.musthave ?? "",
    should_have: r.should_have ?? r.shouldhave ?? "",
    nice_to_have: r.nice_to_have ?? r.nicetohave ?? "",
  };
}

function dedupeBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

async function loadCsvOnce(origin) {
  const cache = getCsvCache();
  if (cache.rows && Date.now() - cache.at < 1000 * 60 * 10) {
    return cache.rows;
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

function parseCsv(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => (row[h] = cells[idx] ?? ""));
    if ("weight" in row && !("weight_grams" in row)) row.weight_grams = row.weight;
    out.push(row);
  }
  return out;
}

function splitCsvLine(line) {
  const out = [];
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

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const ok = [];
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

async function chatJSON(system, user, jsonSchema) {
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

async function safeErrorText(res) {
  try { return (await res.text())?.slice(0, 400); } catch { return ""; }
}

async function streamOpenAI({ messages, onDelta }) {
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

  const reader = res.body.getReader();
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
