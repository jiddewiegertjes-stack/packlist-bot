// api/packlist.js
// Minimal sanity handler zodat /api/packlist bestaat en je kunt testen.
// Later kun je hier je SSE/AI-logica terugzetten.

export default async function handler(req, res) {
  // Zorg dat JSON binnenkomend body goed gelezen wordt
  let body = {};
  try {
    if (typeof req.body === 'string') body = JSON.parse(req.body || '{}');
    else body = req.body || {};
  } catch {
    body = {};
  }

  if (req.method === 'GET') {
    res.status(200).json({
      ok: true,
      hint: 'POST hiernaartoe met { activities: string[], durationDays: number }'
    });
    return;
  }

  if (req.method === 'POST') {
    const { activities = [], durationDays = 7 } = body;
    res.status(200).json({
      ok: true,
      echo: { activities, durationDays },
      note: 'Dit is een stub; je echte SSE/AI-logica komt hierna terug.'
    });
    return;
  }

  res.setHeader('Allow', 'GET, POST');
  res.status(405).json({ ok: false, error: 'Method Not Allowed' });
}
