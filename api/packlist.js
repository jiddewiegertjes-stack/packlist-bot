// app/api/packlist/route.js
export const runtime = "edge";

/**
 * Packlist SSE + Slot-Filling Chat Backend (met CORS/OPTIONS en OpenAI-fallback)
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

function corsHeaders(req) {
  const origin = req.headers.get("origin") || "";
  const allowOrigin = originAllowed(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
      const hasDirectPrompt =
        typeof body?.prompt === "string" && body.prompt.trim().length > 0;

      try {
        // vrije tekst (slot-filling)
        if (!hasDirectPrompt && message) {
          const extracted = await extractSlots({ utterance: message, context: safeContext });
          mergeInto(safeContext, extracted?.context || {});
          const missing = missingSlots(safeContext);

          if (missing.length > 0) {
            const followupQ = await followupQuestion({ missing, context: safeContext });
            send("needs", { missing, contextOut: safeContext });
            send("ask", { question: followupQ, missing });
            send("context", await derivedContext(safeContext));
            controller.close();
            return;
          }

          await generateAndStream({
            controller,
            send,
            prompt: buildPromptFromContext(safeContext),
            context: safeContext,
          });
          return;
        }

        // wizard fallback
        const prompt = hasDirectPrompt ? body.prompt.trim() : buildPromptFromContext(safeContext);
        const missing = missingSlots(safeContext);
        if (!hasDirectPrompt && missing.length > 0) {
          send("needs", { missing, contextOut: safeContext });
          send("context", await derivedContext(safeContext));
          controller.close();
          return;
        }

        await generateAndStream({ controller, send, prompt, context: safeContext });
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
  if (!ctx?.durationDays || ctx.durationDays < 1) missing.push("durationDays");
  if (!ctx?.destination?.country) missing.push("destination.country");
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
  return `Maak een backpack paklijst voor ${days} dagen naar ${where}, ${when}.${acts}`;
}

/* -------------------- Extraction helpers -------------------- */

async function extractSlots({ utterance, context }) {
  const schema = {
    type: "object",
    properties: {
      context: {
        type: "object",
        properties: {
          durationDays: { type: ["integer", "null"] },
          destination: {
            type: "object",
            properties: {
              country: { type: ["string", "null"] },
              region: { type: ["string", "null"] },
            },
            required: ["country", "region"],
          },
          startDate: { type: ["string", "null"] },
          endDate: { type: ["string", "null"] },
          month: { type: ["string", "null"] },
          activities: { type: "array", items: { type: "string" } },
          preferences: {},
        },
        required: ["durationDays", "destination", "startDate", "endDate", "month", "activities", "preferences"],
      },
    },
    required: ["context"],
    additionalProperties: false,
  };

  const sys = [
    "Je bent een NLU-extractor. Geef ALLEEN JSON dat het schema volgt.",
    "Zet maanden om naar kleine letters Nederlands (januari..december).",
    "durationDays is geheel aantal dagen (\"2w\" = 14).",
    "Haal landen/regio's uit de tekst. Activities als lijst, zonder duplicaten.",
    "Als iets niet genoemd is, zet het veld op null (niet raden).",
  ].join(" ");

  const user = [
    `Huidige context (JSON): ${JSON.stringify(context)}`,
    `Nieuwe zin van gebruiker: "${utterance}"`,
    "Update de context velden met wat expliciet gezegd is. Plaats niets dat niet genoemd is.",
  ].join("\n");

  const json = await chatJSON(sys, user, schema);
  return json;
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

async function followupQuestion({ missing, context }) {
  const sys =
    "Je stelt één korte vervolgvraag in het Nederlands om ontbrekende info te verzamelen. Geen uitleg, alleen de vraag.";
  const user = `Ontbrekend: ${missing.join(
    ", "
  )}. Voorbeeld mapping: destination.country = 'naar welk land ga je (regio optioneel)'; period = 'ga je in een specifieke maand of op data?'; durationDays = 'hoeveel dagen?'. Context: ${JSON.stringify(
    context
  )}`;
  const out = await chatText(sys, user);
  return (out || "Welke info mis ik nog?").trim();
}

async function derivedContext(ctx) {
  const sys =
    "Bepaal, indien mogelijk, het seizoen (winter/lente/zomer/herfst of tropisch nat/droog) op basis van land/maand of data. Kort antwoord, alleen het veld 'season'. Geef JSON.";
  const user = `Context: ${JSON.stringify(ctx)}.`;
  const schema = { type: "object", properties: { season: { type: ["string", "null"] } }, required: ["season"] };
  const json = await chatJSON(sys, user, schema);
  return json;
}

/* -------------------- Generate & Stream -------------------- */

async function generateAndStream({ controller, send, prompt, context }) {
  send("context", await derivedContext(context));
  send("start", {});
  try {
    await streamOpenAI({
      prompt,
      onDelta: (chunk) => send("delta", chunk),
    });
  } catch (e) {
    send("error", { message: e?.message || "Fout bij genereren" });
    controller.close();
    return;
  }

  try {
    const products = await suggestProducts(context);
    if (Array.isArray(products) && products.length) send("products", products.slice(0, 24));
  } catch {}

  send("done", {});
  controller.close();
}

async function suggestProducts(ctx) {
  const sys =
    "Je bent een gear advisor. Geef 6-12 korte product-suggesties (geen affiliatelinks) als JSON array met {category,name,weight_grams,activities,seasons,url,image}.";
  const user = `Context: ${JSON.stringify(ctx)}. Doel: backpack paklijst.`;
  const schema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        category: { type: "string" },
        name: { type: "string" },
        weight_grams: { type: "number" },
        activities: { type: "string" },
        seasons: { type: "string" },
        url: { type: "string" },
        image: { type: "string" },
      },
      additionalProperties: false,
    },
  };
  const arr = await chatJSON(sys, user, schema);
  return Array.isArray(arr) ? arr : [];
}

/* -------------------- OpenAI Wrappers (met fallback) -------------------- */

async function chatText(system, user) {
  const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL_TEXT,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const err = await safeErrorText(res);
    throw new Error(`OpenAI text error: ${res.status}${err ? ` — ${err}` : ""}`);
  }

  const json = await res.json();
  return json?.choices?.[0]?.message?.content || "";
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
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction", schema: jsonSchema, strict: true },
      },
    }),
  });

  // fallback naar json_object bij 400
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
              "Geef ALLEEN geldige JSON terug, zonder uitleg. Houd je strikt aan het schema.",
          },
          { role: "user", content: `${system}\n\n${user}\n\nAntwoord enkel met JSON.` },
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
  try {
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

async function safeErrorText(res) {
  try {
    const t = await res.text();
    return t?.slice(0, 400);
  } catch {
    return "";
  }
}

/* -------------------- Stream helper -------------------- */

async function streamOpenAI({ prompt, onDelta }) {
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
      messages: [
        {
          role: "system",
          content:
            "Je schrijft compacte, praktische paklijsten in het Nederlands. Gebruik secties: Korte samenvatting, Kleding, Gear, Gadgets, Health, Tips. Geen disclaimers.",
        },
        { role: "user", content: prompt },
      ],
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
