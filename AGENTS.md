# SHTORA-CLOUD Agent Guidelines

## Mission

This document defines the operating principles, workflows, and conventions for AI agents working on the **shtora-cloud** project. The project is a Next.js 14+ App Router application built with vinext (Next.js on Cloudflare Workers via Vite) using bun as the package manager.

---

## 🚨 CRITICAL USER RULES (MUST FOLLOW)

### Core Toolchain Rules

1. **NEVER use npm/npx - ALWAYS use bun**. Exception: skills CLI uses bunx skills. Use `bun x` to run dev tools (Biome, TypeScript, `cf`).
2. **ALWAYS run lints after modifications** - `bun run lint` must pass before completing any change.
3. **ALWAYS verify for bugs, dead code, duplicates, inconsistencies** after changes.
4. **NEVER modify components in [src/components/ui]** - these are shadcn/ui components.
5. **NEVER use img/a tags for links/images** - MUST use next/link and next/image.
6. **NEVER use `<input type="number">`** — MUST use the project's `InputNumber` component (`import { InputNumber } from "@/components/ui/input-number";`) for all numeric input fields. Native number inputs do not enforce min/max clamping or provide accessible increment/decrement controls.

### Pre-Task Protocol

7. **BEFORE tasks: perform detailed study via MCP, docs, references**. Research thoroughly before implementing.

### Quality Gate Rules

8. **AI SLOP IS PROHIBITED** - always use anti-ai-slop skills after modifications.
9. **ALWAYS use anti-ai-slop, best-practices, organization, cleanup skills available** - apply relevant skills for each task.
10. **ALWAYS use verification checklist for every change**:
    - Run `bun run lint` (Biome + TypeScript)
    - Check for dead code and unused imports
    - Verify no duplicated logic
    - Run anti-ai-slop cleanup
    - Confirm all tests pass

### Maintenance Standards

11. **Keep project clean** - no logs, trash, or any junk. Clean up temporary files and artifacts.
12. **Update documentation when completing tasks** - maintain accurate docs for all changes.

---

## Project Context

- **Framework**: Next.js 14+ App Router with vinext (Vite + React Server Components)
- **Runtime**: Cloudflare Workers with `nodejs_compat` flag
- **Package Manager**: Bun 1.4.4 (never npm/npx)
- **Language**: TypeScript with `@/*` path alias
- **Styling**: Tailwind CSS + shadcn/ui components
- **Linting**: Biome 2.6.8 + TypeScript
- **Deployment**: Cloudflare via `cloudflare.config.ts`

## O que é este site

O shtora-cloud é um agregador comunitário de modelos de IA rodando em Cloudflare
Workers (vinext). Ele reúne os modelos gratuitos de vários provedores upstream
(no catálogo atual: modelos `:free` e provedores keyless como OVH, AI Horde e
Kilo) atrás de uma única conta. O usuário se registra com usuário e senha, guarda
as chaves dos provedores em `/api/keys` (criptografadas em repouso com
`ENCRYPTION_SECRET`) e recebe uma API key, que autentica os endpoints
públicos compatíveis com OpenAI (`/v1/chat/completions`) e Anthropic
(`/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`) via
`Authorization: Bearer <token>` ou `x-api-key`.

**Pool de chaves comunitário**: toda chave habilitada entra num pool compartilhado
entre todos os usuários (`getEnabledKeysForPlatform` em `src/lib/key-store.ts`
retorna todas as chaves habilitadas da plataforma, com as do próprio usuário
primeiro). O roteador (`src/lib/router.ts`) percorre pool × cadeia de modelos até
um upstream aceitar; falha de provedor faz failover transparente e é registrada
em `provider_requests` (que guarda `user_id` de quem pediu e `key_id` de quem
atendeu), nunca exposta ao cliente. Cada chave continua aplicando seus próprios
limites (rpm/tpm/rpd/tpd em `src/lib/ratelimit.ts`), então compartilhar soma
capacidade total sem remover limites individuais.

**Roteamento por modelo canônico**: modelos são endereçados como
`shtora/<modelo>` (roteia entre todos os provedores daquele modelo lógico, ver
`src/lib/model-canonical.ts`). A API `/api/dashboard/catalog` retorna modelos
agrupados por ID canônico — um único entry por modelo lógico, mesmo quando ele
existe em múltiplos provedores. O playground armazena o modelo escolhido na
sessão como `shtora/<canonical>` e normaliza IDs antigos ao carregar a página.

O endpoint público `GET /v1/models` lista apenas os modelos dos provedores com
ao menos uma chave API habilitada no pool comunitário (consulta
`api_keys WHERE enabled = 1`), seguindo o mesmo critério de roteamento do
router — modelos de provedores sem chave habilitada não aparecem.

**Failover silencioso**: erros de upstream (400, 500, timeouts, rate limits) são
registrados internamente mas nunca retornados ao cliente. O roteador tenta o
próximo provider/key na cadeia automaticamente. Somente quando **todos** os
provedores disponíveis falham o cliente recebe um erro genérico HTTP 502 com a
mensagem "All configured upstream providers are unavailable." — detalhes internos
como mensagens de erro do upstream ou nomes de chaves não vazam.

**Playground sessions**: sessões vivem no banco D1 (`playground_sessions`).
Cada sessão tem um `model_id` que aponta para o modelo canônico selecionado.
Alterar o modelo em uma sessão ativa atualiza o campo via PATCH sem criar nova
sessão. Ao enviar mensagem, o backend valida a sessão e roteia o request através
do router independente do provedor original.

O dashboard tem playground (sessões de chat com anexo de imagens no bucket R2
`shtora-images`, máx. 10 MB e 10 imagens por mensagem), catálogo de modelos,
gerenciamento de chaves e uma página de quarentena (`/dashboard/quarantine`)
que lista as chaves em cooldown e permite liberá-las. Não há área admin no
painel: ela foi removida no commit 2e4a24f e não existe página de usuários ou
estatísticas no dashboard.
As métricas de uso/latência/economia ficam em `src/lib/usage-metrics.ts`.

- **Auth pages** (`/login`, `/register`) compartilham `src/components/auth-shell.tsx`
  e usam o tema escuro da landing (`bg-background`/`bg-card`, acento copper
  `primary`) via classe `dark` no root — visualmente consistentes com a landing.
  Usam shadcn/ui `Input`/`Label`/`Button` (nunca inputs raw) e `next/link`.
- **Landing page** (`src/app/page.tsx`): o conteúdo (contagens de
  provedores/modelos) é lido do D1 em tempo de requisição
  (`export const dynamic = "force-dynamic"`), então se atualiza sozinho
  quando o catálogo no banco muda. `RoutingMap` e
  `IntegrationCode` ficam em `src/components/landing-experience.tsx`.

---

## Available Skills & Usage

### Core Development Skills

| Skill                          | When to Use                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| **nextjs-app-router-patterns** | App Router conventions, Server/Client components, Layout patterns, Loading UI, error.tsx |
| **nextjs-react-typescript**    | React component patterns with TypeScript, hooks, prop types                              |
| **clean-code**                 | Code readability, naming conventions, function complexity, comments                      |
| **code-review**                | Reviewing changes before merging, PR quality checks                                      |
| **refactoring-patterns**       | Extracting functions, reducing complexity, removing duplication                          |

### Quality & Maintenance Skills

| Skill                            | When to Use                                                           |
| -------------------------------- | --------------------------------------------------------------------- |
| **anti-ai-slop**                 | After any modification to remove AI-written patterns, improve clarity |
| **anti-slop-engineering**        | Removing unnecessary abstractions, simplifying builds                 |
| **anti-slop-code**               | Cleaning up code smells, dead code, over-engineering                  |
| **codebase-cleanup**             | Tech debt removal, dead code elimination, cleanup passes              |
| **codebase-design**              | Module interface design, seam placement, testability                  |
| **performance-optimization**     | Profiling bottlenecks, optimizing hot paths                           |
| **debugging-and-error-recovery** | Diagnosing and fixing runtime failures                                |

### Pre-Modification Protocol

Before any significant work:

1. Read relevant source files
2. Study patterns through MCP docs (`mcp://context7_query_docs` for frameworks)
3. Understand existing conventions in the codebase

---

## Coding Standards

### File & Directory Structure

```
src/
├── app/           # App Router pages and layouts
│   ├── layout.tsx # Root layout
│   ├── page.tsx   # Default page
│   └── api/       # Route handlers (Route App Router)
├── components/    # Project-specific components
│   └── ui/        # SHADCN/UI components (NEVER modify)
├── hooks/         # Custom React hooks
└── lib/           # Utility functions, helpers
```

### TypeScript Conventions

- **Strict mode**: Enabled (`strict: true` in tsconfig.json)
- **Type imports**: Use `import type { }` for type-only imports
- **JSX**: `preserve` - use TSX syntax
- **Module system**: ES modules (`type: module`)
- **Path alias**: `@/*` resolves to `./src/*`

### Component Patterns

- **Server Components**: Default. Return JSX directly.
- **Client Components**: Mark with `"use client"` at top
- **Props**: Always use TypeScript interfaces/types

```typescript
interface Props {
	title: string;
	count?: number;
}

export default function MyComponent({ title, count = 0 }: Props) {
	// ...
}
```

### Links & Images

**MUST** use vinext equivalents:

- **Links**: Use `next/link` (or vinext equivalent) - never `<a>` tags outside anchor context
- **Images**: Use `next/image` (or vinext equivalent) for optimizeable assets

```tsx
// ✅ Correct
import Link from "next/link";
<Link href="/path">Go to path</Link>;

import Image from "next/image";
<Image src="/image.png" alt="description" width={100} height={100} />;

// ❌ Never use raw <a> or <img> for navigable/display content
```

---

## Development Workflow

### Available Scripts (package.json)

```bash
# Development
bun run dev              # Start vinext dev server
bun run build            # Build Cloudflare Worker output
bun run preview          # Preview built output locally

# Deployment
bun run deploy           # Deploy to Cloudflare Workers

# Verification
bun run lint             # Run Biome + TypeScript checks
bun run cf-typegen       # Generate Cloudflare types
```

### Package Manager

- **ALWAYS use bun** - never npm/npx
- **Biome** is the linter/formatter of record
- Scripts in package.json use `bun x` for dev tool execution

---

## Configuration Files

### Cloudflare Configuration: `cloudflare.config.ts`

**ONLY** this file is used for deployment configuration.

```typescript
import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
	worker: defineWorker({
		name: "shtora-cloud",
		entrypoint: "vinext/server/fetch-handler",
		compatibilityDate: "2026-11-12",
		compatibilityFlags: ["nodejs_compat"],
		assets: {
			htmlHandling: "none",
			notFoundHandling: "none",
			runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
		},
		env: {
			ASSETS: bindings.assets(),
			IMAGES: bindings.images(),
		},
	}),
});
```

**NEVER** use `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml`.

### Vite Configuration: `vite.config.ts`

Configured for vinext with images optimizer and Cloudflare plugin.

### Biome Configuration: `biome.json`

- **Formatter**: Enabled, tab indentation, double quotes
- **Linter**: Recommended rules preset
- **Assist**: Import organization on save

---

## Linting & Verification Protocol

### Pre-Commit Checklist

1. **Run lint**: `bun run lint` (Biome check + TypeScript)
2. **Verify no dead code**: Check for unused exports/imports
3. **Check for duplicates**: No duplicated logic or components
4. **Anti-slop review**: Run anti-ai-slop and anti-slop-code

### Lint Command

```bash
bun run lint
```

This runs:

- `bun x biome check --write` - Biome formatter and linter
- `bun x tsc --noEmit` - TypeScript type checking

---

## Deployment Workflow

### Local Development

```bash
bun run dev
```

### Production Build

```bash
bun run build
```

### Preview

```bash
bun run preview
```

### Deploy to Cloudflare

```bash
bun run deploy
```

### Verify Deployment

- Check Cloudflare dashboard for Worker status
- Verify routes respond correctly
- Test API endpoints

---

## Anti-Slop Policies

### AI Slop Prohibition

AI-generated code patterns are NOT acceptable. Signs of slop:

- Generic boilerplate without purpose
- Over-abstracted patterns for simple tasks
- Unnecessary comments or verbose prose in code

**Remediation**: Apply `anti-ai-slop` skill after any modification.

### Code Cleanup Rules

- Delete dead code (unused functions, imports, variables)
- Remove duplicate implementations
- Simplify over-engineered abstractions
- Prefer explicit over implicit behavior

---

## Debugging Protocol

### Common Issues

1. **Build failures**: Check TypeScript errors first, then Biome
2. **Worker failures**: Check logs in Cloudflare dashboard
3. **Route issues**: Verify `runWorkerFirst` patterns in config

### Debug Workflow

1. Reproduce locally with `bun run dev`
2. Check Cloudflare logs for production issues
3. Verify TypeScript types with `bun run lint`

---

## Testing & Verification

### Run Tests

```bash
bun test
```

### CI/CD Pipeline

O workflow de deploy na main (`.github/workflows/deploy.yml`) roda estes
passos, nesta ordem, um deploy por vez (`concurrency: group: deploy`, sem
cancelar um deploy em curso):

1. Checkout, Setup Bun e `bun install --frozen-lockfile`
2. Lint (`bun x biome check`, só leitura, sem `--write`)
3. Type check (`bun x tsc --noEmit`)
4. Tests (`bun test`)
5. Migrations D1 (`bun x cf d1 migrations apply <id> --dir migrations`),
   antes do deploy
6. Build e deploy (passo `Build & Deploy`, `bun run deploy`)

Se um passo falha, os passos seguintes não rodam e nada vai para produção.

---

## Model Catalog

O catálogo vive **unicamente no D1** — não existe mais JSON de catálogo no
repo. Duas tabelas:

- **`providers`** (migração 0010): uma linha por provedor (`id`, `name`,
  `baseUrl`, `authType`, `protocol`, `description`, `keyless`, `keyHint`,
  `extraHeaders`, `forceSingleToolCall`, `modelIdentity`, `modelAliases`,
  `electronHubProxyError`, `ensureDone`, `limits` como JSON). É a única fonte
  da config de runtime que o roteador usa (`src/lib/provider-catalog.ts` lê
  daqui via `getDb()`; nunca importe config de provedor de outro lugar).
- **`models`**: uma linha por (provedor, modelo). O `name` guardado já é o
  nome limpo — sem o sufixo " (Provedor)" (migrações 0011–0014 aplicam o
  `displayModelName()` de `src/lib/model-canonical.ts`; 11 nomes mantêm o
  parêntese de propósito: datas de versão, FP4, OVH safety). As rotas
  mantêm o `displayModelName()` ao servir como defesa, mas o banco já guarda
  o nome limpo.

- **Fonte original**: `https://freellmapi.co/models` — a página renderiza de
  `window.CATALOG_SNAPSHOT` embutido em `https://freellmapi.co/assets/data.js`
  (o mesmo bundle que o site exibe). Feed alternativo:
  `https://api.freellmapi.co/v1/latest` (JSON; pode estar um snapshot à frente
  do bundle da página). Snapshot atual no banco: `2026.11.14.64a371`
  (50 provedores, 307 modelos, 32 com modelos; os 4 modelos Anthropic da
  migração 0005 são provedor do catálogo desde a migração 0015).
- **Atualizar o catálogo**: escreva uma NOVA migração (nunca edite as
  aplicadas). Para cada provedor/mudança: `INSERT INTO providers ... ON
  CONFLICT(id) DO UPDATE ...` e `INSERT INTO models ... ON CONFLICT(platform,
  model_id) DO UPDATE ...` no mesmo formato das 0011–0014, sem tocar em
  `enabled` nem em nenhuma outra tabela. Gere os modelos a partir do feed:
  `modelId → id`, `displayName → name` (limpo com `displayModelName()`),
  `contextWindow ?? 0`, `supportsTools → supportsFunctions` + `"tools"`,
  `supportsVision → "vision"`, `intelligenceRank ?? 0`. Vocabulário de
  capabilities: `"chat"` para texto, senão a string da modalidade (`"audio"`,
  `"image"`, `"video"`).
- **Limite de tamanho de migração**: o `cf d1 migrations apply` envia cada
  arquivo como um único lote e o D1 rejeita arquivos acima de ~100 KB
  (`SQLITE_TOOBIG`). Mantenha cada arquivo de migração com dados abaixo de
  ~50 KB — as 0011–0014 têm ~44 KB cada (76 modelos por arquivo). A migração
  0006, com 60 KB, é o maior arquivo anterior que já foi aplicado.
- **Aplicar migrations**: local `bun x cf d1 migrations apply
  5a731b04-a5ac-4897-91cd-bd212e80699b --dir migrations --local`; produção é
  o mesmo comando sem `--local`. O workflow de deploy (`.github/workflows/
  deploy.yml`) aplica as migrations antes do `bun run deploy` e falha o job
  se a migração falhar — nunca deployar com o banco desatualizado.
- **Seed**: `bun run scripts/seed.mjs` aplica `migrations/*.sql` em ordem
  (local: arquivo SQLite em `LOCAL_D1_PATH`, padrão `./.dev-d1.sqlite`;
  remoto: binding D1) e depois garante settings padrão, fallback chain e o
  admin inicial. O seed não lê mais catálogo nenhum — as migrations são a
  única fonte.
- **Preservar a config de runtime por provedor** (o snapshot do site não
  publica): `baseUrl`, `authType`, `protocol`, `keyless`, `keyHint`,
  `modelIdentity`, `extraHeaders`, `forceSingleToolCall`, `modelAliases`,
  `electronHubProxyError`, `ensureDone`.
- **Provedores extras fora do site** (BYOK + importação de chave): `cerebras`,
  `together`, `xai`, `bai`, `huggingface`, `ollama`, `orcarouter`. (`openai`
  não é provedor do catálogo; `anthropic` é provedor desde a migração 0015;
  os protocolos de endpoint OpenAI-compatível e Anthropic permanecem
  suportados para roteamento.)
- **Rate-limit defaults**: a coluna `limits` de `providers` guarda os
  `limits.rpm/rpd/tpm/tpd` por provedor (mínimo entre os modelos quando
  variam; valor exato quando idênticos). No `POST /api/keys`, o limite
  informado pelo usuário vence; senão vale o da tabela. Sem nenhum dos dois,
  `src/lib/ratelimit.ts` aplica os defaults (rpm 60, tpm 200.000, rpd 5.000,
  tpd 5.000.000). Linhas existentes no banco mantêm os valores definidos
  manualmente até uma migração sobrescrevê-los.
- **Key format reference** (key prefixes seen upstream): `sk-` generic, `sk-air-` airforce, `sk-bl-` bazaarlink, `sk-or-v1-` openrouter, `sk-orca-` orcarouter, `sk-speka-live-` speka, `sk-xt-` xkiro, `mstrl_` mistral, `nvapi-` nvidia, `fc-` firecrawl, `tvly-dev-` tavily, `hf_` huggingface, `rqsty-sk-` requesty, `rc-` radeon, `ek...` aihorde/electronhub, `AQ.Ab8...` google cloud project key, `email:token` cloudflare, `id.secret` zhipu/ollama-cloud, plus merged from freellmapi-keys.json export (2026-11-17): `blaze-` blaze, `dp-` dreamprompting, `sk-free-` freeai, `inf_` inferbase, `llmtr-` llmtr, `lfu_` logfare, `sk-r9k-` router9, `sk-onomeo-` onomeo, `cmp-` lucidity, `kn-` kenari, `kios_live_` kiosapi, `ick_live_` iteracompute, `ft_live_` freetts. Extra chat providers merged from that export: airforce, blaze, dreamprompting, electronhub, freeai, inferbase, llmtr, logfare, moondream, radeon, router9, routeway, speka, xkiro, beatapi, iteracompute, kenari, kiosapi, lucidity, onomeo, siliconflow, exa, firecrawl, tavily, freetts.

---

## Troubleshooting

### Build Errors

1. Ensure `nodejs_compat` flag is set in `cloudflare.config.ts`
2. Check for TypeScript errors: `bun x tsc --noEmit`
3. Verify all dependencies are installed: `bun install`

### Deployment Failures

1. Check Cloudflare dashboard for error details
2. Verify `wrote` package is correctly configured
3. Ensure the Cloudflare CLI is up to date: `bun x cf --version`

---

_Last updated: 2026-11-13_
