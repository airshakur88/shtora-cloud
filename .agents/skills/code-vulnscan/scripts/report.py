#!/usr/bin/env python3
"""Generate canonical Code-VulnScan Markdown, HTML, JSON, and SARIF reports.

The report boundary deliberately accepts both current database rows and older,
partially populated finding dictionaries.  Missing optional assessment data is
rendered as "Not assessed" instead of causing report generation to fail or
silently omitting a required field.

Usage:
  python3 scripts/report.py [--run-id <id>] [--format markdown|html|json|sarif|all]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from typing import Any, Iterable, Mapping

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.utils.db import get_findings, get_latest_run, initialize_database


TOOL_NAME = "Code-VulnScan"
TOOL_VERSION = "1.3.0"
WORKSPACE = Path(__file__).parent.parent / "workspace"
SEVERITIES = ("critical", "high", "medium", "low", "informational")
SEVERITY_ORDER = {severity: index for index, severity in enumerate(SEVERITIES)}
SEVERITY_EMOJI = {
    "critical": "[CRITICAL]",
    "high": "[HIGH]",
    "medium": "[MEDIUM]",
    "low": "[LOW]",
    "informational": "[INFO]",
}
NOT_ASSESSED = "Not assessed"


def _as_dict(value: Any) -> dict[str, Any]:
    """Convert sqlite rows and arbitrary mappings to a plain dictionary."""
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, Mapping):
        return dict(value)
    if hasattr(value, "keys"):
        return {key: value[key] for key in value.keys()}
    raise TypeError(f"Expected a finding mapping, got {type(value).__name__}")


def _json_value(value: Any, fallback: Any = None) -> Any:
    if value in (None, ""):
        return fallback
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return value


def _string_list(value: Any) -> list[str]:
    parsed = _json_value(value, [])
    if parsed in (None, ""):
        return []
    if isinstance(parsed, (list, tuple, set)):
        return [str(item).strip() for item in parsed if str(item).strip()]
    if isinstance(parsed, dict):
        return [json.dumps(parsed, sort_keys=True)]
    return [str(parsed).strip()] if str(parsed).strip() else []


def _cvss_metrics(vector: str | None) -> dict[str, str]:
    metrics: dict[str, str] = {}
    if not vector:
        return metrics
    for component in str(vector).split("/"):
        if ":" in component:
            key, value = component.split(":", 1)
            metrics[key.upper()] = value.upper()
    return metrics


def _derive_attack_prerequisites(vector: str | None) -> str:
    metrics = _cvss_metrics(vector)
    if not metrics:
        return NOT_ASSESSED
    attack_vectors = {
        "N": "network access",
        "A": "adjacent-network access",
        "L": "local access",
        "P": "physical access",
    }
    privileges = {"N": "no prior privileges", "L": "low privileges", "H": "high privileges"}
    interaction = {"N": "no user interaction", "R": "user interaction required"}
    complexity = {"L": "low attack complexity", "H": "high attack complexity"}
    parts = [
        attack_vectors.get(metrics.get("AV", "")),
        complexity.get(metrics.get("AC", "")),
        privileges.get(metrics.get("PR", "")),
        interaction.get(metrics.get("UI", "")),
    ]
    return "; ".join(part for part in parts if part) or NOT_ASSESSED


def _derive_exploitability(
    explicit: Any,
    vector: str | None,
    taint_path: Any,
) -> str:
    if explicit not in (None, ""):
        return str(explicit)
    metrics = _cvss_metrics(vector)
    if metrics:
        reach = {"N": "Remote", "A": "Adjacent", "L": "Local", "P": "Physical"}.get(
            metrics.get("AV", ""), "Unspecified"
        )
        effort = "low complexity" if metrics.get("AC") == "L" else "high complexity"
        auth = {
            "N": "without authentication",
            "L": "with low privileges",
            "H": "with high privileges",
        }.get(metrics.get("PR", ""), "with unspecified privileges")
        return f"{reach}; {effort}; {auth}"
    if taint_path:
        return "Demonstrated source-to-sink path; environmental reachability not assessed"
    return NOT_ASSESSED


def _reference_links(cwe: str, owasp: str, explicit: Any) -> list[str]:
    references = _string_list(explicit)
    match = re.search(r"CWE-(\d+)", cwe, flags=re.IGNORECASE)
    if match:
        references.append(f"https://cwe.mitre.org/data/definitions/{match.group(1)}.html")
    if owasp and owasp != "Not classified":
        references.append("https://owasp.org/www-project-top-ten/")
    return list(dict.fromkeys(references))


def _stable_finding_id(file_path: str, line_start: Any, vuln_type: str, title: str) -> str:
    identity = f"{file_path}|{line_start or ''}|{vuln_type}|{title}".encode("utf-8")
    return f"CVS-{hashlib.sha256(identity).hexdigest()[:12].upper()}"


def _mask_sensitive_evidence(text: Any, vuln_type: str) -> str:
    """Redact likely credential material from secret-finding evidence."""
    value = str(text or "")
    kind = vuln_type.lower()
    if not any(marker in kind for marker in ("secret", "credential", "api_key", "private_key")):
        return value
    value = re.sub(
        r"(?i)\b(password|passwd|pwd|api[_-]?key|secret|token|auth)"
        r"(\s*[:=]\s*)(['\"])[^'\"\r\n]+\3",
        lambda match: f"{match.group(1)}{match.group(2)}{match.group(3)}[REDACTED]{match.group(3)}",
        value,
    )
    value = re.sub(r"\bAKIA[0-9A-Z]{16}\b", "AKIA[REDACTED]", value)
    value = re.sub(r"\bghp_[A-Za-z0-9]{20,}\b", "ghp_[REDACTED]", value)
    value = re.sub(r"\bsk_(?:live_)?[A-Za-z0-9_-]{16,}\b", "sk_[REDACTED]", value)
    value = re.sub(r"\bxox[baprs]-[A-Za-z0-9-]{16,}\b", "xox-[REDACTED]", value)
    value = re.sub(
        r"(?i)\b(authorization\s*:\s*bearer)\s+[A-Za-z0-9._~+/=-]{12,}",
        r"\1 [REDACTED]",
        value,
    )
    value = re.sub(
        r"(?i)\b(password|passwd|pwd|api[_-]?key|secret|token|auth)"
        r"(\s*[:=]\s*)(?!['\"])([^\s,;&]+)",
        lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]",
        value,
    )
    value = re.sub(
        r"(?i)([a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s/@]+(@)",
        r"\1[REDACTED]\2",
        value,
    )
    value = re.sub(
        r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
        "[REDACTED-JWT]",
        value,
    )
    value = re.sub(
        r"\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[a-z])"
        r"(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b",
        "[REDACTED-TOKEN]",
        value,
    )
    value = re.sub(
        r"(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)",
        r"\1\n[REDACTED]\n\2",
        value,
    )
    return value


def _mask_sensitive_structure(value: Any, vuln_type: str) -> Any:
    """Recursively redact secret-bearing strings in every serialized field."""
    if isinstance(value, dict):
        return {
            key: _mask_sensitive_structure(item, vuln_type)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_mask_sensitive_structure(item, vuln_type) for item in value]
    if isinstance(value, tuple):
        return tuple(_mask_sensitive_structure(item, vuln_type) for item in value)
    if isinstance(value, str):
        return _mask_sensitive_evidence(value, vuln_type)
    return value


def _mask_taint_path(taint_path: Any, vuln_type: str) -> Any:
    if not isinstance(taint_path, list):
        return taint_path
    sanitized = []
    for step in taint_path:
        if not isinstance(step, dict):
            sanitized.append(step)
            continue
        clean = dict(step)
        for key in ("code", "code_snippet"):
            if key in clean:
                clean[key] = _mask_sensitive_evidence(clean[key], vuln_type)
        sanitized.append(clean)
    return sanitized


def normalize_finding(raw_finding: Any) -> dict[str, Any]:
    """Return one complete, format-independent finding contract.

    New metadata can be supplied either as top-level keys or inside a legacy
    JSON ``notes`` object.  This keeps old scan databases reportable while new
    review agents can populate the richer contract.
    """
    raw = _as_dict(raw_finding)
    notes_value = _json_value(raw.get("notes"), {})
    notes = notes_value if isinstance(notes_value, dict) else {}

    def get(*names: str, default: Any = None) -> Any:
        for source in (raw, notes):
            for name in names:
                if source.get(name) not in (None, ""):
                    return source[name]
        return default

    title = str(get("vulnerability_name", "title", default="Unnamed vulnerability"))
    file_path = str(get("file_path", "file", default="Unknown asset"))
    vuln_type = str(get("vuln_type", "category", default="security_vulnerability"))
    line_start = get("line_start")
    line_end = get("line_end") or line_start
    severity = str(get("severity", default="informational")).lower()
    if severity not in SEVERITY_ORDER:
        severity = "informational"

    cvss_score = get("cvss_score")
    try:
        cvss_score = float(cvss_score) if cvss_score not in (None, "") else None
    except (TypeError, ValueError):
        cvss_score = None
    cvss_vector = str(get("cvss_vector", default="")) or None

    taint_path = _json_value(get("taint_path"), [])
    if taint_path in (None, ""):
        taint_path = []
    taint_path = _mask_taint_path(taint_path, vuln_type)

    nearest_route = notes.get("nearest_route")
    affected_assets = _string_list(get("affected_assets", "assets"))
    if not affected_assets:
        affected_assets = [file_path]
        if isinstance(nearest_route, dict):
            route = f"{nearest_route.get('method', 'ANY')} {nearest_route.get('path', '?')}"
            if route not in affected_assets:
                affected_assets.append(route)

    exact_locations = _json_value(get("exact_locations", "locations"), [])
    if not isinstance(exact_locations, list) or not exact_locations:
        exact_locations = [{
            "file": file_path,
            "line_start": line_start,
            "line_end": line_end,
        }]

    cwe = str(get("cwe", default="Not classified"))
    if cwe.isdigit():
        cwe = f"CWE-{cwe}"
    owasp = str(get("owasp_category", "owasp", default="Not classified"))
    impact = _mask_sensitive_evidence(get("impact", default=NOT_ASSESSED), vuln_type)
    remediation = _mask_sensitive_evidence(
        get("remediation_guidelines", "remediation", default=NOT_ASSESSED), vuln_type
    )
    attack_prerequisites = str(
        get("attack_prerequisites", default=_derive_attack_prerequisites(cvss_vector))
    )
    exploitability = _derive_exploitability(get("exploitability"), cvss_vector, taint_path)

    stable_id = str(
        get(
            "finding_id",
            "stable_id",
            default=_stable_finding_id(file_path, line_start, vuln_type, title),
        )
    )
    record_id = get("id")

    finding = {
        "finding_id": stable_id,
        "record_id": str(record_id) if record_id not in (None, "") else None,
        "vulnerability_name": title,
        "severity": severity,
        "exploitability": exploitability,
        "cvss_score": cvss_score,
        "cvss_vector": cvss_vector or NOT_ASSESSED,
        "owasp_category": owasp,
        "cwe": cwe,
        "vulnerability_description": _mask_sensitive_evidence(
            get("vulnerability_description", "description", default=NOT_ASSESSED), vuln_type
        ),
        "impact": impact,
        "affected_assets": affected_assets,
        "remediation_guidelines": remediation,
        "confidence": str(get("confidence", default=NOT_ASSESSED)),
        "validation_status": str(get("validation_status", "status", default=NOT_ASSESSED)),
        "exact_locations": exact_locations,
        "evidence": {
            "code_snippet": _mask_sensitive_evidence(get("code_snippet", default=""), vuln_type),
            "taint_source": _mask_sensitive_evidence(
                get("taint_source", default=""), vuln_type
            ),
            "taint_sink": _mask_sensitive_evidence(
                get("taint_sink", default=""), vuln_type
            ),
            "taint_path": taint_path,
        },
        "attack_prerequisites": attack_prerequisites,
        "references": _reference_links(
            cwe, owasp, get("references", "references_json", "reference_urls")
        ),
        "language": str(get("language", default="")),
        "vulnerability_type": vuln_type,
        "category": str(get("category", default=vuln_type)),
        "file_path": file_path,
        "line_start": line_start,
        "line_end": line_end,
    }
    return _mask_sensitive_structure(finding, vuln_type)


def normalize_findings(findings: Iterable[Any]) -> list[dict[str, Any]]:
    normalized = [normalize_finding(finding) for finding in findings]
    return sorted(
        normalized,
        key=lambda finding: (
            SEVERITY_ORDER.get(finding["severity"], len(SEVERITY_ORDER)),
            finding["vulnerability_name"].lower(),
            finding["finding_id"],
        ),
    )


def _run_value(run: Any, key: str, default: Any = "") -> Any:
    return _as_dict(run).get(key, default)


def get_run_and_findings(conn, run_id: str | None = None, min_severity: str = "medium"):
    if run_id:
        run = conn.execute("SELECT * FROM scan_runs WHERE id = ?", (run_id,)).fetchone()
    else:
        run = get_latest_run(conn)

    if not run:
        print("Error: no scan run found.", file=sys.stderr)
        raise SystemExit(1)

    findings = get_findings(
        conn,
        run_id=run["id"],
        status=["confirmed", "likely"],
        min_severity=min_severity,
    )
    return run, findings


def _severity_counts(findings: list[dict[str, Any]]) -> dict[str, int]:
    return {severity: sum(1 for f in findings if f["severity"] == severity) for severity in SEVERITIES}


def _display(value: Any) -> str:
    if value in (None, "", []):
        return NOT_ASSESSED
    return str(value)


def _location_label(location: Any) -> str:
    if not isinstance(location, dict):
        return str(location)
    file_path = location.get("file") or location.get("file_path") or "Unknown asset"
    start = location.get("line_start") or location.get("line")
    end = location.get("line_end") or start
    if not start:
        return str(file_path)
    suffix = f":{start}"
    if end and end != start:
        suffix += f"-{end}"
    return f"{file_path}{suffix}"


def _append_markdown_evidence(lines: list[str], finding: dict[str, Any]) -> None:
    evidence = finding["evidence"]
    code = evidence.get("code_snippet")
    if code:
        lines.extend(["#### Evidence", "", f"```{finding['language']}", code, "```", ""])

    taint_path = evidence.get("taint_path")
    if taint_path:
        lines.extend(["#### Evidence / Taint Path", ""])
        steps = taint_path if isinstance(taint_path, list) else [taint_path]
        for index, step in enumerate(steps, 1):
            if isinstance(step, dict):
                role = str(step.get("role", "step")).upper()
                location = _location_label(step)
                code_text = step.get("code") or step.get("code_snippet") or ""
                line = f"{index}. **{role}** at `{location}`"
                if code_text:
                    line += f" — `{str(code_text).strip()}`"
                lines.append(line)
            else:
                lines.append(f"{index}. `{step}`")
        lines.append("")

    if evidence.get("taint_source") or evidence.get("taint_sink"):
        lines.append(f"**Source:** `{_display(evidence.get('taint_source'))}`  ")
        lines.append(f"**Sink:** `{_display(evidence.get('taint_sink'))}`")
        lines.append("")


def generate_markdown(run: Any, findings: Iterable[Any]) -> str:
    normalized = normalize_findings(findings)
    counts = _severity_counts(normalized)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    run_id = _run_value(run, "id")
    target = _run_value(run, "path")

    lines = [
        "# Security Vulnerability Report — Code-VulnScan",
        "",
        f"**Target:** `{target}`  ",
        f"**Scan ID:** `{run_id}`  ",
        f"**Generated:** {ts}  ",
        f"**Tool:** {TOOL_NAME} v{TOOL_VERSION}",
        "",
        "---",
        "",
        "## Executive Summary",
        "",
        "| Severity | Count |",
        "|---|---:|",
    ]
    for severity in SEVERITIES:
        lines.append(f"| {severity.capitalize()} | {counts[severity]} |")
    lines.extend([f"| **Total** | **{len(normalized)}** |", ""])

    if normalized:
        top = normalized[0]
        lines.append(
            f"The highest-priority issue is **{top['vulnerability_name']}** in "
            f"`{top['file_path']}` (CVSS: {_display(top['cvss_score'])}). "
            "Prioritize Critical and High findings whose prerequisites are satisfied."
        )
    else:
        lines.append(
            "No confirmed or likely findings met the selected severity threshold. "
            "This is not proof that the target is vulnerability-free; retain scan scope and coverage evidence."
        )
    lines.extend(["", "---", ""])

    by_severity: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for finding in normalized:
        by_severity[finding["severity"]].append(finding)

    for severity in SEVERITIES:
        severity_findings = by_severity.get(severity, [])
        if not severity_findings:
            continue
        lines.extend([f"## {severity.capitalize()} Findings ({len(severity_findings)})", ""])
        for finding in severity_findings:
            lines.extend([
                f"### {SEVERITY_EMOJI[severity]} {finding['vulnerability_name']}",
                "",
                f"**Finding ID:** `{finding['finding_id']}`  ",
                f"**Vulnerability Name:** {finding['vulnerability_name']}  ",
                f"**Severity:** {severity.capitalize()}  ",
                f"**Exploitability:** {finding['exploitability']}  ",
                f"**CVSS Score:** {_display(finding['cvss_score'])}  ",
                f"**CVSS Vector:** `{finding['cvss_vector']}`  ",
                f"**OWASP Category:** {finding['owasp_category']}  ",
                f"**CWE:** {finding['cwe']}  ",
                f"**Confidence:** {finding['confidence']}  ",
                f"**Validation Status:** {finding['validation_status']}",
                "",
                "#### Vulnerability Description",
                "",
                finding["vulnerability_description"],
                "",
                "#### Impact",
                "",
                finding["impact"],
                "",
                "#### Affected Assets",
                "",
            ])
            lines.extend(f"- `{asset}`" for asset in finding["affected_assets"])
            lines.extend(["", "#### Exact Locations", ""])
            lines.extend(f"- `{_location_label(location)}`" for location in finding["exact_locations"])
            lines.extend([
                "",
                "#### Attack Prerequisites",
                "",
                finding["attack_prerequisites"],
                "",
            ])
            _append_markdown_evidence(lines, finding)
            lines.extend([
                "#### Remediation Guidelines",
                "",
                finding["remediation_guidelines"],
                "",
                "#### References",
                "",
            ])
            if finding["references"]:
                lines.extend(f"- {reference}" for reference in finding["references"])
            else:
                lines.append(f"- {NOT_ASSESSED}")
            lines.extend(["", "---", ""])

    lines.extend(["## Remediation Priority Checklist", ""])
    if normalized:
        due = {
            "critical": "Immediate action required",
            "high": "Fix within one sprint",
            "medium": "Fix in the planned remediation cycle",
            "low": "Backlog and risk-accept explicitly if deferred",
            "informational": "Review as hardening guidance",
        }
        for severity in SEVERITIES:
            if not by_severity.get(severity):
                continue
            lines.extend([f"### {due[severity]} ({severity.capitalize()})", ""])
            for finding in by_severity[severity]:
                lines.append(
                    f"- [ ] `{finding['finding_id']}` — {finding['vulnerability_name']} — "
                    f"`{_location_label(finding['exact_locations'][0])}`"
                )
            lines.append("")
    else:
        lines.extend(["No finding-specific remediation actions were generated.", ""])

    lines.extend([
        "---",
        "*Report generated by [Code-VulnScan](https://github.com/Bhanunamikaze/Code-VulnScan-Skill).*",
    ])
    return "\n".join(lines)


def _json_finding(finding: dict[str, Any]) -> dict[str, Any]:
    """Return schema v2 fields plus schema v1 aliases for existing consumers."""
    item = dict(finding)
    item.update({
        "id": finding["record_id"] or finding["finding_id"],
        "title": finding["vulnerability_name"],
        "file": finding["file_path"],
        "language": finding["language"],
        "vuln_type": finding["vulnerability_type"],
        "owasp": finding["owasp_category"],
        "description": finding["vulnerability_description"],
        "taint_source": finding["evidence"]["taint_source"],
        "taint_sink": finding["evidence"]["taint_sink"],
        "taint_path": finding["evidence"]["taint_path"],
        "remediation": finding["remediation_guidelines"],
    })
    return item


def generate_json(run: Any, findings: Iterable[Any]) -> dict[str, Any]:
    normalized = normalize_findings(findings)
    counts = _severity_counts(normalized)
    return {
        "schema_version": "2.0.0",
        "tool": TOOL_NAME,
        "tool_version": TOOL_VERSION,
        "scan_id": _run_value(run, "id"),
        "target": _run_value(run, "path"),
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "summary": {**counts, "total": len(normalized)},
        "findings": [_json_finding(finding) for finding in normalized],
    }


def _html_list(values: Iterable[Any], *, code: bool = False) -> str:
    items = []
    for value in values:
        rendered = escape(str(value))
        items.append(f"<li><code>{rendered}</code></li>" if code else f"<li>{rendered}</li>")
    return "<ul>" + "".join(items) + "</ul>"


def _html_evidence(finding: dict[str, Any]) -> str:
    evidence = finding["evidence"]
    parts: list[str] = []
    if evidence.get("code_snippet"):
        parts.append(f"<pre><code>{escape(evidence['code_snippet'])}</code></pre>")
    if evidence.get("taint_path"):
        steps = evidence["taint_path"]
        steps = steps if isinstance(steps, list) else [steps]
        rendered_steps = []
        for step in steps:
            if isinstance(step, dict):
                rendered_steps.append(
                    f"{escape(str(step.get('role', 'step')).upper())} at "
                    f"<code>{escape(_location_label(step))}</code> — "
                    f"{escape(str(step.get('code') or step.get('code_snippet') or ''))}"
                )
            else:
                rendered_steps.append(escape(str(step)))
        parts.append("<h4>Evidence / Taint Path</h4><ol>" + "".join(f"<li>{s}</li>" for s in rendered_steps) + "</ol>")
    if evidence.get("taint_source") or evidence.get("taint_sink"):
        parts.append(
            f"<p><strong>Source:</strong> <code>{escape(_display(evidence.get('taint_source')))}</code><br>"
            f"<strong>Sink:</strong> <code>{escape(_display(evidence.get('taint_sink')))}</code></p>"
        )
    return "".join(parts) or f"<p>{NOT_ASSESSED}</p>"


def generate_html(run: Any, findings: Iterable[Any]) -> str:
    normalized = normalize_findings(findings)
    counts = _severity_counts(normalized)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    target = escape(str(_run_value(run, "path")))
    run_id = escape(str(_run_value(run, "id")))
    colors = {
        "critical": "#b91c1c",
        "high": "#c2410c",
        "medium": "#a16207",
        "low": "#15803d",
        "informational": "#0369a1",
    }

    summary_rows = "".join(
        f"<tr><th>{severity.capitalize()}</th><td>{counts[severity]}</td></tr>"
        for severity in SEVERITIES
    ) + f"<tr><th>Total</th><td><strong>{len(normalized)}</strong></td></tr>"

    if normalized:
        summary_text = (
            f"Highest-priority issue: <strong>{escape(normalized[0]['vulnerability_name'])}</strong> "
            f"in <code>{escape(normalized[0]['file_path'])}</code>."
        )
    else:
        summary_text = (
            "No confirmed or likely findings met the selected severity threshold. "
            "This does not prove that the target is vulnerability-free."
        )

    finding_sections: list[str] = []
    for finding in normalized:
        sev = finding["severity"]
        rows = [
            ("Finding ID", f"<code>{escape(finding['finding_id'])}</code>"),
            ("Vulnerability Name", escape(finding["vulnerability_name"])),
            ("Severity", escape(sev.capitalize())),
            ("Exploitability", escape(finding["exploitability"])),
            ("CVSS Score", escape(_display(finding["cvss_score"]))),
            ("CVSS Vector", f"<code>{escape(finding['cvss_vector'])}</code>"),
            ("OWASP Category", escape(finding["owasp_category"])),
            ("CWE", escape(finding["cwe"])),
            ("Confidence", escape(finding["confidence"])),
            ("Validation Status", escape(finding["validation_status"])),
        ]
        metadata = "".join(f"<tr><th>{label}</th><td>{value}</td></tr>" for label, value in rows)
        references = _html_list(finding["references"]) if finding["references"] else f"<p>{NOT_ASSESSED}</p>"
        finding_sections.append(f"""
<article id="{escape(finding['finding_id'])}" class="finding" style="border-left-color:{colors[sev]}">
  <h2>[{sev.upper()}] {escape(finding['vulnerability_name'])}</h2>
  <table>{metadata}</table>
  <h3>Vulnerability Description</h3><p>{escape(finding['vulnerability_description'])}</p>
  <h3>Impact</h3><p>{escape(finding['impact'])}</p>
  <h3>Affected Assets</h3>{_html_list(finding['affected_assets'], code=True)}
  <h3>Exact Locations</h3>{_html_list((_location_label(location) for location in finding['exact_locations']), code=True)}
  <h3>Attack Prerequisites</h3><p>{escape(finding['attack_prerequisites'])}</p>
  <h3>Evidence</h3>{_html_evidence(finding)}
  <h3>Remediation Guidelines</h3><p>{escape(finding['remediation_guidelines'])}</p>
  <h3>References</h3>{references}
</article>""")

    findings_html = "\n".join(finding_sections) or '<section class="empty"><h2>Findings</h2><p>No reportable findings.</p></section>'
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Code-VulnScan Security Report — {target}</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ max-width:1100px;margin:0 auto;padding:24px;font:16px/1.55 system-ui,sans-serif;color:#1f2937; }}
  h1 {{ border-bottom:2px solid #111827;padding-bottom:10px; }}
  code,pre {{ font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }}
  code {{ background:#f3f4f6;padding:2px 5px;border-radius:4px; }}
  pre {{ background:#111827;color:#f9fafb;padding:14px;overflow:auto;border-radius:6px; }}
  table {{ border-collapse:collapse;width:100%;margin:12px 0; }}
  th,td {{ border:1px solid #d1d5db;padding:8px;text-align:left;vertical-align:top; }}
  th {{ width:220px;background:#f9fafb; }}
  .meta,.summary,.empty {{ background:#f9fafb;border:1px solid #d1d5db;padding:16px;border-radius:8px;margin:16px 0; }}
  .finding {{ border:1px solid #d1d5db;border-left:7px solid;padding:18px;margin:24px 0;border-radius:8px; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background:#111827;color:#e5e7eb; }} .meta,.summary,.empty,th {{ background:#1f2937; }}
    table,th,td,.finding {{ border-color:#4b5563; }} code {{ background:#374151; }}
  }}
</style>
</head>
<body>
<h1>Security Vulnerability Report — Code-VulnScan</h1>
<div class="meta"><strong>Target:</strong> <code>{target}</code><br>
<strong>Scan ID:</strong> <code>{run_id}</code><br><strong>Generated:</strong> {ts}<br>
<strong>Tool:</strong> {TOOL_NAME} v{TOOL_VERSION}</div>
<section class="summary"><h2>Executive Summary</h2><table>{summary_rows}</table><p>{summary_text}</p></section>
{findings_html}
<footer><hr><small>Report generated by Code-VulnScan — Scan ID {run_id}</small></footer>
</body>
</html>"""


def _sarif_location(location: Any, fallback: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(location, dict):
        location = {}
    file_path = str(location.get("file") or location.get("file_path") or fallback["file_path"])
    start = location.get("line_start") or location.get("line") or fallback.get("line_start") or 1
    end = location.get("line_end") or start
    return {
        "physicalLocation": {
            "artifactLocation": {"uri": file_path.lstrip("/")},
            "region": {"startLine": int(start), "endLine": int(end)},
        }
    }


def _sarif_code_flow(finding: dict[str, Any]) -> list[dict[str, Any]]:
    taint_path = finding["evidence"].get("taint_path")
    if not isinstance(taint_path, list):
        return []
    locations = []
    for step in taint_path:
        if not isinstance(step, dict) or not (step.get("file") or step.get("file_path")):
            continue
        location = _sarif_location(step, finding)
        location["message"] = {"text": str(step.get("code") or step.get("code_snippet") or step.get("role") or "Data-flow step")}
        locations.append({
            "location": location,
            "kinds": [str(step.get("role") or "data-flow")],
        })
    return [{"threadFlows": [{"locations": locations}]}] if locations else []


def generate_sarif(run: Any, findings: Iterable[Any]) -> dict[str, Any]:
    normalized = normalize_findings(findings)
    rules: dict[str, dict[str, Any]] = {}
    results: list[dict[str, Any]] = []
    severity_map = {
        "critical": "error",
        "high": "error",
        "medium": "warning",
        "low": "note",
        "informational": "note",
    }

    for finding in normalized:
        rule_id = finding["cwe"] if finding["cwe"] != "Not classified" else finding["vulnerability_type"]
        rule_id = re.sub(r"[^A-Za-z0-9_.-]", "-", rule_id) or "security-vulnerability"
        if rule_id not in rules:
            rule: dict[str, Any] = {
                "id": rule_id,
                "name": re.sub(r"[^A-Za-z0-9_.-]", "-", finding["vulnerability_type"]),
                "shortDescription": {"text": finding["vulnerability_name"]},
                "fullDescription": {"text": finding["vulnerability_description"]},
                "properties": {
                    "tags": ["security", finding["category"], finding["owasp_category"]],
                    "security-severity": str(finding["cvss_score"] if finding["cvss_score"] is not None else 0.0),
                    "cwe": finding["cwe"],
                    "owasp-category": finding["owasp_category"],
                },
            }
            cwe_match = re.search(r"CWE-(\d+)", finding["cwe"], re.IGNORECASE)
            if cwe_match:
                rule["helpUri"] = f"https://cwe.mitre.org/data/definitions/{cwe_match.group(1)}.html"
            rules[rule_id] = rule

        primary = _sarif_location(finding["exact_locations"][0], finding)
        if finding["evidence"].get("code_snippet"):
            primary["physicalLocation"]["region"]["snippet"] = {
                "text": finding["evidence"]["code_snippet"]
            }
        result: dict[str, Any] = {
            "ruleId": rule_id,
            "level": severity_map[finding["severity"]],
            "message": {
                "text": (
                    f"{finding['vulnerability_name']}. {finding['vulnerability_description']} "
                    f"Impact: {finding['impact']}"
                )
            },
            "locations": [primary],
            "fingerprints": {"code-vulnscan/v1": finding["finding_id"]},
            "partialFingerprints": {"primaryLocationLineHash": finding["finding_id"]},
            "properties": {
                "findingId": finding["finding_id"],
                "severity": finding["severity"],
                "exploitability": finding["exploitability"],
                "cvssScore": finding["cvss_score"],
                "cvssVector": finding["cvss_vector"],
                "owaspCategory": finding["owasp_category"],
                "cwe": finding["cwe"],
                "confidence": finding["confidence"],
                "validationStatus": finding["validation_status"],
                "impact": finding["impact"],
                "affectedAssets": finding["affected_assets"],
                "attackPrerequisites": finding["attack_prerequisites"],
                "remediationGuidelines": finding["remediation_guidelines"],
                "references": finding["references"],
                "taintSource": finding["evidence"]["taint_source"],
                "taintSink": finding["evidence"]["taint_sink"],
            },
        }
        if len(finding["exact_locations"]) > 1:
            result["relatedLocations"] = [
                {"id": index, **_sarif_location(location, finding)}
                for index, location in enumerate(finding["exact_locations"][1:], 1)
            ]
        code_flows = _sarif_code_flow(finding)
        if code_flows:
            result["codeFlows"] = code_flows
        results.append(result)

    return {
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {
                "driver": {
                    "name": TOOL_NAME,
                    "version": TOOL_VERSION,
                    "informationUri": "https://github.com/Bhanunamikaze/Code-VulnScan-Skill",
                    "rules": list(rules.values()),
                }
            },
            "results": results,
            "invocations": [{
                "executionSuccessful": True,
                "commandLine": f"vulnscan scan {_run_value(run, 'path')}",
                "properties": {"scanId": str(_run_value(run, "id"))},
            }],
        }],
    }


def generate_report_artifacts(
    run: Any,
    findings: Iterable[Any],
    output_dir: str | Path = WORKSPACE,
    formats: Iterable[str] = ("markdown", "html", "json", "sarif"),
    *,
    write_primary: bool = True,
) -> dict[str, Path]:
    """Write requested report artifacts and the primary in-project report.

    ``Vulnscan_results.md`` is written only when Markdown is requested.  The
    automatic scan-completion path requests all formats, so every completed
    review produces the complete artifact set, including a valid empty report.
    """
    raw_findings = list(findings)
    selected = list(dict.fromkeys(formats))
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    run_id = str(_run_value(run, "id"))
    outputs: dict[str, Path] = {}

    if "markdown" in selected:
        content = generate_markdown(run, raw_findings)
        path = out_dir / f"report_{run_id}.md"
        path.write_text(content, encoding="utf-8")
        outputs["markdown"] = path
        if write_primary:
            target = Path(str(_run_value(run, "path"))).resolve()
            if not target.is_dir():
                raise RuntimeError(f"Cannot write primary report: scan target is not a directory: {target}")
            primary = target / "Vulnscan_results.md"
            primary.write_text(content, encoding="utf-8")
            outputs["primary_markdown"] = primary

    if "html" in selected:
        path = out_dir / f"report_{run_id}.html"
        path.write_text(generate_html(run, raw_findings), encoding="utf-8")
        outputs["html"] = path

    if "json" in selected:
        path = out_dir / f"report_{run_id}.json"
        path.write_text(json.dumps(generate_json(run, raw_findings), indent=2), encoding="utf-8")
        outputs["json"] = path

    if "sarif" in selected:
        path = out_dir / f"report_{run_id}.sarif"
        path.write_text(json.dumps(generate_sarif(run, raw_findings), indent=2), encoding="utf-8")
        outputs["sarif"] = path

    canonical_findings = [_json_finding(finding) for finding in normalize_findings(raw_findings)]
    confirmed_path = out_dir / "confirmed_findings.json"
    confirmed_path.write_text(json.dumps(canonical_findings, indent=2), encoding="utf-8")
    outputs["confirmed_findings"] = confirmed_path
    return outputs


def main() -> None:
    parser = argparse.ArgumentParser(description="Code-VulnScan report generator")
    parser.add_argument("--run-id", help="Specific run ID (default: latest)")
    parser.add_argument(
        "--format",
        choices=["markdown", "json", "sarif", "html", "all"],
        default="all",
        help="Output format (default: all)",
    )
    parser.add_argument(
        "--min-severity",
        choices=["critical", "high", "medium", "low", "informational"],
        default="informational",
    )
    parser.add_argument("--output-dir", default=str(WORKSPACE))
    args = parser.parse_args()

    conn = initialize_database()
    run, findings = get_run_and_findings(conn, args.run_id, args.min_severity)
    formats = ("markdown", "html", "json", "sarif") if args.format == "all" else (args.format,)
    print(
        f"Generating report for run {run['id']}: {len(findings)} confirmed findings",
        file=sys.stderr,
    )
    outputs = generate_report_artifacts(run, findings, args.output_dir, formats)
    labels = {
        "markdown": "Markdown report",
        "primary_markdown": "Primary report",
        "html": "HTML report",
        "json": "JSON report",
        "sarif": "SARIF report",
        "confirmed_findings": "Confirmed findings",
    }
    for name, path in outputs.items():
        print(f"{labels[name]}: {path}")


if __name__ == "__main__":
    main()
