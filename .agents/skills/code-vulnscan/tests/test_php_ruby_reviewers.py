"""Content gates for the first-class PHP and Ruby web reviewers."""

from pathlib import Path


ROOT = Path(__file__).parent.parent


def test_php_reviewer_covers_frameworks_and_required_web_risks():
    reviewer = (ROOT / "sub-skills" / "php-security-reviewer.md").read_text()
    for framework in ("Laravel", "Symfony", "WordPress"):
        assert framework in reviewer
    for topic in (
        "authentication",
        "authorization",
        "CSRF",
        "mass assignment",
        "raw SQL",
        "SSRF",
        "template",
        "upload",
        "archive",
        "deserialization",
        "redirect",
        "command",
        "secrets",
        "logging",
        "tenant",
    ):
        assert topic.lower() in reviewer.lower()
    assert "WordPress nonces are CSRF controls, not capability" in reviewer
    assert "Pass all candidates through `false-positive-filter.md`" in reviewer


def test_ruby_reviewer_covers_frameworks_and_required_web_risks():
    reviewer = (ROOT / "sub-skills" / "ruby-security-reviewer.md").read_text()
    for framework in ("Rails", "Sinatra"):
        assert framework in reviewer
    for topic in (
        "authentication",
        "authorization",
        "CSRF",
        "mass assignment",
        "raw ORM",
        "SSRF",
        "template",
        "upload",
        "archive",
        "deserialization",
        "redirect",
        "command",
        "secrets",
        "logging",
        "tenant",
    ):
        assert topic.lower() in reviewer.lower()
    assert "Strong parameters constrain fields but do not authorize" in reviewer
    assert "Pass all candidates through `false-positive-filter.md`" in reviewer
