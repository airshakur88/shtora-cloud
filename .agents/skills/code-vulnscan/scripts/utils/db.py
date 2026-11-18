"""SQLite state management for Code-VulnScan."""

import sqlite3
import uuid
import json
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent.parent.parent / "workspace" / "scan_state.db"


# Nullable report metadata was added after the original database format.  The
# migration keeps existing scan databases readable and lets richer reviewer
# output survive the update-findings -> report boundary.
FINDING_REPORT_COLUMNS = {
    "stable_id": "TEXT",
    "exploitability": "TEXT",
    "impact": "TEXT",
    "affected_assets": "TEXT",
    "exact_locations": "TEXT",
    "attack_prerequisites": "TEXT",
    "references_json": "TEXT",
    "notes": "TEXT",
}


def _ensure_finding_report_columns(conn):
    existing = {row[1] for row in conn.execute("PRAGMA table_info(findings)")}
    for column, column_type in FINDING_REPORT_COLUMNS.items():
        if column not in existing:
            conn.execute(f"ALTER TABLE findings ADD COLUMN {column} {column_type}")


def _db_value(value):
    """Serialize structured reviewer metadata for SQLite text columns."""
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value)
    return value


def get_connection():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def initialize_database():
    conn = get_connection()
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS scan_runs (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'running',
            languages TEXT,
            total_files INTEGER DEFAULT 0,
            candidate_count INTEGER DEFAULT 0,
            confirmed_count INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS findings (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            line_start INTEGER,
            line_end INTEGER,
            language TEXT,
            vuln_type TEXT NOT NULL,
            category TEXT,
            severity TEXT DEFAULT 'medium',
            confidence TEXT DEFAULT 'possible',
            title TEXT NOT NULL,
            description TEXT,
            code_snippet TEXT,
            taint_source TEXT,
            taint_sink TEXT,
            taint_path TEXT,
            cwe TEXT,
            owasp TEXT,
            cvss_score REAL,
            cvss_vector TEXT,
            remediation TEXT,
            false_positive_analysis TEXT,
            status TEXT NOT NULL DEFAULT 'candidate',
            FOREIGN KEY (run_id) REFERENCES scan_runs(id)
        );

        CREATE TABLE IF NOT EXISTS reviews (
            id TEXT PRIMARY KEY,
            finding_id TEXT NOT NULL,
            verdict TEXT NOT NULL,
            reason TEXT,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (finding_id) REFERENCES findings(id)
        );
    """)
    _ensure_finding_report_columns(conn)
    conn.commit()
    return conn


def create_run(conn, path, languages=None):
    run_id = str(uuid.uuid4())[:8]
    conn.execute(
        "INSERT INTO scan_runs (id, path, timestamp, languages) VALUES (?, ?, ?, ?)",
        (run_id, str(path), datetime.now(timezone.utc).isoformat(), ",".join(languages or [])),
    )
    conn.commit()
    return run_id


def insert_finding(conn, run_id, finding: dict, *, commit=True):
    fid = str(uuid.uuid4())[:12]
    conn.execute(
        """INSERT INTO findings
           (id, run_id, file_path, line_start, line_end, language, vuln_type, category,
            severity, confidence, title, description, code_snippet,
            taint_source, taint_sink, taint_path, cwe, owasp, remediation, status,
            stable_id, exploitability, impact, affected_assets, exact_locations,
            attack_prerequisites, references_json, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            fid, run_id,
            finding.get("file_path", ""), finding.get("line_start"), finding.get("line_end"),
            finding.get("language"), finding.get("vuln_type"), finding.get("category"),
            finding.get("severity", "medium"), finding.get("confidence", "possible"),
            finding.get("title") or finding.get("vulnerability_name", ""),
            finding.get("description") or finding.get("vulnerability_description"),
            finding.get("code_snippet"), finding.get("taint_source"),
            finding.get("taint_sink"), _db_value(finding.get("taint_path")),
            finding.get("cwe"), finding.get("owasp") or finding.get("owasp_category"),
            finding.get("remediation") or finding.get("remediation_guidelines"),
            finding.get("status", "candidate"),
            finding.get("finding_id") or finding.get("stable_id"),
            finding.get("exploitability"), finding.get("impact"),
            _db_value(finding.get("affected_assets")), _db_value(finding.get("exact_locations")),
            finding.get("attack_prerequisites"),
            _db_value(finding.get("references_json") or finding.get("references")),
            _db_value(finding.get("notes")),
        ),
    )
    if commit:
        conn.commit()
    return fid


def update_finding_status(conn, finding_id, status, *, commit=True, **kwargs):
    updates = ["status = ?"]
    values = [status]
    for k, v in kwargs.items():
        updates.append(f"{k} = ?")
        values.append(v)
    values.append(finding_id)
    conn.execute(f"UPDATE findings SET {', '.join(updates)} WHERE id = ?", values)
    if commit:
        conn.commit()


def list_runs(conn, limit=10):
    return conn.execute(
        "SELECT * FROM scan_runs ORDER BY timestamp DESC LIMIT ?", (limit,)
    ).fetchall()


def get_findings(conn, run_id=None, status=None, min_severity=None):
    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "informational": 4}
    query = "SELECT * FROM findings WHERE 1=1"
    params = []
    if run_id:
        query += " AND run_id = ?"
        params.append(run_id)
    if status:
        statuses = status if isinstance(status, list) else [status]
        query += f" AND status IN ({','.join('?'*len(statuses))})"
        params.extend(statuses)
    rows = conn.execute(query, params).fetchall()
    if min_severity:
        threshold = severity_order.get(min_severity, 4)
        rows = [r for r in rows if severity_order.get(r["severity"], 4) <= threshold]
    return sorted(rows, key=lambda r: severity_order.get(r["severity"], 4))


def get_latest_run(conn):
    row = conn.execute("SELECT * FROM scan_runs ORDER BY timestamp DESC LIMIT 1").fetchone()
    return row
