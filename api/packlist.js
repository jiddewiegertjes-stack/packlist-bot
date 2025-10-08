// api/packlist.js  (CommonJS, Vercel/Node)

/* ---------------- SSE & CORS ---------------- */
function writeSSE(res, event) {
  if (event.comment) res.write(`: ${event.comment}\n\n`);
  if (event.event)   res.write(`event: ${event.event}\n`);
  if (event.data !== undefined) {
    const payload = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
    res.write(`data: ${payload}\n\n`);
  }
}
const setCors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // in prod: whitelist je domein
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
};

/* ---------------- Config ---------------- */
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CSV_URL = process.env.CSV_URL;
const SEASONS_URL = process.env.SEASONS_URL || null;

/* ---------------- CSV utils ---------------- */
function parseCsv(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow   = () => { rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { pushField(); i++; continue; }
    if (c === "\n") { pushField(); pushRow(); i++; continue; }
    if (c === "\r") { i++; continue; }
    field += c; i++;
  }
  pushField(); if (row.length > 1 || (row.length === 1 && row[0] !== "")) pushRow();
  if (!rows.length) return [];
  const headers = rows[0].map(h => String(h || "").trim());
  return rows.slice(1).map(r => {
    const o = {}; headers.forEach((h, idx) => o[h] = (r[idx] ?? "").toString().trim()); return o;
  });
}

/* ---------------- Producten ---------------- */
let __csvCache = { at: 0, data: [] };
async function getCsvProducts(force = false) {
  const TTL_MS = 5 * 60 * 1000;
  if (!force && Date.now() - __csvCache.at < TTL_MS && __csvCache.data.length) return __csvCache.data;
  if (!CSV_URL) throw new Error("CSV_URL ontbreekt in env.");
  const r = await fetch(CSV_URL);
  if (!r.ok) throw new Error(`CSV download failed: ${r.status} ${r.statusText}`);
  const text = await r.text();
  const rows = parseCsv(text);
  const products = rows.map(r => ({
    category: r.category || r.Category || "",
    name:     r.name || r.Product || r.Title || "",
    weight_grams: Number(r.weight_grams || r.Weight || 0) || 0,
    seasons:  (r.seasons || r.Seasons || "all").toLowerCase(),
    activities: (r.activities || r.Activities || "").toLowerCase(),
    url:      r.url || r.Link || r.URL || "",
    image:    r.image || r.Image || "",
    raw:      r
  }));
  __csvCache = { at: Date.now(), data: products };
  return products;
}
function filterProducts(products, { activities = [], season = "all", maxWeight = 4000 }) {
  const acts = activities.map(a => a.toLowerCase());
  const seasonKey = String(season || "all").toLowerCase();
  let list = products.slice();
  if (acts.length) {
    list = list.filter(p => !p.activities || acts.some(a => p.activities.includes(a)));
  }
  if (seasonKey !== "all") {
    list = list.filter(p => !p.seasons || p.seasons.includes(seasonKey) || p.seasons.includes("all"));
  }
  if (maxWeight) list = list.filter(p => p.weight_grams <= maxWeight || !p.weight_grams);
  list.sort((a, b) => (a.weight_grams || 999999) - (b.weight_grams || 999999));
  return list;
}

/* ---------------- Seizoenen (optioneel) ---------------- */
let __seasonsCache = { at: 0, data: null };
async function loadSeasons(force = false) {
  if (!SEASONS_URL) return null;
  const TTL_MS = 5 * 60 * 1000;
  if (!force && __seasonsCache.data && Date.now() - __seasonsCache.at < TTL_MS) return __seasonsCache.data;
  const r = await fetch(SEASONS_URL);
  if (!r.ok) throw new Error(`SEASONS_URL fetch failed: ${r.status} ${r.statusText}`);
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  let data;
  if (ct.includes("application/json")) {
    data = await r.json();
  } else {
    const text = await r.text();
    // CSV: country,region,months,season   (months e.g. "6|7|8")
    data = normalizeSeasonsCSV(parseCsv(text));
  }
  __seasonsCache = { at: Date.now(), data };
  return data;
}
function normalizeSeasonsCSV(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const country = (r.country || r.Country || "").trim();
    const region  = (r.region || r.Region || "").trim() || null;
    const months  = String(r.months || r.Months || "")
      .split("|").map(s => parseInt(String(s).trim(), 10)).filter(Boolean);
    const season  = (r.season || r.Season || "").trim().toLowerCase() || "all";
    if (!country || !months.length) continue;
    const key = country.toLowerCase() + "||" + (region ? region.toLowerCase() : "");
    if (!byKey.has(key)) byKey.set(key, { country, region, rules: [] });
    byKey.get(key).rules.push({ months, season });
  }
  return Array.from(byKey.values());
}
function inferSeasonForTrip({ seasonsData, country, region, startDate, endDate }) {
  if (!seasonsData || !country) return "all";
  const mm = monthFromDate(startDate || endDate);
  if (!mm) return "all";
  const lcCountry = country.toLowerCase();
  const lcRegion  = region ? region.toLowerCase() : null;
  let match =
    (lcRegion && seasonsData.find(s => s.country?.toLowerCase() === lcCountry && s.region?.toLowerCase() === lcRegion)) ||
    seasonsData.find(s => s.country?.toLowerCase() === lcCountry && !s.region);
  const rules = match?.rules || [];
  const found = rules.find(r => Array.isArray(r.months) && r.months.includes(mm));
  return found?.season || "all";
}
function monthFromDate(dateISO) {
  if (!dateISO) return null;
  try { return new Date(dateISO).getUTCMonth() + 1; } catch { return null; }
}

/* ---------------- Tijd utils ---------------- */
function safeDateISO(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function diffDaysInclusive(aISO, bISO) {
  const a = new Date(aISO); const b = new Date(bISO);
  const utcA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const utcB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.max(1, Math.round((utcB - utcA) / 86400000) + 1);
}
function parseMonthName(nl) {
  const t = (nl || "").toLowerCase().trim();
  const map = {
    jan:1, januari:1, feb:2, februari:2, mrt:3, maart:3, apr:4, april:4,
    mei:5, jun:6, juni:6, jul:7, juli:7, aug:8, augustus:8, sep:9, sept:9, september:9,
    okt:10, oktober:10, nov:11, november:11, dec:12, december:12
  };
  return map[t] || null;
}

/* ---------------- LLM slot-filling helpers ---------------- */
async function extractTripFactsWithLLM(openai, prompt) {
  const sys = `Je krijgt een Nederlandse prompt over een reis. Antwoord ALLEEN met JSON.
Velden:
- destination: { country: string|null, region: string|null }
- durationDays: int|null
- startDate: YYYY-MM-DD|null
- endDate: YYYY-MM-DD|null
- month: string|null (bv. "juli")
- activities: string[]
- preferences: object|null`;
  const user = `Prompt: """${prompt}"""`;
  const r = await openai.chat.completions.create({
    model: MODEL, temperature: 0, messages: [{ role: "system", content: sys }, { role: "user", content: user }]
  });
  try {
    const txt = r.choices?.[0]?.message?.content?.trim() || "{}";
    return JSON.parse(txt);
  } catch { return {}; }
}
function mergeContext(prev = {}, ext = {}) {
  return {
    destination: {
      country: prev?.destination?.country || ext?.destination?.country || null,
      region:  prev?.destination?.region  || ext?.destination?.region  || null,
    },
    startDate: prev?.startDate || ext?.startDate || null,
    endDate:   prev?.endDate   || ext?.endDate   || null,
    durationDays: prev?.durationDays || ext?.durationDays || null,
    month: prev?.month || ext?.month || null,
    activities: Array.from(new Set([...(prev?.activities || []), ...(ext?.activities || [])])),
    preferences: { ...(ext?.preferences || {}), ...(prev?.preferences || {}) },
  };
}
function findMissing(ctx) {
  const missing = []; const reasons = {};
  if (!ctx?.destination?.country) { missing.push("destination.country"); reasons["destination.country"] = "Land ontbreekt."; }
  const hasDuration = !!ctx?.durationDays, hasStart = !!ctx?.startDate, hasEnd = !!ctx?.endDate, hasMonth = !!ctx?.month;
  if (!((hasDuration && hasStart) || (hasStart && hasEnd) || (hasDuration && hasEnd) || (hasDuration && hasMonth))) {
    missing.push("period"); reasons["period"] = "Geef duur + (startdatum of maand), of start + eind.";
  }
  return { missing, reasons };
}
function normalizeDates(ctx) {
  let { startDate, endDate, durationDays, month } = ctx;
  if (startDate && durationDays && !endDate) {
    const s = new Date(startDate); const e = new Date(s.getTime() + (durationDays - 1) * 86400000);
    endDate = safeDateISO(e);
  } else if (endDate && durationDays && !startDate) {
    const e = new Date(endDate); const s = new Date(e.getTime() - (durationDays - 1) * 86400000);
    startDate = safeDateISO(s);
  } else if (!startDate && !endDate && durationDays && month) {
    const m = parseMonthName(month);
    if (m) {
      const now = new Date(); const thisMonth = now.getUTCMonth() + 1;
      const year = (m <= thisMonth) ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
      const s = new Date(Date.UTC(year, m - 1, 1));
      const e = new Date(s.getTime() + (durationDays - 1) * 86400000);
      startDate = safeDateISO(s); endDate = safeDateISO(e);
    }
  }
  const dur = durationDays || ((startDate && endDate) ? diffDaysInclusive(startDate, endDate) : undefined);
  return { ...ctx, startDate, endDate, durationDays: dur };
}
function buildFollowUpQuestionTemplate(merged, missing) {
  const parts = [];
  if (missing.includes("destination.country")) parts.push("land (en evt. regio)");
  if (missing.includes("period")) parts.push("duur + (startdatum of maand)");
  const need = parts.join(" en ");
  return `Helder! Kun je nog aangeven: ${need}? Bijvoorbeeld: "20 dagen in juli naar Indonesië".`;
}

/* ---------------- SYSTEM PROMPT voor advies ---------------- */
const SYS_ADVICE = String.raw`Je bent een ervaren backpack-expert. Je maakt een minimalistische maar complete paklijst
die rekening houdt met duur, bestemming(en), activiteiten en seizoen. Schrijf in het Nederlands.

=== STRUCTUUR ===
1️⃣ **Korte samenvatting**
- 3–5 bullets met context, omstandigheden, strategie (laagjes/regen/gewicht).
- Geen productlijst hier.

2️⃣ **De paklijst per categorie**
- **Kleding**, **Gear**, **Gadgets**, **Health**, **Tips**
- Concrete items met aantallen, bijv. "- Merino baselayer (2x)"
- 1 lege regel tussen secties. Alleen Markdown, geen HTML.

=== STIJL ===
Kort, concreet, deskundig; geen meta; na leestekens spatie; stream complete zinnen/bullets.`;

/* ---------------- Handler ---------------- */
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  const safeError = (status, message, extra = {}) => {
    try { setCors(res); res.status(status).json({ ok: false, error: message, ...extra }); }
    catch { try { res.end(); } catch {} }
  };

  // Body lezen
  let body = {};
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
  catch { body = {}; }

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      hint: "POST { prompt, context? }  (stream met ?stream=1). Back-compat: { activities, durationDays, season }."
    });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return safeError(405, "Method Not Allowed");
  }

  const wantStream = String(req.query?.stream || req.query?.s || req.query?.mode) === "1";

  /* ---------- PROMPT-MODUS ---------- */
  if (typeof body?.prompt === "string" && body.prompt.trim()) {
    if (!process.env.OPENAI_API_KEY) return safeError(500, "OPENAI_API_KEY ontbreekt in env.");

    // dynamic import (OpenAI v4 SDK) in CommonJS
    let OpenAI;
    try { ({ default: OpenAI } = await import("openai")); }
    catch (e) { return safeError(500, "OPENAI_PKG_ERROR", { details: e.message }); }
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    if (!wantStream) {
      return res.status(200).json({ ok: true, message: "Gebruik ?stream=1 voor SSE prompt-modus." });
    }

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const hb = setInterval(() => { try { writeSSE(res, { comment: "heartbeat" }); } catch {} }, 15000);
    const cleanup = () => { try { clearInterval(hb); } catch {} };
    req.on("close", cleanup); req.on("aborted", cleanup);

    try {
      const userPrompt = body.prompt.trim();
      const ctxIn = body.context || {};

      // 1) extract → merge → missing
      const ext = await extractTripFactsWithLLM(openai, userPrompt);
      const merged = mergeContext(ctxIn, ext);
      const { missing, reasons } = findMissing(merged);

      writeSSE(res, { event: "start", data: { model: MODEL, missing, reasons } });

      if (missing.length) {
        // duidelijke, ééndelige follow-up (geen per-letter)
        const followUp = buildFollowUpQuestionTemplate(merged, missing);
        writeSSE(res, { event: "delta", data: { text: `\n${followUp}\n` } });
        writeSSE(res, { event: "needs", data: { missing, contextOut: merged } });
        writeSSE(res, { event: "done", data: { ok: true } });
        return res.end();
      }

      // 2) compleet → normaliseer
      const norm = normalizeDates(merged);

      // 3) seizoenen (optioneel)
      let derivedSeason = "all";
      try {
        const seasonsData = await loadSeasons();
        derivedSeason = inferSeasonForTrip({
          seasonsData,
          country: norm?.destination?.country,
          region:  norm?.destination?.region,
          startDate: norm?.startDate,
          endDate:   norm?.endDate
        }) || "all";
      } catch { derivedSeason = "all"; }

      // 4) producten
      let products = [], shortlist = [];
      try {
        products = await getCsvProducts();
        shortlist = filterProducts(products, {
          activities: norm.activities || [],
          season: derivedSeason,
          maxWeight: 4000
        });
      } catch (e) {
        writeSSE(res, { event: "error", data: { message: "CSV_ERROR", details: e.message } });
        return res.end();
      }

      // 5) advies streamen
      const productContext = shortlist.slice(0, 60).map(p => ({
        category: p.category, name: p.name, weight_grams: p.weight_grams || undefined,
        activities: p.activities || undefined, seasons: p.seasons || undefined, url: p.url || undefined
      }));
      const userContent =
        `Maak een paklijst.\n` +
        `Bestemming: ${norm?.destination?.country || "-"}${norm?.destination?.region ? " - " + norm?.destination?.region : ""}\n` +
        `Periode: ${norm?.startDate || "?"} t/m ${norm?.endDate || "?"} (${norm?.durationDays || "?"} dagen)\n` +
        `Afgeleid seizoen: ${derivedSeason}\n` +
        `Activiteiten: ${(norm.activities || []).join(", ") || "geen"}\n` +
        `Voorkeuren: ${JSON.stringify(norm.preferences || {})}\n\n` +
        `Beschikbare producten (max 60):\n` +
        `${JSON.stringify(productContext).slice(0, 12000)}\n`;

      writeSSE(res, { event: "context", data: { products: productContext.slice(0, 20), season: derivedSeason } });

      const stream = await openai.chat.completions.create({
        model: MODEL, temperature: 0.5, stream: true,
        messages: [{ role: "system", content: SYS_ADVICE }, { role: "user", content: userContent }]
      });

      for await (const part of stream) {
        const delta = part.choices?.[0]?.delta?.content;
        if (delta) writeSSE(res, { event: "delta", data: delta });
      }

      writeSSE(res, { event: "products", data: shortlist.slice(0, 30) });
      writeSSE(res, { event: "done", data: { ok: true } });
      res.end();
    } catch (e) {
      writeSSE(res, { event: "error", data: { message: e?.message || "Server error (prompt mode)" } });
      try { res.end(); } catch {}
    }
    return;
  }

  /* ---------- OUDE PAD (achterwaarts compatibel) ---------- */
  const { activities = [], durationDays = 7, season = "all", preferences = {} } = body;

  let products, shortlist;
  try {
    products = await getCsvProducts();
    shortlist = filterProducts(products, { activities, season, maxWeight: 4000 });
  } catch (e) {
    return safeError(500, "CSV_ERROR", { details: e.message });
  }

  if (!process.env.OPENAI_API_KEY) return safeError(500, "OPENAI_API_KEY ontbreekt in env.");
  let OpenAI; try { ({ default: OpenAI } = await import("openai")); }
  catch (e) { return safeError(500, "OPENAI_PKG_ERROR", { details: e.message }); }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const productContext = shortlist.slice(0, 60).map(p => ({
    category: p.category, name: p.name, weight_grams: p.weight_grams || undefined,
    activities: p.activities || undefined, seasons: p.seasons || undefined, url: p.url || undefined
  }));
  const userContent =
    `Maak een paklijst.\n` +
    `Duur: ${durationDays} dagen\n` +
    `Activiteiten: ${activities.join(", ") || "geen"}\n` +
    `Seizoen: ${season}\n` +
    `Voorkeuren: ${JSON.stringify(preferences)}\n\n` +
    `Beschikbare producten (max 60):\n` +
    `${JSON.stringify(productContext).slice(0, 12000)}\n`;

  const wantStreamLegacy = wantStream;
  if (!wantStreamLegacy) {
    try {
      const completion = await openai.chat.completions.create({
        model: MODEL, temperature: 0.5,
        messages: [{ role: "system", content: SYS_ADVICE }, { role: "user", content: userContent }]
      });
      const advice = completion.choices?.[0]?.message?.content || "";
      setCors(res);
      return res.status(200).json({ ok: true, advice, suggestedProducts: shortlist.slice(0, 30), meta: { model: MODEL } });
    } catch (e) {
      return safeError(500, "OPENAI_ERROR", { details: e.message });
    }
  }

  // STREAM (legacy)
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const hb = setInterval(() => { try { writeSSE(res, { comment: "heartbeat" }); } catch { } }, 15000);
  const cleanup = () => { try { clearInterval(hb); } catch { } };
  req.on("close", cleanup); req.on("aborted", cleanup);

  try {
    writeSSE(res, { event: "start", data: { activities, durationDays, season, model: MODEL } });
    writeSSE(res, { event: "context", data: { products: productContext.slice(0, 20) } });

    const stream = await openai.chat.completions.create({
      model: MODEL, temperature: 0.5, stream: true,
      messages: [{ role: "system", content: SYS_ADVICE }, { role: "user", content: userContent }]
    });
    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content;
      if (delta) writeSSE(res, { event: "delta", data: delta });
    }

    writeSSE(res, { event: "products", data: shortlist.slice(0, 30) });
    writeSSE(res, { event: "done", data: { ok: true } });
    res.end();
  } catch (e) {
    writeSSE(res, { event: "error", data: { message: e?.message || "Server error" } });
    try { res.end(); } catch {}
  }
};
