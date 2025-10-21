/* ===================================================================

  app/api/packlist/route.ts
  - Edge runtime (Vercel)
  - SSE protocol: ask | needs | context | start | delta | products | done | error
  - CORS + OPTIONS preflight
  - Works with your 900-line frontend as-is

=================================================================== */

export const runtime = "edge";

/* =======================  Types (tolerant)  ======================= */
type StepId = "countries" | "period" | "duration" | "activities";

type GuidancePolicy = {
  allowPartial?: boolean;
  preferAdviceOverQuestions?: boolean;
  questionsOnlyWhenBlocking?: boolean;
  showAlternatives?: boolean;
  assumptions?: { allowed?: boolean; mustBeExplicit?: boolean; max?: number };
};

type ContextIn = {
  destination?: { country?: string | null; region?: string | null };
  durationDays?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  month?: string | null;
  activities?: string[];
  preferences?: any;
};

type NLUHints = {
  country?: string | null;
  durationDays?: number | null;
  month?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  paraphrase?: string;
};

type Product = {
  category?: string;
  name?: string;
  weight_grams?: number;
  activities?: string;
  seasons?: string;
  url?: string;
  image?: string;
};

/* =======================  CORS & SSE helpers  ======================= */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    // belangrijk voor SSE in sommige proxies:
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
}
export async function OPTIONS() {
  // Preflight voor CORS; lost "Failed to fetch" op bij POST
  return new Response(null, { headers: corsHeaders() });
}

const enc = (s: string) => new TextEncoder().encode(s);
const sse = (event: string, data: any) =>
  `event: ${event}\n` +
  `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

/* =======================  Utilities  ======================= */
function pickSeason(month?: string | null) {
  const m = (month || "").toLowerCase();
  if (!m) return "onbekend";
  const winter = ["december", "januari", "februari"];
  const lente = ["maart", "april", "mei"];
  const zomer = ["juni", "juli", "augustus"];
  if (winter.includes(m)) return "winter";
  if (lente.includes(m)) return "lente";
  if (zomer.includes(m)) return "zomer";
  return "herfst";
}

function missingSlots(ctx: ContextIn): StepId[] {
  const out: StepId[] = [];
  if (!ctx?.destination?.country) out.push("countries");
  if (!(ctx?.month || ctx?.startDate)) out.push("period");
  if (!ctx?.durationDays) out.push("duration");
  if (!ctx?.activities || !ctx.activities.length) out.push("activities");
  return out;
}

function firstAskFor(slot: StepId): string {
  switch (slot) {
    case "countries":
      return "Kun je nog aangeven: bestemming (land, optioneel regio)?";
    case "period":
      return "Kun je nog aangeven: in welke periode (maand of exacte data)?";
    case "duration":
      return "Kun je nog aangeven: hoeveel dagen of weken?";
    case "activities":
      return "Welke activiteiten denk je te gaan doen? (bijv. hiken, surfen)";
  }
}

function friendlyCountry(c?: string | null) {
  if (!c) return null;
  const map: Record<string, string> = {
    vietnam: "Vietnam",
    thailand: "Thailand",
    indonesie: "Indonesië",
    "indonesië": "Indonesië",
    laos: "Laos",
    cambodja: "Cambodja",
    filipijnen: "Filipijnen",
  };
  const key = c.toLowerCase();
  return map[key] || c;
}

/* =======================  Advice & Products  ======================= */
function buildAdvice(ctx: ContextIn, policy: GuidancePolicy) {
  const country = ctx.destination?.country || null;
  const month = ctx.month || null;
  const dur = ctx.durationDays || null;
  const acts = ctx.activities && ctx.activities.length ? ctx.activities : null;

  const assumptions: string[] = [];
  if (policy?.assumptions?.allowed !== false) {
    if (!country) assumptions.push("Land nog onbekend → generiek backpack-advies.");
    if (!month) assumptions.push("Periode onbekend → ga uit van gematigde temperaturen en regenoptie.");
    if (!dur) assumptions.push("Duur onbekend → capsule-packlijst (2–4 weken) als basis.");
  }

  const lines: string[] = [];
  lines.push("**Korte samenvatting**\n");
  lines.push("- Concreet advies op basis van je input + aannames.");
  if (country) lines.push(`- Focus op items passend bij ${friendlyCountry(country)}.`);
  if (month) lines.push(`- Laagjes & regenbescherming voor ${pickSeason(month)}.`);
  if (acts) lines.push(`- Extra’s voor: ${acts.join(", ")}.`);
  lines.push("");

  lines.push("**Kleding** - 4–5 lichte tops, 2–3 bottoms, 1 warm laagje (fleece/merino), 5–7 ondergoed, 2–3 sokken, regenjas/windjack.");
  lines.push("**Gear** - daypack 20–30L, packing cubes, waterfles 750ml+, lakenzak, sneldrogende handdoek, slotje.");
  lines.push("**Gadgets** - universele adapter, powerbank, USB-kabels, eSIM/roaming, oordoppen.");
  lines.push("**Health** - EHBO, ORS, DEET (tropen), zonnebrand, pleisters, persoonlijke medicatie (kopie recepten).");
  lines.push("**Tips** - scan paspoort/verzekering, offline maps, noodcash, wasmiddel/waslijn.\n");

  return { summaryMD: lines.join("\n"), assumptions };
}

function suggestProducts(ctx: ContextIn): Product[] {
  const out: Product[] = [];
  const season = pickSeason(ctx.month);
  const tropical =
    (ctx.destination?.country || "")
      .toLowerCase()
      .match(/(vietnam|thailand|indonesie|indonesië|laos|cambodja|filipijnen)/) ||
    season === "zomer";

  // Basic
  out.push({
    category: "tassen",
    name: "Daypack 25L",
    weight_grams: 620,
    url: "https://example.com/daypack",
    activities: "allround",
  });
  out.push({
    category: "power",
    name: "Powerbank 10.000 mAh",
    weight_grams: 185,
    url: "https://example.com/powerbank",
  });

  if (tropical) {
    out.push({
      category: "bescherming",
      name: "Lichte regenjas (2.5L)",
      weight_grams: 280,
      url: "https://example.com/rain",
      seasons: "tropen",
    });
    out.push({
      category: "gezondheid",
      name: "DEET 30%",
      weight_grams: 100,
      url: "https://example.com/deet",
      seasons: "tropen",
    });
  }

  if ((ctx.activities || []).some((a) => /surf|duik|snorkel/i.test(a))) {
    out.push({
      category: "water",
      name: "Sneldrogende handdoek",
      weight_grams: 90,
      url: "https://example.com/towel",
      activities: "water",
    });
    out.push({
      category: "water",
      name: "Drybag 5L",
      weight_grams: 70,
      url: "https://example.com/drybag",
      activities: "water",
    });
  }

  return out;
}

/* =======================  POST (SSE)  ======================= */
export async function POST(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const policy: GuidancePolicy = body?.policy ?? {};
  const contextIn: ContextIn = body?.context ?? {};
  const hints: NLUHints | null = body?.nluHints ?? null;

  // Defensieve samenvoeging van context + hints
  const ctx: ContextIn = {
    ...contextIn,
    destination: {
      country: hints?.country ?? contextIn?.destination?.country ?? null,
      region: contextIn?.destination?.region ?? null,
    },
    month: hints?.month ?? contextIn?.month ?? null,
    startDate: hints?.startDate ?? contextIn?.startDate ?? null,
    endDate: hints?.endDate ?? contextIn?.endDate ?? null,
    durationDays: hints?.durationDays ?? contextIn?.durationDays ?? null,
    activities: Array.isArray(contextIn?.activities) ? contextIn.activities : [],
  };

  const stream = new ReadableStream({
    start(controller) {
      // Keep-alive (houd proxies “wakker”)
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(enc(": keep-alive\n\n"));
        } catch {
          // stream vermoedelijk dicht
        }
      }, 15000);

      const safeClose = () => {
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {}
      };

      try {
        // 1) start
        controller.enqueue(enc(sse("start", {})));

        // 2) context/meta (seizoen + flags)
        const season = pickSeason(ctx.month);
        const seasonalRisks =
          season === "tropen"
            ? [{ type: "hitte/UV", level: "medium" }]
            : season === "winter"
            ? [{ type: "kou", level: "medium" }]
            : [];
        controller.enqueue(
          enc(
            sse("context", {
              season,
              seasonalRisks,
              adviceFlags: { generic: !ctx.destination?.country },
            })
          )
        );

        // 3) needs
        const missing = missingSlots(ctx);
        controller.enqueue(enc(sse("needs", { missing, contextOut: ctx })));

        // 4) optioneel 1 vraag (alleen als je dat wilt)
        const shouldAsk =
          missing.length > 0 &&
          policy?.preferAdviceOverQuestions !== true &&
          policy?.questionsOnlyWhenBlocking !== true; // advies mag alvast
        if (shouldAsk) {
          controller.enqueue(enc(sse("ask", { question: firstAskFor(missing[0]) })));
        }

        // 5) assumptions + hoofdadvies
        const built = buildAdvice(ctx, policy);
        if (built.assumptions.length && (policy?.assumptions?.allowed !== false)) {
          controller.enqueue(
            enc(
              sse(
                "assumptions",
                built.assumptions.slice(0, policy?.assumptions?.max ?? 5)
              )
            )
          );
        }

        // 6) delta (de tekst zelf)
        controller.enqueue(enc(sse("delta", built.summaryMD)));

        // 7) products (optioneel)
        const prods = suggestProducts(ctx);
        if (prods.length) {
          controller.enqueue(enc(sse("products", prods)));
        }

        // 8) done
        controller.enqueue(enc(sse("done", {})));
        safeClose();
      } catch (err: any) {
        // Bezorg front-end een net 'error'-event i.p.v. netwerkfout
        controller.enqueue(
          enc(
            sse("error", {
              message:
                err?.message ||
                "Onverwachte fout tijdens genereren van advies.",
            })
          )
        );
        safeClose();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
}
