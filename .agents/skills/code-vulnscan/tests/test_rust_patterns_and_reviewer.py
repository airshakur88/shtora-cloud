"""Static resource quality checks for first-class Rust review support."""

from pathlib import Path

from scripts.utils.patterns import scan_file_for_candidates


ROOT = Path(__file__).parent.parent


def _pattern_types(content: str) -> set[str]:
    path = Path("example.rs")
    return {
        item["vuln_type"]
        for item in scan_file_for_candidates(path, content, "rust")
    }


def test_high_signal_rust_web_patterns():
    assert "sqli" in _pattern_types('sqlx::query(&format!("SELECT * FROM users WHERE id={}", input));')
    assert "cmdi" in _pattern_types('Command::new("sh").arg("-c").arg(input);')
    assert "xss" in _pattern_types('Html(format!("<b>{}</b>", input));')
    assert "deserialization" in _pattern_types("let value = bincode::deserialize(&input)?;")


def test_thread_rng_is_not_inaccurately_reported_as_insecure():
    assert "insecure_random" not in _pattern_types("let token: [u8; 32] = rand::thread_rng().gen();")
    assert "insecure_random" in _pattern_types("let rng = StdRng::seed_from_u64(7);")


def test_rust_reviewer_covers_frameworks_and_required_domains():
    reviewer = (ROOT / "sub-skills" / "rust-security-reviewer.md").read_text().lower()
    for framework in ("actix", "axum", "warp", "rocket"):
        assert framework in reviewer
    for topic in (
        "sqlx", "diesel", "command", "reqwest", "hyper", "path", "redirect",
        "header", "template", "deserialization", "serde", "unsafe", "ffi", "async",
    ):
        assert topic in reviewer
