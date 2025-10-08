// app/api/packlist/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------------- CORS ---------------- */
function buildCorsHeaders(req) {
  const origin = req.headers.get("origin") || "*";
  const reqHdr = req.headers.get("access-control-request-headers");
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS,HEAD",
    "Access-Control-Allow-Headers": reqHdr || "Content-Type, Authorization, Accept",
    "Access-Control-Max-Age": "86400",
  };
}
function withCors(req, init = {}) {
  const headers = new Headers(init.headers || {});
  Object.entries(buildCorsHeaders(req)).forEach(([k, v]) => headers.set(k, v));
  return new Response(init.body ?? null, { ...init, headers });
}

/* ---------------- SSE ---------------- */
function sseEncode(event) {
  let s = "";
  if (event.comment) s += `: ${event.comment}\n`;
  if (event.event) s += `event: ${event.event}\n`;
  if (event.data !== undefined) {
    const payload = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
    s += `data: ${payload}\n`;
  }
  return s + "\n";
}
function sseHeaders(req) {
  return {
    ...buildCorsHeaders(req),
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

/* ---------------- Config ---------------- */
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CSV_URL = process.env.CSV_URL;
const SEASONS_URL = process.env.SEASONS_URL || null;

/* ---------------- CSV mini parser ---------------- */
function parseCsv(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  const pf = () => { row.push(field); field = ""; };
  const pr = () => { rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { pf(); i++; continue; }
    if (c === "\n") { pf(); pr(); i++; continue; }
    if (c === "\r") { i++; continue; }
    field += c; i++;
  }
  pf(); if (row.length > 1 || (row.length === 1 && row[0] !== "")) pr();
  if (!rows.length) return [];
  const hdr = rows[0].map((h) => String(h || "").trim());
  return rows.slice(1).map((r) => Object.fromEntries(hdr.map((h, j) => [h, (r[j] ?? "").toString().trim()])));
}

/* ---------------- Products ---------------- */
let __csvCache = { at: 0, data: [] };
async function getCsvProducts(force = false) {
  const TTL = 5 * 60 * 1000;
  if (!force && Date.now() - __csvCache.at < TTL && __csvCache.data.length) return __csvCache.data;
  if (!CSV_URL) throw new Error("CSV_URL ontbreekt in env.");
  const r = await fetch(CSV_URL);
  if (!r.ok) throw new Error(`CSV download failed: ${r.status} ${r.statusText}`);
  const text = await r.text();
  const rows = parseCsv(text);
  const products = rows.map((r) => ({
    category: r.category || r.Category || "",
    name: r.name || r.Product || r.Title || "",
    weight_grams: Number(r.weight_grams || r.Weight || 0) || 0,
    seasons: (r.seasons || r.Seasons || "all").toLowerCase(),
    activities: (r.activities || r.Activities || "").toLowerCase(),
    url: r.url || r.Link || r.URL || "",
    image: r.image || r.Image || "",
    raw: r,
  }));
  __csvCache = { at: Date.now(), data: products };
  return products;
}
function filterProducts(products, { activities = [], season = "all", maxWeight = 4000 }) {
  const acts = activities.map((a) => a.toLowerCase());
  const seasonKey = String(season || "all").toLowerCase();
  let list = products.slice();
  if (acts.length) list = list.filter((p) => !p.activities || acts.some((a) => p.activities.includes(a)));
  if (seasonKey !== "all") list = list.filter((p) => !p.seasons || p.seasons.includes(seasonKey) || p.seasons.includes("all"));
  if (maxWeight) list = list.filter((p) => p.weight_grams <= maxWeight || !p.weight_grams);
  list.sort((a, b) => (a.weight_grams || 999999) - (b.weight_grams || 999999));
  return list;
}

/* ---------------- Seasons (optional) ---------------- */
let __seasonsCache = { at: 0, data: null };
async function loadSeasons(force = false) {
  if (!SEASONS_URL) return null;
  const TTL = 5 * 60 * 1000;
  if (!force && __seasonsCache.data && Date.now() - __seasonsCache.at < TTL) return __seasonsCache.data;
  const r = await fetch(SEASONS_URL);
  if (!r.ok) throw new Error(`SEASONS_URL fetch failed: ${r.status} ${r.statusText}`);
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  let data;
  if (ct.includes("application/json")) data = await r.json();
  else {
    const text = await r.text();
    data = normalizeSeasonsCSV(parseCsv(text));
  }
  __seasonsCache = { at: Date.now(), data };
  return data;
}
function normalizeSeasonsCSV(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const country = (r.country || r.Country || "").trim();
    const region = (r.region || r.Region || "").trim() || null;
    const months = String(r.months || r.Months || "")
      .split("|")
      .map((s) => parseInt(String(s).trim(), 10))
      .filter(Boolean);
    const season = (r.season || r.Season || "").trim().toLowerCase() || "all";
    if (!country || !months.length) continue;
    const key = country.toLowerCase() + "||" + (region ? region.toLowerCase() : "");
    if (!byKey.has(key)) byKey.set(key, { country, region, rules: [] });
    byKey.get(key).rules.push({ months, season });
  }
  return Array.from(byKey.values());
}
function monthFromDate(iso) { try { return iso ? new Date(iso).getUTCMonth() + 1 : null; } catch { return null; } }
function inferSeasonForTrip({ seasonsData, country, region, startDate, endDate }) {
  if (!seasonsData || !country) return "all";
  const mm = monthFromDate(startDate || endDate);
  if (!mm) return "all";
  const lcC = country.toLowerCase();
  const lcR = region ? region.toLowerCase() : null;
  const match =
    (lcR && seasonsData.find((s) => s.country?.toLowerCase() === lcC && s.region?.toLowerCase() === lcR)) ||
    seasonsData.find((s) => s.country?.toLowerCase() === lcC && !s.region);
  const found = match?.rules?.find((r) => r.months?.includes(mm));
  return found?.season || "all";
}

/* ---------------- Time utils ---------------- */
function safeDateISO(d) {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0"), day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function diffDaysInclusive(aISO, bISO) {
  const a = new Date(aISO), b = new Date(bISO);
  const utcA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const utcB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.max(1, Math.round((utcB - utcA) / 86400000) + 1);
}
function parseMonthName(nl) {
  const t = (nl || "").toLowerCase().trim();
  const map = {
    jan: 1, januari: 1, feb: 2, februari: 2, mrt: 3, maart: 3, apr: 4, april: 4,
    mei: 5, jun: 6, juni: 6, jul: 7, juli: 7, aug: 8, augustus: 8, sep: 9, sept: 9, september: 9,
    okt: 10, oktober: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  return map[t] || null;
}

/* ---------------- Regex extractie (fallback vóór LLM) ---------------- */
function regexExtract(prompt) {
  const p = prompt.replace(/\s+/g, " ").trim().toLowerCase();

  // duur
  let durationDays = null;
  const mDays = p.match(/(\d+)\s*(dag|dagen)\b/);
  const mWeeks = p.match(/(\d+)\s*(week|weken)\b/);
  const mMonths = p.match(/(\d+)\s*(maand|maanden)\b/);
  if (mDays) durationDays = parseInt(mDays[1], 10);
  else if (mWeeks) durationDays = parseInt(mWeeks[1], 10) * 7;
  else if (mMonths) durationDays = parseInt(mMonths[1], 10) * 30;

  // maand
  let month = null;
  const allMonths = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december",
    "jan","feb","mrt","apr","jun","jul","aug","sep","sept","okt","nov","dec"];
  for (const m of allMonths) {
    if (p.includes(` ${m} `) || p.endsWith(` ${m}`)) { month = m; break; }
  }

  // data (dd-mm-yyyy / dd/mm/yyyy)
  let startDate = null, endDate = null;
  const mDate = p.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (mDate) {
    const d = parseInt(mDate[1], 10), mo = parseInt(mDate[2], 10), y = parseInt(mDate[3].length === 2 ? "20"+mDate[3] : mDate[3], 10);
    startDate = safeDateISO(new Date(Date.UTC(y, mo - 1, d)));
  }

  // bestemming "naar X" / "in X"
  let country = null;
  const mDest = p.match(/(?:naar|richting|to)\s+([a-zà-ÿ'’\-\s]+)/i) || p.match(/(?:in)\s+([a-zà-ÿ'’\-\s]+)/i);
  if (mDest) {
    // pak tot aan eerste punt/comma/voorzetsel
    country = mDest[1].split(/[,.;]| met | voor | en /)[0].trim();
    country = country.replace(/\s{2,}/g, " ").trim();
    if (country) country = country.replace(/^\bde\b\s+/i, ""); // "de VS" → "VS" (grove)
  }

  // activiteiten (lichte set)
  const actLex = ["hike","hiken","wandelen","trekking","duiken","snorkelen","surfen","skiën","kamperen","backpacken","klimmen","trailrun"];
  const activities = actLex.filter((w) => p.includes(w)).map((w) => w.replace("hike","hiken"));

  return {
    destination: { country: country || null, region: null },
    durationDays: durationDays || null,
    startDate, endDate, month,
    activities,
    preferences: null,
  };
}

/* ---------------- LLM helpers ---------------- */
async function extractTripFactsWithLLM(openai, prompt) {
  const sys = `Je krijgt een Nederlandse prompt over een reis. Antwoord ALLEEN met JSON.
Velden:
- destination: { country: string|null, region: string|null }
- durationDays: int|null
- startDate: YYYY-MM-DD|null
- endDate: YYYY-MM-DD|null
- month: string|null
- activities: string[]
- preferences: object|null`;
  const user = `Prompt: """${prompt}"""`;
  const r = await openai.chat.completions.create({
    model: MODEL, temperature: 0,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
  });
  try { return JSON.parse(r.choices?.[0]?.message?.content?.trim() || "{}"); }
  catch { return {}; }
}

function mergeContext(a = {}, b = {}) {
  return {
    destination: {
      country: a?.destination?.country || b?.destination?.country || null,
      region: a?.destination?.region || b?.destination?.region || null,
    },
    startDate: a?.startDate || b?.startDate || null,
    endDate: a?.endDate || b?.endDate || null,
    durationDays: a?.durationDays || b?.durationDays || null,
    month: a?.month || b?.month || null,
    activities: Array.from(new Set([...(a?.activities || []), ...(b?.activities || [])])),
    preferences: { ...(b?.preferences || {}), ...(a?.preferences || {}) },
  };
}
function normalizeDates(ctx) {
  let { startDate, endDate, durationDays, month } = ctx;
  if (startDate && durationDays && !endDate) {
    const s = new Date(startDate); endDate = safeDateISO(new Date(s.getTime() + (durationDays - 1) * 86400000));
  } else if (endDate && durationDays && !startDate) {
    const e = new Date(endDate); startDate = safeDateISO(new Date(e.getTime() - (durationDays - 1) * 86400000));
  } else if (!startDate && !endDate && durationDays && month) {
    const m = parseMonthName(month); if (m) {
      const now = new Date(); const thisM = now.getUTCMonth() + 1;
      const year = m <= thisM ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
      const s = new Date(Date.UTC(year, m - 1, 1));
      const e = new Date(s.getTime() + (durationDays - 1) * 86400000);
      startDate = safeDateISO(s); endDate = safeDateISO(e);
    }
  }
  const dur = durationDays || (startDate && endDate ? diffDaysInclusive(startDate, endDate) : undefined);
  return { ...ctx, startDate, endDate, durationDays: dur };
}

/* ✅ Losser: genoeg als (bestemming) én (duur OF datumcombi OF maand+duur); maand zonder duur → default 14 */
function fillDefaultsAndFindMissing(ctx) {
  const out = { ...ctx };
  const hasDest = !!out?.destination?.country;
  const hasDur = !!out?.durationDays;
  const hasStart = !!out?.startDate;
  const hasEnd = !!out?.endDate;
  const hasMonth = !!out?.month;

  if (!hasDur && hasMonth) out.durationDays = 14; // default

  const okTime =
    out.durationDays ||
    (hasStart && hasEnd) ||
    (hasStart && out.durationDays) ||
    (hasMonth && out.durationDays);

  const missing = [];
  if (!hasDest) missing.push("destination.country");
  if (!okTime) missing.push("period");

  return { ctx: out, missing };
}

function followUpText(missing) {
  const parts = [];
  if (missing.includes("destination.country")) parts.push("land (en evt. regio)");
  if (missing.includes("period")) parts.push("duur + (startdatum of maand)");
  return `Helder! Kun je nog aangeven: ${parts.join(" en ")}? Bijvoorbeeld: "20 dagen in juli naar Indonesië".`;
}

/* ---------------- System prompt advies ---------------- */
const SYS_ADVICE = String.raw`Je bent een ervaren backpack-expert. Je maakt een minimalistische maar complete paklijst
die rekening houdt met duur, bestemming(en), activiteiten en seizoen. Schrijf in het Nederlands.

1) **Korte samenvatting** – 3–5 bullets met omstandigheden en strategie.
2) **De paklijst** – secties **Kleding**, **Gear**, **Gadgets**, **Health**, **Tips** met concrete items en aantallen.
Alleen Markdown. Stream complete zinnen/bullets.`;

/* ---------------- Routes ---------------- */
export async function OPTIONS(req) { return withCors(req, { status: 204 }); }
export async function GET(req) {
  return withCors(req, {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, hint: "POST { prompt, context? }  (stream met ?stream=1). Back-compat: { activities, durationDays, season }." }),
  });
}

export async function POST(req) {
  const url = new URL(req.url);
  const wantStream = url.searchParams.get("stream") === "1" || url.searchParams.get("s") === "1";
  let body = {}; try { body = await req.json(); } catch { body = {}; }

  /* ---------- Prompt-modus ---------- */
  if (typeof body?.prompt === "string" && body.prompt.trim()) {
    if (!process.env.OPENAI_API_KEY)
      return withCors(req, { status: 500, body: JSON.stringify({ ok: false, error: "OPENAI_API_KEY ontbreekt in env." }) });

    let OpenAI; try { ({ default: OpenAI } = await import("openai")); }
    catch (e) { return withCors(req, { status: 500, body: JSON.stringify({ ok: false, error: "OPENAI_PKG_ERROR", details: String(e?.message || e) }) }); }
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const userPrompt = body.prompt.trim();
    const ctxClient = body.context || {};

    // ⛳ 1) regex → 2) LLM → 3) merge met client
    const rx = regexExtract(userPrompt);
    const llm = await extractTripFactsWithLLM(openai, userPrompt);
    const merged = mergeContext(mergeContext(ctxClient, rx), llm);

    // normaliseer & defaults/missing
    const norm = normalizeDates(merged);
    const { ctx: ready, missing } = fillDefaultsAndFindMissing(norm);

    if (!wantStream) {
      if (missing.length) {
        return withCors(req, {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ok: true, needs: { missing, contextOut: ready } }),
        });
      }
      // advies + producten (1-shot)
      try {
        const seasonsData = await loadSeasons().catch(() => null);
        const derivedSeason = inferSeasonForTrip({
          seasonsData, country: ready?.destination?.country, region: ready?.destination?.region,
          startDate: ready?.startDate, endDate: ready?.endDate,
        }) || "all";

        const products = await getCsvProducts();
        const shortlist = filterProducts(products, { activities: ready.activities || [], season: derivedSeason, maxWeight: 4000 });

        const productContext = shortlist.slice(0, 60).map((p) => ({
          category: p.category, name: p.name, weight_grams: p.weight_grams || undefined,
          activities: p.activities || undefined, seasons: p.seasons || undefined, url: p.url || undefined,
        }));
        const userContent =
          `Maak een paklijst.\n` +
          `Bestemming: ${ready?.destination?.country || "-"}${ready?.destination?.region ? " - " + ready?.destination?.region : ""}\n` +
          `Periode: ${ready?.startDate || "?"} t/m ${ready?.endDate || "?"} (${ready?.durationDays || "?"} dagen)\n` +
          `Afgeleid seizoen: ${derivedSeason}\n` +
          `Activiteiten: ${(ready.activities || []).join(", ") || "geen"}\n` +
          `Voorkeuren: ${JSON.stringify(ready.preferences || {})}\n\n` +
          `Beschikbare producten (max 60):\n` + `${JSON.stringify(productContext).slice(0, 12000)}\n`;

        const r = await openai.chat.completions.create({
          model: MODEL, temperature: 0.5,
          messages: [{ role: "system", content: SYS_ADVICE }, { role: "user", content: userContent }],
        });
        const advice = r.choices?.[0]?.message?.content || "";
        return withCors(req, {
          status: 200, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ok: true, advice, suggestedProducts: shortlist.slice(0, 30), meta: { model: MODEL } }),
        });
      } catch (e) {
        return withCors(req, { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "OPENAI_ERROR", details: String(e?.message || e) }) });
      }
    }

    // ---------- STREAM ----------
    const stream = new ReadableStream({
      start: async (controller) => {
        const enc = new TextEncoder();
        const write = (evt) => controller.enqueue(enc.encode(sseEncode(evt)));
        const hb = setInterval(() => { try { write({ comment: "heartbeat" }); } catch {} }, 15000);
        const close = () => { try { clearInterval(hb); } catch {} };

        try {
          write({ comment: "connected" });
          const { ctx: ready2, missing: miss2 } = fillDefaultsAndFindMissing(normalizeDates(merged));

          write({ event: "start", data: { model: MODEL, missing: miss2 } });

          if (miss2.length) {
            write({ event: "delta", data: { text: `\n${followUpText(miss2)}\n` } });
            write({ event: "needs", data: { missing: miss2, contextOut: ready2 } });
            write({ event: "done", data: { ok: true } });
            controller.close(); close(); return;
          }

          // seasons
          let derivedSeason = "all";
          try {
            const seasonsData = await loadSeasons();
            derivedSeason = inferSeasonForTrip({
              seasonsData, country: ready2?.destination?.country, region: ready2?.destination?.region,
              startDate: ready2?.startDate, endDate: ready2?.endDate,
            }) || "all";
          } catch { derivedSeason = "all"; }

          // producten
          let shortlist = [];
          try {
            const products = await getCsvProducts();
            shortlist = filterProducts(products, { activities: ready2.activities || [], season: derivedSeason, maxWeight: 4000 });
          } catch (e) {
            write({ event: "error", data: { message: "CSV_ERROR", details: String(e?.message || e) } });
            controller.close(); close(); return;
          }

          const productContext = shortlist.slice(0, 60).map((p) => ({
            category: p.category, name: p.name, weight_grams: p.weight_grams || undefined,
            activities: p.activities || undefined, seasons: p.seasons || undefined, url: p.url || undefined,
          }));
          const userContent =
            `Maak een paklijst.\n` +
            `Bestemming: ${ready2?.destination?.country || "-"}${ready2?.destination?.region ? " - " + ready2?.destination?.region : ""}\n` +
            `Periode: ${ready2?.startDate || "?"} t/m ${ready2?.endDate || "?"} (${ready2?.durationDays || "?"} dagen)\n` +
            `Afgeleid seizoen: ${derivedSeason}\n` +
            `Activiteiten: ${(ready2.activities || []).join(", ") || "geen"}\n` +
            `Voorkeuren: ${JSON.stringify(ready2.preferences || {})}\n\n` +
            `Beschikbare producten (max 60):\n` + `${JSON.stringify(productContext).slice(0, 12000)}\n`;

          write({ event: "context", data: { products: productContext.slice(0, 20), season: derivedSeason } });

          let OpenAI; ({ default: OpenAI } = await import("openai"));
          const openai2 = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          const resp = await openai2.chat.completions.create({
            model: MODEL, temperature: 0.5, stream: true,
            messages: [{ role: "system", content: SYS_ADVICE }, { role: "user", content: userContent }],
          });

          for await (const part of resp) {
            const delta = part.choices?.[0]?.delta?.content;
            if (delta) write({ event: "delta", data: delta });
          }

          write({ event: "products", data: shortlist.slice(0, 30) });
          write({ event: "done", data: { ok: true } });
          controller.close(); close();
        } catch (e) {
          try { controller.enqueue(new TextEncoder().encode(sseEncode({ event: "error", data: { message: String(e?.message || e) } }))); }
          finally { controller.close(); }
        }
      },
    });

    return new Response(stream, { status: 200, headers: sseHeaders(req) });
  }

  /* ---------- Legacy pad (activities/duration/season) ---------- */
  const { activities = [], durationDays = 7, season = "all", preferences = {} } = body;
  try {
    const products = await getCsvProducts();
    const shortlist = filterProducts(products, { activities, season, maxWeight: 4000 });

    if (!process.env.OPENAI_API_KEY)
      return withCors(req, { status: 500, body: JSON.stringify({ ok: false, error: "OPENAI_API_KEY ontbreekt in env." }) });

    let OpenAI; ({ default: OpenAI } = await import("openai"));
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const productContext = shortlist.slice(0, 60).map((p) => ({
      category: p.category, name: p.name, weight_grams: p.weight_grams || undefined,
      activities: p.activities || undefined, seasons: p.seasons || undefined, url: p.url || undefined,
    }));
    const userContent =
      `Maak een paklijst.\nDuur: ${durationDays} dagen\nActiviteiten: ${activities.join(", ") || "geen"}\nSeizoen: ${season}\nVoorkeuren: ${JSON.stringify(preferences)}\n\nBeschikbare producten (max 60):\n${JSON.stringify(productContext).slice(0, 12000)}\n`;

    if (wantStream) {
      const stream = new ReadableStream({
        start: async (controller) => {
          const write = (evt) => controller.enqueue(new TextEncoder().encode(sseEncode(evt)));
          const hb = setInterval(() => { try { write({ comment: "heartbeat" }); } catch {} }, 15000);
          const close = () => { try { clearInterval(hb); } catch {} };
          try {
            write({ event: "start", data: { activities, durationDays, season, model: MODEL } });
            write({ event: "context", data: { products: productContext.slice(0, 20) } });
            const resp = await openai.chat.completions.create({
              model: MODEL, temperature: 0.5, stream: true,
              messages: [{ role: "system", content: SYS_ADVICE }, { role: "user", content: userContent }],
            });
            for await (const part of resp) {
              const delta = part.choices?.[0]?.delta?.content;
              if (delta) write({ event: "delta", data: delta });
            }
            write({ event: "products", data: shortlist.slice(0, 30) });
            write({ event: "done", data: { ok: true } });
            controller.close(); close();
          } catch (e) {
            write({ event: "error", data: { message: String(e?.message || e) } });
            controller.close(); close();
          }
        },
      });
      return new Response(stream, { status: 200, headers: sseHeaders(req) });
    } else {
      const r = await openai.chat.completions.create({
        model: MODEL, temperature: 0.5,
        messages: [{ role: "system", content: SYS_ADVICE }, { role: "user", content: userContent }],
      });
      const advice = r.choices?.[0]?.message?.content || "";
      return withCors(req, {
        status: 200, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, advice, suggestedProducts: shortlist.slice(0, 30), meta: { model: MODEL } }),
      });
    }
  } catch (e) {
    return withCors(req, { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "SERVER_ERROR", details: String(e?.message || e) }) });
  }
}
