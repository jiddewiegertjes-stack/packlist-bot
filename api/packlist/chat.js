import { parse as parseCsv } from "csv-parse/sync";
import OpenAI from "openai";
import { readFileSync } from "fs";
import path from "path";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const rules = JSON.parse(readFileSync(path.join(process.cwd(), "data", "rules.json"), "utf8"));

async function loadCatalog() {
  const url = process.env.CSV_URL;
  const res = await fetch(url);
  if (!res.ok) throw new Error("CSV fetch failed: " + res.status);
  const text = await res.text();
  return parseCsv(text, { columns: true, skip_empty_lines: true });
}

function climateKey(climate) {
  const c = String(climate || "").toLowerCase();
  if (/rain|wet/.test(c)) return "rain";
  if (/cold|winter/.test(c)) return "cold";
  if (/trop|humid|hot/.test(c)) return "tropical";
  return "mild";
}

async function buildPacklist({ activities = [], climate = "mild", durationDays = 7 }) {
  const catalog = await loadCatalog();
  const set = new Set(rules.alwaysInclude || []);
  for (const act of activities) for (const id of (rules.activities?.[act] || [])) set.add(id);
  for (const id of (rules.climate?.[climateKey(climate)] || [])) set.add(id);
  const bucket = durationDays >= 21 ? "long" : durationDays >= 10 ? "medium" : "short";
  for (const id of (rules.durationHints?.[bucket] || [])) set.add(id);

  const byId = new Map(catalog.map(p => [p.id, p]));
  const items = [...set].map(id => byId.get(id)).filter(Boolean);
  const pri = { must: 0, should: 1, nice: 2 };
  items.sort((a, b) => (pri[a.priority] ?? 99) - (pri[b.priority] ?? 99));
  return items;
}

const toolDefs = [{
  type: "function",
  name: "get_pack_suggestions",
  description: "Return packing items based on Google Sheet catalog and rules",
  parameters: {
    type: "object",
    properties: {
      activities: { type: "array", items: { type: "string" } },
      climate: { type: "string" },
      durationDays: { type: "number" }
    },
    required: ["activities", "climate", "durationDays"]
  }
}];

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const { messages, trip } = req.body || {};
  const seed = messages ?? [
    { role: "system", content: "Je bent een paklijst-chatbot. Vraag bestemming, duur, activiteiten en klimaat en gebruik daarna get_pack_suggestions." },
    { role: "user", content: trip ? JSON.stringify(trip) : "Ik ga 14 dagen hiken in regenachtig Peru." }
  ];

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  const stream = await openai.responses.stream({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    input: seed,
    tools: toolDefs
  });

  stream.on("tool_call", async (event) => {
    if (event.name === "get_pack_suggestions") {
      const args = JSON.parse(event.arguments || "{}");
      const items = await buildPacklist(args);
      await event.submitToolOutput(JSON.stringify({ items }));
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
