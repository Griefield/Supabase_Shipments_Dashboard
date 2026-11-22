// Cloudflare Worker that proxies Gemini for the dashboard's Ask tab.
// The API key lives only here (wrangler secret); the dashboard never sees it.
//
// Three request shapes, all on POST /:
//   {question, context, history}              -> plans a query; either returns
//                                                {mode:'query', spec} for the browser to run,
//                                                or answers from the packet {answer}
//   {mode:'phrase', question, result, ...}    -> turns a query result into prose {answer}
//   {question, context, history, forcePacket} -> skips planning, answers from the packet
// The browser holds the rows; the Worker never sees them, so a query spec is always
// executed client-side and only the (small) result travels back here.

const DEFAULT_MODEL = 'gemini-3.8-flash';
const MAX_QUESTION = 2000;   // characters, generous for a dashboard question
const MAX_CONTEXT = 20000;   // characters, browser caps the packet at 12000
const MAX_RESULT = 20000;    // characters of query output sent back for phrasing
const MAX_HISTORY = 20;      // turns, browser sends 6
const MAX_TURN = 2000;       // characters per history turn
const MAX_SPEC = 2000;       // characters of planner JSON
const RATE_LIMIT = 40;       // requests per IP per window: a query question costs 2-3
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

// One call decides and answers: most questions are answered straight from the packet,
// and only questions the packet cannot cover cost a second (phrasing) call. That keeps
// free-tier quota usable (Gemini free tier is per-model, generation requests per day).
const ANSWER_PROMPT = `You are the assistant for a sea-freight shipments dashboard.
Reply with JSON only, no prose, no code fences, in one of two shapes:

1) {"mode":"answer","text":"..."} when the DATA block is enough, when the message is a
   greeting/thanks/small talk, or when the question is unrelated to the data.
   For data answers use only the DATA block and quote its numbers exactly, 3 sentences max
   unless a list was asked. Greetings: reply naturally and briefly, then offer examples.
   If DATA does not cover a data question and no query would help, say what is missing.

2) {"mode":"query","spec":{...}} when the answer needs specific rows, a grouping, or a
   computed total the DATA block does not contain. Superlatives and computed totals (most,
   least, highest, lowest, total, average, how many) MUST use a query when a field/aggregate
   can compute them - do not say DATA is missing before trying. The browser runs the spec
   over the loaded shipment rows and a second call phrases the result, so only request a
   query when it genuinely adds detail.

Spec fields: date (YYYY-MM-DD), month (YYYY-MM), dayOfWeek, clientName, companyName, vessel,
portFrom, portTo, port (either end), companyCountry, shipCountry, portFromCountry,
portToCountry, cost, loadTonnes, distanceNm.
Operators: eq, in, contains (text); gt, gte, lt, lte, between (cost/loadTonnes/distanceNm).
Shape: {"where":{field:{"eq":"value"}},"groupBy":"companyName","aggregate":{"count":true,
"sumCost":true},"sort":{"field":"sumCost","dir":"desc"},"limit":10}
Rules: at most 6 where fields, ANDed, one operator each; use portFrom for departures,
portTo for arrivals, port for either; copy names exactly as the user wrote them (the browser
fixes typos); omit groupBy/aggregate for row listings; aggregate without groupBy returns one
total; limit <= 50 (default 20); never invent fields, numbers, or filter values.
For "total ships that departed/arrived at a port in a month", filter portFrom or portTo +
month, then groupBy vessel (distinct ships) or omit groupBy with aggregate count.

Example: "which ships left Brani Terminal Gate 5 in August 2026?"
{"mode":"query","spec":{"where":{"month":{"eq":"2026-08"},"portFrom":{"eq":"Brani Terminal Gate 5"}},"limit":20}}

Example: "who is the client with the most money spent?"
{"mode":"query","spec":{"groupBy":"clientName","aggregate":{"count":true,"sumCost":true},"sort":{"field":"sumCost","dir":"desc"},"limit":10}}`;

// Second call: only sees the executed result, so it cannot wander off.
const PHRASE_PROMPT = `You are the assistant for a sea-freight shipments dashboard.
Answer ONLY from the DATA RESULT block, quoting numbers exactly as given.
- If the result starts with TOTAL, lead with that total, then add at most one useful comparison.
- 3 sentences max unless the user asked for a list.
- If the result is empty or does not cover the question, say what is missing instead of guessing.
- If a "resolved" line shows the question's spelling was corrected, mention the corrected name briefly.`;

// Field / operator / aggregate allowlists - the validator is the security boundary
// for anything the model invents.
const SPEC_FIELDS = [
  'date', 'month', 'dayOfWeek', 'clientName', 'companyName', 'vessel',
  'portFrom', 'portTo', 'port', 'companyCountry', 'shipCountry',
  'portFromCountry', 'portToCountry', 'cost', 'loadTonnes', 'distanceNm'
];
const SPEC_NUMBER_FIELDS = ['cost', 'loadTonnes', 'distanceNm'];
const SPEC_STRING_OPS = ['eq', 'in', 'contains'];
const SPEC_NUMBER_OPS = ['gt', 'gte', 'lt', 'lte', 'between'];
const SPEC_AGGREGATES = ['count', 'sumCost', 'sumLoad', 'avgDistance'];
const SPEC_SORT_FIELDS = ['count', 'sumCost', 'sumLoad', 'avgDistance', 'key'];

// Transport only: performs the Gemini request from a pinned region so a
// restricted edge colo (e.g. HKG) cannot block it. All prompt building and
// validation stays in the Worker above.
export class GeminiProxy {
  constructor(state, env) {
    this.env = env;
  }

  async fetch(request) {
    const { model, payload } = await request.json();
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.env.GEMINI_API_KEY },
        body: JSON.stringify(payload)
      });
    // pass the provider status and body straight through; the Worker shapes errors
    return new Response(await upstream.text(),
      { status: upstream.status, headers: { 'content-type': 'application/json' } });
  }
}

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
    if (history.length > MAX_HISTORY) return json({ error: 'History too long.' }, 400, cors);

    let turns = [];
    try {
      turns = historyTurns(history);
    } catch (err) {
      return json({ error: err.message }, 400, cors);
    }

    // ── phrase: the browser already ran the spec, turn its result into prose
    if (body.mode === 'phrase') {
      const result = typeof body.result === 'string' ? body.result.trim() : '';
      if (!result || result.length > MAX_RESULT) return json({ error: 'Invalid result.' }, 400, cors);
      return sendAnswer(env, cors, PHRASE_PROMPT,
        [...turns, { role: 'user', parts: [{ text: `DATA RESULT:\n${result}\n\nQUESTION: ${question}` }] }],
        0.2, 1200);
    }

    if (!context || context.length > MAX_CONTEXT) return json({ error: 'Invalid context.' }, 400, cors);

    // ── answer or query: one call decides. Packet answers cost one request, row
    // questions cost a second call to phrase the result the browser computed.
    if (!body.forcePacket) {
      try {
        const first = await callGemini(env, ANSWER_PROMPT,
          [...turns, { role: 'user', parts: [{ text: `DATA:\n${context}\n\nQUESTION: ${question}` }] }],
          0, 2048, true);
        const parsed = JSON.parse(first.text);
        if (parsed && parsed.mode === 'query') {
          const reason = validateSpec(parsed.spec);
          if (!reason) return json({ mode: 'query', spec: parsed.spec }, 200, cors);
          console.error('spec rejected:', reason, JSON.stringify(parsed.spec).slice(0, 300));
        } else if (parsed && parsed.mode === 'answer' && typeof parsed.text === 'string' && parsed.text.trim()) {
          return json({ answer: parsed.text.trim() }, 200, cors);
        }
      } catch (err) {
        // A failed or unparseable first call must never break the answer:
        // fall through to the plain packet call below.
        console.error('answer-or-query failed:', err && err.message ? err.message : err);
      }
    }

    // ── packet: the original single-call path, unchanged in spirit
    return sendAnswer(env, cors, SYSTEM_PROMPT,
      [...turns, { role: 'user', parts: [{ text: `DATA:\n${context}\n\nQUESTION: ${question}` }] }],
      0.2, 4096);
  }
};

// Shared Gemini call + answer shaping so every branch reports errors the same way.
async function sendAnswer(env, cors, systemPrompt, turns, temperature, maxOutputTokens) {
  let out;
  try {
    out = await callGemini(env, systemPrompt, turns, temperature, maxOutputTokens, false);
  } catch (err) {
    return json({ error: 'Assistant is unavailable right now.' }, 502, cors);
  }
  // Thinking models spend part of the budget before the visible answer, so a long
  // list can still be cut off; say so instead of ending mid-sentence.
  const cutOff = out.finishReason === 'MAX_TOKENS';
  return json({ answer: cutOff ? `${out.text}\n\n(Answer cut off — ask a narrower question.)` : out.text }, 200, cors);
}

async function callGemini(env, systemPrompt, turns, temperature, maxOutputTokens, jsonMode) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const generationConfig = { temperature, maxOutputTokens };
  if (jsonMode) generationConfig.responseMimeType = 'application/json';

  let upstream;
  try {
    // The edge colo can be one Gemini refuses (e.g. HKG), so the outbound call
    // is made from a Durable Object pinned to a supported region.
    const stub = env.GEMINI_PROXY.get(
      env.GEMINI_PROXY.idFromName('gemini'),
      { locationHint: 'wnam' });
    upstream = await stub.fetch('https://gemini-proxy/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        payload: {
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: turns,
          generationConfig
        }
      })
    });
  } catch (err) {
    console.error('Gemini request failed:', err);
    throw new Error('network');
  }

  if (!upstream.ok) {
    // Log the provider message, keep the client response generic.
    console.error('Gemini error', upstream.status, (await upstream.text()).slice(0, 500));
    throw new Error(`gemini ${upstream.status}`);
  }

  const data = await upstream.json().catch(() => null);
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('empty answer');
  return { text, finishReason: candidate?.finishReason };
}

// History is replayed before the DATA turn, so an earlier message cannot
// rewrite the data block of the current question.
function historyTurns(history) {
  const turns = [];
  for (const h of history) {
    if (!h || typeof h.text !== 'string' || !h.text) continue;
    if (h.text.length > MAX_TURN) throw new Error('History turn too long.');
    turns.push({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: h.text }] });
  }
  return turns;
}

// Returns null when the spec is acceptable, or a short reason when it is not.
// Deliberately strict: an invented field must fall back, never reach the rows.
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return 'spec is not an object';
  if (JSON.stringify(spec).length > MAX_SPEC) return 'spec too large';

  const where = spec.where == null ? {} : spec.where;
  if (typeof where !== 'object' || Array.isArray(where)) return 'where is not an object';
  const fields = Object.keys(where);
  if (fields.length > 6) return 'too many filters';

  for (const field of fields) {
    if (!SPEC_FIELDS.includes(field)) return `unknown field: ${field}`;
    const cond = where[field];
    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return 'condition is not an object';
    const ops = Object.keys(cond);
    if (ops.length !== 1) return 'one operator per field';
    const op = ops[0];
    const value = cond[op];
    const numeric = SPEC_NUMBER_FIELDS.includes(field);

    if (SPEC_STRING_OPS.includes(op)) {
      if (numeric) return `string operator on numeric field: ${field}`;
      if (op === 'in') {
        if (!Array.isArray(value) || !value.length || value.length > 20) return 'bad in list';
        if (value.some(v => typeof v !== 'string')) return 'in values must be strings';
        if (value.some(v => v.length > 64)) return 'in value too long';
      } else if (typeof value !== 'string' || !value.length || value.length > 64) {
        return 'bad string value';
      }
    } else if (SPEC_NUMBER_OPS.includes(op)) {
      if (!numeric) return `numeric operator on text field: ${field}`;
      if (op === 'between') {
        if (!Array.isArray(value) || value.length !== 2) return 'bad between';
        if (value.some(v => typeof v !== 'number' || !Number.isFinite(v))) return 'between needs numbers';
      } else if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'numeric operator needs a number';
      }
    } else {
      return `unknown operator: ${op}`;
    }
  }

  if (spec.groupBy != null) {
    if (!SPEC_FIELDS.includes(spec.groupBy)) return 'unknown groupBy';
    if (SPEC_NUMBER_FIELDS.includes(spec.groupBy)) return 'cannot group by a number';
  }
  if (spec.aggregate != null) {
    if (typeof spec.aggregate !== 'object' || Array.isArray(spec.aggregate)) return 'bad aggregate';
    const aggs = Object.keys(spec.aggregate).filter(k => spec.aggregate[k]);
    if (!aggs.length) return 'empty aggregate';
    if (aggs.some(k => !SPEC_AGGREGATES.includes(k))) return 'unknown aggregate';
  }
  if (spec.sort != null) {
    if (typeof spec.sort !== 'object' || typeof spec.sort.field !== 'string') return 'bad sort';
    if (!SPEC_SORT_FIELDS.includes(spec.sort.field)) return 'unknown sort field';
    if (spec.sort.dir != null && !['asc', 'desc'].includes(spec.sort.dir)) return 'bad sort dir';
  }
  if (spec.limit != null && (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > 50)) {
    return 'bad limit';
  }
  return null;
}

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
