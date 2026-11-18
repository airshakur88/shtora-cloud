"""Regression gates for cross-language validation and false-positive guidance."""

from pathlib import Path


ROOT = Path(__file__).parent.parent


def _subskill(name: str) -> str:
    return (ROOT / "sub-skills" / name).read_text()


def test_sql_false_positive_guidance_covers_modern_orms_without_select_exception():
    guidance = _subskill("false-positive-filter.md")
    for technology in ("Dapper", "SQLx", "Diesel", "JDBC"):
        assert technology in guidance
    assert "SELECT-only" in guidance
    assert "typed objects" in guidance
    assert "Do not disqualify SQL injection" in guidance
    assert "only performs a SELECT" not in guidance


def test_java_reviewer_has_actionable_ktor_guidance():
    reviewer = _subskill("java-security-reviewer.md")
    for marker in (
        "call.receive<T>()", "authenticate", "call.principal", "Resources DTOs",
        "Ktor has no automatic SQL safety", "WebSocket", "HttpClient",
    ):
        assert marker in reviewer


def test_input_validation_covers_ktor_dotnet_and_rust_semantics():
    validator = _subskill("input-validator.md")
    for heading in ("### Kotlin / Ktor", "### .NET / ASP.NET Core", "### Rust / Serde and web extractors"):
        assert heading in validator
    for concept in ("privileged-property", "overposting", "deny_unknown_fields", "body limits"):
        assert concept in validator
