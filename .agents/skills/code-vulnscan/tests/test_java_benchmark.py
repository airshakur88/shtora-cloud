"""End-to-end Java benchmark gates for recall and false-positive control."""

import importlib.util
import json
from pathlib import Path

from scripts.taint import analyze_file


ROOT = Path(__file__).parent.parent
BENCHMARK_DIR = ROOT / "tests" / "benchmark"
SPEC = importlib.util.spec_from_file_location(
    "vulnscan_benchmark", BENCHMARK_DIR / "run_benchmark.py"
)
BENCHMARK = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BENCHMARK)


def _found_types(path: Path) -> set[str]:
    return {
        BENCHMARK.normalize_vuln_type(finding["vuln_type"])
        for finding in BENCHMARK.scan_file(path)
        if finding.get("vuln_type")
    }


def test_all_labeled_java_vulnerabilities_are_detected():
    labels = json.loads((BENCHMARK_DIR / "labels.json").read_text())
    misses = []
    for relative, expected in labels.items():
        if not relative.startswith("vulnerable/java/"):
            continue
        expected_types = {item["type"] for item in expected}
        found_types = _found_types(BENCHMARK_DIR / relative)
        missing = expected_types - found_types
        if missing:
            misses.append(f"{relative}: missing {sorted(missing)}; found {sorted(found_types)}")
    assert not misses, "\n".join(misses)


def test_all_safe_java_fixtures_remain_clean():
    false_positives = []
    for path in sorted((BENCHMARK_DIR / "safe" / "java").glob("*.java")):
        found_types = _found_types(path)
        if found_types:
            false_positives.append(f"{path.name}: {sorted(found_types)}")
    assert not false_positives, "\n".join(false_positives)


def test_annotated_parameter_tracking_is_forward_only_and_method_local(tmp_path):
    source = tmp_path / "UsersController.java"
    source.write_text(
        """import org.springframework.web.bind.annotation.*;
class UsersController {
  @GetMapping("/unsafe")
  Object unsafe(@RequestParam String name) {
    return entityManager.createNativeQuery("select * from users where name='" + name + "'").getResultList();
  }
  @GetMapping("/safe")
  Object safe(@RequestParam String name) {
    return entityManager.createNativeQuery("select * from users where name=:name")
      .setParameter("name", name).getResultList();
  }
}
"""
    )
    result = analyze_file(str(source), "java")
    sql_paths = [path for path in result["potential_paths"] if path["sink_type"] == "sqli"]
    assert len(sql_paths) == 1
    assert sql_paths[0]["source_line"] == 4
    assert sql_paths[0]["sink_line"] == 5
    assert sql_paths[0]["source_line"] <= sql_paths[0]["sink_line"]


def test_servlet_writer_and_jsp_scriptlet_output_are_tracked(tmp_path):
    servlet = tmp_path / "EchoServlet.java"
    servlet.write_text(
        """class EchoServlet {
  void doGet(HttpServletRequest req, HttpServletResponse resp) throws Exception {
    String value = req.getParameter("q");
    PrintWriter writer = resp.getWriter();
    writer.write(value);
  }
}
"""
    )
    jsp = tmp_path / "echo.jsp"
    jsp.write_text('<%= request.getParameter("q") %>')

    servlet_paths = analyze_file(str(servlet), "java")["potential_paths"]
    jsp_paths = analyze_file(str(jsp), "java")["potential_paths"]
    assert any(path["sink_type"] == "xss" for path in servlet_paths)
    assert any(path["sink_type"] == "xss" for path in jsp_paths)
