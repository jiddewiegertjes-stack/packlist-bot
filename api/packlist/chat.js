// /api/packlist.ts
import { parse as parseCsv } from "csv-parse/sync";
import OpenAI from "openai";
import { readFileSync } from "fs";
import path from "path";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const rules = JSON.parse(readFileSync(path.join(process.cwd(), "data", "rules.json"), "utf8"));

// --- LOAD CSV ---
async function loadCatalog() {
  const url = process.env.CSV_URL;
  if (!url) throw new Error("CSV_URL ontbreekt");
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("CSV fetch failed: " + res.status);
  const text = await res.text();
  return parseCsv(text, { columns: true, skip_empty_lines: true });
}

// --- NORMALISATIE ACTIVITEITEN ---
function normalizeActivities(raw: string[] = []) {
  const map: Record<string, string> = {
    // Hike
    "hike": "hike", "hiken": "hike", "hiketocht": "hike", "trekking": "hike",
    "wandelen": "hike", "daghike": "hike", "meerdaagse hike": "hike",
    "hut-to-hut": "hike", "berghike": "hike",

    // City
    "city": "city", "stad": "city", "citytrip": "city",
    "sightseeing": "city", "free walking tour": "city",

    // Camp
    "camp": "camp", "kamperen": "camp", "wildkamperen": "camp",
    "tent": "camp", "bivak": "camp",

    // Boat
    "boat": "boat", "boot": "boat", "varen": "boat",
    "eilandhoppen": "boat", "kayak": "boat", "kajak": "boat",
  };

  return raw
    .map(a => String(a || "").toLowerCase().trim())
    .map(a => map[a] ?? a)
    .filter(Boolean);
}

// --- SYSTEM PROMPT ---
const SYSTEM_PROMPT = `
Je bent een behulpzame paklijst-assistent voor backpackers.
DOEL: Maak een compacte paklijst op basis van DUUR (dagen) en ACTIVITEITEN.

WERKWIJZE
1) Verzamel alleen wat je nodig hebt:
   - duur (in dagen)
   - activiteiten[] (backpacker-stijl; vrije tekst of kiezen uit voorbeelden)
2) Vat in één korte zin samen wat je hebt begrepen en vraag om bevestiging.
3) Pas NA bevestiging de tool get_pack_suggestions aan te roepen met:
   { activities: [...], durationDays: <int> }.
4) Gebruik GEEN items buiten de catalogus; de tooloutput is leidend.
5) Presenteer resultaat gegroepeerd op prioriteit (must / should / nice) met een korte reden per groep (1 regel).
6) Als info ontbreekt, vraag gericht door (één vraag per beurt), geen gokwerk.

Voorbeelden van backpacker-activiteiten (niet-limitatief):
- hiking/trekking (dagtochten, meerdaags), hut-to-hut
- city / sightseeing / free walking tours
- camp / tent / wildkamperen
- boat / eilandhoppen / kajak
- hostels & dorms, nachtbussen/treinen, strand/snorkelen/duiken, surf/kitesurf
- roadtrip/scooter/motor, fotografie/content, werken onderweg, vrijwilligerswerk, festivals/nachtleven

Stijl:
- Bondig, vriendelijk, NL.
- Geen interne IDs tonen aan de gebruiker.
`;

// --- TOOL DEFINITIES ---
const toolDefs = [{
  type: "function",
  name: "get_pack_suggestions",
  description: "Return packing items based on catalog rules (activities, duration)",
  parameters: {
    type: "object",
    properties: {
      activities: {
        type: "array",
        description: "Normalized activity keys",
        items: { type: "string" }
      },
      durationDays: { type: "number", minimum: 1, maximum: 365 }
    },
    required: ["activities", "durationDays"],
    additionalProperties: false
  }
}];

// --- PACKLIST BOUWEN ---
async function buildPacklist({ activities = [], durationDays = 7 }) {
  const catalog = await loadCatalog();

  const set = new Set(rules.alwaysInclude || []);

  // Activiteitenregels
  for (const act of activities) {
    for (const id of (rules.activities?.[act] || [])) set.add(id);
  }

  // Duurhints
  const bucket = durationDays >= 21 ? "long" : durationDays >= 10 ? "medium" : "short";
  for (const id of (rules.durationHints?.[bucket] || [])) set.add(id);

  // Climate genegeerd (komt later via seizoenen-landen)
  const byId = new Map(catalog.map((p: any) => [p.id, p]));
  const items = [...set].map(id => byId.get(id)).filter(Boolean);
  const pri: Record<string, number> = { must: 0, should: 1, nice: 2 };
  items.sort((a: any, b: any) => (pri[a.priority] ?? 99) - (pri[b.priority] ?? 99));
  return items;
}

// --- SEED MESSAGES ---
function seedMessages(trip?: any) {
  const demoUser = trip
    ? { role: "user", content: JSON.stringify(trip) }
    : { role: "user", content: "Ik ga 14 dagen backpacken met veel hiken en een paar nachtbussen." };

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "assistant", content: "Top! Hoelang ga je precies (dagen) en welke activiteiten doe je? (bijv. hiking, city, camp, boat …)" },
    demoUser
  ];
}

// --- HANDLER ---
export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const { messages, trip } = req.body || {};
  const seed = messages ?? seedMessages(trip);

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
      tools: toolDefs,
    });
  } catch (e: any) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
    return;
  }

  stream.on("tool_call", async (event: any) => {
    if (event.name === "get_pack_suggestions") {
      try {
        const args = JSON.parse(event.arguments || "{}");
        const activities = normalizeActivities(args.activities || []);
        const durationDays = Math.max(1, Math.min(365, Math.floor(args.durationDays || 7)));
        const items = await buildPacklist({ activities, durationDays });
        await event.submitToolOutput(JSON.stringify({ items }));
      } catch (e: any) {
        await event.submitToolOutput(JSON.stringify({ error: "tool_failed", message: e.message }));
      }
    }
  });

  stream.on("message", (msg: any) => {
    const delta = msg.delta ?? msg.output_text ?? "";
    if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
  });

  stream.on("end", () => res.end());
  stream.on("error", (e: any) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  });

  await stream.start();
}
