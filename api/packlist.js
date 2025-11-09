export const runtime = "edge";

/**
 * Packlist SSE + Slot-Filling Chat Backend (Edge)
 * ------------------------------------------------
 * Inclusief:
 * - Unknown-friendly generate flow (allowGeneral)
 * - Sterke CORS (met reflectie en zonder credentials bij "*")
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

function buildCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const requestACRH = req.headers.get("access-control-request-headers") || "";
  const allowOrigin = originAllowed(origin) ? origin : "*";

  const base: Record<string, string> = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // sta altijd de gangbare headers toe + protection-bypass
    "Access-Control-Allow-Headers":
      requestACRH ||
      "Content-Type, Authorization, x-session-id, x-vercel-protection-bypass",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin, Access-Control-Request-Headers",
  };

  // Alleen credentials toestaan als we een specifieke origin echoën
  if (allowOrigin !== "*") {
    base["Access-Control-Allow-Credentials"] = "true";
  }

  return base;
}

export async function OPTIONS(req: Request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...buildCorsHeaders(req),
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
      ...buildCorsHeaders(req),
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

      const history = sanitizeHistory(body?.history);
      const nluHints = body?.nluHints || null;

      try {
        /* ---------- Vrije tekst pad (slot-filling) ---------- */
        if (!hasDirectPrompt && message) {
          const extracted = await extractSlots({ utterance: message, context: safeContext });
          mergeInto(safeContext, extracted?.context || {});
          const missing = missingSlots(safeContext);

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

          // ✅ general unknown flow toegestaan
          const allowGeneral =
            safeContext?.unknownCountry === true &&
            safeContext?.unknownPeriod === true &&
            safeContext?.unknownDuration === true;

          if (!allowGeneral && allHardMissing && !hasAnySignal) {
            const followupQ = followupQuestion({ missing, context: safeContext });
            send("needs", { missing, contextOut: extracted?.context || {} });
            const derived = await derivedContext(safeContext);
            const seasonsCtx = await seasonsContextFor(safeContext);
            send("ask", { question: followupQ, missing });
            send("context", { ...derived, ...seasonsCtx });
            controller.close();
            return;
          }

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

        /* ---------- Wizard back-compat (direct genereren) ---------- */
        const prompt = hasDirectPrompt ? body.prompt.trim() : buildPromptFromContext(safeContext);
        const missing = missingSlots(safeContext);

        const HARD_MISS = ["destination.country", "durationDays", "period"];
        const allHardMissing = HARD_MISS.every(f => missing.includes(f));
        const hasAnySignal =
          !!safeContext?.destination?.country ||
          !!safeContext?.durationDays ||
          !!safeContext?.month || (safeContext?.startDate && safeContext?.endDate);

        const allowGeneral =
          safeContext?.unknownCountry === true &&
          safeContext?.unknownPeriod === true &&
          safeContext?.unknownDuration === true;

        if (!hasDirectPrompt && !allowGeneral && allHardMissing && !hasAnySignal) {
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
      // In Edge mag deze er gewoon bij staan; CORS regelt toegestane origins.
      Connection: "keep-alive",
      ...buildCorsHeaders(req),
    },
  });
}

/* -------------------- Context helpers -------------------- */

function normalizeContext(ctx: any = {}) {
  const c: any = typeof ctx === "object" && ctx ? structuredClone(ctx) : {};
  c.destination = c.destination || {};
  if (c.activities && !Array.isArray(c.activities)) {
    c.activities = String(c.activities)
      .split(",")
      .map((s: string) => s.trim())
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
  return `Maak een backpack paklijst voor ${days} dagen naar ${where}, ${when}.${acts}`;
}

/* -------------------- Hybride slot-extractie -------------------- */

async function extractSlots({ utterance, context }: { utterance: string; context: any; }) {
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
      const llm = await chatJSON(sys, user, schema);
      mergeInto(baseline, llm);
    } catch {}
  }

  return baseline;
}

function toISO(y: any, m: any, d: any) {
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

/* -------------------- Vervolgvraag -------------------- */

function followupQuestion({ missing, context }: { missing: string[]; context: any; }) {
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

/* -------------------- Afgeleide context -------------------- */

async function derivedContext(ctx: any) {
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
  const res = await fetch(SEASONS_CSV_URL, { cache: "no-store" } as any);
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
  return [{ role: "system" as const, content: `Gebruik deze seizoenscontext expliciet in de adviezen en paklijst (kleding/gear/health/tips). ${bits.join(" ")}` }];
}

/* -------------------- ✨ Prompt policy helpers -------------------- */

function forceEnglishSystem() {
  return {
    role: "system" as const,
    content:
      "You must always write your final answer in clear, natural English. " +
      "Even if the user's message or the prompt is in another language (e.g., Dutch), reply in English only. " +
      "Do not apologize for switching language; just answer in English with a concise, practical tone."
  };
}

function unknownPolicySystem(ctx: any, nluHints: any) {
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
  return { role: "system" as const, content: lines.join(" ") };
}

/* -------------------- Generate & Stream -------------------- */

async function generateAndStream({ controller, send, req, prompt, context, history, lastUserMessage, nluHints }: any) {
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

/* ---------- Context samenvatting ---------- */
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

/* ---------- Bouw OpenAI messages ---------- */
function buildMessagesForOpenAI({ systemExtras = [], prompt, history, contextSummary, lastUserMessage, nluHints, _ctx }: any) {
  const baseSystem = {
    role: "system" as const,
    content: [
      "Je schrijft altijd in helder Engels, direct en zonder disclaimers of excuses.",
      "Gebruik deze secties in onderstaande volgorde: Korte samenvatting, Kleding, Gear, Gadgets, Health, Tips.",
      "De eerste paragraaf is een verhalende, menselijke intro (2–4 zinnen) die de situatie van de gebruiker samenvat en aannames transparant benoemt.",
      "Behandel land, periode, duur en activiteiten als optioneel. Als iets ontbreekt of ‘onbekend’ is: ga door, maak redelijke aannames, en benoem die kort.",
      "Normaliseer spelfouten en varianten.",
      "Als activiteiten onbekend zijn: basislijst + optionele modules.",
      "Als duur onbekend is: uitbreidingen per extra week.",
      "Als periode onbekend is: scenario’s warm/koel/nat.",
      "Als land onbekend is: klimaat-agnostisch advies.",
      "Gebruik seizoenscontext als die aanwezig is.",
      "Wees concreet en beknopt. Bullets in secties; geen codeblokken of tabellen."
    ].join("\n")
  };

  const policyUnknown = unknownPolicySystem(_ctx, nluHints);

  const approxSystem = (nluHints?.policy?.allowApproximate || nluHints?.durationPhrase || nluHints?.periodPhrase)
    ? [{ role: "system" as const, content: "Je mag vage tijdsaanduidingen interpreteren; vul ontbrekende velden in zonder door te vragen." }]
    : [{ role: "system" as const, content: "Interpreteer vage tijdsaanduidingen zonder door te vragen." }];

  const fewShot = [{
    role: "system" as const,
    content: [
      "Voorbeeld interpretaties:",
      "- 'ik ga miss mexcio paar weekjes over 2 mnd' → Mexico; ~14 dagen; vertrek ~2 maanden.",
      "- 'rond de jaarwisseling naar japan' → ~20 dec–10 jan; Japan."
    ].join("\n")
  }];

  const extras = (systemExtras || []).map((m: any) => ({ role: "system" as const, content: m.content || m }));
  const ctxMsg = contextSummary ? [{ role: "system" as const, content: contextSummary }] : [];
  const english = [forceEnglishSystem()];

  if (history && history.length) {
    const hist = history.map((m: any) => ({ role: m.role, content: String(m.content || "").slice(0, 8000) }));
    const tail = lastUserMessage ? [{ role: "user" as const, content: String(lastUserMessage).slice(0, 8000) }] : [];
    return [...english, policyUnknown, ...fewShot, ...approxSystem, ...extras, baseSystem, ...ctxMsg, ...hist, ...tail];
  }

  return [...english, policyUnknown, ...fewShot, ...approxSystem, ...extras, baseSystem, ...ctxMsg, { role: "user" as const, content: prompt }];
}

/* -------------------- CSV producten -------------------- */
const CSV_PUBLIC_PATH = "/pack_products.csv";

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
  const month = (ctx?.month || "").toLowerCase();

  let seasonHint = "";
  if (["december","januari","februari"].includes(month)) seasonHint = "winter";
  else if (["juni","juli","augustus"].includes(month))   seasonHint = "zomer";

  const filtered = rows.filter((r: any) => {
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

function dedupeBy<T>(arr: T[], keyFn: (x: T) => string) {
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
    return cache.rows;
  }

  const url = resolveCsvUrl(origin);
  const res = await fetch(url, { cache: "no-store" } as any);
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
    the content = (m && m.content) || "";
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

async function streamOpenAI({ messages, onDelta }: { messages: any[]; onDelta: (s: string) => void; }) {
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
