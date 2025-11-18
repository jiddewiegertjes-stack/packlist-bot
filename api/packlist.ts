export const runtime = "edge";

/**
 * Packlist SSE + Slot-Filling Chat Backend (Edge) — JS-only
 * ---------------------------------------------------------
 * - Output en gebruikers-IO geforceerd naar Engels.
 * - CSV komt uit PRODUCTS_CSV_URL (Google Sheets URL wordt automatisch naar CSV export omgezet).
 * - Producten: generiek ALTIJD tonen + extra’s op basis van activiteiten (NL/EN synoniemen).
 * - Seizoenen:
 *   - CSV via SEASONS_CSV_URL (per land/maand → climate, risks, flags).
 *   - LLM-fallback als CSV ontbreekt → gecombineerd in combinedSeasonsCtx.season.
 *   - Extra SSE-events: tripSummary, seasonAdvice, rationale, context.
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
      const rx = new RegExp(
        "^" + pat.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
      );
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
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-session-id",
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
              `data: ${
                typeof data === "string" ? data : JSON.stringify(data)
              }\n\n`;
        controller.enqueue(enc.encode(payload));
      };

      const closeWithError = (msg: string) => {
        try {
          send("error", { message: msg });
        } catch {}
        controller.close();
      };

      let body: any;
      try {
        body = await req.json();
      } catch {
        return closeWithError("Invalid JSON body");
      }

const safeContext = normalizeContext(body?.context);

// 🔹 Bepaal ruwe homeCountry-tekst: eerst uit context/profile, anders uit losse velden, anders uit message
const rawHomeCountry =
  (safeContext as any)?.profile?.homeCountry ||
  (body as any)?.homeCountry ||
  (body as any)?.profile?.homeCountry ||
  (body as any)?.country ||
  (body as any)?.origin ||
  (body?.qaInput && (body.qaInput.homeCountry || body.qaInput.country)) ||
  (body?.message as string) ||
  "";

// Zorg dat profile bestaat
if (!safeContext.profile) safeContext.profile = {};

if (rawHomeCountry && typeof rawHomeCountry === "string") {
  try {
    const detected = await detectHomeCountry(rawHomeCountry);

    // Wat we naar de frontend willen sturen:
    safeContext.profile.homeCountryDetected = detected.country || null;  // bv. "Netherlands"
    safeContext.profile.homeCountryCode = detected.iso2 || null;        // bv. "NL"

    // Optioneel: simpele market-afleiding
    if (detected.iso2 === "NL") {
      safeContext.profile.market = "nl";
    } else if (detected.iso2 === "US") {
      safeContext.profile.market = "us";
    } else {
      safeContext.profile.market = "intl";
    }
  } catch {
    // Bij fout: niets doen, geen crash
  }
}

const message = (body?.message || "").trim();

      const hasDirectPrompt =
        typeof body?.prompt === "string" && body.prompt.trim().length > 0;

      const qaInput =
        body?.qaInput && typeof body.qaInput === "object"
          ? body.qaInput
          : null;

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
          const extracted = await extractSlots({
            utterance: message,
            context: safeContext,
          });
          mergeInto(safeContext, extracted?.context || {});
        }

        const missing = missingSlots(safeContext);

        const userLower = message.toLowerCase?.() || "";
        const hasDurationSignal =
          !!nluHints?.durationDays ||
          !!nluHints?.durationPhrase ||
          /\b(weekje|maandje|paar\s*weken|paar\s*maanden|few\s*weeks|few\s*months)\b/.test(
            userLower,
          );
        const hasPeriodSignal =
          !!nluHints?.month ||
          !!nluHints?.startDate ||
          !!nluHints?.periodPhrase ||
          /\brond\s+de\s+jaarwisseling|rond\s+kerst|oud.*nieuw\b/.test(
            userLower,
          );

        const HARD_MISS = [
          "destination.country",
          "durationDays",
          "period",
        ];
        const allHardMissing = HARD_MISS.every((f) => missing.includes(f));
        const hasAnySignal =
          !!nluHints?.durationDays ||
          !!nluHints?.month ||
          !!nluHints?.startDate ||
          !!safeContext?.destination?.country ||
          !!safeContext?.durationDays ||
          (Array.isArray(safeContext?.activities) &&
            safeContext.activities.length > 0) ||
          hasPeriodSignal ||
          hasDurationSignal;

if (!ALWAYS_GENERATE && allHardMissing && !hasAnySignal) {
  const followupQ = followupQuestion({
    missing,
    context: safeContext,
  });
  send("needs", { missing, contextOut: {} });
  const derived = await derivedContext(safeContext);
  const seasonsCtx = await seasonsContextFor(safeContext);
  send("ask", { question: followupQ, missing });
  send("context", {
    ...derived,
    ...seasonsCtx,
    profile: safeContext.profile || null,   // 👈 hier ook
  });
  controller.close();
  return;
}


        const prompt = hasDirectPrompt
          ? body.prompt.trim()
          : buildPromptFromContext(safeContext);

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

// ondersteunt context.destinations[] en back-compat met context.destination
function normalizeContext(ctx: any = {}) {
  const c =
    typeof ctx === "object" && ctx ? structuredClone(ctx) : ({} as any);

    c.profile = c.profile || {};        // 👈 NIEUW

  // bestaande velden
  c.destination = c.destination || {};
  if (c.activities && !Array.isArray(c.activities)) {
    c.activities = String(c.activities)
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
  }
  ensureKeys(c, ["durationDays", "startDate", "endDate", "month", "preferences"]);

  // meervoudige landen
  if (!Array.isArray(c.destinations)) c.destinations = [];
  // back-compat: promote enkelvoud naar array als array leeg is
  if (c.destination?.country && c.destinations.length === 0) {
    c.destinations = [
      {
        country: c.destination.country,
        region: c.destination.region || null,
      },
    ];
  }

  ensureKeys(c.destination, ["country", "region"]);
  c.activities = Array.isArray(c.activities) ? c.activities : [];
  return c;
}
function ensureKeys(o: any, keys: string[]) {
  for (const k of keys) if (!(k in o)) o[k] = null;
}

// land mag nu óók uit destinations[] komen
function missingSlots(ctx: any) {
  const missing: string[] = [];
  const hasAnyCountry =
    ctx?.destination?.country ||
    (Array.isArray(ctx?.destinations) &&
      ctx.destinations.some((d: any) => d?.country));
  if (!hasAnyCountry) missing.push("destination.country");
  if (!ctx?.durationDays || ctx.durationDays < 1) missing.push("durationDays");
  if (!ctx?.month && !(ctx?.startDate && ctx?.endDate)) missing.push("period");
  return missing;
}

// prompt noemt nu meerdere landen in 1 zin
function buildPromptFromContext(ctx: any) {
  const legs =
    Array.isArray(ctx?.destinations) && ctx.destinations.length
      ? ctx.destinations
      : ctx?.destination?.country
      ? [ctx.destination]
      : [];

  const where = legs.length
    ? legs
        .map((l: any) =>
          [l.country, l.region].filter(Boolean).join(" - "),
        )
        .join(", ")
    : "?";

  const when = ctx?.month
    ? `in ${ctx.month}`
    : `${ctx?.startDate || "?"} t/m ${ctx?.endDate || "?"}`;
  const acts =
    Array.isArray(ctx?.activities) && ctx.activities.length
      ? ` Activiteiten: ${ctx.activities.join(", ")}.`
      : "";
  const days = ctx?.durationDays || "?";
  return `Maak een backpack paklijst voor ${days} dagen langs ${where}, ${when}.${acts}`;
}

/* -------------------- LLM QA-extractie -------------------- */

function hasAnyNonEmptyString(obj: Record<string, any>) {
  return Object.values(obj).some(
    (v) => typeof v === "string" && v.trim().length > 0,
  );
}

/**
 * LLM-helper: bepaal of de ingevulde homeCountry tot Nederland hoort.
 * Geeft true terug als het met heel grote waarschijnlijkheid NL is
 * (Netherlands, Holland, NL, Dutch, Amsterdam, etc.), anders false.
 */
/**
 * LLM-helper: haal het meest waarschijnlijke land uit vrije tekst.
 * Geeft een genormaliseerde Engelse landnaam + ISO2-code terug.
 */
async function detectHomeCountry(
  input: string,
): Promise<{ country: string | null; iso2: string | null }> {
  if (!process.env.OPENAI_API_KEY || !input || typeof input !== "string") {
    return { country: null, iso2: null };
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      country: { type: ["string", "null"] }, // bv. "Netherlands"
      iso2: { type: ["string", "null"] },    // bv. "NL"
    },
    required: ["country", "iso2"],
  };

  const sys =
    "Je taak: lees een vrij antwoord van een gebruiker (in elke taal) en bepaal uit welk land deze persoon komt of in welk land hij/zij woont.\n" +
    "- Normaliseer de landnaam naar Engels, bijv. 'Nederland' -> 'Netherlands', 'Verenigde Staten' -> 'United States'.\n" +
    "- Geef óók de officiële ISO 3166-1 alpha-2 country code terug (twee letters), bijv. 'Netherlands' -> 'NL', 'United States' -> 'US'.\n" +
    "- Als je het land niet redelijk zeker weet, zet beide velden op null.\n" +
    "Antwoord ALLEEN als JSON met velden country en iso2.";

  const user =
    `Antwoord van gebruiker op 'Where do you live / what's your home country?': "${input}".\n` +
    "Bepaal country (Engelse naam) en iso2.";

  try {
    const json = await chatJSON(sys, user, schema);
    return {
      country: (json && json.country) || null,
      iso2: (json && json.iso2 ? String(json.iso2).toUpperCase() : null),
    };
  } catch {
    return { country: null, iso2: null };
  }
}

async function evaluateAnswersLLM(utterance: string) {
  if (!process.env.OPENAI_API_KEY || !utterance || typeof utterance !== "string")
    return null;

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
          region: { type: ["string", "null"] },
          evidence: { type: ["string", "null"] },
        },
        required: ["hasInfo", "country", "region", "evidence"],
      },
      duration: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          durationDays: { type: ["integer", "null"] },
          phrase: { type: ["string", "null"] },
          evidence: { type: ["string", "null"] },
        },
        required: ["hasInfo", "durationDays", "phrase", "evidence"],
      },
      period: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          month: { type: ["string", "null"] },
          startDate: { type: ["string", "null"] },
          endDate: { type: ["string", "null"] },
          phrase: { type: ["string", "null"] },
          evidence: { type: ["string", "null"] },
        },
        required: ["hasInfo", "month", "startDate", "endDate", "phrase", "evidence"],
      },
      activities: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          list: { type: "array", items: { type: "string" } },
          evidence: { type: ["string", "null"] },
        },
        required: ["hasInfo", "list", "evidence"],
      },
    },
    required: ["destination", "duration", "period", "activities"],
  };

  try {
    const json = await chatJSON(sys, user, schema);
    return json;
  } catch {
    return null;
  }
}

async function evaluateQASet(qaInput: any) {
  if (!process.env.OPENAI_API_KEY) return null;

  const {
    destination = "",
    duration = "",
    period = "",
    activities = "",
  } = qaInput || {};
  if (
    ![destination, duration, period, activities].some(
      (s) => typeof s === "string" && s.trim(),
    )
  )
    return null;

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
          country: { type: ["string", "null"] },
          region: { type: ["string", "null"] },
          evidence: { type: ["string", "null"] },
        },
        required: ["hasInfo", "country", "region", "evidence"],
      },
      duration: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          durationDays: { type: ["integer", "null"] },
          phrase: { type: ["string", "null"] },
          evidence: { type: ["string", "null"] },
        },
        required: ["hasInfo", "durationDays", "phrase", "evidence"],
      },
      period: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          month: { type: ["string", "null"] },
          startDate: { type: ["string", "null"] },
          endDate: { type: ["string", "null"] },
          phrase: { type: ["string", "null"] },
          evidence: { type: ["string", "null"] },
        },
        required: ["hasInfo", "month", "startDate", "endDate", "phrase", "evidence"],
      },
      activities: {
        type: "object",
        additionalProperties: false,
        properties: {
          hasInfo: { type: "boolean" },
          list: { type: "array", items: { type: "string" } },
          evidence: { type: ["string", "null"] },
        },
        required: ["hasInfo", "list", "evidence"],
      },
    },
    required: ["destination", "duration", "period", "activities"],
  };

  try {
    const json = await chatJSON(sys, user, schema);
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
    if (qa.destination.region) ctx.destination.region = qa.destination.region;
    // align met destinations[]
    if (!Array.isArray(ctx.destinations)) ctx.destinations = [];
    const first = {
      country: ctx.destination.country || null,
      region: ctx.destination.region || null,
    };
    if (first.country && ctx.destinations.length === 0) {
      ctx.destinations = [first];
    }
  }
  if (
    qa.duration?.hasInfo &&
    Number.isFinite(qa.duration.durationDays || null)
  ) {
    ctx.durationDays = qa.duration.durationDays;
  }
  if (qa.period?.hasInfo) {
    if (qa.period.month) {
      ctx.month = qa.period.month;
      ctx.startDate = ctx.startDate || null;
      ctx.endDate = ctx.endDate || null;
    } else if (qa.period.startDate && qa.period.endDate) {
      ctx.startDate = qa.period.startDate;
      ctx.endDate = qa.period.endDate;
      ctx.month = null;
    }
  }
  if (qa.activities?.hasInfo && Array.isArray(qa.activities.list)) {
    const normActs = qa.activities.list
      .map((s: any) => String(s).toLowerCase().trim())
      .filter(Boolean);
    const merged = new Set([...(ctx.activities || []), ...normActs]);
    ctx.activities = Array.from(merged);
  }
}

function deriveHintsFromQa(qa: any, hintsIn: any) {
  const hints = Object.assign({}, hintsIn || {});
  if (!qa) return hints;

  if (qa.duration?.hasInfo) {
    if (Number.isFinite(qa.duration.durationDays)) {
      hints.durationDays = qa.duration.durationDays;
    }
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
  const m = (utterance || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
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

  const MONTH =
    /(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|january|february|march|april|may|june|july|august|september|october|november|december)/;
  const mm = m.match(MONTH);
  if (mm) baseline.context.month = mm[1];

  const dDays = m.match(/(\d{1,3})\s*(dagen|dag|dgn|days?|d)\b/);
  const dWks = m.match(/(\d{1,2})\s*(weken|weeks?|wk|w)\b/);
  if (dDays) baseline.context.durationDays = Number(dDays[1]);
  else if (dWks) baseline.context.durationDays = Number(dWks[1]) * 7;

  const dateRange = m.match(
    /(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4}).{0,30}?(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/,
  );
  if (dateRange) {
    const [, d1, mo1, y1, d2, mo2, y2] = dateRange;
    baseline.context.startDate = toISO(y1, mo1, d1);
    baseline.context.endDate = toISO(y2, mo2, d2);
  }

  const acts: string[] = [];
  if (/(duik|duiken|snorkel|scuba)/.test(m)) acts.push("duiken");
  if (/(hike|hiken|trek|wandelen|hiking)/.test(m)) acts.push("hiken");
  if (/(surf|surfen|surfing)/.test(m)) acts.push("surfen");
  if (/(city|stad|citytrip)/.test(m)) acts.push("citytrip");
  if (acts.length) baseline.context.activities = acts;

  if (process.env.OPENAI_API_KEY) {
    try {
      const schema = {
        type: "object",
        properties: { context: { type: "object" } },
        required: ["context"],
        additionalProperties: true,
      };
      const sys =
        "Verrijk onderstaande context met expliciet genoemde feiten. Geef ALLEEN JSON.";
      const user = `Huidige context: ${JSON.stringify(
        context,
      )}\nZin: "${utterance}"\nVoeg genoemde velden toe; onbekend blijft null.`;
      const llm = await chatJSON(sys, user, schema);
      mergeInto(baseline, llm);
    } catch {}
  }

  return baseline;
}

function toISO(y: string | number, m: string | number, d: string | number) {
  const year = +y < 100 ? 2000 + +y : +y;
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

function followupQuestion({
  missing,
  context,
}: {
  missing: string[];
  context: any;
}) {
  const labels: string[] = [];
  if (missing.includes("destination.country"))
    labels.push("bestemming (land, optioneel regio)");
  if (missing.includes("durationDays")) labels.push("hoeveel dagen");
  if (missing.includes("period"))
    labels.push("in welke periode (maand of exacte data)");
  const pref: string[] = [];
  if (context?.destination?.country)
    pref.push(`bestemming: ${context.destination.country}`);
  if (context?.durationDays) pref.push(`duur: ${context.durationDays} dagen`);
  if (context?.month) pref.push(`maand: ${context.month}`);
  if (context?.startDate && context?.endDate)
    pref.push(`data: ${context.startDate} t/m ${context.endDate}`);
  const hint = pref.length ? ` (bekend: ${pref.join(", ")})` : "";
  return `Kun je nog aangeven: ${labels.join(", ")}?${hint}`;
}

/* -------------------- Afgeleide context (LLM) -------------------- */

async function derivedContext(ctx: any) {
  const sys =
    "Bepaal, indien mogelijk, het seizoen (winter/lente/zomer/herfst of tropisch nat/droog) op basis van land/maand of data. Kort antwoord, alleen het veld 'season'. Geef JSON.";
  const user = `Context: ${JSON.stringify(ctx)}.`;
  const schema = {
    type: "object",
    properties: { season: { type: ["string", "null"] } },
    required: ["season"],
  };
  const json = await chatJSON(sys, user, schema);
  return json;
}

/* -------------------- Seasons CSV integratie -------------------- */

const SEASONS_CSV_URL = (process.env.SEASONS_CSV_URL || "").trim();
const SEASONS_TTL_MS = 6 * 60 * 60 * 1000;
const MONTHS_EN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const NL2EN: Record<string, string> = {
  januari: "Jan",
  februari: "Feb",
  maart: "Mar",
  april: "Apr",
  mei: "May",
  juni: "Jun",
  juli: "Jul",
  augustus: "Aug",
  september: "Sep",
  oktober: "Oct",
  november: "Nov",
  december: "Dec",
};
let __SEASONS_CACHE__: { rows: any[] | null; at: number } = { rows: null, at: 0 };

// merge seizoensinfo over meerdere landen (destinations[])
async function seasonsContextFor(ctx: any) {
  try {
    const tbl = await loadSeasonsTable();
    if (!tbl || !tbl.length) return {};
    const legs =
      Array.isArray(ctx?.destinations) && ctx.destinations.length
        ? ctx.destinations
        : ctx?.destination?.country
        ? [ctx.destination]
        : [];

    if (!legs.length) return {};

    const merged: any = {
      season: null,
      seasonalRisks: [],
      adviceFlags: {},
      itemTags: [],
    };

    for (const leg of legs) {
      const legCtx = {
        ...ctx,
        destination: {
          country: leg.country || null,
          region: leg.region || null,
        },
        month: (leg as any).month || ctx.month || null,
        startDate: (leg as any).startDate || ctx.startDate || null,
        endDate: (leg as any).endDate || ctx.endDate || null,
      };
      const out = computeSeasonInfoForContext(legCtx, tbl);
      if (!out) continue;

      if (!merged.season && out.season) merged.season = out.season;

      if (Array.isArray(out.seasonalRisks))
        merged.seasonalRisks.push(...out.seasonalRisks);
      Object.assign(merged.adviceFlags, out.adviceFlags || {});
      if (Array.isArray(out.itemTags)) merged.itemTags.push(...out.itemTags);
    }

    // dedupe
    const dedupBy = (arr: any[], key: (x: any) => string) => {
      const seen = new Set<string>();
      const out: any[] = [];
      for (const x of arr || []) {
        const k = key(x);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(x);
        }
      }
      return out;
    };
    merged.seasonalRisks = dedupBy(
      merged.seasonalRisks,
      (r) => `${r.type}|${r.level || ""}|${r.note || ""}`,
    );
    merged.itemTags = Array.from(new Set(merged.itemTags));

    return merged;
  } catch {
    return {};
  }
}

async function loadSeasonsTable() {
  if (!SEASONS_CSV_URL) return [];
  if (
    __SEASONS_CACHE__.rows &&
    Date.now() - __SEASONS_CACHE__.at < SEASONS_TTL_MS
  ) {
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
    return (
      NL2EN[m] ||
      MONTHS_EN.find((mm) =>
        mm.toLowerCase().startsWith(m.slice(0, 3)),
      ) ||
      null
    );
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

function inSeasonEN(
  monthAbbrev: string | null,
  start: string,
  end: string,
) {
  if (!monthAbbrev || !start || !end) return false;
  const idx = (m: string) => MONTHS_EN.indexOf(m) + 1;
  const m = idx(monthAbbrev);
  const a = idx(start);
  const b = idx(end);
  if (!m || !a || !b) return false;
  return a <= b ? m >= a && m <= b : m >= a || m <= b;
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
    const regionMatch = rr ? rc === C && rr === R : rc === C;
    return regionMatch && inSeasonEN(monthAbbrev, r.start_month, r.end_month);
  });

  const climate =
    hits.find(
      (h) => String(h.type).toLowerCase() === "climate",
    )?.label || null;

  const risks = hits
    .filter((h) => String(h.type).toLowerCase() === "risk")
    .map((h) => ({
      type: String(h.label || "").toLowerCase(),
      level: String(h.level || "unknown").toLowerCase(),
      note: h.note || "",
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

  return {
    season: climate,
    seasonalRisks: risks,
    adviceFlags: flags,
    itemTags: Array.from(items),
  };
}

function seasonPromptLines(seasonsCtx: any) {
  const bits: string[] = [];
  if (seasonsCtx?.season)
    bits.push(`Seizoenscontext: ${seasonsCtx.season}.`);
  if (
    Array.isArray(seasonsCtx?.seasonalRisks) &&
    seasonsCtx.seasonalRisks.length
  ) {
    const top = seasonsCtx.seasonalRisks[0];
    const lvl = top.level ? ` (${top.level})` : "";
    bits.push(`Belangrijke risico's: ${top.type}${lvl}.`);
  }
  if (!bits.length) return [];
  return [
    {
      role: "system",
      content:
        "Gebruik deze seizoenscontext expliciet in de adviezen en paklijst (kleding/gear/health/tips). " +
        bits.join(" "),
    },
  ];
}

/* -------------------- Prompt policy helpers -------------------- */

function forceEnglishSystem() {
  return {
    role: "system",
    content:
      "You must always write your final answer in clear, natural English. " +
      "Even if the user's message or the prompt is in another language (e.g., Dutch), reply in English only. " +
      "Do not apologize for switching language; just answer in English with a concise, practical tone.",
  };
}

function unknownPolicySystem(ctx: any, nluHints: any) {
  const unknowns: string[] = [];
  if (ctx?.unknownCountry) unknowns.push("land/bestemming");
  if (ctx?.unknownPeriod) unknowns.push("periode (maand of data)");
  if (ctx?.unknownDuration) unknowns.push("duur (aantal dagen)");
  if (!ctx?.destination?.country && !unknowns.includes("land/bestemming"))
    unknowns.push("land/bestemming");
  if (!ctx?.month && !(ctx?.startDate && ctx?.endDate) && !unknowns.includes("periode (maand of data)"))
    unknowns.push("periode (maand of data)");
  if (!ctx?.durationDays && !unknowns.includes("duur (aantal dagen)"))
    unknowns.push("duur (aantal dagen)");

  const lines = [
    "Ga door met antwoorden, ook als onderstaande velden onbekend zijn.",
    "Stel géén vervolgvraag; maak redelijke aannames en benoem ze kort in de tekst.",
    unknowns.length
      ? `Onbekend gemarkeerd: ${unknowns.join(", ")}.`
      : "Alle velden lijken bekend; aannames blijven toegestaan.",
  ];
  return { role: "system", content: lines.join(" ") };
}

/* -------------------- Generate & Stream helpers -------------------- */

function listCountries(ctx: any) {
  const legs =
    ctx?.destinations && ctx.destinations.length
      ? ctx.destinations
      : ctx?.destination?.country
      ? [ctx.destination]
      : [];
  const names = legs.map((l: any) => l?.country).filter(Boolean);
  return Array.from(new Set(names)).join(", ");
}

function generateRationale(ctx: any, seasonsCtx: any) {
  const countries = listCountries(ctx) || "unknown country";
  const days = ctx?.durationDays
    ? `${ctx.durationDays} days`
    : "an unspecified duration";
  const season = seasonsCtx?.season || null;

  const reasons: string[] = [];
  if (seasonsCtx?.adviceFlags?.rain) reasons.push("rain protection");
  if (seasonsCtx?.adviceFlags?.mosquito)
    reasons.push("mosquito prevention");
  if (seasonsCtx?.adviceFlags?.sun) reasons.push("sun exposure");
  if ((seasonsCtx?.itemTags || []).includes("humidity"))
    reasons.push("humidity & quick-dry fabrics");

  const because = reasons.length
    ? ` We prioritized ${reasons.join(", ")} based on seasonal conditions.`
    : "";
  const seasonBit = season ? ` during ${season}` : "";

  return `Tailored for ${countries}${seasonBit}, for ${days}.${because}`;
}

async function generateTripSummary(
  ctx: any,
  seasonsCtx: any,
  history: any,
) {
  if (!process.env.OPENAI_API_KEY) return null;

  const countries = listCountries(ctx) || "an unknown destination";
  const days = ctx?.durationDays
    ? `${ctx.durationDays} days`
    : "an open-ended duration";

  const period = ctx?.month
    ? `in ${ctx.month}`
    : ctx?.startDate && ctx?.endDate
    ? `from ${ctx.startDate} to ${ctx.endDate}`
    : "at an unspecified time of year";

  const activities =
    Array.isArray(ctx?.activities) && ctx.activities.length
      ? ctx.activities.join(", ")
      : null;

  const prefs = ctx?.preferences || {};

  const travelStyleLabel = prefs?.travelStyle || "";
  const budgetLabel = prefs?.budgetLevel || "";
  const accommodationLabel = prefs?.accommodation || "";
  const workModeLabel = prefs?.workMode || "";
  const seasonLine = seasonsCtx?.season || "";

  const convoSnippet = Array.isArray(history)
    ? history
        .slice(-8)
        .filter((m: any) => m.role === "user")
        .map((m: any) => m.content)
        .join("\n")
    : "";

  const messages = [
    {
      role: "system",
      content:
        "You create short, concrete, second-person trip summaries that feel directly tailored to the user’s situation.\n" +
        "Tone & style:\n" +
        "- Informative, grounded, specific, and practical.\n" +
        "- Warm and human, but NOT poetic or abstract.\n" +
        "- Subtle personalization is required—show clearly that the summary reflects *their* input.\n\n" +
        "Rules:\n" +
        "- ALWAYS write in the second person ('you', 'your trip'). Never use 'I' or 'we'.\n" +
        "- One paragraph, 3–4 sentences, ~60–90 words.\n" +
        "- Be concise and concrete: describe the climate, seasonal feel, regions that fit their plan, and how their choices shape the experience.\n" +
        "- Light directional suggestions are allowed (e.g., typical regions for certain activities).\n" +
        "- Do NOT mention packing, gear, lists, or advice.\n" +
        "- No bullets, no headings, no lists.",
    },
    {
      role: "user",
      content:
        `Write a concise, personalized second-person trip summary using the user’s input.\n\n` +
        `Trip details:\n` +
        `- Destinations: ${countries}\n` +
        `- Duration: ${days}\n` +
        `- Period: ${period}\n` +
        `${activities ? `- Activities: ${activities}\n` : ""}` +
        `${travelStyleLabel ? `- Travel style: ${travelStyleLabel}\n` : ""}` +
        `${budgetLabel ? `- Budget: ${budgetLabel}\n` : ""}` +
        `${accommodationLabel ? `- Accommodation: ${accommodationLabel}\n` : ""}` +
        `${workModeLabel ? `- Work mode: ${workModeLabel}\n` : ""}` +
        `${seasonLine ? `- Season context: ${seasonLine}\n` : ""}` +
        (convoSnippet
          ? `\nConversation hints (do NOT quote literally):\n${convoSnippet}\n`
          : "") +
        "\nYour goal:\n" +
        "- Produce a paragraph in the same tone and clarity as this example:\n" +
        '  “Your July trip to Vietnam fits perfectly with the country’s summer patterns: bright weather, warm water and vivid green landscapes. Since you want to surf, head south—Mũi Né and nearby spots have the most reliable conditions this time of year. Staying in hostels there matches your style, giving you easy access to board rentals, group lessons and other travelers on the same route. It creates a relaxed, social rhythm for your entire trip.”\n' +
        "- Follow the same structure: seasonal context + region/activity relevance + how their preferences shape the vibe.\n" +
        "- Adapt all content to the actual user input.",
    },
  ];

  const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL_TEXT,
      temperature: 0.65,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await safeErrorText(res);
    throw new Error(
      `OpenAI tripSummary error: ${res.status}${
        err ? ` — ${err}` : ""
      }`,
    );
  }

  const j = await res.json();
  return j?.choices?.[0]?.message?.content?.trim() || null;
}

async function generateSeasonAdvice(ctx: any, seasonsCtx: any) {
  if (!process.env.OPENAI_API_KEY) return null;

  const countries = listCountries(ctx) || "your destination";
  const period = ctx?.month
    ? `in ${ctx.month}`
    : ctx?.startDate && ctx?.endDate
    ? `from ${ctx.startDate} to ${ctx.endDate}`
    : "at an unspecified time of year";

  const season = seasonsCtx?.season || null;
  const risks = Array.isArray(seasonsCtx?.seasonalRisks)
    ? seasonsCtx.seasonalRisks
    : [];
  const riskSummary = risks
    .map((r: any) => r.type)
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");

  const messages = [
    {
      role: "system",
      content:
        "You write short, concrete, second-person season and weather advice for trips.\n" +
        "- Always answer in clear, natural English.\n" +
        "- 2–3 sentences, one paragraph, no bullets, no headings.\n" +
        "- Focus on climate, typical conditions, and what that means for comfort and safety.\n" +
        "- Mention risks (heat, rain, storms, mosquitoes, altitude, etc.) only if relevant.\n" +
        "- Do NOT talk about packing lists or gear brands; just describe what the season is like and what to be mindful of.",
    },
    {
      role: "user",
      content:
        `Trip details:\n` +
        `- Destinations: ${countries}\n` +
        `- Period: ${period}\n` +
        `${season ? `- Season label: ${season}\n` : ""}` +
        `${riskSummary ? `- Key risks: ${riskSummary}\n` : ""}` +
        `\nWrite a short second-person paragraph that explains what this season is like for a traveller and what they should be aware of.`,
    },
  ];

  const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL_TEXT,
      temperature: 0.65,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await safeErrorText(res);
    throw new Error(
      `OpenAI seasonAdvice error: ${res.status}${
        err ? ` — ${err}` : ""
      }`,
    );
  }

  const j = await res.json();
  return j?.choices?.[0]?.message?.content?.trim() || null;
}

async function generateAndStream({
  controller,
  send,
  req,
  prompt,
  context,
  history,
  lastUserMessage,
  nluHints,
}: {
  controller: ReadableStreamDefaultController;
  send: (event: string, data?: any) => void;
  req: Request;
  prompt: string;
  context: any;
  history: any;
  lastUserMessage: string;
  nluHints: any;
}) {
  // 1) LLM-seizoen (fallback)
  const derived = await derivedContext(context);

  // 2) CSV-seizoen (voorkeur)
  const seasonsCtx = await seasonsContextFor(context);

  // 3) Gecombineerde seizoenscontext:
  //    - eerst CSV.season
  //    - anders LLM.season
  const effectiveSeason =
    (seasonsCtx && seasonsCtx.season) ||
    (derived && derived.season) ||
    null;

  const combinedSeasonsCtx = {
    ...(seasonsCtx || {}),
    season: effectiveSeason,
  };

// seizoenscontext + profile (incl. detected country) naar frontend
send("context", {
  ...derived,
  ...combinedSeasonsCtx,
  profile: context.profile || null,  // 👈 NIEUW
});


  // trip-verhaal (LLM) vroeg uitsturen
  try {
    const summaryText = await generateTripSummary(
      context,
      combinedSeasonsCtx,
      history,
    );
    if (summaryText) {
      send("tripSummary", { text: summaryText });
    }
  } catch (e) {
    // stil falen
  }

  // seizoensadvies (korte uitleg over weer & seizoen)
  try {
    const seasonAdviceText = await generateSeasonAdvice(
      context,
      combinedSeasonsCtx,
    );
    if (seasonAdviceText) {
      send("seasonAdvice", { text: seasonAdviceText });
    }
  } catch (e) {
    // stil falen
  }

  // rationale (debug / sanity)
  try {
    const rationaleText = generateRationale(
      context,
      combinedSeasonsCtx,
    );
    if (rationaleText) send("rationale", { text: rationaleText });
  } catch (e) {}

  const systemExtras = seasonPromptLines(combinedSeasonsCtx);

  send("start", {});
  try {
    const messages = buildMessagesForOpenAI({
      systemExtras,
      prompt,
      history,
      contextSummary: summarizeContext(context),
      lastUserMessage,
      nluHints,
      _ctx: context,
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
    const products = await productsFromCSV(context, req);
    if (Array.isArray(products) && products.length) {
      const batch = 6;
      for (let i = 0; i < Math.min(products.length, 100); i += batch) {
        send("products", products.slice(i, i + batch));
      }
    }
  } catch (e: any) {
    send("products", [
      {
        category: "DEBUG",
        name: `products error: ${(e && e.message) || "unknown"}`,
        weight_grams: null,
        activities: "",
        seasons: "",
        url: "",
        image: "",
      },
    ]);
  }

  // nogmaals context (zodat frontend laatste data heeft)
  send("context", {
    ...derived,
    ...combinedSeasonsCtx,
    profile: context.profile || null,
  });
  send("done", {});
  controller.close();          // 👈 stream netjes sluiten
}                              // 👈 einde generateAndStream


/* -------------------- Context samenvatting -------------------- */

function summarizeContext(ctx: any) {
  const parts: string[] = [];
  if (ctx?.destination?.country)
    parts.push(`land: ${ctx.destination.country}`);
  if (ctx?.destination?.region)
    parts.push(`regio: ${ctx.destination.region}`);
  if (Array.isArray(ctx?.destinations) && ctx.destinations.length) {
    const countries = Array.from(
      new Set(
        ctx.destinations.map((d: any) => d.country).filter(Boolean),
      ),
    );
    if (countries.length) parts.push(`landen: ${countries.join(", ")}`);
  }
  if (ctx?.durationDays) parts.push(`duur: ${ctx.durationDays} dagen`);
  if (ctx?.month) parts.push(`maand: ${ctx.month}`);
  if (ctx?.startDate && ctx?.endDate)
    parts.push(`data: ${ctx.startDate} t/m ${ctx.endDate}`);
  if (
    Array.isArray(ctx?.activities) &&
    ctx.activities.length
  )
    parts.push(`activiteiten: ${ctx.activities.join(", ")}`);
  if (!parts.length) return null;
  return `Bekende context (${parts.join(
    " • ",
  )}). Gebruik dit impliciet bij je advies als het relevant is.`;
}

function buildMessagesForOpenAI({
  systemExtras = [],
  prompt,
  history,
  contextSummary,
  lastUserMessage,
  nluHints,
  _ctx,
}: {
  systemExtras?: any[];
  prompt: string;
  history: any;
  contextSummary: string | null;
  lastUserMessage: string;
  nluHints: any;
  _ctx: any;
}) {
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
      "Geen JSON/code in hoofdtekst. Wees concreet en beknopt; bullets oké.",
    ].join("\n"),
  };

  const policyUnknown = unknownPolicySystem(_ctx, nluHints);

  const approxSystem =
    nluHints?.policy?.allowApproximate ||
    nluHints?.durationPhrase ||
    nluHints?.periodPhrase
      ? [
          {
            role: "system",
            content:
              "Je mag vage tijdsaanduidingen interpreteren (bijv. ‘paar maanden’≈60–90d; ‘rond de jaarwisseling’≈20 dec–10 jan). Vul ontbrekende velden in zonder door te vragen.",
          },
        ]
      : [
          {
            role: "system",
            content:
              "Vage tijdsaanduidingen mag je interpreteren (bijv. ‘paar weekjes’≈14d). Vul ontbrekende velden in zonder door te vragen.",
          },
        ];

  const fewShot = [
    {
      role: "system",
      content: [
        "Voorbeeld interpretaties:",
        "- User: 'ik ga miss mexcio paar weekjes over 2 mnd' → land=Mexico; duur≈14d; vertrek≈over 2 mnd.",
        "- User: 'rond de jaarwisseling naar japan' → periode≈20 dec–10 jan; land=Japan.",
      ].join("\n"),
    },
  ];

  const extras = (systemExtras || []).map((m) => ({
    role: "system",
    content: (m as any).content || m,
  }));
  const ctxMsg = contextSummary
    ? [{ role: "system", content: contextSummary }]
    : [];
  const english = [forceEnglishSystem()];

  if (history && history.length) {
    const hist = history.map((m: any) => ({
      role: m.role,
      content: String(m.content || "").slice(0, 8000),
    }));
    const tail = lastUserMessage
      ? [
          {
            role: "user",
            content: String(lastUserMessage).slice(0, 8000),
          },
        ]
      : [];
    return [
      ...english,
      policyUnknown,
      ...fewShot,
      ...approxSystem,
      ...extras,
      baseSystem,
      ...ctxMsg,
      ...hist,
      ...tail,
    ];
  }

  return [
    ...english,
    policyUnknown,
    ...fewShot,
    ...approxSystem,
    ...extras,
    baseSystem,
    ...ctxMsg,
    { role: "user", content: prompt },
  ];
}

/* -------------------- CSV producten -------------------- */

const CSV_PUBLIC_PATH = "/pack_products.csv"; // fallback-pad

function googleSheetToCsv(url: string) {
  try {
    const u = new URL(url);
    if (!/docs\.google\.com/.test(u.host)) return url;
    const parts = u.pathname.split("/");
    const fileIdIdx = parts.indexOf("d") + 1;
    const fileId = parts[fileIdIdx];
    const gid = u.searchParams.get("gid") || "";
    const base = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`;
    return gid ? `${base}&gid=${gid}` : base;
  } catch {
    return url;
  }
}

function resolveCsvUrl(origin: string) {
  const raw =
    (process.env.PRODUCTS_CSV_URL &&
      String(process.env.PRODUCTS_CSV_URL).trim()) ||
    "";
  if (raw) return googleSheetToCsv(raw);
  return new URL(CSV_PUBLIC_PATH, origin).toString();
}

function getCsvCache() {
  if (!(globalThis as any).__PACKLIST_CSV__) {
    (globalThis as any).__PACKLIST_CSV__ = { rows: null, at: 0 };
  }
  return (globalThis as any).__PACKLIST_CSV__ as {
    rows: any[] | null;
    at: number;
  };
}

/* ---------- Activities NL/EN normalisatie ---------- */

const ACT_SYNONYMS: Record<string, string[]> = {
  surfing: ["surf", "surfen", "surfing"],
  hiking: ["hike", "hiken", "wandelen", "trek", "trekking", "hiking"],
  diving: ["duik", "duiken", "scuba", "diving", "snorkel", "snorkeling"],
  city: ["city", "stad", "citytrip", "urban"],
  camping: ["camping", "kamperen"],
  snow: ["snow", "ski", "skiën", "skien", "snowboard", "winterspor"],
  swimming: ["zwem", "zwemmen", "swim"],
  running: ["hardlopen", "run", "running"],
  climbing: [
    "klim",
    "klimmen",
    "climb",
    "climbing",
    "boulder",
    "boulderen",
  ],
};

function norm(s: any) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function tokenizeCsvList(v: any) {
  if (!v) return [];
  return String(v)
    .split(/[,;|/]+/)
    .map((s) => norm(s))
    .filter(Boolean);
}

function canonActivity(tok: string) {
  const t = norm(tok);
  for (const [canon, syns] of Object.entries(ACT_SYNONYMS)) {
    if (syns.some((w) => t.includes(w))) return canon;
  }
  return t;
}

function canonActivities(list: string[]) {
  const set = new Set<string>();
  for (const t of list) {
    const c = canonActivity(t);
    if (c) set.add(c);
  }
  return set;
}

function anyIntersect(aSet: Set<string>, bSet: Set<string>) {
  for (const a of aSet) if (bSet.has(a)) return true;
  return false;
}

// 🔹 Helper: bereken aanbevolen quantity voor kleding o.b.v. tripduur
function computeQuantityForTrip(days: number | null, p: any): number | null {
  // geen duur bekend óf geen clothing → geen quantity
  if (!days || norm(p.category) !== "clothing") return null;

  const short = p.qty_short ?? null;
  const medium = p.qty_medium ?? null;
  const long = p.qty_long ?? null;

  // als er helemaal geen qty-info in de CSV staat → niks doen
  if (short == null && medium == null && long == null) return null;

  // 0–15 dagen
  if (days <= 15) {
    return short ?? medium ?? long ?? null;
  }

  // 16–30 dagen
  if (days <= 30) {
    return medium ?? long ?? short ?? null;
  }

  // 30+ dagen
  return long ?? medium ?? short ?? null;
}

async function productsFromCSV(ctx: any, req: Request) {
  const origin = new URL(req.url).origin;
  const resolvedUrl = resolveCsvUrl(origin);

  let rows: any[];
  try {
    rows = await loadCsvOnce(origin);
  } catch (e: any) {
    return [
      {
        category: "DEBUG",
        name: `CSV load error: ${(e && e.message) || "unknown"}`,
        weight_grams: null,
        activities: "",
        seasons: "",
        url: resolvedUrl,
        image: "",
      },
    ];
  }

  const ctxActs = canonActivities((ctx?.activities || []).map(String));

  const scored = rows.map((r) => {
    const prodActsArr = tokenizeCsvList(r.activities);
    const prodActs = canonActivities(prodActsArr);
    const isGeneric =
      prodActs.size === 0 ||
      prodActs.has("alle") ||
      prodActs.has("generic");
    const matchesActivity =
      ctxActs.size > 0 && anyIntersect(prodActs, ctxActs);

    let score = 0;
    if (matchesActivity) score += 2;
    if (isGeneric) score += 0;

    const weight =
      Number(
        String(r.weight_grams ?? r.weight ?? "")
          .toString()
          .replace(",", "."),
      ) || 999_999;

    return { row: r, score, isGeneric, matchesActivity, weight };
  });

  const selected = scored.filter((s) => s.isGeneric || s.matchesActivity);

  selected.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.weight !== b.weight) return a.weight - b.weight;
    return String(a.row.name || "").localeCompare(
      String(b.row.name || ""),
    );
  });

  const mapped = selected.map(({ row }) => mapCsvRow(row));
 const days = ctx?.durationDays ?? null;

  const mappedWithQuantity = mapped.map((p) => {
    const quantity = computeQuantityForTrip(days, p);
    return quantity != null ? { ...p, quantity } : p;
  });

  const dedup = dedupeBy(
    mappedWithQuantity,
    (p) => `${p.category}|${p.name}`,
  ).slice(0, 72);

  const debugItem = {
    category: "DEBUG",
    name: `csv=${resolvedUrl} | total=${rows.length} | ctxActs=${[
      ...ctxActs,
    ].join(",")} | out=${dedup.length} (activity+generic)`,
    weight_grams: null,
    activities: "",
    seasons: "",
    url: resolvedUrl,
    image: "",
  };

  return [debugItem, ...dedup];
}

function mapCsvRow(r: any) {
  return {
    category: r.category || "",
    name: r.name || "",
    weight_grams: r.weight_grams
      ? Number(String(r.weight_grams).replace(",", "."))
      : null,
    activities: r.activities || "",
    seasons: r.seasons || "",

    url: r.url || "",
    url_us: r.url_us || r.url || "",
    url_nl: r.url_nl || "",
    image: r.image || "",

    notes: r.notes ?? r.note ?? r.Notes ?? "",
    priority:
      r.priority ??
      r.prio ??
      r.importance ??
      r.tier ??
      r.priority_level ??
      "",
    must_have: r.must_have ?? r.musthave ?? "",
    should_have: r.should_have ?? r.shouldhave ?? "",
    nice_to_have: r.nice_to_have ?? r.nicetohave ?? "",

    // 🔹 NIEUW: quantity velden rechtstreeks uit CSV
    qty_short: r.qty_short ? Number(r.qty_short) : null,
    qty_medium: r.qty_medium ? Number(r.qty_medium) : null,
    qty_long: r.qty_long ? Number(r.qty_long) : null,
  };
}

function dedupeBy<T>(arr: T[], keyFn: (x: T) => string) {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

async function loadCsvOnce(origin: string) {
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

function parseCsv(text: string) {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const out: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row: any = {};
    headers.forEach((h, idx) => (row[h] = cells[idx] ?? ""));
    if ("weight" in row && !("weight_grams" in row))
      row.weight_grams = row.weight;
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
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQ = true;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
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

async function chatJSON(
  system: string,
  user: string,
  jsonSchema: any,
) {
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
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction", schema: jsonSchema, strict: true },
      },
    }),
  });

  if (!res.ok && res.status === 400) {
    res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL_JSON,
        messages: [
          {
            role: "system",
            content:
              "Geef ALLEEN geldige JSON terug, zonder tekst of uitleg.",
          },
          {
            role: "user",
            content: `${system}\n\n${user}\n\nAntwoord uitsluitend met JSON.`,
          },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
  }

  if (!res.ok) {
    const err = await safeErrorText(res);
    throw new Error(
      `OpenAI json error: ${res.status}${err ? ` — ${err}` : ""}`,
    );
  }

  const j = await res.json();
  const txt = j?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

async function safeErrorText(res: Response) {
  try {
    return (await res.text())?.slice(0, 400);
  } catch {
    return "";
  }
}

async function streamOpenAI({
  messages,
  onDelta,
}: {
  messages: any[];
  onDelta: (chunk: string) => void;
}) {
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
  if (!res.ok || !res.body)
    throw new Error(`OpenAI stream error: ${res.status}`);

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
