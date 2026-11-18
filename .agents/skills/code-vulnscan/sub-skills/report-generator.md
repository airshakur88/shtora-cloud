# Final report generator

Read this before producing or reviewing the final vulnerability report.

## Invariant

Every completed scan produces a report, including a scan with zero confirmed
findings. The canonical artifacts are:

- `<target>/Vulnscan_results.md` — primary human-readable deliverable
- `workspace/report_<run_id>.md`
- `workspace/report_<run_id>.html`
- `workspace/report_<run_id>.json`
- `workspace/report_<run_id>.sarif`
- `workspace/confirmed_findings.json`

`scripts/scan.py --update-findings ...` completes the review and generates all
artifacts automatically. Always run it after every full review; submit an empty
JSON array (`[]`) when the complete analysis has no reportable findings. A zero-
candidate pattern sweep remains `pending_review` because taint, auth,
architecture, secret, dependency, and manual phases can still find issues.
Running `python3 scripts/report.py` regenerates all four formats for the latest
run by default; `--format` can select one format.

An empty report must state that no confirmed or likely findings met the selected
threshold and that this does not prove the target is vulnerability-free. Never
skip or delete the report just because the finding count is zero.

## Canonical finding contract

Every final finding must contain these user-facing fields:

1. **Vulnerability Name** — specific weakness plus affected component.
2. **Severity** — Critical, High, Medium, Low, or Informational.
3. **Exploitability** — reachability, required effort, privileges, and user
   interaction. Prefer one concrete sentence over a vague rating.
4. **CVSS Score** — CVSS base score, or `Not assessed` when not yet scored.
5. **CVSS Vector** — full vector matching the score, or `Not assessed`.
6. **OWASP Category** — include edition when known, for example
   `A03:2021 — Injection`.
7. **Vulnerability Description** — what is wrong and why the control fails.
8. **Impact** — concrete attacker outcome and affected security properties.
9. **Affected Assets** — files, routes, services, packages, resources, or data.
10. **Remediation Guidelines** — exact fix, preferably with same-language code.

The report also includes the minimum metadata needed to validate, deduplicate,
and operationalize a finding:

- **Finding ID** — stable across report regeneration.
- **CWE** — identifier and name when known.
- **Confidence** — evidence confidence, separate from severity.
- **Validation Status** — `confirmed` or `likely` for reportable findings.
- **Exact Locations** — file and line range; list all material locations.
- **Evidence / Taint Path** — masked code evidence and numbered source-to-sink
  flow where applicable.
- **Attack Prerequisites** — access, privileges, user interaction, configuration,
  or environmental conditions required.
- **References** — primary CWE/OWASP/advisory/vendor references only.

These are distinct concepts. Do not use CVSS as confidence, do not use affected
files as impact, and do not describe a candidate pattern match as confirmed
exploitability.

## Reviewer JSON input

Use the following shape in `workspace/confirmed_findings.json`. Existing legacy
keys (`title`, `description`, `owasp`, and `remediation`) remain accepted, but new
review output should use the canonical names.

```json
{
  "finding_id": "CVS-A1B2C3D4E5F6",
  "vulnerability_name": "SQL injection in account search",
  "severity": "critical",
  "exploitability": "Remote; low complexity; without authentication",
  "cvss_score": 9.8,
  "cvss_vector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
  "owasp_category": "A03:2021 — Injection",
  "cwe": "CWE-89 — SQL Injection",
  "vulnerability_description": "The search parameter is concatenated into a SQL statement executed by the database.",
  "impact": "An unauthenticated attacker can read or modify all records accessible to the database account.",
  "affected_assets": ["app/routes/search.py", "GET /accounts/search", "customer database"],
  "remediation_guidelines": "Use a parameterized query and bind the search value as data.",
  "confidence": "confirmed",
  "validation_status": "confirmed",
  "exact_locations": [
    {"file": "app/routes/search.py", "line_start": 42, "line_end": 43}
  ],
  "taint_path": [
    {"role": "source", "file": "app/routes/search.py", "line": 38, "code": "term = request.args['q']"},
    {"role": "sink", "file": "app/routes/search.py", "line": 43, "code": "cursor.execute(query)"}
  ],
  "attack_prerequisites": "The search endpoint is network reachable; no account is required.",
  "references": ["https://cwe.mitre.org/data/definitions/89.html"],
  "status": "confirmed"
}
```

If a field genuinely cannot be assessed, use `null` or `Not assessed`; do not
invent facts. `report.py` safely fills missing legacy fields with explicit
fallbacks so old scan databases continue to render.

## Finding section order

Use this stable order in Markdown and HTML:

```text
[SEVERITY] Vulnerability Name
Finding ID, Vulnerability Name, Severity, Exploitability
CVSS Score, CVSS Vector, OWASP Category, CWE
Confidence, Validation Status
Vulnerability Description
Impact
Affected Assets
Exact Locations
Attack Prerequisites
Evidence / Taint Path
Remediation Guidelines
References
```

Group findings by severity descending. Within a severity, use deterministic
title and finding-ID order. End with a severity-based remediation checklist.

## Quality and safety rules

- State a concrete outcome: `an attacker can read all customer records`, not
  `this may result in unauthorized access`.
- Cite exact files and lines. Include the nearest discovered HTTP entry point
  when available.
- Include exact vulnerable code with enough context to validate it. Mask secret
  values and personal data; never put live credentials into any report format.
- Number source, propagation, validation, and sink steps for taint findings.
- Keep remediation specific to the vulnerable technology and include corrected
  code where useful.
- Do not include rejected candidates or unvalidated speculation.
- Do not claim that a zero-finding report proves security.

## Format mapping

- **Markdown and HTML:** render every canonical field with explicit labels.
- **JSON schema 2.0:** preserve every field in structured form and retain v1
  aliases for existing integrations.
- **SARIF 2.1.0:** map description and impact into the result message; locations
  into `locations`/`relatedLocations`; evidence flows into `codeFlows`; CVSS,
  OWASP, CWE, confidence, status, exploitability, prerequisites, assets,
  remediation, and references into rule/result properties. Empty findings yield
  a valid SARIF run with empty `rules` and `results` arrays.

Dependency findings use the same contract. Put package name/version and manifest
location in Affected Assets, the CVE/advisory in References, and the fixed version
or compensating control in Remediation Guidelines.
