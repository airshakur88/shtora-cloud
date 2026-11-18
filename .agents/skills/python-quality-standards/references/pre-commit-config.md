# pre-commit Configuration Reference

This is the recommended default `.pre-commit-config.yaml` for Python projects.

## Full Default Configuration

```yaml
# See https://pre-commit.com for more information
# See https://pre-commit.com/hooks.html for more hooks
default_language_version:
  python: python3

repos:
  # --- File hygiene ---
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0 # check for latest: https://github.com/pre-commit/pre-commit-hooks/releases
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-toml
      - id: check-added-large-files
        args: ["--maxkb=1000"]
      - id: check-merge-conflict
      - id: debug-statements # catches pdb/ipdb left in code

  # --- Ruff: lint + format ---
  # Order matters: lint --fix first (may change code), then format
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.11.12 # check for latest: https://github.com/astral-sh/ruff-pre-commit/releases
    hooks:
      - id: ruff
        types_or: [python, pyi]
        args: [--fix]
      - id: ruff-format
        types_or: [python, pyi]

  # --- Type checking ---
  - repo: https://github.com/pre-commit/mirrors-mypy
    rev: v1.15.0 # check for latest: https://github.com/pre-commit/mirrors-mypy/tags
    hooks:
      - id: mypy
        # Add type stubs your project needs as additional_dependencies:
        additional_dependencies: []
        # Example:
        # additional_dependencies:
        #   - types-requests
        #   - django-stubs
        #   - types-PyYAML
```

## Hook Execution Order

The hooks run in the order listed:

1. **File hygiene** — Fix whitespace, newlines, detect merge conflicts and debug statements
2. **Ruff lint with --fix** — Auto-fix linting issues (import sorting, unused imports, etc.)
3. **Ruff format** — Apply consistent formatting to all files (including any changes from step 2)
4. **mypy** — Type check (runs last because it needs clean, formatted code)

This order is important. Running lint --fix before format ensures that auto-fixed code also gets formatted. Running mypy last ensures it sees the final version of the code.

## Setup Commands

```bash
# Install pre-commit (if not already in dev dependencies)
uv add --dev pre-commit
# or: pip install pre-commit

# Install the git hooks
pre-commit install

# Run all hooks on all files (useful for first-time setup or CI)
pre-commit run --all-files

# Update hook versions to latest
pre-commit autoupdate
```

## Notes on mypy in pre-commit

Running mypy in pre-commit has a caveat: pre-commit runs each hook in an isolated environment, so mypy won't have access to your project's installed dependencies unless you list them in `additional_dependencies`. For complex projects, you may prefer running mypy separately:

```yaml
# Alternative: run mypy via local hook using project's venv
- repo: local
  hooks:
    - id: mypy
      name: mypy
      entry: uv run mypy
      language: system
      types: [python]
      pass_filenames: false
```

This approach uses your project's actual environment, so mypy can see all installed packages and stubs. The tradeoff is it depends on the developer having run `uv sync` first.

## CI Configuration

For CI, don't rely on pre-commit — run the tools directly for clearer error messages:

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy .
uv run pytest --cov
```

Or use pre-commit in CI too:

```bash
pre-commit run --all-files
```

Both approaches work. Direct tool invocation gives better error output and more control.
