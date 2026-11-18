# npm-package-release-hardening

An **agent skill** that takes a JavaScript/TypeScript npm package from "works locally" to "honest, inspectable, and safe to publish." It prioritizes real verification over vibes — tarball contents, runtime contract, CI, GitHub settings, and dependency-update hygiene.

Built for the [Agent Skills](https://agentskills.io) open standard, so it works in **any skills-compatible agent** — Claude Code, Codex, Cursor, Gemini CLI, OpenCode, and [many more](https://agentskills.io/clients).

![npm pack --dry-run on an agent-built package — a .env and a local database are about to be published to the public npm registry](secret-leak.gif)

> Without a `files` allowlist, `npm publish` ships whatever is in the folder — including secrets. This skill catches it before it leaves your machine.

## Why

Agent-built packages tend to fail in quiet, expensive ways at publish time:

- They ship secrets — a stray `.env` or local `.db` ends up in the npm tarball because there's no `files` allowlist.
- They lie about runtime support — `engines.node` says `>=20` while `@types/node@26` lets the code compile against APIs that don't exist on Node 20.
- They publish junk — `src/`, `tests/`, fixtures, and build scratch all ride along.
- They claim hardening that never happened — "branch protection enabled" on a repo with no remote.

This skill makes the cheap, safe, honest path the obvious one — and, just as importantly, refuses to report controls as enabled when they weren't.

## Install

```sh
npx skills add SSBrouhard/npm-package-release-hardening
```

Or install manually by copying `SKILL.md` into your agent's skills directory (e.g. `~/.claude/skills/npm-package-release-hardening/` for Claude Code, or your client's equivalent — see your tool's skills docs).

## What it checks

- **Package contract** — `name`, `version`, `license`, `repository`/`homepage`/`bugs`, `exports`/`bin`, `files`, `engines.node`, `prepublishOnly`.
- **Runtime floor rule** — keeps `@types/node` on the minimum supported Node line; blocks type-only majors that would let code compile against unsupported APIs.
- **Verification** — `npm ci` / build / test / `npm audit --omit=dev` / `npm pack --dry-run`, plus an outside-in CLI smoke test.
- **Tarball review** — confirms built output ships and secrets, tests, fixtures, and local databases do not.
- **GitHub baseline** — CI, Dependabot, CODEOWNERS, PR template, SECURITY.md, branch protection, and remote security settings — applied only where the repo/plan actually supports them.
- **Publish path** — provenance, scoped `--access public`, tag + release, and honest post-publish verification.

## Honesty by default

The skill is explicit that an agent must **report only what it actually verified** and **call out controls blocked by plan or visibility** instead of claiming them. That single rule is what makes its output trustworthy.

## License

[MIT](LICENSE) — © 2026 SSBrouhard. Contributions and issues welcome.
