// Cloudflare Worker that proxies one question at a time to Gemini.
// The API key lives only here (wrangler secret); the dashboard never sees it.
// The browser sends the question plus a compact data packet built from the
// rows it already loaded from Supabase, and gets plain text back.

const DEFAULT_MODEL = 'gemini-3.8-flash';
const MAX_QUESTION = 2000;   // characters, generous for a dashboard question
const MAX_CONTEXT = 20000;   // characters, browser caps the packet at 12000
const MAX_HISTORY = 20;      // turns, browser sends 6
const MAX_TURN = 2000;       // characters per history turn
const RATE_LIMIT = 20;       // requests per IP per window
const RATE_WINDOW = 60 * 60 * 1000;

// Per-isolate counter: cheap abuse brake, not a global quota.
const hits = new Map();

// The dashboard may be served from GitHub Pages or a local test server.
const DEFAULT_ORIGINS = [
  'https://griefield.github.io',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
];

// The model answers from the packet, not from its own memory.
const SYSTEM_PROMPT = `You are the assistant for a sea-freight shipments dashboard.
- If the message is a greeting, thanks, or general chat, reply naturally and briefly, then offer examples of what you can answer from the data (e.g. top companies by cost, monthly totals, a client's shipments).
- For questions about the shipments, answer ONLY from the DATA block, quoting numbers exactly as given, 3 sentences max unless a list is asked.
- If a data question is not covered by the DATA block, say what is missing instead of guessing.`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || DEFAULT_ORIGINS.join(','))
      .split(',').map(s => s.trim()).filter(Boolean);

    // Browsers send Origin; curl and other clients do not. Only enforce when present.
    const originAllowed = !origin || allowed.includes(origin);
    if (!originAllowed) return new Response('Forbidden origin', { status: 403 });

    const cors = {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST' || url.pathname !== '/') {
      return json({ error: 'POST / only' }, 404, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!underLimit(ip)) return json({ error: 'Too many requests, try again later.' }, 429, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Body must be JSON.' }, 400, cors); }

    const question = typeof body.question === 'string' ? body.question.trim() : '';
    const context = typeof body.context === 'string' ? body.context : '';
    const history = Array.isArray(body.history) ? body.history : [];

    // Validate at the trust boundary: this endpoint is public.
    if (!question || question.length > MAX_QUESTION) return json({ error: 'Invalid question.' }, 400, cors);
    if (!context || context.length > MAX_CONTEXT) return json({ error: 'Invalid context.' }, 400, cors);
    if (history.length > MAX_HISTORY) return json({ error: 'History too long.' }, 400, cors);

    const turns = [];
    for (const h of history) {
      if (!h || typeof h.text !== 'string' || !h.text) continue;
      if (h.text.length > MAX_TURN) return json({ error: 'History turn too long.' }, 400, cors);
      turns.push({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: h.text }] });
    }
    // The data block is injected on the final turn, so the model cannot be
    // talked out of it by earlier conversation history.
    turns.push({ role: 'user', parts: [{ text: `DATA:\n${context}\n\nQUESTION: ${question}` }] });

    const model = env.GEMINI_MODEL || DEFAULT_MODEL;
    let upstream;
    try {
      upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: turns,
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
          })
        }
      );
    } catch (err) {
      console.error('Gemini request failed:', err);
      return json({ error: 'Assistant is unavailable right now.' }, 502, cors);
    }

    if (!upstream.ok) {
      // Log the provider message, keep the client response generic.
      console.error('Gemini error', upstream.status, (await upstream.text()).slice(0, 500));
      return json({ error: 'Assistant is unavailable right now.' }, 502, cors);
    }

    const data = await upstream.json().catch(() => null);
    const candidate = data?.candidates?.[0];
    const answer = (candidate?.content?.parts || [])
      .map(p => p.text || '').join('').trim();

    if (!answer) return json({ error: 'No answer was generated for that question.' }, 502, cors);
    // Thinking models spend part of the token budget before the visible answer,
    // so a long list can still be cut off; tell the user instead of ending mid-sentence.
    const cutOff = candidate?.finishReason === 'MAX_TOKENS';
    return json({ answer: cutOff ? `${answer}\n\n(Answer cut off — ask a narrower question.)` : answer }, 200, cors);
  }
};

// Sliding-window-ish counter per IP, reset after RATE_WINDOW.
function underLimit(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.reset) {
    hits.set(ip, { count: 1, reset: now + RATE_WINDOW });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT;
}

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
