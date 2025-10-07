// api/packlist.js  (CommonJS)

function writeSSE(res, event) {
  if (event.comment) res.write(`: ${event.comment}\n\n`);
  if (event.event) res.write(`event: ${event.event}\n`);
  if (event.data !== undefined) {
    const payload = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
    res.write(`data: ${payload}\n\n`);
  }
}

// ✅ CORS helpers (ALTIJD toepassen)
const setCors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // in prod liever je domein whitelisten
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
};

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CSV_URL = process.env.CSV_URL;

function parseCsv(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) { if (c === '"') { if (text[i+1]==='"'){field+='"'; i+=2; continue;} inQuotes=false; i++; continue; } field+=c; i++; continue; }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { pushField(); i++; continue; }
    if (c === "\n") { pushField(); pushRow(); i++; continue; }
    if (c === "\r") { i++; continue; }
    field += c; i++;
  }
  pushField(); if (row.length>1 || (row.length===1 && row[0] !== "")) pushRow();
  if (rows.length === 0) return [];
  const headers = rows[0].map((h)=>String(h||"").trim());
  return rows.slice(1).map((r)=>{ const o={}; headers.forEach((h,idx)=>o[h]=(r[idx]??"").toString().trim()); return o; });
}

let __csvCache = { at: 0, data: [] };
async function getCsvProducts(force=false){
  const TTL_MS = 5*60*1000;
  if(!force && Date.now()-__csvCache.at<TTL_MS && __csvCache.data.length) return __csvCache.data;
  if(!CSV_URL) throw new Error("CSV_URL ontbreekt in env.");
  const r = await fetch(CSV_URL);
  if(!r.ok) throw new Error(`CSV download failed: ${r.status} ${r.statusText}`);
  const text = await r.text();
  const rows = parseCsv(text);
  const products = rows.map((r)=>({
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

function filterProducts(products,{activities=[],season="all",maxWeight=4000}){
  const acts = activities.map((a)=>a.toLowerCase());
  const seasonKey = String(season||"all").toLowerCase();
  let list = products.slice();
  if(acts.length) list = list.filter(p=>!p.activities || acts.some(a=>p.activities.includes(a)));
  if(seasonKey!=="all") list = list.filter(p=>!p.seasons || p.seasons.includes(seasonKey) || p.seasons.includes("all"));
  if(maxWeight) list = list.filter(p=>p.weight_grams <= maxWeight || !p.weight_grams);
  list.sort((a,b)=>(a.weight_grams||999999)-(b.weight_grams||999999));
  return list;
}

module.exports = async (req, res) => {
  // ✅ Altijd CORS zetten
  setCors(res);

  // ✅ Preflight (browser stuurt OPTIONS voor POST)
  if (req.method === "OPTIONS") {
    res.statusCode = 204;  // No Content
    return res.end();
  }

  const safeError = (status, message, extra = {}) => {
    try { setCors(res); res.status(status).json({ ok:false, error: message, ...extra }); }
    catch { try{res.end();}catch{} }
  };

  let body = {};
  try { body = typeof req.body === "string" ? JSON.parse(req.body||"{}") : (req.body||{}); }
  catch { body = {}; }

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      hint: "POST met { activities: string[], durationDays: number, season?: 'summer'|'winter'|'shoulder'|'all' }. Stream met ?stream=1"
    });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow","GET, POST, OPTIONS");
    return safeError(405,"Method Not Allowed");
  }

  const { activities = [], durationDays = 7, season = "all", preferences = {} } = body;
  const wantStream = String(req.query?.stream || req.query?.s || req.query?.mode) === "1";

  let products, shortlist;
  try {
    products = await getCsvProducts();
    shortlist = filterProducts(products, { activities, season, durationDays });
  } catch (e) {
    return safeError(500, "CSV_ERROR", { details: e.message });
  }

  if (!process.env.OPENAI_API_KEY) return safeError(500, "OPENAI_API_KEY ontbreekt in env.");

  let OpenAI;
  try { ({ default: OpenAI } = await import("openai")); }
  catch(e){ return safeError(500,"OPENAI_PKG_ERROR",{ details: e.message }); }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const sys = [
  "Je bent een ervaren backpack-expert. Minimalistische maar complete paklijst per categorie.",
  "– Concrete aantallen per item; rekening met duur, activiteiten en seizoen.",
  "– Lichtgewicht voorkeur; gebruik meegeleverde productcontext met url waar passend.",
  "– Output: korte samenvatting (3–5 bullets) + gecategoriseerde lijst."
].join("\n");

  const productContext = shortlist.slice(0, 60).map((p)=>({
    category:p.category, name:p.name, weight_grams:p.weight_grams||undefined,
    activities:p.activities||undefined, seasons:p.seasons||undefined, url:p.url||undefined
  }));

  const userMsg = {
    role: "user",
    content: [
      { type:"text", text:`Maak een paklijst.\nDuur: ${durationDays} dagen\nActiviteiten: ${activities.join(", ")||"geen"}\nSeizoen: ${season}\nVoorkeuren: ${JSON.stringify(preferences)}` },
      { type:"text", text:`Beschikbare producten (max 60):\n${JSON.stringify(productContext).slice(0,12000)}` }
    ]
  };

  if (!wantStream) {
    try {
      const completion = await openai.chat.completions.create({
        model: MODEL, temperature: 0.5,
        messages: [{ role:"system", content: sys }, userMsg]
      });
      const advice = completion.choices?.[0]?.message?.content || "";
      setCors(res); // nogmaals voor de zekerheid
      return res.status(200).json({
        ok: true,
        advice,
        suggestedProducts: shortlist.slice(0, 30),
        meta: { model: MODEL }
      });
    } catch (e) {
      return safeError(500, "OPENAI_ERROR", { details: e.message });
    }
  }

  // STREAM (SSE)
  res.setHeader("Content-Type","text/event-stream; charset=utf-8");
  // setCors is al aangeroepen bovenin; hieronder nogmaals voor duidelijkheid:
  res.setHeader("Access-Control-Allow-Origin","*");

  const hb = setInterval(()=>{ try{ writeSSE(res,{ comment:"heartbeat" }); } catch{} }, 15000);
  const cleanup = ()=> clearInterval(hb);
  req.on("close", cleanup); req.on("aborted", cleanup);

  try {
    writeSSE(res,{ event:"start", data:{ activities, durationDays, season, model: MODEL } });
    writeSSE(res,{ event:"context", data:{ products: productContext.slice(0,20) } });

    const stream = await openai.chat.completions.create({
      model: MODEL, temperature: 0.5, stream: true,
      messages: [{ role:"system", content: sys }, userMsg]
    });

    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content;
      if (delta) writeSSE(res,{ event:"delta", data: delta });
    }

    writeSSE(res,{ event:"products", data: shortlist.slice(0,30) });
    writeSSE(res,{ event:"done", data:{ ok:true } });
    res.end();
  } catch (e) {
    writeSSE(res,{ event:"error", data:{ message: e.message } });
    try { res.end(); } catch {}
  }
};
