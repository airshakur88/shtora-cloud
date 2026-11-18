"""Regression tests for the aggregate benchmark quality gate."""

import importlib.util
from pathlib import Path


ROOT = Path(__file__).parent.parent
HARNESS_PATH = ROOT / "tests" / "benchmark" / "run_benchmark.py"
SPEC = importlib.util.spec_from_file_location("benchmark_harness", HARNESS_PATH)
assert SPEC and SPEC.loader
HARNESS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HARNESS)


def _results(*, tp=70, fp=0, fn=0, precision=1.0, recall=1.0, f1=1.0):
    return {
        "overall": {
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "precision": precision,
            "recall": recall,
            "f1": f1,
        }
    }


def test_benchmark_gate_accepts_equal_or_improved_metrics():
    baseline = _results(tp=70, fp=2, precision=0.9722, f1=0.9859)
    assert HARNESS.baseline_regressions(baseline, baseline) == []
    assert HARNESS.baseline_regressions(_results(tp=71), baseline) == []


def test_benchmark_gate_rejects_lost_coverage_or_quality():
    baseline = _results(tp=70, fp=2, precision=0.9722, f1=0.9859)
    current = _results(tp=69, fp=3, fn=1, precision=0.9583, recall=0.9857, f1=0.9718)
    failures = HARNESS.baseline_regressions(current, baseline)

    assert any("true positives decreased" in failure for failure in failures)
    assert any("false negatives increased" in failure for failure in failures)
    assert any("precision decreased" in failure for failure in failures)
    assert any("recall decreased" in failure for failure in failures)
    assert any("f1 decreased" in failure for failure in failures)
