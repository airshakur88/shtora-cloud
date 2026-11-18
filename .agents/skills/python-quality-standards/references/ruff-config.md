# Ruff Configuration Reference

This is the recommended default Ruff configuration for `pyproject.toml`. Adapt target-version and per-file-ignores to your project.

## Full Default Configuration

```toml
[tool.ruff]
# Target the project's minimum supported Python version
target-version = "py310"

# Line length: 88 is Black/Ruff default.
# This is the modern community consensus — a practical balance between
# PEP 8's 79 (too tight for modern code) and 120 (too wide for side-by-side views).
# Used by Black, Ruff, FastAPI, and most modern Python projects.
line-length = 88

# Directories to exclude from linting
extend-exclude = [
    "migrations",
    "alembic",
]

[tool.ruff.lint]
# Rule selection — comprehensive but not noisy.
# Each category is chosen for a reason:
select = [
    # --- Core Python correctness ---
    "E",     # pycodestyle errors — basic style violations
    "W",     # pycodestyle warnings — whitespace issues, deprecated features
    "F",     # Pyflakes — undefined names, unused imports, redefined variables

    # --- Import organization ---
    "I",     # isort — consistent import sorting and sectioning

    # --- Modern Python ---
    "UP",    # pyupgrade — replace deprecated syntax with modern equivalents (match target-version)

    # --- Bug prevention ---
    "B",     # flake8-bugbear — common sources of bugs and design problems
    "S",     # flake8-bandit (security) — basic security checks (SQL injection, hardcoded passwords, etc.)
    "A",     # flake8-builtins — prevent shadowing Python builtins
    "SIM",   # flake8-simplify — simplifiable code patterns (if/else that could be ternary, etc.)

    # --- Code quality ---
    "C4",    # flake8-comprehensions — unnecessary list/dict/set calls that should be comprehensions
    "RET",   # flake8-return — unnecessary return statements, implicit None returns
    "ARG",   # flake8-unused-arguments — unused function arguments
    "PTH",   # flake8-use-pathlib — suggest pathlib over os.path
    "ERA",   # eradicate — detect commented-out code
    "PL",    # Pylint subset — broad set of additional checks (conventions, errors, refactoring, warnings)

    # --- Naming ---
    "N",     # pep8-naming — enforce PEP 8 naming conventions

    # --- Documentation ---
    "D",     # pydocstyle — docstring presence and format

    # --- Type checking ---
    "TC",    # flake8-type-checking — move imports only used for type hints into TYPE_CHECKING blocks
    "ANN",   # flake8-annotations — enforce type annotations on function signatures

    # --- Performance ---
    "PERF",  # Perflint — performance anti-patterns (unnecessary list() calls, etc.)

    # --- Ruff-specific ---
    "RUF",   # Ruff's own rules — catches common issues not covered by other tools

    # --- Debug leftovers ---
    "T20",   # flake8-print — flag print() statements (use logging instead)
]

# Rules to ignore globally — these are deliberately excluded:
ignore = [
    # Line length is handled by the formatter. The linter rule E501 only catches
    # lines the formatter can't fix (comments, strings). We let the formatter
    # handle what it can and accept the rest.
    "E501",

    # These D rules conflict with Google-style docstrings or are too noisy:
    "D100",  # Missing docstring in public module — too noisy for most projects
    "D104",  # Missing docstring in public package (__init__.py)
    "D106",  # Missing docstring in public nested class
    "D203",  # One blank line before class docstring — conflicts with D211
    "D213",  # Multi-line summary on second line — conflicts with D212

    # Annotation rules that conflict with modern patterns:
    "ANN101",  # Missing type annotation for self — deprecated, unnecessary
    "ANN102",  # Missing type annotation for cls — deprecated, unnecessary
    "ANN401",  # Dynamically typed expressions (typing.Any) — sometimes necessary

    # These are valid patterns in certain contexts:
    "S101",  # assert used — fine in tests, flagged globally but ignored in tests via per-file
    "RET504",  # Unnecessary assignment before return — sometimes aids readability
]

# Allow all rules to be auto-fixed
fixable = ["ALL"]

# Rules that should NOT be auto-fixed (too risky to auto-correct):
unfixable = [
    "ERA001",  # Don't auto-delete commented-out code — human should decide
]

[tool.ruff.lint.per-file-ignores]
# Tests don't need docstrings, can use assert, can have security issues (test data),
# and can have unused arguments (fixtures)
"tests/**/*.py" = ["D", "S101", "ARG", "ANN", "PLR2004"]
"test_*.py" = ["D", "S101", "ARG", "ANN", "PLR2004"]

# __init__.py can re-export and have unused imports
"__init__.py" = ["F401", "D104"]

# Scripts and CLI entry points can use print
"scripts/**/*.py" = ["T20"]
"**/cli.py" = ["T20"]
"**/cli/**/*.py" = ["T20"]
"**/commands/**/*.py" = ["T20"]

# Migration files have their own rules
"**/migrations/**/*.py" = ["D", "ANN", "N", "ERA"]

[tool.ruff.lint.pydocstyle]
# Google style: clean, readable, widely supported by tools.
# Preferred over NumPy style (too verbose for non-scientific code) and
# reST style (noisy :param: syntax).
convention = "google"

[tool.ruff.lint.isort]
# Known first-party packages — adjust to your project name
# known-first-party = ["your_package"]
combine-as-imports = true
force-wrap-aliases = true

[tool.ruff.lint.flake8-bugbear]
# Allow default arguments like Depends() for FastAPI
extend-immutable-calls = [
    "fastapi.Depends",
    "fastapi.Query",
    "fastapi.Path",
    "fastapi.Body",
    "fastapi.Header",
    "fastapi.Cookie",
    "fastapi.Form",
    "fastapi.File",
]

[tool.ruff.lint.pylint]
# Maximum number of arguments for functions/methods
max-args = 8
# Maximum number of return statements
max-returns = 8
# Maximum number of branches (if/elif/else)
max-branches = 12

[tool.ruff.format]
# Double quotes: Python community default (PEP 8 doesn't mandate, but Black chose
# double quotes and it's become the consensus for new projects)
quote-style = "double"
indent-style = "space"
skip-magic-trailing-comma = false
line-ending = "auto"

# Enable docstring formatting
docstring-code-format = true
docstring-code-line-length = "dynamic"
```

## Rule Categories Explained

### Why these rules and not ALL?

Using `select = ["ALL"]` is tempting but counterproductive:
- New rules get enabled silently on every Ruff upgrade, breaking CI
- Many rules contradict each other (D203 vs D211, D212 vs D213)
- Some rules are domain-specific and add noise in the wrong context

Instead, we explicitly select rules that have proven value across many projects. This makes the config predictable and the developer experience pleasant.

### Categories we deliberately excluded

| Code | Name | Why excluded |
|------|------|-------------|
| `FBT` | flake8-boolean-trap | Too opinionated — booleans as function params are fine in many cases |
| `EM` | flake8-errmsg | Forces intermediate variables for exception messages — low value, high noise |
| `TRY` | tryceratops | Many rules too strict for practical code |
| `FIX` | flake8-fixme | Flags TODO/FIXME — these are useful development markers |
| `TD` | flake8-todos | Too prescriptive about TODO format |
| `INP` | flake8-no-pep420 | Implicit namespace packages — valid in many project structures |
| `COM` | flake8-commas | Trailing comma enforcement — formatter handles this |
| `Q` | flake8-quotes | Quote enforcement — formatter handles this |

## Adapting to Python Version

Change `target-version` to match your project's `requires-python`:

| Project supports | target-version |
|-----------------|----------------|
| Python 3.10+ | `"py310"` |
| Python 3.11+ | `"py311"` |
| Python 3.12+ | `"py312"` |
| Python 3.13+ | `"py313"` |

This affects `UP` (pyupgrade) rules — Ruff will only suggest syntax available in your minimum supported version.

## Framework-Specific Adjustments

### Django

Add to `[tool.ruff.lint]`:
```toml
extend-ignore = [
    "RUF012",  # Mutable class variables — Django model fields are class-level
]
```

Add to `[tool.ruff.lint.per-file-ignores]`:
```toml
"**/management/commands/**/*.py" = ["T20"]  # Management commands can print
```

### FastAPI

The default config already handles FastAPI's `Depends()` pattern via `extend-immutable-calls`. No additional changes needed for most projects.

### CLI applications (Click, Typer)

Add to `[tool.ruff.lint.per-file-ignores]`:
```toml
"**/cli.py" = ["T20", "B008"]  # print is OK, function calls in defaults (Click/Typer)
"**/commands/**/*.py" = ["T20", "B008"]
```
