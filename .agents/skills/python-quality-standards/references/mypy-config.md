# mypy Configuration Reference

This is the recommended default mypy configuration for `pyproject.toml`.

## Full Default Configuration (New Projects)

For new projects or projects ready for strict type checking:

```toml
[tool.mypy]
# Target the project's minimum Python version
python_version = "3.10"

# Strict mode: enables all strict flags at once.
# This is the recommended starting point for new projects.
# It's much easier to start strict and loosen per-module than to
# retrofit strictness onto an untyped codebase.
strict = true

# Show error codes in output — makes targeted ignores possible
# e.g., # type: ignore[assignment] instead of blanket # type: ignore
show_error_codes = true

# Warn about stale type: ignore comments that no longer suppress anything
warn_unused_ignores = true

# Warn about unnecessary casts
warn_redundant_casts = true

# Warn about code that will never be executed
warn_unreachable = true

# Treat every namespace as a package (needed for most project layouts)
namespace_packages = true

# Show the source of each error in the output
show_error_context = true

# Use pretty output with source snippets
pretty = true

# --- Per-module overrides ---

# Example: ignore missing stubs for third-party libraries
# [[tool.mypy.overrides]]
# module = ["some_untyped_library.*"]
# ignore_missing_imports = true

# Example: relax strictness for test files
# [[tool.mypy.overrides]]
# module = ["tests.*"]
# disallow_untyped_defs = false
# disallow_untyped_calls = false
```

## Gradual Adoption Configuration (Existing Projects)

For existing projects that need to adopt type checking incrementally:

```toml
[tool.mypy]
python_version = "3.10"

# Don't use strict = true yet — enable flags one at a time
# Start with these (least disruptive, highest value):

# Check function bodies even when signatures lack hints
check_untyped_defs = true

# Show error codes for targeted ignores
show_error_codes = true

# Catch stale ignore comments
warn_unused_ignores = true

# Catch unnecessary casts
warn_redundant_casts = true

# Explicit is better than implicit — don't auto-assume Optional
no_implicit_optional = true

# Pretty output
pretty = true

# --- Phase 2: Add these once the codebase is cleaner ---
# warn_return_any = true
# disallow_untyped_defs = true

# --- Phase 3: Go full strict ---
# strict = true

# Relax for untyped third-party libraries
[[tool.mypy.overrides]]
module = [
    # Add libraries without stubs here
]
ignore_missing_imports = true

# Relax for legacy modules that aren't typed yet
# [[tool.mypy.overrides]]
# module = ["your_package.legacy_module.*"]
# disallow_untyped_defs = false
```

## What strict = true Enables

When you set `strict = true`, mypy enables all of these:

| Flag | What it does |
|------|-------------|
| `warn_unused_configs` | Catch unused `[mypy-*]` config sections |
| `disallow_any_generics` | Forbid bare `list`, `dict` — require `list[int]`, `dict[str, Any]` |
| `disallow_subclassing_any` | Prevent subclassing untyped classes |
| `disallow_untyped_calls` | Forbid calling untyped functions from typed ones |
| `disallow_untyped_defs` | Require type hints on all function signatures |
| `disallow_incomplete_defs` | Forbid partially typed function signatures |
| `check_untyped_defs` | Check function bodies even without hints |
| `disallow_untyped_decorators` | Flag decorators without type information |
| `no_implicit_optional` | Require explicit `Optional[X]` or `X | None` |
| `warn_redundant_casts` | Flag unnecessary `cast()` calls |
| `warn_unused_ignores` | Flag stale `# type: ignore` comments |
| `warn_return_any` | Flag `Any` returns from typed functions |
| `no_implicit_reexport` | Require explicit `__all__` for re-exports |
| `strict_equality` | Flag nonsensical equality comparisons |

## Best Practices

### Always use targeted ignores

```python
# Bad — hides all errors on this line
x = some_call()  # type: ignore

# Good — documents exactly what's being ignored and why
x = some_call()  # type: ignore[no-untyped-call]
```

### Never use these globally

- `ignore_errors = True` — hides all errors for a module, defeating the purpose
- `strict_optional = False` — makes `None` assignable everywhere, which is the #1 thing mypy catches

### Common type stubs to install

For projects using popular untyped libraries:

```
types-requests     # for requests
types-redis        # for redis
types-PyYAML       # for pyyaml
types-python-dateutil  # for dateutil
django-stubs       # for Django
djangorestframework-stubs  # for DRF
celery-types       # for Celery
boto3-stubs        # for boto3/AWS
types-Pillow       # for Pillow
```

Install as dev dependencies:
```bash
uv add --dev types-requests django-stubs  # etc.
```

## Framework-Specific Configuration

### Django

```toml
[tool.mypy]
plugins = ["mypy_django_plugin.main"]

[tool.django-stubs]
django_settings_module = "your_project.settings"
```

### Pydantic

```toml
[tool.mypy]
plugins = ["pydantic.mypy"]

[tool.pydantic-mypy]
init_forbid_extra = true
init_typed = true
warn_required_dynamic_aliases = true
```
