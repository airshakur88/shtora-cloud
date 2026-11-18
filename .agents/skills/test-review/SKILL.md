---
name: test-review
description: "Review pytest tests against the high-value rubric — focused, deterministic, readable, fast, behavior-bound. Flags AI-generated anti-patterns (mocks-the-SUT, patch-at-definition, raw floats, non-deterministic inputs) with file:line references and rewrite suggestions. Use before merging AI-generated tests, during PR review, or to audit a suite for rot."
---

# Test Review

Audit the pytest tests in this repo. Grade each test against the keep-or-delete checklist. Produce a prioritized finding list with file:line, severity, and concrete rewrite suggestions.

Scope: Python / pytest only.

## Step 1: Locate the test suite

1. **Find the pytest config root.** Locate the directory containing `pyproject.toml`, `pytest.ini`, `setup.cfg` with `[tool:pytest]`, or `tox.ini` with `[pytest]` — closest to the tests. In a single-package repo this is the repo root. In a monorepo or mixed-language repo, the Python package may live in a subdirectory (seen in the wild: `backend/`, `server/`, `api/`, `python/`, `src/`). Do not assume a name — discover it.

2. **Pick the pytest invocation prefix.** From the config root, check in order:
   - `uv.lock` or `[tool.uv]` → `uv run pytest`
   - `poetry.lock` or `[tool.poetry]` → `poetry run pytest`
   - `Pipfile.lock` → `pipenv run pytest`
   - `.venv/bin/pytest` or `venv/bin/pytest` present → use that absolute path
   - fallback: bare `pytest`
   
   If the config root is not the repo root, prefix the command with `cd <config-root> && `. Record the full prefix for later steps. Do NOT run tests in this skill — the prefix is stored in case `--fix` needs to verify.

3. **Glob test files.** If `$ARGS` is a path or glob, use that. Otherwise prefer `[tool.pytest.ini_options].testpaths` from `pyproject.toml` (or `testpaths` from `pytest.ini`). If unspecified, fall back to `**/test_*.py **/*_test.py` under the config root.

4. **Read nearest conftest files.** Walk up from each test file to the config root. Collect fixture names and note any existing autouse safety rails (network block, frozen clock, random seed, fs isolation). This is needed for finding `safety-rail gaps`.

## Step 2: Spawn reviewer agents in parallel

Batch test files into groups of ~5 and spawn one reviewer agent per batch using the Agent tool (general-purpose or Explore subagent). Agents run in parallel. Prompt:

```
You are a pytest quality reviewer. Read the test files listed below and
return structured findings against the high-value-tests rubric.

Files:
  <list>

Repo conventions:
  - pytest invocation prefix: <prefix>
  - known conftest fixtures in scope: <names>
  - existing autouse safety rails: <network/clock/random/fs — which are installed>

For each test, grade against:
  1. Does the name describe a behavior, not a function?
  2. If internals were refactored correctly, would this stay green?
  3. Is it deterministic — no real time, network, randomness, or FS?
  4. Does failure produce a message that tells you what broke?
  5. Does it patch boundaries, not the unit under test?
  6. Would anyone notice if it were deleted?

Flag the anti-patterns below. For each finding report:
  severity (HIGH/MEDIUM/LOW), file:line, test_name, smell (short label),
  evidence (2-5 lines of code), why_it_matters (one sentence),
  suggested_fix (sketch, or "delete" if the test proves nothing).

## HIGH severity
  - mocks-the-SUT: patch target is the same function/method the test
    claims to exercise.
  - patch-at-definition: patch("lib.x.Y") when the SUT does
    `from lib.x import Y` — patches the wrong name.
  - asserts-private-state: reads `_field`, `__dict__`, cached internals.
  - float-equals-without-approx: `assert <float> == <float-literal>` with
    no `pytest.approx`.
  - non-deterministic: datetime.now, time.time, random.* without seed,
    uuid.uuid4, requests/httpx/urllib/socket without patch, when no
    corresponding autouse safety rail is installed.
  - real-filesystem-write: `open("/tmp/...", "w")`, writes outside
    `tmp_path` / `tmpdir`.

## MEDIUM severity
  - over-specified-call-assertion: assert_called_with(...) with ≥3 kwargs
    AND the test already asserts return/side effects.
  - no-autospec: `patch(...)` lacking `autospec=True` or `spec=`.
  - kitchen-sink: multiple Act phases or >20-line test body.
  - weak-name: <3 underscore-separated words OR no behavior clause.
  - silent-skip: `@pytest.mark.skip` without `reason=`, or
    `@pytest.mark.xfail` without `strict=True`.
  - session-scope-under-xdist: `@pytest.fixture(scope="session")` with
    observable side effects (DB migrations, port binding, shared files,
    external-service seeding) when `pytest-xdist` is in addopts, CI
    config, or present as a dev dependency. Each xdist worker is a
    separate process, so session fixtures run ONCE PER WORKER, not
    once per session — producing races, port conflicts, duplicate
    migrations, and intermittent setup failures. Fix: use a lock-file
    pattern on `tmp_path_factory.getbasetemp().parent`, or use
    `pytest-shared-session-scope`.

## LOW severity (style)
  - copy-paste-parametrize: duplicate tests differing only in literals.
  - duplicate-setup: fixture-worthy setup repeated across files.
  - unittest-TestCase: subclass using only plain assertions.
  - caplog-text-substring: `assert "..." in caplog.text` — prefer
    `caplog.record_tuples` (list of `(logger_name, level, message)`
    tuples) when the contract includes the logger name or level.
    `caplog.text` assertions are brittle to formatter changes and
    silently miss "logged at the wrong level" bugs. Use `caplog.text`
    only when substring-matching a rendered message is genuinely
    the contract.

Positive observations: briefly note any test files that cleanly pass
the checklist — this keeps the signal calibrated.

Output a single markdown report, grouped by severity. Do not edit files.
Do not run tests. Do not invent contracts — if a test asserts on
behavior you cannot verify from the source, write "contract unclear."
```

## Step 3: Aggregate & present

Merge all agent reports into a single prioritized report:

```
## Summary
 - Reviewed: <N> tests across <M> files
 - Findings: <H> HIGH, <M> MEDIUM, <L> LOW
 - Safety-rail gaps: <list of missing rails — network/clock/random/fs>
 - Overall: <one-sentence assessment>

## HIGH
### <file>:<line> — test_<name> — <smell>
Evidence:
    <code>
Why it matters: <sentence>
Suggested fix: <sketch, or "delete">

## MEDIUM
...

## LOW
(consolidated where fixable by a single conftest change)

## What's working
 - <file>: cleanly passes the rubric.

## Next steps
 - If safety-rail gaps exist, suggest running python-test-quality:test-harden.
 - If HIGH findings are AI-generated, suggest adding the rubric to the
   team's AI prompt (see slide 33 / the `/test-write` skill).
 - If the suite mocks an HTTP client (requests, httpx, urllib3) to an
   external service, consider a consumer-driven contract test (Pact,
   or a nightly integration run against the real service) — autospec-
   checked mocks validate only the local client's shape, not the
   external service's schema, status codes, or error payloads.
 - If the suite has HIGH coverage but you are uncertain whether tests
   actually catch bugs, run mutmut or cosmic-ray periodically
   (nightly CI or on-demand). Mutation score quantifies assertion
   gaps that line coverage cannot detect. Runs are slow (hours-to-
   overnight on a non-trivial suite), so treat this as a periodic
   audit, not a PR gate.
```

**Consolidate repeated smells.** If 12 tests all lack `autospec=True`, emit one MEDIUM finding listing all 12 — not 12 separate findings.

**Budget.** If there are >30 findings, keep all HIGH + top 10 MEDIUM; summarize LOW as counts by smell.

## Step 4: Apply safe fixes (only if `--fix` in $ARGS)

Apply only the mechanical rewrites below. Any other rewrite stays as a suggestion, not an edit.

1. `@pytest.mark.skip` → add `reason="TODO: <file>:<line>"` placeholder.
2. `@pytest.mark.xfail` → add `strict=True`.
3. Float `==` literal → wrap RHS in `pytest.approx(..., rel=1e-6)`.
4. `patch("…")` where the target is importable at collection time → add `, autospec=True`.
5. `pytest.raises(Exc)` followed by `assert "..." in str(excinfo.value)` → rewrite as `pytest.raises(Exc, match="...")`.

After applying, run `<prefix> -q` on the affected files. Report any test that broke (it was depending on the un-fixed behavior). Show a diff summary.

## Rules

- **Static review only** unless `--fix`. Do not run tests by default.
- **Do not edit production code.** Findings are against test files only.
- **Do not delete tests** — mark them `delete` in suggested_fix and let the author decide.
- **Do not lower coverage thresholds** to hide findings.
- **Consolidate.** Ten identical smells with one fix = one finding, not ten.
- **Do not invent contracts.** If the SUT source is ambiguous about what a test should pin, say so; do not guess.

## Anti-goals

- Do not grade style in isolation (line length, import order) — `ruff` already does that and this skill's output is about semantics.
- Do not recommend retry plugins (`pytest-rerunfailures`) as a fix for flaky tests. Flakes are a determinism bug; see `python-test-quality:test-harden`.
