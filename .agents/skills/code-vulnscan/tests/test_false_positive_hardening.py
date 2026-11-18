"""Regression controls for high-confidence sanitizer and sink semantics."""

from pathlib import Path

from scripts.taint import analyze_file, analyze_python_ast
from scripts.taint_go import analyze_go
from scripts.utils.patterns import scan_file_for_candidates


def _types(result: dict) -> set[str]:
    return {path["sink_type"] for path in result["potential_paths"]}


def test_python_template_sinks_have_distinct_categories():
    ssti = analyze_python_ast(
        """
from flask import request, render_template_string
def view():
    value = request.args.get("value")
    return render_template_string(value)
""",
        "view.py",
    )
    xss = analyze_python_ast(
        """
from flask import request
from markupsafe import Markup
def view():
    value = request.args.get("value")
    return Markup(value)
""",
        "view.py",
    )

    assert _types(ssti) == {"ssti"}
    assert _types(xss) == {"xss"}


def test_python_path_construction_and_safe_directory_join_are_not_sinks():
    contained = analyze_python_ast(
        """
import os
from flask import request
def download():
    name = request.args.get("name")
    path = os.path.realpath(os.path.join("/srv/files", name))
    if not path.startswith("/srv/files/"):
        raise ValueError("outside root")
    return open(path).read()
""",
        "download.py",
    )
    werkzeug = analyze_python_ast(
        """
from flask import request, send_from_directory
from werkzeug.utils import secure_filename
def download():
    name = request.args.get("name")
    return send_from_directory("/srv/files", secure_filename(name))
""",
        "download.py",
    )
    tainted_base = analyze_python_ast(
        """
from flask import request, send_from_directory
def download():
    directory = request.args.get("directory")
    return send_from_directory(directory, "manual.pdf")
""",
        "download.py",
    )

    assert _types(contained) == set()
    assert _types(werkzeug) == set()
    assert _types(tainted_base) == {"path_traversal"}


def test_python_command_pattern_requires_direct_external_input():
    safe = "safe = shlex.quote(user_value)\nos.system(f'convert {safe}')"
    unsafe = "os.system(request.args.get('cmd'))"

    assert scan_file_for_candidates(Path("safe.py"), safe, "python") == []
    assert {
        finding["vuln_type"]
        for finding in scan_file_for_candidates(Path("unsafe.py"), unsafe, "python")
    } == {"cmdi"}


def test_javascript_redirect_allowlist_requires_positive_dominating_guard(tmp_path):
    safe = tmp_path / "safe.js"
    safe.write_text(
        """
const ALLOWED_REDIRECTS = new Set(['/home']);
function go(req, res) {
  const next = req.query.next;
  if (ALLOWED_REDIRECTS.has(next)) {
    res.redirect(next);
  }
}
"""
    )
    unsafe = tmp_path / "unsafe.js"
    unsafe.write_text(
        """
const ALLOWED_REDIRECTS = new Set(['/home']);
function go(req, res) {
  const next = req.query.next;
  if (!ALLOWED_REDIRECTS.has(next)) {
    res.redirect(next);
  }
}
"""
    )

    assert _types(analyze_file(str(safe), "javascript")) == set()
    assert _types(analyze_file(str(unsafe), "javascript")) == {"open_redirect"}


def test_php_nested_command_sink_is_not_duplicated_as_xss(tmp_path):
    source = tmp_path / "command.php"
    source.write_text("<?php\n$cmd = $_GET['cmd'];\necho system($cmd);\n")

    assert _types(analyze_file(str(source), "php")) == {"cmdi"}


def test_go_containment_guard_requires_boundary_and_rejecting_exit():
    safe = """
package main
func read(r *http.Request) {
  raw := r.URL.Query().Get("path")
  clean := filepath.Clean(filepath.Join(root, raw))
  if !strings.HasPrefix(clean, root+string(os.PathSeparator)) {
    return
  }
  os.ReadFile(clean)
}
"""
    weak = """
package main
func read(r *http.Request) {
  raw := r.URL.Query().Get("path")
  clean := filepath.Clean(filepath.Join(root, raw))
  if !strings.HasPrefix(clean, root) {
    log.Print("outside root")
  }
  os.ReadFile(clean)
}
"""

    assert _types(analyze_go(safe, "safe.go")) == set()
    assert _types(analyze_go(weak, "weak.go")) == {"path_traversal"}
