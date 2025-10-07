// api/packlist.js
// Node serverless ( @vercel/node ) SSE-implementatie met res.write,
// GEEN ReadableStream of stream.start() gebruiken.

function writeSSE(res, event) {
  // event: { event?: string, data?: any, comment?: string }
  if (event.comment) res.write(`: ${event.comment}\n\n`);
  if (event.event) res.write(`event: ${event.event}\n`);
  if (event.data !== undefined) res.write(`data: ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}\n\n`);
}

export default async function handler(req, res) {
  // JSON body parsen (Node @vercel/node heeft geen Edge Request)
  let body = {};
  try {
    if (typeof req.body === 'string') body = JSON.parse(req.body || '{}');
    else body = req.body || {};
  } catch {
    body = {};
  }

  if (req.method === 'GET') {
    // Snelle health voor deze route
    res.status(200).json({
      ok: true,
      hint: 'POST hiernaartoe met { activities: string[], durationDays: number }. Voor stream: laat ?stream=1 in de URL.'
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  const { activities = [], durationDays = 7 } = body;
  const wantStream = String(req.query?.stream || req.query?.s || req.query?.mode) === '1';

  if (!wantStream) {
    // Niet-streamende fallback (handig voor snelle tests of Postman)
    res.status(200).json({
      ok: true,
      echo: { activities, durationDays },
      note: 'Niet-streamend pad. Voeg ?stream=1 toe voor SSE.'
    });
    return;
  }

  // --- STREAMEND PAD (SSE) ---
  // Belangrijk: juiste headers en geen buffering
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // CORS (voor Framer of je site; in productie liever specifiek origin whitelisten)
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Eventuele proxies wakker houden (herhaal-comment)
  const heartbeat = setInterval(() => {
    try { writeSSE(res, { comment: 'heartbeat' }); } catch {}
  }, 15000);

  // Zorg dat we netjes opruimen bij disconnect
  req.on('close', () => clearInterval(heartbeat));
  req.on('aborted', () => clearInterval(heartbeat));

  try {
    // Stuur een begin-event
    writeSSE(res, { event: 'start', data: { ok: true, activities, durationDays } });

    // (Hier zou je normaal OpenAI-stream verwerken, bijv. for-await-of chunks:
    // for await (const chunk of openaiStream) { writeSSE(res, { event: 'delta', data: chunk }); }
    // Voor nu simuleren we een paar deltas:)
    const chunks = [
      { text: 'We gaan je paklijst samenstellen…' },
      { text: `Activiteiten: ${activities.join(', ') || '(n.v.t.)'}` },
      { text: `Duur: ${durationDays} dagen` },
      { text: 'Aanbeveling: lichte regenjas, sneldrogende shirts, dry-bag, snorkelset.' }
    ];

    for (const c of chunks) {
      await new Promise(r => setTimeout(r, 300)); // mini delay om stream te zien
      writeSSE(res, { event: 'delta', data: c });
    }

    writeSSE(res, { event: 'done', data: { ok: true } });
    // Sluit de stream af
    res.end();
  } catch (err) {
    // Stuur nette fout als SSE event en sluit af
    writeSSE(res, { event: 'error', data: { message: err?.message || 'unknown error' } });
    try { res.end(); } catch {}
  }
}
