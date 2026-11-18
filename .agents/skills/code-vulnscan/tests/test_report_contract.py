"""Regression tests for the canonical final-report contract and lifecycle."""

import argparse
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts import report, scan
from scripts.utils import db


def _run(target: Path, run_id: str = "run-123"):
    return {"id": run_id, "path": str(target), "timestamp": "2026-08-13T00:00:00Z"}


def _rich_finding():
    return {
        "id": "db-row-1",
        "finding_id": "CVS-TEST12345678",
        "vulnerability_name": "SQL injection in account search",
        "severity": "critical",
        "exploitability": "Remote; low complexity; without authentication",
        "cvss_score": 9.8,
        "cvss_vector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
        "owasp_category": "A03:2021 — Injection",
        "cwe": "CWE-89 — SQL Injection",
        "vulnerability_description": "User input is interpolated into an executed SQL query.",
        "impact": "An unauthenticated attacker can read or modify customer records.",
        "affected_assets": ["app/search.py", "GET /accounts/search"],
        "remediation_guidelines": "Bind the search value as a query parameter.",
        "confidence": "confirmed",
        "validation_status": "confirmed",
        "exact_locations": [{"file": "app/search.py", "line_start": 42, "line_end": 43}],
        "code_snippet": "cursor.execute(f\"SELECT * FROM accounts WHERE q='{term}'\")",
        "taint_source": "request.args['q']",
        "taint_sink": "cursor.execute(query)",
        "taint_path": [
            {"role": "source", "file": "app/search.py", "line": 38, "code": "term = request.args['q']"},
            {"role": "sink", "file": "app/search.py", "line": 43, "code": "cursor.execute(query)"},
        ],
        "attack_prerequisites": "The HTTP route is reachable; no account is required.",
        "references": ["https://owasp.org/www-community/attacks/SQL_Injection"],
        "language": "python",
        "vuln_type": "sqli",
        "file_path": "app/search.py",
        "line_start": 42,
        "line_end": 43,
        "status": "confirmed",
    }


def test_markdown_and_html_render_every_required_field(tmp_path):
    finding = _rich_finding()

    markdown = report.generate_markdown(_run(tmp_path), [finding])
    html = report.generate_html(_run(tmp_path), [finding])

    required_labels = (
        "Vulnerability Name",
        "Severity",
        "Exploitability",
        "CVSS Score",
        "CVSS Vector",
        "OWASP Category",
        "Vulnerability Description",
        "Impact",
        "Affected Assets",
        "Remediation Guidelines",
        "Finding ID",
        "CWE",
        "Confidence",
        "Validation Status",
        "Exact Locations",
        "Attack Prerequisites",
        "Evidence",
        "References",
    )
    for label in required_labels:
        assert label in markdown
        assert label in html
    assert finding["impact"] in markdown
    assert finding["finding_id"] in html


def test_json_and_sarif_preserve_contract_and_taint_flow(tmp_path):
    finding = _rich_finding()
    json_report = report.generate_json(_run(tmp_path), [finding])
    sarif = report.generate_sarif(_run(tmp_path), [finding])

    assert json_report["schema_version"] == "2.0.0"
    item = json_report["findings"][0]
    for key in (
        "finding_id", "vulnerability_name", "severity", "exploitability",
        "cvss_score", "cvss_vector", "owasp_category", "cwe",
        "vulnerability_description", "impact", "affected_assets",
        "remediation_guidelines", "confidence", "validation_status",
        "exact_locations", "evidence", "attack_prerequisites", "references",
    ):
        assert key in item
    # Schema-v1 aliases remain available to downstream consumers.
    assert item["title"] == finding["vulnerability_name"]
    assert item["remediation"] == finding["remediation_guidelines"]

    result = sarif["runs"][0]["results"][0]
    assert result["properties"]["findingId"] == finding["finding_id"]
    assert result["properties"]["cvssVector"] == finding["cvss_vector"]
    assert result["properties"]["impact"] == finding["impact"]
    assert len(result["codeFlows"][0]["threadFlows"][0]["locations"]) == 2
    assert sarif["runs"][0]["tool"]["driver"]["version"] == "1.3.0"


def test_legacy_missing_fields_are_explicit_not_assessed(tmp_path):
    legacy = {
        "id": "legacy-1",
        "title": "Legacy finding",
        "severity": "high",
        "file_path": "legacy.py",
        "line_start": 7,
        "vuln_type": "xss",
        "status": "likely",
    }

    normalized = report.normalize_finding(legacy)
    markdown = report.generate_markdown(_run(tmp_path), [legacy])

    assert normalized["finding_id"].startswith("CVS-")
    assert normalized["impact"] == "Not assessed"
    assert normalized["remediation_guidelines"] == "Not assessed"
    assert normalized["affected_assets"] == ["legacy.py"]
    assert "Not assessed" in markdown


def test_secret_evidence_is_redacted_in_every_report_format(tmp_path):
    stripe_token = "_".join(("sk", "live", "1234567890abcdefghijklmn"))
    github_token = "".join(("gh", "p_", "123456789012345678901234567890123456"))
    generic_token = "AbCdEfGhIjKlMnOpQrStUvWxYz123456"
    secret = _rich_finding()
    secret.update({
        "vulnerability_name": f"Hardcoded credential {github_token}",
        "vuln_type": "hardcoded_secret",
        "code_snippet": f'api_key = "{stripe_token}"',
        "vulnerability_description": f"The live token is {github_token}.",
        "taint_source": f'token = "{github_token}"',
        "impact": f"Attackers can use {stripe_token}.",
        "exploitability": f"Authorization: Bearer {generic_token}",
        "affected_assets": [f"https://example.test/hook?token={generic_token}"],
        "exact_locations": [{
            "file": f"config/{github_token}.env",
            "line_start": 2,
        }],
        "attack_prerequisites": f"Use api_key={generic_token}",
        "references": [f"https://user:{generic_token}@example.test/advisory"],
        "taint_path": [{
            "role": "source", "file": "config.py", "line": 2,
            "code": f'token = "{github_token}"',
        }],
    })

    documents = [
        report.generate_markdown(_run(tmp_path), [secret]),
        report.generate_html(_run(tmp_path), [secret]),
        json.dumps(report.generate_json(_run(tmp_path), [secret])),
        json.dumps(report.generate_sarif(_run(tmp_path), [secret])),
    ]
    for document in documents:
        assert "1234567890abcdefghijklmn" not in document
        assert "123456789012345678901234567890123456" not in document
        assert "AbCdEfGhIjKlMnOpQrStUvWxYz123456" not in document
        assert "REDACTED" in document


def test_empty_scan_writes_complete_artifact_set_and_primary_report(tmp_path):
    output = tmp_path / "reports"
    target = tmp_path / "target"
    target.mkdir()

    paths = report.generate_report_artifacts(_run(target, "empty-1"), [], output)

    assert set(paths) == {
        "markdown", "primary_markdown", "html", "json", "sarif", "confirmed_findings"
    }
    assert all(path.is_file() for path in paths.values())
    assert "No confirmed or likely findings" in paths["primary_markdown"].read_text()
    assert json.loads(paths["json"].read_text())["summary"]["total"] == 0
    sarif = json.loads(paths["sarif"].read_text())
    assert sarif["runs"][0]["results"] == []
    assert sarif["runs"][0]["tool"]["driver"]["rules"] == []


def test_database_migrates_and_persists_report_metadata(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "scan.db")
    conn = db.initialize_database()
    run_id = db.create_run(conn, str(tmp_path))
    finding = _rich_finding()

    fid = db.insert_finding(conn, run_id, finding)
    stored = conn.execute("SELECT * FROM findings WHERE id = ?", (fid,)).fetchone()

    assert stored["stable_id"] == finding["finding_id"]
    assert stored["exploitability"] == finding["exploitability"]
    assert json.loads(stored["affected_assets"]) == finding["affected_assets"]
    assert json.loads(stored["exact_locations"]) == finding["exact_locations"]
    assert json.loads(stored["references_json"]) == finding["references"]


def test_update_findings_always_generates_final_reports(tmp_path, monkeypatch):
    target = tmp_path / "target"
    target.mkdir()
    output = tmp_path / "workspace"
    monkeypatch.setattr(db, "DB_PATH", output / "scan.db")
    monkeypatch.setattr(scan, "WORKSPACE_REPORT_DIR", output)
    conn = db.initialize_database()
    db.create_run(conn, str(target))
    confirmed = tmp_path / "confirmed.json"
    confirmed.write_text("[]")

    scan.cmd_update_findings(conn, str(confirmed))

    assert db.get_latest_run(conn)["status"] == "complete"
    assert (target / "Vulnscan_results.md").is_file()
    assert list(output.glob("report_*.html"))
    assert list(output.glob("report_*.json"))
    assert list(output.glob("report_*.sarif"))
    assert "No confirmed or likely findings" in (target / "Vulnscan_results.md").read_text()


def test_empty_final_snapshot_removes_previously_confirmed_findings(tmp_path, monkeypatch):
    target = tmp_path / "target"
    target.mkdir()
    output = tmp_path / "workspace"
    monkeypatch.setattr(db, "DB_PATH", output / "scan.db")
    monkeypatch.setattr(scan, "WORKSPACE_REPORT_DIR", output)
    conn = db.initialize_database()
    run_id = db.create_run(conn, str(target))
    db.insert_finding(conn, run_id, _rich_finding())
    final_snapshot = tmp_path / "confirmed.json"
    final_snapshot.write_text("[]")

    scan.cmd_update_findings(conn, str(final_snapshot))

    assert db.get_findings(conn, run_id=run_id, status=["confirmed", "likely"]) == []
    assert db.get_findings(conn, run_id=run_id, status="rejected")
    assert "No confirmed or likely findings" in (target / "Vulnscan_results.md").read_text()
    report_json = json.loads(next(output.glob("report_*.json")).read_text())
    assert report_json["findings"] == []


def test_failed_report_write_does_not_mark_review_complete(tmp_path, monkeypatch):
    target = tmp_path / "target"
    target.mkdir()
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "scan.db")
    conn = db.initialize_database()
    db.create_run(conn, str(target))
    confirmed = tmp_path / "confirmed.json"
    confirmed.write_text("[]")

    def fail_report(*_args, **_kwargs):
        raise OSError("report destination unavailable")

    monkeypatch.setattr(scan, "generate_final_reports", fail_report)
    with pytest.raises(OSError, match="destination unavailable"):
        scan.cmd_update_findings(conn, str(confirmed))

    assert db.get_latest_run(conn)["status"] != "complete"


def test_scan_attaches_nearest_route_metadata_to_candidates(tmp_path, monkeypatch):
    target = tmp_path / "app"
    target.mkdir()
    source = target / "routes.py"
    source.write_text(
        "from flask import Flask, request\n"
        "import os\n"
        "app = Flask(__name__)\n"
        "@app.get('/run')\n"
        "def run():\n"
        "    return os.system(request.args['cmd'])\n"
    )
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "scan.db")
    monkeypatch.setattr(scan, "WORKSPACE_REPORT_DIR", tmp_path / "workspace")
    conn = db.initialize_database()
    args = argparse.Namespace(
        path=str(target), lang=None, exclude=None, force=False, resume=False,
        min_severity=None,
    )

    scan.cmd_scan(conn, args)
    stored = conn.execute("SELECT notes FROM findings WHERE vuln_type = 'cmdi'").fetchone()

    assert stored is not None
    route = json.loads(stored["notes"])["nearest_route"]
    assert route["method"] == "GET"
    assert route["path"] == "/run"
    assert route["line"] == 4


def test_zero_candidate_pattern_scan_stays_pending_until_full_review(tmp_path, monkeypatch):
    target = tmp_path / "clean-app"
    target.mkdir()
    (target / "app.py").write_text("def health():\n    return 'ok'\n")
    output = tmp_path / "workspace"
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "scan.db")
    monkeypatch.setattr(scan, "WORKSPACE_REPORT_DIR", output)
    conn = db.initialize_database()
    args = argparse.Namespace(
        path=str(target), lang=None, exclude=None, force=False, resume=False,
        min_severity=None,
    )

    scan.cmd_scan(conn, args)

    run = db.get_latest_run(conn)
    assert run["status"] == "pending_review"
    assert run["candidate_count"] == 0
    assert not (target / "Vulnscan_results.md").exists()
    assert not list(output.glob("report_*.sarif"))
