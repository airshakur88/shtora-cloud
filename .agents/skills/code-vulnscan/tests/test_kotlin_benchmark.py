"""End-to-end Kotlin/JVM benchmark gates."""

import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).parent.parent
BENCHMARK_DIR = ROOT / "tests" / "benchmark"
SPEC = importlib.util.spec_from_file_location("vulnscan_benchmark", BENCHMARK_DIR / "run_benchmark.py")
BENCHMARK = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BENCHMARK)


def _found_types(path: Path) -> set[str]:
    return {
        BENCHMARK.normalize_vuln_type(finding["vuln_type"])
        for finding in BENCHMARK.scan_file(path)
        if finding.get("vuln_type")
    }


def test_all_labeled_kotlin_vulnerabilities_are_detected():
    labels = json.loads((BENCHMARK_DIR / "labels.json").read_text())
    misses = []
    for relative, expected in labels.items():
        if not relative.startswith("vulnerable/kotlin/"):
            continue
        expected_types = {item["type"] for item in expected}
        found_types = _found_types(BENCHMARK_DIR / relative)
        if missing := expected_types - found_types:
            misses.append(f"{relative}: missing {sorted(missing)}; found {sorted(found_types)}")
    assert not misses, "\n".join(misses)


def test_all_safe_kotlin_fixtures_remain_clean():
    false_positives = []
    for path in sorted((BENCHMARK_DIR / "safe" / "kotlin").glob("*.kt")):
        if found := _found_types(path):
            false_positives.append(f"{path.name}: {sorted(found)}")
    assert not false_positives, "\n".join(false_positives)
