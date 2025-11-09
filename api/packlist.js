export const runtime = "edge";

/**
 * Packlist SSE + Slot-Filling Chat Backend (Edge)
 * ------------------------------------------------
 * NL-code, maar output en gebruikers-IO worden geforceerd naar Engels.
 * Wijzigingen:
 * - forceEnglishSystem(): systemregel om ALTIJD in Engels te antwoorden.
 * - baseSystem eerste regel: schrijft altijd in helder Engels.
 * - extractSlots(): maanden + duur ondersteunen nu ook Engelse termen.
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

      // Conversatiegeschiedenis en hints uit de frontend
      const history = sanitizeHistory(body?.history);
      const nluHints = body?.nluHints || null;

      try {
        // Vrije tekst pad (slot-filling)
        if (!hasDirectPrompt && message) {
          const extracted = await extractSlots({ utterance: message, context: safeContext });
          mergeInto(safeContext, extracted?.context || {});
          const missing = missingSlots(safeContext);

          // Kijk of er taalsignaal is waardoor we níet hoeven te vragen
          const userLower = message.toLowerCase();
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
  send("needs", { missing, contextOut: extracted?.context || {} });
  const derived = await derivedContext(safeContext);
  const seasonsCtx = await seasonsContextFor(safeContext);
  send("ask", { question: followupQ, missing });
  send("context", { ...derived, ...seasonsCtx });
  controller.close();
  return;
}


          // 👉 Anders: ALTIJD genereren
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

        // Wizard back-compat (direct genereren)
        const prompt = hasDirectPrompt ? body.prompt.trim() : buildPromptFromContext(safeContext);
        const missing = missingSlots(safeContext);

        const HARD_MISS = ["destination.country", "durationDays", "period"];
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

        await generateAndStream({ controller, send, req, prompt, context: safeContext, history, nluHints });
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

function normalizeContext(ctx = {}) {
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
function ensureKeys(o, keys) { for (const k of keys) if (!(k in o)) o[k] = null; }

function missingSlots(ctx) {
  const missing = [];
  if (!ctx?.destination?.country) missing.push("destination.country");
  if (!ctx?.durationDays || ctx.durationDays < 1) missing.push("durationDays");
  if (!ctx?.month && !(ctx?.startDate && ctx?.endDate)) missing.push("period");
  return missing;
}

function buildPromptFromContext(ctx) {
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

/* -------------------- Hybride slot-extractie -------------------- */

/* -------------------- Hybride slot-extractie (regex + LLM fallback) -------------------- */
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function extractSlots({ utterance, context }) {
  const m = (utterance || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
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

  /* ---------- 1. Regex baseline ---------- */

  // Landen (kleine lijst — rest via LLM)
  const COUNTRY = [
    { re: /\bvietnam\b/, name: "Vietnam" },
    { re: /\bindonesie|indonesia\b/, name: "Indonesië" },
    { re: /\bthailand\b/, name: "Thailand" },
    { re: /\bmaleisie|malaysia\b/, name: "Maleisië" },
    { re: /\bfilipijnen|philippines\b/, name: "Filipijnen" },
    { re: /\blaos\b/, name: "Laos" },
    { re: /\bcambodja|cambodia\b/, name: "Cambodja" },
  ];
  const hit = COUNTRY.find((c) => c.re.test(m));
  if (hit) baseline.context.destination.country = hit.name;

  // Maand (NL + EN)
  const MONTH =
    /(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|january|february|march|april|may|june|july|august|september|october|november|december)/;
  const mm = m.match(MONTH);
  if (mm) baseline.context.month = mm[1];

  // Duur (NL + EN)
  const dDays = m.match(/(\d{1,3})\s*(dagen|dag|dgn|days?|d)\b/);
  const dWks = m.match(/(\d{1,2})\s*(weken|weeks?|wk|w)\b/);
  if (dDays) baseline.context.durationDays = Number(dDays[1]);
  else if (dWks) baseline.context.durationDays = Number(dWks[1]) * 7;

  // Datumbereik
  const dateRange = m.match(
    /(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4}).{0,30}?(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/
  );
  if (dateRange) {
    const [, d1, mo1, y1, d2, mo2, y2] = dateRange;
    baseline.context.startDate = toISO(y1, mo1, d1);
    baseline.context.endDate = toISO(y2, mo2, d2);
  }

  // Activiteiten
  const acts = [];
  if (/(duik|duiken|snorkel|scuba)/.test(m)) acts.push("diving");
  if (/(hike|hiken|trek|wandelen|hiking)/.test(m)) acts.push("hiking");
  if (/(surf|surfen|surfing)/.test(m)) acts.push("surfing");
  if (/(city|stad|citytrip)/.test(m)) acts.push("citytrip");
  if (acts.length) baseline.context.activities = acts;

  /* ---------- 2. LLM fallback voor ontbrekende velden ---------- */
  const missing = [];
  if (!baseline.context.destination.country) missing.push("country");
  if (!baseline.context.durationDays) missing.push("duration");
  if (!baseline.context.month && !baseline.context.startDate)
    missing.push("period");
  if (!baseline.context.activities.length) missing.push("activities");

  if (process.env.OPENAI_API_KEY && missing.length) {
    try {
      const prompt = `
You are a travel context extraction assistant.
From this user message, infer the following fields if possible:
- destination.country (the country name)
- durationDays (in days)
- period (month, or date range)
- activities (comma-separated list)

Return valid JSON in English:
{ "destination": { "country": string|null }, "durationDays": number|null, "month": string|null, "startDate": string|null, "endDate": string|null, "activities": string[] }

Message: "${utterance}"
      `;

      const res = await client.responses.create({
        model: "gpt-4o-mini",
        input: prompt,
      });

      const txt = res.output_text.trim();
      try {
        const parsed = JSON.parse(txt);
        mergeInto(baseline.context, parsed);
      } catch {
        console.warn("LLM fallback parse failed:", txt);
      }
    } catch (err) {
      console.error("LLM fallback extraction failed:", err);
    }
  }

  return baseline;
}

  // Landen (kleine lijst — rest via LLM)
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

  // Maand (NL + EN)
  const MONTH = /(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|january|february|march|april|may|june|july|august|september|october|november|december)/;
  const mm = m.match(MONTH);
  if (mm) baseline.context.month = mm[1];

  // Duur (NL + EN)
  const dDays = m.match(/(\d{1,3})\s*(dagen|dag|dgn|days?|d)\b/);
  const dWks  = m.match(/(\d{1,2})\s*(weken|weeks?|wk|w)\b/);
  if (dDays) baseline.context.durationDays = Number(dDays[1]);
  else if (dWks) baseline.context.durationDays = Number(dWks[1]) * 7;

  // Datumbereik (optioneel, numeriek)
  const dateRange = m.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4}).{0,30}?(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if (dateRange) {
    const [, d1, mo1, y1, d2, mo2, y2] = dateRange;
    baseline.context.startDate = toISO(y1, mo1, d1);
    baseline.context.endDate   = toISO(y2, mo2, d2);
  }

  // Activiteiten
  const acts = [];
  if (/(duik|duiken|snorkel|scuba)/.test(m)) acts.push("duiken");
  if (/(hike|hiken|trek|wandelen|hiking)/.test(m)) acts.push("hiken");
  if (/(surf|surfen|surfing)/.test(m)) acts.push("surfen");
  if (/(city|stad|citytrip)/.test(m)) acts.push("citytrip");
  if (acts.length) baseline.context.activities = acts;

  // 2) Optioneel: LLM-verrijking
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

/* -------------------- Vervolgvraag (deterministisch) -------------------- */

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
const SEASONS_TTL_MS = 6 * 60 * 60 * 1000; // 6 uur
const MONTHS_EN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const NL2EN = {
  januari:"Jan", februari:"Feb", maart:"Mar", april:"Apr", mei:"May", juni:"Jun",
  juli:"Jul", augustus:"Aug", september:"Sep", oktober:"Oct", november:"Nov", december:"Dec"
};
let __SEASONS_CACHE__ = { rows: null, at: 0 };

async function seasonsContextFor(ctx) {
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

/* -------------------- Prompt-injectie seizoenscontext -------------------- */

function seasonPromptLines(seasonsCtx) {
  const bits = [];
  if (seasonsCtx?.season) {
    bits.push(`Seizoenscontext: ${seasonsCtx.season}.`);
  }
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

/** Forceer: ALTIJD in het Engels antwoorden */
function forceEnglishSystem() {
  return {
    role: "system",
    content:
      "You must always write your final answer in clear, natural English. " +
      "Even if the user's message or the prompt is in another language (e.g., Dutch), reply in English only. " +
      "Do not apologize for switching language; just answer in English with a concise, practical tone."
  };
}

/** Forceer: ga door met antwoorden (ook bij onbekend), niet doorvragen, normaliseer varianten */
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

async function generateAndStream({ controller, send, req, prompt, context, history, lastUserMessage, nluHints }) {
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
  } catch (e) {
    send("error", { message: e?.message || "Fout bij genereren" });
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

/* ---------- Context samenvatting (inject als system) ---------- */
function summarizeContext(ctx) {
  const parts = [];
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
function buildMessagesForOpenAI({ systemExtras = [], prompt, history, contextSummary, lastUserMessage, nluHints, _ctx }) {
  // ✨ Strengere basisrichtlijnen + output-structuur + gedrag bij onbekend
  const baseSystem = {
    role: "system",
    content: [
      // Doel & taal — NU ENGELS
      "Je schrijft altijd in helder Engels, direct en zonder disclaimers of excuses.",
      // Structuur
      "Gebruik deze secties in onderstaande volgorde: Korte samenvatting, Kleding, Gear, Gadgets, Health, Tips.",
      "De eerste paragraaf is een verhalende, menselijke intro (2–4 zinnen) die de situatie van de gebruiker samenvat en aannames transparant benoemt.",
      // Ontbrekende input = niet blokkeren
      "Behandel land, periode, duur en activiteiten als optioneel. Als iets ontbreekt of ‘onbekend’ is: ga door, maak redelijke aannames, en benoem die kort (‘Als je naar warm/vochtig gebied gaat…’, ‘Bij winter…’, ‘Per extra week…’). Stel geen vervolgvraag in plaats van een antwoord.",
      // Normalisatie/interpretatie
      "Normaliseer spelfouten en varianten (‘miss’→‘misschien’, ‘mexcio’→‘Mexico’, ‘paar weekjes’≈14 dagen, ‘rond de jaarwisseling’≈20 dec–10 jan).",
      // Activiteiten-modules
      "Als activiteiten onbekend zijn: bied een basislijst + optionele modules (hiken, stad, strand, duiken, etc.).",
      // Duur onbekend
      "Als duur onbekend is: geef een minimale kernlijst en voeg uitbreidingen per extra week toe (bijv. +3 T-shirts, +1 onderkleding per 3–4 dagen).",
      // Periode onbekend
      "Als periode onbekend is: geef scenario’s voor warm/heet, koel/koud en nat (regen) met korte aanwijzingen per scenario.",
      // Land onbekend
      "Als land onbekend is: geef klimaat-agnostische adviezen en varieer waar nodig per klimaat.",
      // Seizoenscontext
      "Als er seizoenscontext is meegegeven: gebruik die expliciet in advies en in de secties.",
      // Machineleesbare hints
      "Eventuele machineleesbare hints (seasonalRisks, adviceFlags, itemTags, geïnterpreteerde velden) horen via een apart kanaal te gaan; plaats GEEN JSON in de hoofdtekst.",
      // Stijl/compactheid
      "Wees concreet en beknopt. Gebruik bullets in secties; geen lange lijstjes met irrelevante items. Geen codeblokken, geen tabellen."
    ].join("\n")
  };

  // ✨ Policy: ga door, niet doorvragen, ook als onbekend
  const policyUnknown = unknownPolicySystem(_ctx, nluHints);

  // ✨ Interpretatie van vage taal (few-shot + regel)
  const approxSystem = (nluHints?.policy?.allowApproximate || nluHints?.durationPhrase || nluHints?.periodPhrase)
    ? [{
        role: "system",
        content:
          "Je mag vage tijdsaanduidingen interpreteren. Voorbeelden: ‘paar maanden’≈60–90 dagen (kies 90 bij twijfel), ‘rond de jaarwisseling’≈20 dec–10 jan. " +
          "Vul ontbrekende velden in zonder opnieuw te vragen; vraag alleen door bij echte ambiguïteit (niet van toepassing wanneer velden als onbekend zijn gemarkeerd)."
      }]
    : [{
        role: "system",
        content:
          "Vage tijdsaanduidingen mag je interpreteren: ‘paar weekjes’≈14 dagen, ‘rond de jaarwisseling’≈20 dec–10 jan. " +
          "Vul ontbrekende velden in zonder door te vragen."
      }];

  // Korte few-shot interpretaties
  const fewShot = [{
    role: "system",
    content: [
      "Voorbeeld interpretaties:",
      "- User: 'ik ga miss mexcio paar weekjes over 2 mnd' → Normaliseer: land=Mexico; duur≈14 dagen; vertrek≈over 2 maanden.",
      "- User: 'rond de jaarwisseling naar japan' → Periode≈20 dec–10 jan; land=Japan."
    ].join("\n")
  }];

  const extras = (systemExtras || []).map((m) => ({ role: "system", content: m.content || m }));
  const ctxMsg = contextSummary ? [{ role: "system", content: contextSummary }] : [];

  // ➕ Zet Engelse policy als eerste systeemregel
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

function resolveCsvUrl(origin) {
  const url = (process.env.PRODUCTS_CSV_URL && String(process.env.PRODUCTS_CSV_URL).trim()) || "";
  return url || new URL(CSV_PUBLIC_PATH, origin).toString();
}

function getCsvCache() {
  if (!globalThis.__PACKLIST_CSV__) {
    globalThis.__PACKLIST_CSV__ = { rows: null, at: 0 };
  }
  return globalThis.__PACKLIST_CSV__;
}

async function productsFromCSV(ctx, req) {
  const origin = new URL(req.url).origin;
  const resolvedUrl = resolveCsvUrl(origin);

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

  const acts  = (ctx?.activities || []).map((s) => String(s).toLowerCase());
  const month = (ctx?.month || "").toLowerCase();

  let seasonHint = "";
  if (["december","januari","februari"].includes(month)) seasonHint = "winter";
  else if (["juni","juli","augustus"].includes(month))   seasonHint = "zomer";

  const filtered = rows.filter((r) => {
    const prodActs    = splitCsvList(r.activities);
    const prodSeasons = splitCsvList(r.seasons);

    const actsOk =
      prodActs.length === 0 ||
      acts.some((a) => prodActs.includes(a));

    const seasonOk =
      prodSeasons.length === 0 ||
      prodSeasons.includes("alle") ||
      (seasonHint && prodSeasons.includes(seasonHint)) ||
      (month && prodSeasons.includes(month));

    return actsOk && seasonOk;
  });

  let outRows = filtered;
  if (outRows.length === 0) {
    outRows = rows.filter((r) => {
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

function splitCsvList(v) {
  if (!v) return [];
  return String(v)
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function mapCsvRow(r) {
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
