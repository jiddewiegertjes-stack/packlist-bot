import { parse as parseCsv } from "csv-parse/sync";
import OpenAI from "openai";
import { readFileSync } from "fs";
import path from "path";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const rulesPath = path.join(process.cwd(), "data", "rules.json");
const rules = JSON.parse(readFileSync(rulesPath, "utf8"));

async function loadCatalog() {
  const url = process.env.CSV_URL;
  if (!url) throw new Error("CSV_URL ontbreekt");
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("CSV fetch failed: " + res.status);
  const text = await res.text();
  return parseCsv(text, { columns: true, skip_empty_lines: true });
}

function normalizeActivities(raw = []) {
  const map = {
    "hike":"hike","hiken":"hike","hiketocht":"hike","trekking":"hike","wandelen":"hike","daghike":"hike","meerdaagse hike":"hike","hut-to-hut":"hike","berghike":"hike",
    "city":"city","stad":"city","citytrip":"city","sightseeing":"city","free walking tour":"city",
    "camp":"camp","kamperen":"camp","wildkamperen":"camp","tent":"camp","bivak":"camp",
    "boat":"boat","boot":"boat","varen":"boat","eilandhoppen":"boat","kayak":"boat","kajak":"boat"
  };
  return raw.map(a => String(a||"").toLowerCase().trim()).map(a => map[a] ?? a).filter(Boolean);
}

async function buildPacklist({ activities = [], durationDays = 7 }) {
  const catalog = await loadCatalog();
  const set = new Set(rules.alwaysInclude || []);

  for (const act of activities) for (const id of (rules.activities?.[act] || [])) set.add(id);

  const bucket = durationDays >= 21 ? "long" : durationDays >= 10 ? "medium" : "short";
  for (const id of (rules.durationHints?.[bucket] || [])) set.add(id);

  const byId = new Map(catalog.map(p => [p.id, p]));
  const items = [...set].map(id => byId.get(id)).filter(Boolean);
  const pri = { must: 0, should: 1, nice: 2 };
  items.sort((a, b) => (pri[a?.priority] ?? 99) - (pri[b?.priority] ?? 99));
  return items;
}

const SYSTEM_PROMPT = `
Je bent een behulpzame paklijst-assistent voor backpackers.
DOEL: Maak een compacte paklijst op basis van DUUR (dagen) en ACTIVITEITEN.
WERKWIJZE
1) Verzamel: duur (dagen) en activiteiten[].
2) Vat kort samen en vraag om bevestiging.
3) Na bevestiging: roep tool get_pack_suggestions aan met { activities, durationDays }.
4) Gebruik alleen catalogus-items (tooloutput is leidend).
5) Groepeer op prioriteit (must/should/nice) met korte reden per groep.
6) Vraag gericht door als info ontbreekt (één vraag per beurt).
Stijl: Bondig, NL, geen interne IDs tonen.
`;

const toolDefs = [{
  type: "function",
  name: "get_pack_suggestions",
  description: "Return packing items based on catalog rules (activities, duration)",
  parameters: {
    type: "object",
    properties: {
      activities: { type: "array", items: { type: "string" } },
      durationDays: { type: "number", minimum: 1, maximum: 365 }
    },
    required: ["activities", "durationDays"],
    additionalProperties: false
  }
}];

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");               // of jouw Framer domein
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(200).end();
    return;
  }

  // Healthcheck op GET (handig in de browser)
  if (req.method === "GET") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(405).json({ error: "Use POST" });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(405).json({ error: "Use POST" });
    return;
  }

  // ---- Body robuust lezen (sommige runtimes vullen req.body niet) ----
  let body = {};
  try {
    if (!req.body || typeof req.body === "string") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8") || "{}";
      body = JSON.parse(raw);
    } else {
      body = req.body;
    }
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(400).json({ error: "INVALID_JSON", message: String(e?.message || e) });
    return;
  }

  const { messages, trip } = body || {};

  // ---- Debug modes via query (?mode=echo|nostream) ----
  const urlObj = new URL(req.url, "https://dummy");
  const mode = urlObj.searchParams.get("mode");

  if (mode === "echo") {
    // Geen OpenAI; direct packlist uit rules+CSV
    try {
      const activities = normalizeActivities((trip?.activities) || []);
      const durationDays = Math.max(1, Math.min(365, Math.floor(trip?.durationDays || 7)));
      const items = await buildPacklist({ activities, durationDays });
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(200).json({ mode: "echo", activities, durationDays, itemsCount: items.length, items });
      return;
    } catch (e) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(500).json({ mode: "echo", error: String(e?.message || e) });
      return;
    }
  }

  if (mode === "nostream") {
    // OpenAI zonder SSE (makkelijk debuggen)
    try {
      const seed = messages ?? [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "assistant", content: "Top! Hoelang ga je (dagen) en welke activiteiten? (bijv. hiking, city, camp, boat …)" },
        { role: "user", content: trip ? JSON.stringify(trip) : "Ik ga 14 dagen backpacken met veel hiken en een paar nachtbussen." }
      ];
      const resp = await openai.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        input: seed,
        tools: toolDefs
      });
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(200).json(resp);
      return;
    } catch (e) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(500).json({ mode: "nostream", error: String(e?.message || e) });
      return;
    }
  }

  // ---- Normale SSE-stream ----
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*"              // CORS voor Framer
  });

  // Eerste 'ping' zodat clients meteen iets zien
  res.write(`data: ${JSON.stringify({ delta: "🔌 verbinding oké, model wordt aangeroepen…" })}\n\n`);

  const seed = messages ?? [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "assistant", content: "Top! Hoelang ga je (dagen) en welke activiteiten? (bijv. hiking, city, camp, boat …)" },
    { role: "user", content: trip ? JSON.stringify(trip) : "Ik ga 14 dagen backpacken met veel hiken en een paar nachtbussen." }
  ];

  let stream;
  try {
    stream = await openai.responses.stream({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      input: seed,
      tools: toolDefs
    });
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: String(e?.message || e) })}\n\n`);
    res.end();
    return;
  }

  stream.on("tool_call", async (event) => {
    if (event.name === "get_pack_suggestions") {
      try {
        const args = JSON.parse(event.arguments || "{}");
        const activities = normalizeActivities(args.activities || []);
        const durationDays = Math.max(1, Math.min(365, Math.floor(args.durationDays || 7)));
        const items = await buildPacklist({ activities, durationDays });
        await event.submitToolOutput(JSON.stringify({ items }));
      } catch (e) {
        await event.submitToolOutput(JSON.stringify({ error: "tool_failed", message: String(e?.message || e) }));
      }
    }
  });

  stream.on("message", (msg) => {
    const delta = msg.delta ?? msg.output_text ?? "";
    if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
  });

  stream.on("end", () => res.end());
  stream.on("error", (e) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error: String(e?.message || e) })}\n\n`);
    res.end();
  });

  await stream.start();
}
