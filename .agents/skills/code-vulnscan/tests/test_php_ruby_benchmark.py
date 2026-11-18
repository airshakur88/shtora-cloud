"""Framework-focused PHP/Ruby detection and safe-fixture regression gates."""

import importlib.util
from pathlib import Path


ROOT = Path(__file__).parent.parent
BENCHMARK_DIR = ROOT / "tests" / "benchmark"
SPEC = importlib.util.spec_from_file_location(
    "php_ruby_vulnscan_benchmark", BENCHMARK_DIR / "run_benchmark.py"
)
BENCHMARK = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BENCHMARK)


EXPECTED = {
    "vulnerable/php/laravel_ssrf_001.php": "ssrf",
    "vulnerable/php/laravel_mass_assignment_001.php": "mass_assignment",
    "vulnerable/php/laravel_open_redirect_001.php": "open_redirect",
    "vulnerable/php/deserialization_001.php": "deserialization",
    "vulnerable/php/blade_xss_001.blade.php": "xss",
    "vulnerable/php/wordpress_sqli_001.php": "sqli",
    "vulnerable/ruby/rails_sqli_001.rb": "sqli",
    "vulnerable/ruby/rails_cmdi_001.rb": "cmdi",
    "vulnerable/ruby/rails_ssrf_001.rb": "ssrf",
    "vulnerable/ruby/rails_xss_001.rb": "xss",
    "vulnerable/ruby/rails_path_traversal_001.rb": "path_traversal",
    "vulnerable/ruby/rails_deserialization_001.rb": "deserialization",
    "vulnerable/ruby/rails_open_redirect_001.rb": "open_redirect",
    "vulnerable/ruby/rails_mass_assignment_001.rb": "mass_assignment",
}


def _found_types(path: Path) -> set[str]:
    return {
        BENCHMARK.normalize_vuln_type(finding["vuln_type"])
        for finding in BENCHMARK.scan_file(path)
        if finding.get("vuln_type")
    }


def test_all_new_php_ruby_vulnerable_fixtures_are_detected():
    misses = []
    for relative, expected in EXPECTED.items():
        found = _found_types(BENCHMARK_DIR / relative)
        if expected not in found:
            misses.append(f"{relative}: expected {expected}; found {sorted(found)}")
    assert not misses, "\n".join(misses)


def test_all_php_ruby_safe_fixtures_remain_clean():
    false_positives = []
    for language in ("php", "ruby"):
        for path in sorted((BENCHMARK_DIR / "safe" / language).glob("*")):
            if not path.is_file():
                continue
            found = _found_types(path)
            if found:
                false_positives.append(f"{language}/{path.name}: {sorted(found)}")
    assert not false_positives, "\n".join(false_positives)
