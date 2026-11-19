# vinext app

This project was created with create-vinext-app.

## Landing page

The public landing is in Brazilian Portuguese and always dark. `src/app/page.tsx` renders catalog counts on the server; `src/app/landing.css` scopes the copper/charcoal identity to the landing. The root `dark` class also keeps shared UI components in dark mode.

`src/components/landing-experience.tsx` contains the routing diagram and OpenAI/Anthropic/cURL examples with clipboard feedback. Examples use the current origin. Routing animation can be paused and respects reduced motion.

Registry sources are installed outside the protected `src/components/ui` directory: Magic UI [Animated Beam](https://magicui.design/docs/components/animated-beam) in `src/components/magicui`, and NS UI [FAQ Accordion](https://design.helpmarq.com/components/faq-answer-depth-gutter) in `src/components/ns-ui`. They reuse existing React/Motion dependencies; no additional runtime package is needed.

## Backend

Set the Cloudflare Worker secret `ENCRYPTION_SECRET` to a random value of at least 32 characters. Provider credentials are encrypted with it; key operations fail when it is missing.
Local development must supply `ENCRYPTION_SECRET` in `.dev.vars`; production uses the Worker secret. Never commit secret values.

Authentication uses username and password. Provider keys are managed through `/api/keys`. OpenAI-compatible clients use `/v1/chat/completions`; Anthropic clients use `/v1/messages` and the related native endpoints with the issued API key as either `Authorization: Bearer …` or `x-api-key`.

Registration is capped at 5 accounts per IP per day and 100 accounts per day across all IPs (plus a 20/hour per-IP burst limit); exceeding a cap answers 429. There is no CAPTCHA on registration yet: to enable Cloudflare Turnstile, create a Turnstile site in the Cloudflare dashboard, set the Worker secrets `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, and wire the widget into `/register` plus server-side verification of the token in `src/lib/auth.ts`. Until that wiring exists, registration works without a challenge.

## Scheduled jobs (catalog validation + key probe)

Two jobs run outside the request path and keep the catalog and the
key pool honest (audit §E 2.2/2.4). Both need the columns from
migration 0019 (`models.suspect_reason/suspect_since`,
`api_keys.suspended_until_ms/suspension_reason`); before that
migration they run in degraded mode: health still updates, but
nothing is marked suspect or suspended.

- **Catalog validation** (`src/lib/jobs/catalog-validation.ts`,
  daily 03:00 UTC): marks enabled model rows suspect, never deleting
  them: (a) rows with no successful request in 7 days (audit §B.7
  Q5, `suspect_reason = 'no_success_7d'`), and (b) rows absent from
  the upstream's model list (`'upstream_missing'`), one `GET
  {baseUrl}/models` call per platform with one enabled key. Anthropic
  has no list endpoint, so its rows are only covered by (a). At most
  50 rows are marked per run.
- **Key probe** (`src/lib/jobs/key-probe.ts`, every 30 minutes, max
  50 keys per run, stalest first): a cheap upstream call per enabled
  key that turns `last_health_check_*` into real health: `GET
  {baseUrl}/models` for OpenAI-compatible, Cohere, Cloudflare (via
  `/accounts/{id}/ai/v1/models/search`) and AI Horde, `GET
  /models?key=...` for Gemini, and a minimal `POST /messages` with
  `max_tokens: 1` for Anthropic. 401/403 marks the key `invalid` and
  runs the existing Fix C expurgo (`maybeDisableKeyAfterAuthFailures`,
  3 consecutive auth failures disables the key); 5 consecutive
  failures of any type (counted in `provider_requests`, ignoring 499
  cancellations) suspends the key for 24 h, and a good probe after
  the suspension expired clears it automatically. A 404 from the
  probe endpoint, or a network error, is not attributable to the key:
  it sets health to `error` but is not recorded and never suspends.
  Probe attempts are recorded in `provider_requests` with
  `model_routed = '__probe__'` so they stay out of per-model scoring.

Both jobs are dispatched by Cloudflare cron triggers, not by an
external scheduler: `worker/index.ts` re-exports the vinext fetch
handler and adds a `scheduled` handler
(`src/lib/jobs/scheduled.ts`) that dispatches on the cron string, and
`cloudflare.config.ts` declares the triggers
(`triggers.scheduled({ schedule: "0 3 * * *" })` and `"*/30 * * * *"`)
The build output keeps the `scheduled` export and the triggers in
`worker.config.json`. The schedules are literals in the config (that
file loads as plain Node ESM and cannot import the `@/`-aliased job
modules); `tests/jobs-scheduled.test.ts` fails if they drift from the
constants in `scheduled.ts`.

The same jobs are also reachable over HTTP for manual runs and for an
external scheduler, at `POST /api/cron/validate-catalog` and `POST
/api/cron/probe-keys`. Both require `Authorization: Bearer
<CRON_SECRET>` with the `CRON_SECRET` Worker secret
(`bun x cf secret put CRON_SECRET`); no secret configured answers
503, a wrong secret answers 401, and the comparison is constant-time
over SHA-256 digests. Each answers with its summary JSON:

```bash
curl -X POST https://shtora.cloud/api/cron/validate-catalog \
  -H "Authorization: Bearer $CRON_SECRET"
# {"checked":307,"suspected":12,"skipped":3}

curl -X POST https://shtora.cloud/api/cron/probe-keys \
  -H "Authorization: Bearer $CRON_SECRET"
# {"checked":48,"healthy":41,"invalid":2,"errored":5,"suspended":1,"reenabled":0,"skipped":0}
```

If the cron triggers are ever removed, any external cron service
(cron-job.org, for example) can call the same two endpoints on the
same frequencies: daily for validation, every 30 minutes for the
probe.

## Anthropic clients

The gateway supports native Anthropic Messages requests at `/v1/messages` and `/v1/messages/count_tokens`, plus negotiated model listing at `/v1/models` and model retrieval at `/v1/models/{model_id}`. Set `anthropic-version`; beta headers and native request fields are forwarded to Anthropic providers. The official TypeScript SDK 1.8.0 defaults to version `2026-10-21`.

Common text, tool, and supported image requests can route through compatible providers when their semantics are preserved. Native-only options and content blocks require a compatible Anthropic provider; unsupported requests return an explicit error rather than silently dropping fields. `count_tokens` requires native provider token counting; unsupported models return `invalid_request_error` rather than an estimate. Translated responses mark estimated fields with `usage.shtora_estimated.input_tokens` and `usage.shtora_estimated.output_tokens`. Native responses retain provider usage unchanged. Request bodies are limited to 1 MB; larger requests return HTTP 413.

Explicit model IDs pin requests to the matching configured model; a bare ID matches by canonical model, so `model: "qwen3-8-flash"` also finds a row stored as `free/qwen3-8-flash`, while `model: "groq/qwen3-8-flash"` stays pinned to Groq. Use `model: "shtora/auto"`, the curated router, to allow cross-model routing. A bare `model: "auto"` redirects to `shtora/auto`. Count-token requests and requests with bound native state require an explicit model.

To use a Claude model, add your Anthropic key in the dashboard first: open the Providers tab, choose Add Provider API Key, type `anthropic` in the Provider field, and paste the key. No base URL is needed; the gateway routes Anthropic requests to `https://api.anthropic.com/v1`, the base URL stored for the `anthropic` catalog provider. Then use active model IDs such as `claude-opus-5-5` or `anthropic/claude-opus-5-5`. For the official SDK, configure the gateway origin as `baseURL` (for example, `https://shtora.cloud`); the SDK appends `/v1`. Authenticate with the API key:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
	apiKey: process.env.SHTORA_API_KEY,
	baseURL: "https://shtora.cloud",
});

const message = await client.messages.create({
	model: "claude-opus-5-5",
	max_tokens: 1024,
	messages: [{ role: "user", content: "Hello" }],
});
```

Anthropic's [Messages API](https://platform.claude.com/docs/en/api/messages) and [LLM gateway guidance](https://code.claude.com/docs/en/llm-gateway) describe the upstream contract. This gateway does not provide Anthropic subscription/OAuth authentication or claim support for every Claude Code feature.

## Provider coverage

The catalog lives in D1, not in a bundled file: migration 0010 creates the `providers` table (50 providers with base URL, protocol, keyless flag, limits and the remaining runtime config) and migrations 0011–0014 upsert the 303 catalog models with clean display names, sourced from the first-party feed snapshot 2026.11.14.64a371, plus the four Anthropic models from migration 0005, registered as a catalog provider by migration 0015 (base URL `https://api.anthropic.com/v1`, protocol `anthropic_messages`). It retains 18 providers with no models (Baichuan, BeatAPI, Cerebras, Exa, Firecrawl, FreeTTS, Hugging Face, IteraCompute, Kenari, KiosAPI, Composite (Lucidity), Ollama, onomeo, Orca Router, SiliconFlow, Tavily, Together, and Xai). OpenAI is not a catalog provider; Anthropic is one, for its four direct models. The chat route uses OpenAI-compatible transports where applicable and dedicated Responses, Anthropic Messages, Gemini, Cloudflare Workers AI, AI Horde, and Moondream adapters where required.

The Gemini and Moondream adapters accept inline base64 image data URLs within the 1 MB request-body limit. Remote and `file://` image references are rejected; the Worker never fetches caller-supplied image URLs.

The feed's 491 model records comprise 466 chat, 11 image-only, and 14 audio-only rows; it separately lists 39 embedding, 13 transcription, 1 video, 4 search, and 2 decision models. These non-chat categories are not copied into `/v1/models` because this project has no corresponding public routes. The audio-only providers are Speechify and Free.ai; the five feed integrations without chat models are Pinecone, Tavily, Exa, Firecrawl, and Linkup.

Sources: [FreeLLMAPI model catalog](https://freellmapi.co/models) and [provider implementations](https://github.com/tashfeenahmed/freellmapi/tree/main/server/src/providers); [Google Gemini API](https://ai.google.dev/gemini-api/docs), [Anthropic Messages API](https://docs.anthropic.com/en/api/messages), and [Cloudflare Workers AI OpenAI compatibility](https://developers.cloudflare.com/workers-ai/openai-compatibility/).

Fresh D1 databases apply migrations 0001 through 0014 in numeric order. Migration 0003 adds the metrics schema and triggers; 0004 backfills existing attempts; 0005 adds direct Anthropic catalog and pricing data. Migration 0005 is a forward code migration and must be applied to each database before the new catalog entries are available; this change does not apply it to remote databases. Migrations 0010–0014 carry the providers table and the clean model display names (model upserts are split into four files of ~44 KB each because the D1 API rejects migration files over ~100 KB with `SQLITE_TOOBIG`). The `metrics_processed` marker lets the backfill and live insert trigger count each attempt once, even when requests arrive between migration files. Apply all unapplied migrations before deploying the code that reads the summaries — the Deploy workflow does this with `bun x cf d1 migrations apply <id> --dir migrations` before `bun run deploy`.

Use the project’s `cloudflare.config.ts` D1 ID with the installed Cloudflare CLI. From the repository root, local application is `bun x cf d1 migrations apply 5a731b04-a5ac-4897-91cd-bd212e80699b --dir migrations --local`. Production application is the same command without `--local`; it targets Cloudflare. The CLI requires the database ID, not its name or binding. Its local D1 state is separate from the Vite plugin’s `.cloudflare/state`.

`/api/usage` reports lifetime provider attempts, including failovers. Failures with NULL token counts contribute zero to totals; the estimated savings figure in the response covers successful attempts only and uses frozen per-attempt rates. No dashboard page displays the savings figure. Existing rows are backfilled using migration 0003's current rates because prior rows had no price snapshot. Valid provider counts are retained; absent or malformed counts are estimated from input text and emitted text/tool arguments.

Average latency and p95 use `latency_ms`, measured to provider response headers. P95 uses histogram bucket upper bounds; an overflow percentile falls back to one indexed exact D1 query. TTFT is averaged across streaming attempts that emitted visible content; historical TTFT is unavailable.

The 24-hour success rate and 7-day latency diagnostics remain separate from the lifetime figures above.

## Scripts

- `bun run dev` starts the vinext dev server.
- `bun run build` builds the Cloudflare Worker output.
- `bun run preview` builds the Worker and previews it locally.
- `bun run start` previews the built Worker locally.
- `bun run deploy` deploys the Cloudflare Worker.

## API key export/import

The platform provides import and export of API keys via two endpoints:

- **Export**: `GET /api/keys/export` - Returns all keys for the authenticated user in shtora-cloud format:

  ```json
  {
    "version": 1,
    "exportedAt": "2026-11-12T03:44:55.040Z",
    "source": "shtora-cloud",
    "keys": [{ "platform": "openai", "key": "sk-...", "label": "gpt-4" }]
  }
  ```

- **Import**: `POST /api/keys/import` - Accepts multiple JSON formats:
  - **Freellmapi format**: `{version, exportedAt, source, keys: [{platform, key, label?}]}`
  - **Shtora-cloud format**: `{version, exportedAt, source:"shtora-cloud", keys: [...]}`
  - **Flat map format**: `{"openai": "sk-...", "groq": "gsk-..."}`
  - **Array format**: `{keys: [{platform, key}]}` or `[{provider, apiKey}]` with field aliases

The import validates each key's platform against the known provider catalog and skips unsupported platforms or empty/invalid keys with non-secret reasons.

Request bodies are limited to 512 KB with a maximum of 500 keys. Export and import return only non-secret information (counts, skip reasons); key values are never logged or returned in error responses.
