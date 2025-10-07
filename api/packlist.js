// api/packlist.js
// Node (@vercel/node) — werkt met req/res, geen Edge-streams nodig.

import OpenAI from "openai";

/** ---------- Helpers ---------- **/

function writeSSE(res, event) {
  // event: { event?: string, data?: any, comment?: string }
  if (event.comment) res.write(`: ${event.comment}\n\n`);
  if (event.event) res.write(`event: ${event.event}\n`);
  if (event.data !== undefined) {
    const payload = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
    res.write(`data: ${payload}\n\n`);
  }
}

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CSV_URL = process.env.CSV_URL;

// simpele CSV parser (ondersteunt quotes); voor complexere CSV kun je csv-parse gebruiken.
function parseCsv(text) {
  // Minimal, pragmatic parser (ondersteunt "..." met comma's binnen quotes)
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { rows.push(row); row = []; };

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { pushField(); i++; continue; }
    if (c === "\n") { pushField(); pushRow(); i++; continue; }
    if (c === "\r") { i++; continue; } // ignore CR
    field += c; i++;
  }
  // last field/row
  pushField();
  if (row.length > 1 || (row.length === 1 && row[0] !== "")) pushRow();

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => String(h || "").trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = (r[idx] ?? "").toString().trim()));
    return obj;
  });
}

// Eenvoudige in-memory cache voor CSV
let __csvCache = { at: 0, data: [] };
async function getCsvProducts(force = false) {
  const TTL_MS = 5 * 60 * 1000; // 5 min
  if (!force && Date.now() - __csvCache.at < TTL_MS && __csvCache.data.length) {
    return __csvCache.data;
  }
  if (!CSV_URL) throw new Error("CSV_URL ontbreekt (Vercel env).");
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`CSV download failed: ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);

  // Verwacht kolommen (voorbeeld): category,name,weight_grams,seasons,activities,url,image
  // Je kunt dit hier mappen naar je eigen schema:
  const products = rows.map((r) => ({
    category: r.category || r.Category || "",
    name: r.name || r.Product || r.Title || "",
    weight_grams: Number(r.weight_grams || r.Weight || 0) || 0,
    seasons: (r.seasons || r.Seasons || "all").toLowerCase(),
    activities: (r.activities || r.Activities || "").toLowerCase(),
    url: r.url || r.Link || r.URL || "",
    image: r.image || r.Image || "",
    raw: r
  }));

  __csvCache = { at: Date.now(), data: products };
  return products;
}

function filterProducts(products, { activities = [], season = "all", maxWeight = 4000, durationDays = 7 }) {
  const acts = activities.map((a) => a.toLowerCase());
  const seasonKey = String(season || "all").toLowerCase();

  let list = products.slice();

  // filter op activiteiten (losjes: product.activities bevat 1 van acts)
  if (acts.length) {
    list = list.filter((p) => {
      if (!p.activities) return true; // geen label = algemeen
      return acts.some((a) => p.activities.includes(a));
    });
  }

  // filter op season (losjes)
  if (seasonKey !== "all") {
    list = list.filter((p) => {
      if (!p.seasons) return true;
      return p.seasons.includes(seasonKey) || p.seasons.includes("all");
    });
  }

  // eenvoudig gewichtslimiet (optioneel)
  if (maxWeight) list = list.filter((p) => p.weight_grams <= maxWeight || !p.weight_grams);

  // sorteer licht → zwaar, prefer matches
  list.sort((a, b) => (a.weight_grams || 999999) - (b.weight_grams || 999999));

  // duration hint (bijv. 3× sokken bij 14 dagen): dit doen we in prompt, niet hier
  return list;
}

/** ---------- Handler ---------- **/

export default async function handler(req, res) {
  // parse body
  let body = {};
  try {
    if (typeof req.body === "string") body = JSON.parse(req.body || "{}");
    else body = req.body || {};
  } catch {
    body = {};
  }

  // GET = health / hint
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      hint: "POST hiernaartoe met { activities: string[], durationDays: number, season?: 'summer'|'winter'|'shoulder'|'all' } en optioneel ?stream=1"
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const { activities = [], durationDays = 7, season = "all", preferences = {} } = body;
  const wantStream = String(req.query?.stream || req.query?.s || req.query?.mode) === "1";

  try {
    // 1) CSV laden + filteren
    const products = await getCsvProducts();
    const shortlist = filterProducts(products, { activities, season, durationDays });

    // Maak compacte context (truncate om tokenkosten te beperken)
    const productContext = shortlist.slice(0, 60).map((p) => ({
      category: p.category,
      name: p.name,
      weight_grams: p.weight_grams || undefined,
      activities: p.activities || undefined,
      seasons: p.seasons || undefined,
      url: p.url || undefined
    }));

    // 2) OpenAI voorbereiden
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY ontbreekt (Vercel env).");
    }
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const sys = [
      "Je bent een ervaren backpack-expert. Je geeft een minimalistische maar complete paklijst, afgestemd op activiteiten, duur en seizoen.",
      "– Geef concrete aantallen per item (bv. 3× sokken voor 2 weken).",
      "– Houd rekening met gewicht & weer; voorkom overpakken.",
      "– Adviseer ultralight alternatieven waar logisch.",
      "– Verwijs bij producten subtiel naar de `url` als die er is.",
      "– Output: eerst een korte samenvatting (3–5 bullets), daarna een gecategoriseerde lijst.",
    ].join("\n");

    const userMsg = {
      role: "user",
      content: [
        { type: "text", text: `Maak een paklijst.\nDuur: ${durationDays} dagen\nActiviteiten: ${activities.join(", ") || "geen specifieke"}\nSeizoen: ${season}\nVoorkeuren: ${JSON.stringify(preferences)}` },
        { type: "text", text: `Beschikbare producten (max 60):\n${JSON.stringify(productContext).slice(0, 12000)}` }
      ]
    };

    // 3) Niet-streamend pad: eenvoudig te testen/integraal antwoord
    if (!wantStream) {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.5,
        messages: [{ role: "system", content: sys }, userMsg],
      });

      const advice = completion.choices?.[0]?.message?.content || "";
      return res.status(200).json({
        ok: true,
        advice,
        suggestedProducts: shortlist.slice(0, 30), // stuur top 30 mee (client kan renderen/ deeplinks tonen)
        meta: { model: MODEL }
      });
    }

    // 4) STREAM modus (SSE)
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const heartbeat = setInterval(() => {
      try { writeSSE(res, { comment: "heartbeat" }); } catch {}
    }, 15000);
    const cleanup = () => clearInterval(heartbeat);
    req.on("close", cleanup);
    req.on("aborted", cleanup);

    writeSSE(res, { event: "start", data: { activities, durationDays, season, model: MODEL } });
    writeSSE(res, { event: "context", data: { products: productContext.slice(0, 20) } }); // kleine voorproef

    const stream = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.5,
      stream: true,
      messages: [{ role: "system", content: sys }, userMsg],
    });

    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content;
      if (delta) writeSSE(res, { event: "delta", data: delta });
    }

    writeSSE(res, { event: "products", data: shortlist.slice(0, 30) });
    writeSSE(res, { event: "done", data: { ok: true } });
    res.end();
  } catch (err) {
    const message = err?.message || "unknown error";
    if (wantStream) {
      writeSSE(res, { event: "error", data: { message } });
      try { res.end(); } catch {}
      return;
    }
    return res.status(500).json({ ok: false, error: message });
  }
}
