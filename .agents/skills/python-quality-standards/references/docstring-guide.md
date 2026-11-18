# Google-Style Docstring Guide

This skill uses **Google-style docstrings** as the default convention. This guide shows how to write them well.

## Why Google Style?

- **Clean and readable** — Section headers (Args, Returns, Raises) are more scannable than reST's `:param:` noise
- **Well supported** — Ruff's `convention = "google"` validates them, mkdocstrings and Sphinx (via napoleon) render them
- **Community adoption** — Google's Python Style Guide is one of the most widely referenced, and many modern projects (FastAPI docs, Pydantic, etc.) use similar patterns
- **Good balance** — Less verbose than NumPy style, more structured than plain text

## Basic Patterns

### Function with arguments and return value

```python
def calculate_discount(price: float, percentage: float) -> float:
    """Calculate the discounted price.

    Applies the given percentage discount to the original price.
    The discount is clamped to 0-100%.

    Args:
        price: Original price in the base currency. Must be non-negative.
        percentage: Discount percentage (0-100). Values outside this
            range are clamped.

    Returns:
        The price after applying the discount.

    Raises:
        ValueError: If price is negative.

    Example:
        >>> calculate_discount(100.0, 25.0)
        75.0
    """
```

### Class

```python
class UserService:
    """Manages user lifecycle operations.

    Handles user creation, authentication, and profile updates.
    All operations are scoped to a single tenant.

    Attributes:
        repository: The user data repository.
        cache: Optional cache backend for session data.

    Example:
        >>> service = UserService(repo, cache=redis_cache)
        >>> user = service.create("alice@example.com")
    """

    def __init__(self, repository: UserRepository, cache: Cache | None = None) -> None:
        """Initialize the user service.

        Args:
            repository: Data access layer for user records.
            cache: Optional cache for session acceleration.
                Defaults to no caching.
        """
```

### Generator function

```python
def paginate(items: list[T], page_size: int) -> Iterator[list[T]]:
    """Yield successive pages of items.

    Args:
        items: The full list to paginate.
        page_size: Maximum items per page. Must be positive.

    Yields:
        Lists of up to page_size items, in order.

    Raises:
        ValueError: If page_size is less than 1.
    """
```

### Context manager

```python
@contextmanager
def temporary_directory(prefix: str = "tmp") -> Iterator[Path]:
    """Create a temporary directory that is cleaned up on exit.

    Args:
        prefix: Prefix for the directory name.

    Yields:
        Path to the temporary directory.
    """
```

### Property

```python
@property
def is_active(self) -> bool:
    """Whether the user account is currently active."""
```

### Module-level docstring

```python
"""User authentication and session management.

This module provides the core authentication flow including
login, logout, token refresh, and session validation. It is
designed to work with any backend that implements the
AuthRepository protocol.

Typical usage:
    auth = AuthService(repository=db_repo, secret=settings.SECRET_KEY)
    token = auth.login(email, password)
"""
```

## Section Reference

| Section              | When to use                         | Notes                                                                     |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| Summary line         | Always                              | First line, one sentence, imperative mood ("Calculate", not "Calculates") |
| Extended description | When the summary isn't enough       | After a blank line. Explain behavior, constraints, side effects           |
| `Args:`              | When the function takes parameters  | One line per arg: `name: Description.` Indent continuation lines          |
| `Returns:`           | When the function returns something | Describe what, not the type (the type hint already does that)             |
| `Yields:`            | For generators                      | Same as Returns but for yielded values                                    |
| `Raises:`            | When the function raises exceptions | `ExceptionType: When this happens.`                                       |
| `Example:`           | When a usage example helps          | Use `>>>` doctest format for simple cases                                 |
| `Note:`              | For important caveats               | Sparingly — if everything is a note, nothing is                           |
| `Attributes:`        | On classes                          | Document public attributes                                                |

## Style Rules

1. **First line is imperative** — "Calculate the price", not "Calculates the price" or "This function calculates the price"
2. **First line is a complete sentence** — Ends with a period
3. **Don't repeat the type hint** — The signature has `price: float`, the docstring says "Original price in the base currency", not "float: Original price"
4. **Args descriptions start lowercase** — Unless it's a proper noun. No leading type annotation.
5. **One blank line between summary and body** — And between body and sections
6. **Indent continuation lines** — 4 spaces from the margin within a section

## When Docstrings Are Required

This skill's Ruff config requires docstrings on:

- **Public modules** (D101) — unless ignored
- **Public classes** (D101)
- **Public methods** (D102, D103)
- **Public functions** (D103)
- **Public packages** — unless ignored

Docstrings are NOT required on:

- Test files (configured via per-file-ignores)
- Private methods/functions (`_name`)
- `__init__.py` files
- Migration files
- Simple properties with self-evident names

## Common Mistakes

```python
# Bad: restates the function name
def get_user(user_id: int) -> User:
    """Get a user."""  # Adds nothing

# Good: explains behavior
def get_user(user_id: int) -> User:
    """Retrieve a user by ID from the database.

    Returns the cached version if available, otherwise queries
    the database and populates the cache.

    Args:
        user_id: The user's primary key.

    Returns:
        The matching user record.

    Raises:
        UserNotFoundError: If no user exists with this ID.
    """
```

```python
# Bad: documents the obvious, ignores the non-obvious
def retry(func: Callable, max_attempts: int = 3) -> Any:
    """Retry a function.

    Args:
        func: The function.
        max_attempts: The max attempts.
    """

# Good: documents what matters
def retry(func: Callable, max_attempts: int = 3) -> Any:
    """Retry a callable with exponential backoff on failure.

    Catches all exceptions except KeyboardInterrupt and SystemExit.
    The delay between attempts doubles each time, starting at 1 second.

    Args:
        func: A no-argument callable to retry.
        max_attempts: Maximum number of attempts before re-raising
            the last exception. Defaults to 3.

    Returns:
        The return value of the first successful call.

    Raises:
        Exception: The last exception raised after all attempts are exhausted.
    """
```
