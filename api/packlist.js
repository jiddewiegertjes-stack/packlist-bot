// pages/api/packlist.js
// Next.js Pages API (Node runtime)
// - Fix voor "Failed to fetch": complete CORS + OPTIONS preflight + SSE headers
// - Conversatiegeheugen via needs.contextOut + readiness gate

// -------- Helpers: CORS & SSE --------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-id");
}
function sseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
}
function sseWrite(res, event, data) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
}
function sseDone(res) {
  sseWrite(res, "done", {});
  res.end();
}

// -------- Mini "session store" (demo) --------
const sessions = new Map();
function defaultCtx() {
  return {
    destinations: [],          // [{ country, region }]
    activities: [],            // ["hiken","duiken",...]
    startDate: null,           // "YYYY-MM-DD"
    endDate: null,             // "YYYY-MM-DD"
    month: null,               // "juli"
    durationDays: null,        // number
    preferences: null,         // vrij veld
  };
}
function getSession(req) {
  const sid = String(req.headers["x-session-id"] || "demo");
  if (!sessions.has(sid)) sessions.set(sid, defaultCtx());
  return { sid, ctx: sessions.get(sid) };
}

// -------- Utils --------
function normalize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function toISO(y, m, d) {
  const year = (+y < 100 ? 2000 + (+y) : +y);
  const month = String(+m).padStart(2, "0");
  const day = String(+d).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function daysBetween(isoA, isoB) {
  try {
    const a = new Date(isoA + "T00:00:00Z").getTime();
    const b = new Date(isoB + "T00:00:00Z").getTime();
    return Math.max(1, Math.round(Math.abs(b - a) / 86400000));
  } catch {
    return null;
  }
}
function mergeArraysUnique(a = [], b = [], keyFn) {
  const seen = new Set();
  const out = [];
  const add = (x) => {
    const k = keyFn ? keyFn(x) : JSON.stringify(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  };
  a.forEach(add); b.forEach(add);
  return out;
}
function deepMergeMemory(target, source) {
  if (!source || typeof source !== "object") return target;
  const out = Array.isArray(target) ? [...target] : { ...(target || {}) };
  for (const k of Object.keys(source)) {
    const sv = source[k];
    const tv = out[k];
    if (Array.isArray(sv)) {
      if (k === "destinations") {
        out[k] = mergeArraysUnique(tv || [], sv, (x) => `${(x.country || "").toLowerCase()}|${(x.region || "").toLowerCase()}`);
      } else if (k === "activities") {
        out[k] = mergeArraysUnique(
          (tv || []).map((x) => String(x).toLowerCase()),
          sv.map((x) => String(x).toLowerCase())
        );
      } else out[k] = sv;
    } else if (sv && typeof sv === "object") {
      out[k] = deepMergeMemory(tv || {}, sv);
    } else if (sv !== null && sv !== undefined) {
      out[k] = sv;
    }
  }
  return out;
}

// -------- Extractie & Readiness --------
const COUNTRY_PATTERNS = [
  { re: /(indonesie|indonesia|indonesië)/, name: "Indonesië" },
  { re: /(maleisie|malaysia|maleisië)/,     name: "Maleisië" },
  { re: /(vietnam)/,                        name: "Vietnam" },
  { re: /(thailand)/,                       name: "Thailand" },
  { re: /(filipijnen|philippines|filippijnen)/, name: "Filipijnen" },
  { re: /(laos)/,                           name: "Laos" },
  { re: /(cambodja|cambodia|kampuchea)/,    name: "Cambodja" },
];
const MONTH_RE = /\b(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\b/;

function extractContext(message) {
  const m = normalize(message);
  const out = {};

  const destHits = COUNTRY_PATTERNS
    .filter((c) => c.re.test(m))
    .map((c) => ({ country: c.name, region: null }));
  if (destHits.length) out.destinations = destHits;

  const acts = [];
  if (/(hike|hiken|trek|wandelen)/.test(m)) acts.push("hiken");
  if (/(duik|duiken|scuba|snorkel)/.test(m)) acts.push("duiken");
  if (/(surf|surfen)/.test(m)) acts.push("surfen");
  if (/(city|stad|citytrip)/.test(m)) acts.push("citytrip");
  if (/(kamperen|camp|tent)/.test(m)) acts.push("kamperen");
  if (acts.length) out.activities = acts;

  const maand = m.match(MONTH_RE);
  if (maand) out.month = maand[1];

  const dateRange = m.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4}).{0,40}?(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dateRange) {
    const [, d1, mo1, y1, d2, mo2, y2] = dateRange;
    out.startDate = toISO(y1, mo1, d1);
    out.endDate   = toISO(y2, mo2, d2);
  }

  const duurD = m.match(/(\d{1,3})\s*(dagen|dgn|dag|d)\b/);
  const duurW = m.match(/(\d{1,2})\s*(weken|wk|w)\b/);
  if (duurD) out.durationDays = Number(duurD[1]);
  else if (duurW) out.durationDays = Number(duurW[1]) * 7;

  return out;
}
function inferDurationIfPossible(ctx) {
  if (ctx.durationDays == null && ctx.startDate && ctx.endDate) {
    const d = daysBetween(ctx.startDate, ctx.endDate);
    if (d) ctx.durationDays = d;
  }
  return ctx;
}
function readiness(ctx) {
  const hasDestination =
    Array.isArray(ctx.destinations) && ctx.destinations.length > 0 && !!ctx.destinations[0]?.country;
  const hasActivities = Array.isArray(ctx.activities) && ctx.activities.length > 0;
  const hasPeriod     = !!ctx.startDate || !!ctx.month;
  const hasDuration   = ctx.durationDays != null || (ctx.startDate && ctx.endDate);
  const missing = [];
  if (!hasDestination) missing.push("bestemming(en)");
  if (!hasActivities)  missing.push("activiteiten");
  if (!hasPeriod)      missing.push("periode (maand of data)");
  if (!hasDuration)    missing.push("totale duur (dagen of start+eind)");
  return { ok: missing.length === 0, missing };
}
function nextQuestion(ctx) {
  const { ok, missing } = readiness(ctx);
  if (ok) return null;
  if (missing.includes("bestemming(en)")) return "Naar welke landen/regio’s ga je precies? Meerdere mag ook.";
  if (missing.includes("periode (maand of data)")) return "Wanneer ga je (een maand of specifieke data)?";
  if (missing.includes("totale duur (dagen of start+eind)")) return "Hoe lang ga je in totaal (aantal dagen of begin- en einddatum)?";
  if (missing.includes("activiteiten")) return "Welke activiteiten wil je doen (bv. hiken, duiken, citytrips)?";
  return "Heb je nog voorkeuren (gewicht, budget, comfort)?";
}
function inferSeason(ctx) {
  const m = (ctx.month || "").toLowerCase();
  if (["juni","juli","augustus"].includes(m)) return "zomer";
  if (["december","januari","februari"].includes(m)) return "winter";
  return null;
}
function summaryKnown(ctx) {
  const bits = [];
  if (ctx.destinations?.length) {
    const names = ctx.destinations.map((d) => d.country).filter(Boolean).join(", ");
    if (names) bits.push(`bestemming: ${names}`);
  }
  if (ctx.activities?.length) bits.push(`activiteiten: ${ctx.activities.join(", ")}`);
  if (ctx.durationDays) bits.push(`duur: ${ctx.durationDays} dagen`);
  else if (ctx.startDate && ctx.endDate) bits.push(`periode: ${ctx.startDate}–${ctx.endDate}`);
  else if (ctx.month) bits.push(`periode: ${ctx.month}`);
  return bits.length ? `Ik heb: ${bits.join("; ")}. ` : "";
}
function suggestProducts(ctx) {
  const out = [];
  if (ctx.activities?.includes("duiken")) out.push({ category: "Duiken", name: "Snorkel + Masker", weight_grams: 450, url: "https://example.com/snorkel" });
  if (ctx.activities?.includes("hiken"))  out.push({ category: "Hiken",  name: "Lichte regenjas",   weight_grams: 180, url: "https://example.com/regenjas" });
  return out;
}

// -------- Handler --------
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).end("Method Not Allowed");
  }

  try {
    sseHeaders(res);
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const body = req.body || {};
    const userMessage   = String(body.message || "");
    const clientContext = body.context || defaultCtx();

    const { sid, ctx: serverCtx } = getSession(req);

    const extracted = extractContext(userMessage);

    let merged = deepMergeMemory(serverCtx, clientContext);
    merged = deepMergeMemory(merged, extracted);
    merged = inferDurationIfPossible(merged);

    if (Object.keys(extracted).length > 0) {
      sseWrite(res, "needs", { contextOut: extracted });
    }

    const r = readiness(merged);
    if (!r.ok) {
      sseWrite(res, "ask", { question: `${summaryKnown(merged)}${nextQuestion(merged)}` });
      sessions.set(sid, merged);
      return sseDone(res);
    }

    const season = inferSeason(merged);
    if (season) sseWrite(res, "context", { season });

    sseWrite(res, "start", {});

    const destText = merged.destinations.map((d) => d.country).join(", ");
    sseWrite(res, "delta", { text: `Top! Ik onthoud: ${destText}. ` });
    if (merged.activities?.length) sseWrite(res, "delta", { text: `Activiteiten: ${merged.activities.join(", ")}. ` });
    if (merged.durationDays)       sseWrite(res, "delta", { text: `Totale duur: ${merged.durationDays} dagen. ` });
    if (merged.month || (merged.startDate && merged.endDate)) {
      const per = merged.month ? `periode: ${merged.month}` : `periode: ${merged.startDate} t/m ${merged.endDate}`;
      sseWrite(res, "delta", { text: `${per}. ` });
    }

    sseWrite(res, "delta", {
      text: "\n\n**Korte samenvatting**\n- Lichte kleding, regenlaag, daypack 20–30L\n- Snelle drogers, microvezelhanddoek\n- EHBO, DEET, zonnebrand, waterfiltertabletten\n- Wereldstekker, powerbank\n\n**Kleding** - 4–5 shirts, 2 shorts, 1 lange broek, 5–7 sokken/ondergoed\n**Gear** - Daypack, regenhoes, packing cubes\n**Gadgets** - Powerbank, universele stekker, kabels\n**Health** - EHBO, ORS, pleisters, desinfectie\n**Tips** - Reisverzekering, kopieën paspoort, eSIM\n",
    });

    const products = suggestProducts(merged);
    if (products.length) sseWrite(res, "products", products);

    sessions.set(sid, merged);
    sseDone(res);
  } catch (e) {
    try { sseWrite(res, "error", { message: e?.message || "Onbekende fout" }); } catch {}
    res.end();
  }
}
