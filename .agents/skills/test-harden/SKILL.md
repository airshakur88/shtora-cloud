---
name: test-harden
description: "Install determinism safety rails in a pytest suite — autouse conftest fixtures that block real network, freeze the clock, seed randomness, and redirect HOME/XDG to tmp_path. Audits existing flaky patterns. Use once per repo to make the suite deterministic by default; essential before handing the repo to an AI agent that runs pytest in a loop."
---

# Test Harden

Install an autouse `conftest.py` that makes the pytest suite deterministic by default. Audit existing tests for the flaky patterns the new rails would catch.

Scope: Python / pytest only.

## Step 1: Locate the test package

1. **Find the pytest config root** (same logic as `test-review`): the directory containing `pyproject.toml`, `pytest.ini`, `setup.cfg` with `[tool:pytest]`, or `tox.ini` with `[pytest]`, closest to the test files. Do not assume a subdirectory name — discover it.

2. **Find the target conftest.** From the config root, check `[tool.pytest.ini_options].testpaths` (or `testpaths` in `pytest.ini`). The target is the top-level `conftest.py` under the first testpath. If no testpath is configured, default to `<config-root>/tests/conftest.py`. If no `test_*.py` files exist anywhere under the config root, stop and report "no tests found."

3. **Detect the pytest invocation prefix** (same logic as `test-review`: `uv run pytest` / `poetry run pytest` / `pipenv run pytest` / bare `pytest`, prefixed with `cd <config-root> &&` if needed). Store it for Step 6.

4. **Check what's already installed.** Grep the target conftest (and any parent conftests) for:
   - Network blocking: `socket.socket` patches, `responses`, `httpx_mock`, `pytest-socket`.
   - Clock freezing: `time_machine.travel`, `freeze_time`, `freezegun`, clock-injection fixtures.
   - Random seeding: `random.seed`, `np.random.seed`, `torch.manual_seed`.
   - Filesystem isolation: `monkeypatch.setenv("HOME", ...)` patterns.
   
   **Do not overwrite existing rails.** Record which are already installed; skip them in Step 4.

## Step 2: Audit for flaky patterns

Scan all test files and the production code they import for:

| Pattern | Rail that catches it |
|---|---|
| `datetime.now()`, `datetime.utcnow()`, `time.time()`, `time.monotonic()` | clock |
| `random.*`, `np.random.*`, `torch.rand*` without seed | random |
| `uuid.uuid4()` | random (seeded UUID4 is deterministic in tests) |
| `requests.`, `httpx.`, `urllib.`, `aiohttp.`, `socket.` without a patch | network |
| `/tmp/`, `os.getcwd()` writes, `Path("./out")` writes | fs |
| `@pytest.mark.flaky`, `pytest-rerunfailures` in config | all (these are symptoms) |

Produce a findings table: `file:line`, pattern, proposed fix. This goes in the report.

## Step 3: Choose rails

`$ARGS` may contain `--rails network,clock,random,fs,shuffle` to subset. Default: all five.

If `time-machine` is not a dependency, the clock rail still ships — it's wrapped in try/except so it no-ops until the user runs `uv add time-machine` (or equivalent). Mention this in the report. Prefer `time-machine` over `freezegun`: it is ~100-200x faster on a per-test basis and covers C-extension time calls that freezegun silently misses ([Adam Johnson benchmark](https://adamj.eu/tech/2021/02/19/freezegun-versus-time-machine/); [time-machine comparison](https://time-machine.readthedocs.io/en/stable/comparison.html)).

The `shuffle` rail is `pytest-randomly` — a dev-dependency, not a conftest change. It auto-activates when installed, reshuffles test order each run, and reseeds `random` / `numpy` / `faker` / `model-bakery` per-test using the test ID as seed salt ([pytest-randomly README](https://github.com/pytest-dev/pytest-randomly/blob/main/README.rst)). The printed `--randomly-seed=<N>` reproduces failures deterministically. Recommend `uv add --dev pytest-randomly` (or equivalent) when this rail is enabled.

## Step 4: Write the conftest

Merge-style — append to the existing file or create a new one. Do not clobber existing fixtures.

The **network rail** prefers `pytest-socket` when installable — it ships per-host allowlisting, unix-socket support, and structured error messages that the handrolled version lacks ([pytest-socket](https://github.com/miketheman/pytest-socket)). Recommend `uv add --dev pytest-socket` (or equivalent) and add to the pytest config in Step 5:

```toml
[tool.pytest.ini_options]
addopts = ["--disable-socket", "--allow-hosts=127.0.0.1,::1"]
markers = [
    "allow_hosts: per-test host allowlist (pytest-socket)",
]
```

If `pytest-socket` cannot be installed (vendored environments, hermetic build constraints), fall back to the handrolled fixture below — it covers `socket.socket` only.

Conftest template (include only the rails not already installed; omit the `_block_real_network` fixture if `pytest-socket` is configured):

```python
# Ambient safety rails — see python-test-quality:test-harden.
# Keep business fixtures in a separate conftest.
import os
import random
import socket

import pytest


# ── network (fallback — prefer pytest-socket; see Step 5) ─────────────────
class _NetworkBlocked(RuntimeError):
    """A test tried to open a real socket. Mock the boundary, or mark
    @pytest.mark.allow_network for an integration test."""


@pytest.fixture(autouse=True)
def _block_real_network(request, monkeypatch):
    if "allow_network" in request.keywords:
        return

    def _guard(*args, **kwargs):
        raise _NetworkBlocked(
            "Real network call in a unit test. Patch the client, use a fake, "
            "or mark the test @pytest.mark.allow_network if it is intentionally "
            "an integration test."
        )

    monkeypatch.setattr(socket, "socket", _guard)


# ── clock ─────────────────────────────────────────────────────────────────
try:
    import time_machine

    @pytest.fixture(autouse=True)
    def _frozen_clock():
        with time_machine.travel("2025-01-01 00:00:00", tick=False):
            yield
except ImportError:
    # time-machine not installed; run `uv add time-machine` (or poetry/pip
    # equivalent) to activate the clock rail. Prefer time-machine over
    # freezegun — C-extension time calls and ~100-200x faster per test.
    pass


# ── randomness ────────────────────────────────────────────────────────────
@pytest.fixture(autouse=True)
def _seed_random():
    random.seed(0)
    try:
        import numpy as np
        np.random.seed(0)
    except ImportError:
        pass
    try:
        import torch
        torch.manual_seed(0)
    except ImportError:
        pass


# ── filesystem ────────────────────────────────────────────────────────────
@pytest.fixture(autouse=True)
def _redirect_home(tmp_path, monkeypatch):
    # Stop tests from polluting the real $HOME / XDG dirs.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
```

## Step 5: Register markers

Edit the `pyproject.toml` at the pytest config root (from Step 1). Under `[tool.pytest.ini_options]`, ensure the following is present:

```toml
[tool.pytest.ini_options]
addopts = ["-ra", "--strict-markers", "--strict-config"]
filterwarnings = ["error"]
markers = [
    "slow: integration/E2E — excluded from the default run",
    "allow_network: opts out of the autouse network block; reserve for integration tests",
]
```

- `-ra` prints a short summary of all non-passed outcomes (failed, errored, skipped, xfailed, xpassed) at the end of the run.
- `--strict-markers` turns any unregistered `@pytest.mark.<name>` into an error instead of a silent typo ([pytest customize.rst](https://github.com/pytest-dev/pytest/blob/main/doc/en/reference/customize.rst)).
- `--strict-config` turns any unknown key in `[tool.pytest.ini_options]` into an error ([pytest customize.rst](https://github.com/pytest-dev/pytest/blob/main/doc/en/reference/customize.rst)).
- `filterwarnings = ["error"]` promotes all warnings to errors during the test run — new deprecation warnings fail CI immediately instead of accumulating ([pytest capture-warnings.rst](https://github.com/pytest-dev/pytest/blob/main/doc/en/how-to/capture-warnings.rst)). Add narrowing `ignore::` entries only when a specific upstream warning is known and unfixable.

If neither `pyproject.toml` nor `pytest.ini` exists, create `pytest.ini` at the repo root with the `[pytest]` equivalent.

**Do not clobber existing configuration.** Merge lists; if `addopts` or `filterwarnings` already exist, union with the existing entries.

## Step 6: Run pytest and report

Run `<prefix> -q`.

Report:

```
## Target: <path to conftest> (new / merged)
## Rails installed
 - network: autouse, opt-out via @pytest.mark.allow_network
 - clock:   autouse, uses time-machine (found in deps / NOT INSTALLED — run `uv add time-machine`)
 - random:  autouse, seeds random + numpy + torch (when importable)
 - fs:      autouse, redirects HOME/XDG to tmp_path
 - shuffle: pytest-randomly auto-activates (found in dev deps / NOT INSTALLED — run `uv add --dev pytest-randomly`)

## Flaky patterns found
 - <file>:<line> — <pattern> → <proposed fix>

## Post-install pytest run
 - <N> passed, <M> failed
 - Failures exposed real-network / time-dependent / etc. usage:
   - <file>::<test> — <reason>
 - Next step for each failure: either convert the test to use a mock/fake,
   or mark it with the appropriate opt-out marker.
```

**Broken tests are the point.** They were silently depending on real time / real network / shared FS state. Surfacing them is progress, not regression.

## Rules

- **Opt-out, not opt-in.** Rails are autouse so forgotten tests are still protected. Individual integration tests opt out with markers.
- **Ambient only.** These fixtures patch *boundaries* (clock, network, fs, randomness). Do not add business-domain mocking here — that belongs in a separate conftest.
- **Function scope.** Do not widen to session scope. Cost is negligible.
- **Do not overwrite.** If a rail exists, skip it. Report what was found.
- **Do not install retry plugins.** `pytest-rerunfailures` trains the team and the AI to ignore failures. If there is a flake, fix determinism instead.

## Anti-goals

- Do not try to freeze time at import time. The rail must be per-test so `time_machine.travel` / `freeze_time` decorators can override.
- Do not mock `datetime.datetime` manually — let `time-machine` (or `freezegun`) handle it, which is more complete.
- Do not touch production code from this skill.
