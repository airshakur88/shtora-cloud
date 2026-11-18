"""Regression coverage for first-class Java/JVM reviewer routing."""

import subprocess
import sys
from pathlib import Path

from scripts.orchestrate import PHASES


ROOT = Path(__file__).parent.parent


def test_java_phase_routes_to_java_reviewer():
    phase = PHASES["java"]
    assert phase["sub_skill"] == "java-security-reviewer.md"
    assert "deserialization" in phase["vuln_types"]
    assert "mass_assignment" in phase["vuln_types"]
    assert (ROOT / "sub-skills" / phase["sub_skill"]).is_file()


def test_list_phases_exposes_java_phase():
    result = subprocess.run(
        [sys.executable, "scripts/orchestrate.py", "--list-phases"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    java_line = next(line for line in result.stdout.splitlines() if line.strip().startswith("java"))
    assert "Java/JVM" in java_line


def test_skill_and_strategy_route_java_progressively():
    skill = (ROOT / "SKILL.md").read_text()
    strategy = (ROOT / "sub-skills" / "scan-strategy.md").read_text()
    scan = (ROOT / "scripts" / "scan.py").read_text()
    reviewer = (ROOT / "sub-skills" / "java-security-reviewer.md").read_text()

    assert "sub-skills/java-security-reviewer.md" in skill
    assert "java-security-reviewer.md" in scan
    assert "mobile-security-reviewer.md" in skill
    for framework in ("Spring Boot", "Jakarta EE", "Struts", "JSF", "Hibernate", "Micronaut", "Quarkus"):
        assert framework in strategy
        assert framework in reviewer
    for topic in ("Expression", "mass assignment", "Deserialization", "SSRF", "Actuator", "Async"):
        assert topic.lower() in reviewer.lower()
