"""C# benchmark gates independent of shared integration routing."""

from pathlib import Path

from scripts.taint_csharp import analyze_file_csharp
from scripts.utils.patterns import scan_file_for_candidates


ROOT = Path(__file__).parent.parent
BENCHMARK = ROOT / "tests" / "benchmark"

EXPECTED = {
    "cmdi_001.cs": "cmdi",
    "deserialization_001.cs": "deserialization",
    "open_redirect_001.cs": "open_redirect",
    "path_traversal_001.cs": "path_traversal",
    "sqli_001.cs": "sqli",
    "ssrf_001.cs": "ssrf",
    "xss_001.cs": "xss",
    "xxe_001.cs": "xxe",
}


def _found_types(path: Path) -> set[str]:
    content = path.read_text()
    result = analyze_file_csharp(str(path))
    found = {item["sink_type"] for item in result["potential_paths"]}
    found.update(
        item["vuln_type"]
        for item in scan_file_for_candidates(path, content, "csharp")
    )
    return found


def test_every_vulnerable_csharp_fixture_has_its_expected_finding():
    failures = []
    directory = BENCHMARK / "vulnerable" / "csharp"
    assert {path.name for path in directory.glob("*.cs")} == set(EXPECTED)
    for name, expected in EXPECTED.items():
        found = _found_types(directory / name)
        if expected not in found:
            failures.append(f"{name}: expected {expected}; found {sorted(found)}")
    assert not failures, "\n".join(failures)


def test_every_safe_csharp_fixture_remains_clean():
    failures = []
    for path in sorted((BENCHMARK / "safe" / "csharp").glob("*.cs")):
        found = _found_types(path)
        if found:
            failures.append(f"{path.name}: {sorted(found)}")
    assert not failures, "\n".join(failures)
