"""Rust fixture recall and false-positive regression gates."""

from pathlib import Path

from scripts.taint_rust import analyze_file_rust
from scripts.utils.patterns import scan_file_for_candidates


ROOT = Path(__file__).parent.parent
BENCHMARK = ROOT / "tests" / "benchmark"

EXPECTED = {
    "actix_sqlx_sqli_001.rs": "sqli",
    "actix_diesel_sqli_001.rs": "sqli",
    "axum_reqwest_ssrf_001.rs": "ssrf",
    "axum_hyper_ssrf_001.rs": "ssrf",
    "warp_command_001.rs": "cmdi",
    "rocket_path_traversal_001.rs": "path_traversal",
    "actix_open_redirect_001.rs": "open_redirect",
    "axum_xss_001.rs": "xss",
    "rocket_deserialization_001.rs": "deserialization",
    "axum_ssti_001.rs": "ssti",
}


def _found_types(path: Path) -> set[str]:
    content = path.read_text()
    pattern_types = {
        item["vuln_type"]
        for item in scan_file_for_candidates(path, content, "rust")
    }
    taint_types = {
        item["sink_type"]
        for item in analyze_file_rust(str(path))["potential_paths"]
    }
    return pattern_types | taint_types


def test_all_rust_vulnerable_fixtures_are_detected():
    misses = []
    base = BENCHMARK / "vulnerable" / "rust"
    for filename, expected in EXPECTED.items():
        found = _found_types(base / filename)
        if expected not in found:
            misses.append(f"{filename}: expected {expected}; found {sorted(found)}")
    assert not misses, "\n".join(misses)


def test_all_safe_rust_fixtures_remain_clean():
    false_positives = []
    for path in sorted((BENCHMARK / "safe" / "rust").glob("*.rs")):
        found = _found_types(path)
        if found:
            false_positives.append(f"{path.name}: {sorted(found)}")
    assert not false_positives, "\n".join(false_positives)
