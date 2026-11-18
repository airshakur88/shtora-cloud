---
name: npm-package-release-hardening
description: Use when releasing or publishing a JavaScript/TypeScript npm package or CLI publicly — making a package public-ready, reviewing package.json or tarball contents, setting up GitHub CI, Dependabot, security settings, or branch protection, triaging dependency-update PRs, or when an agent-built package may overstate the Node runtime it supports.
---

# npm Package Release Hardening

## Goal

Take an npm package from "works locally" to "honest, inspectable, and safe to publish." Prioritize real verification over vibes: package tarball contents, runtime contract, CI, GitHub settings, and dependency-update hygiene.

## Start Here

1. Confirm the exact repo:

```bash
pwd
git status --short --branch
git remote -v
```

2. Inspect the package surface:

```bash
cat package.json
ls -la
find .github -maxdepth 3 -type f -print 2>/dev/null
```

3. Detect the package manager from lockfiles:

- `package-lock.json` -> npm
- `pnpm-lock.yaml` -> pnpm
- `yarn.lock` -> yarn

Use npm commands below as defaults, but translate to the detected package manager when needed.

## Package Contract

Make `package.json` tell the truth:

- `name`: publish target is intentional and available
- `version`: current intended publish version
- `description`, `keywords`: useful enough for registry search
- `license`: present and matches `LICENSE`
- `repository`, `homepage`, `bugs`: point at the public repo. If the public repo URL is not final yet, flag these as an explicit pre-publish TODO rather than silently leaving them out
- `type`, `exports`, `main`, `bin`: match what users will import or run
- `files`: limits the tarball to publishable artifacts
- `engines.node`: minimum runtime the package actually supports
- `prepublishOnly` or equivalent: prevents publishing stale build output

For CLI packages, confirm the `bin` target is built, executable where relevant, and smoke-tested through the command users will run.

## Runtime Floor Rule

The Node engine is a promise, not decoration.

- If `engines.node` says `>=20`, CI must test Node 20.
- Keep `@types/node` on the same major line as the minimum supported runtime.
- Prefer exact-pinning `@types/node` to the latest patch on that runtime line.
- Do not merge `@types/node` major bumps above the runtime floor unless you also raise `engines.node`.
- `engines.node` is advisory: npm only warns and does not hard-block install unless the user sets `engine-strict`, so CI on the floor version is what actually enforces the promise.

Why: Node types are dev-only, but they change what TypeScript allows. `@types/node@26` can let code compile while using APIs that fail for users on Node 20.

## Verification Commands

For npm projects:

```bash
npm ci
npm run build --if-present
npm test --if-present
npm audit --omit=dev
npm pack --dry-run
```

For pnpm/yarn, use the equivalent install/build/test/audit/pack commands. If audit support differs, say so instead of pretending.

For CLIs, also run at least one outside-in smoke test:

```bash
node dist/path/to/cli.js --help
npm pack --dry-run
```

If practical, install the packed `.tgz` in a temp directory and run the binary exactly as a user would.

## Tarball Review

`npm pack --dry-run` is the registry truth surface. Check for:

- includes built output
- includes `README.md` and `LICENSE`
- excludes source-only junk, temp files, tests, private docs, fixtures, local databases, secrets
- package size is reasonable
- CLI `bin` path appears in the tarball

If `files` is missing, add it. Do not rely on `.gitignore` as publish policy.

## GitHub Baseline

Add or verify:

- `.github/workflows/ci.yml`
- `.github/dependabot.yml`
- `.github/CODEOWNERS`
- `.github/pull_request_template.md`
- `SECURITY.md`

Use current supported major versions for GitHub-owned actions. If Actions warns that an action runtime is deprecated, update the action major after CI passes.

CI should usually include:

```yaml
permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@CURRENT_MAJOR
      - uses: actions/setup-node@CURRENT_MAJOR
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build --if-present
      - run: npm test --if-present
```

Adjust `node-version` to the package's minimum supported runtime, and replace each `@CURRENT_MAJOR` with the action's current major tag (for example `actions/checkout@v4`) — pin to a real major, never commit the placeholder.

## Dependabot Baseline

Configure both package and GitHub Actions updates:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    commit-message:
      prefix: deps
      include: scope

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    commit-message:
      prefix: deps
      include: scope
```

When Dependabot opens PRs immediately after config lands, treat that as proof the config is live. Triage the PRs; do not blindly merge all green checks.

## Dependabot Triage

Use this rule of thumb:

- Runtime dependency patch/minor: merge if checks pass and release notes are boring.
- Runtime dependency major: inspect release notes and smoke-test real package behavior.
- Dev tooling major: merge if build/test/pack pass and it does not alter the runtime contract.
- `@types/node` above the runtime floor: close or replace with a pin to the runtime floor.
- GitHub Actions major: merge if CI passes and it removes deprecation warnings.

If two PRs conflict in a small config file, merge one and update the other, or apply the second directly with a clear comment explaining it was superseded.

## GitHub Remote Hardening

Apply what the repo/account supports, then verify the actual settings with `gh` or API reads.

Useful settings:

```bash
gh repo edit OWNER/REPO \
  --delete-branch-on-merge \
  --enable-squash-merge \
  --enable-merge-commit=false \
  --enable-rebase-merge=false \
  --allow-update-branch

gh api --method PUT repos/OWNER/REPO/vulnerability-alerts --silent
gh api --method PUT repos/OWNER/REPO/automated-security-fixes --silent
gh api --method PUT repos/OWNER/REPO/actions/permissions/workflow \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=false --silent
```

For Actions allowlists, prefer GitHub-owned actions only when the workflow uses only GitHub-owned actions. If third-party actions are required, explicitly allow the smallest set.

Public repos usually unlock more security controls. Private repos on free plans may block:

- branch protection or rulesets
- code scanning
- secret scanning
- push protection

Call blockers out plainly. Do not report unavailable controls as enabled.

## Branch Protection

When available, protect the default branch with:

- require pull request before merging
- require CI status checks
- require branches to be up to date if that fits the project
- require conversation resolution
- block force pushes
- block deletions
- require linear history if using squash-only merges

After enabling protection, stop direct-pushing to `main` unless the user explicitly asks and understands the bypass.

## Gated PR Tools

If using an automated review/gate tool, make sure the remote has a default/base branch before asking the gate to create a PR. Empty new remotes often need an initial `main` push first; otherwise the gate can validate and push a feature branch but fail PR creation because there is no base ref.

## Publish Checklist

Before `npm publish`:

- `npm whoami` shows the intended account
- `npm view PACKAGE_NAME name version` confirms name state
- CI is green on the commit being published
- `npm pack --dry-run` has been reviewed
- README install/use examples match actual behavior
- `repository`, `homepage`, and `bugs` resolve to the real public repo (or are explicitly flagged as TODO if the URL is not final)
- no release-blocking Dependabot/security alerts remain
- version bump is intentional, tagged in git (`git tag vX.Y.Z && git push --tags`), and reflected in a CHANGELOG or GitHub release
- scoped packages (`@scope/name`) publish with `--access public` (scoped packages default to restricted/private)

For accounts using web/passkey/2FA auth:

```bash
npm publish --auth-type=web
```

Prefer publishing from CI with provenance for a verifiable supply-chain link. Provenance requires a public package, a supported CI such as GitHub Actions, and `id-token: write` permission on the job:

```bash
npm publish --provenance --access public
```

After publish:

```bash
npm view PACKAGE_NAME version
npm view PACKAGE_NAME bin files engines repository --json
npx -y PACKAGE_NAME --help
```

If published with provenance, confirm the registry shows the provenance / "Built and signed" attestation on the package page.

## Final Response

Report only what was actually verified:

- package checks run
- tarball result
- dependency PR decisions
- commits/PRs created or merged
- GitHub settings confirmed
- controls blocked by plan/visibility
- release tag and provenance status, if published
- publish command or post-publish verification if still user-owned
