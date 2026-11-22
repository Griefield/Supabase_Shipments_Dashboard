# Ask tab backend

Cloudflare Worker that forwards one question at a time to Gemini.
The Gemini key is a Worker secret — it is never in this repo or in `index.html`.

Three request shapes (all `POST /`):

| Body | What happens |
| --- | --- |
| `{question, context, history}` | One Gemini call answers from the packet, **or** returns `{mode:'query', spec}` for the browser to run (row-level questions) |
| `{mode:'phrase', question, result, history}` | Turns the browser's query result into prose; used only after a query |
| `{question, context, history, forcePacket:true}` | Skips the spec path (fallback when a spec cannot be executed) |

Query specs are validated here (field/operator/aggregate allowlists) and again in the browser.
Rate limit: 40 requests per IP per hour (a query question costs 2). Free-tier Gemini keys allow
about 20 generation requests per day per model, so heavy testing exhausts a day's quota.

## Deploy

```powershell
cd chat-backend
npm init -y                      # only needed once
npm i -D wrangler
npx wrangler login               # opens the browser once
npx wrangler secret put GEMINI_API_KEY   # paste the AI Studio key
npx wrangler deploy
```

`wrangler deploy` prints a URL like
`https://shipments-chat.<your-subdomain>.workers.dev`. Put it in `config.js`:

```js
window.CHAT_ENDPOINT = 'https://shipments-chat.griefield.workers.dev';
```

## Test without the dashboard

```powershell
curl https://shipments-chat.griefield.workers.dev/ `
  -H "content-type: application/json" `
  -d '{\"question\":\"hi\",\"context\":\"TOTALS: 1300 shipments\"}'
```

Expect `{"answer":"..."}`. A request with a disallowed `Origin` header returns 403.

## Config

| Setting | Where | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | `wrangler secret` | AI Studio key |
| `ALLOWED_ORIGIN` | `wrangler.toml` `[vars]` | comma-separated origins allowed to call it |
| `GEMINI_MODEL` | `wrangler.toml` `[vars]` | model name; change if the default is retired |
| `GEMINI_PROXY` | `wrangler.toml` binding | Durable Object that makes the Gemini call from a region Gemini serves; some edge colos (e.g. HKG) are refused with HTTP 400 |

Rate limit: 20 requests per IP per hour, counted inside each Worker isolate.
It is a brake on accidental quota burn, not a global quota.

## Free-tier note

The Worker URL is public (it ships in `config.js`), so anyone who reads the page
can call it. If abuse ever becomes real, add a Cloudflare WAF rate-limit rule on
this route before reaching for auth.
