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
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const { messages, trip } = req.body || {};
  const seed = messages ?? [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "assistant", content: "Top! Hoelang ga je (dagen) en welke activiteiten? (bijv. hiking, city, camp, boat …)" },
    { role: "user", content: trip ? JSON.stringify(trip) : "Ik ga 14 dagen backpacken met veel hiken en een paar nachtbussen." }
  ];

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  let stream;
  try {
    stream = await openai.responses.stream({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      input: seed,
      tools: toolDefs
    });
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
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
        await event.submitToolOutput(JSON.stringify({ error: "tool_failed", message: e.message }));
      }
    }
  });

  stream.on("message", (msg) => {
    const delta = msg.delta ?? msg.output_text ?? "";
    if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
  });

  stream.on("end", () => res.end());
  stream.on("error", (e) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  });

  await stream.start();
}
