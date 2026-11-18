"""Evidence-oriented PHP/Ruby pattern coverage and false-positive controls."""

import re
from pathlib import Path

import pytest

from scripts.utils.patterns import load_patterns, scan_file_for_candidates


ROOT = Path(__file__).parent.parent


def _scan(language: str, content: str) -> list[dict]:
    suffix = ".php" if language == "php" else ".rb"
    return scan_file_for_candidates(Path(f"example{suffix}"), content, language)


@pytest.mark.parametrize("language", ["php", "ruby"])
def test_framework_pattern_packs_are_valid_and_ids_are_unique(language):
    patterns = load_patterns(language)
    entries = [entry for group in patterns.values() for entry in group]
    ids = [entry["id"] for entry in entries]
    assert len(entries) >= 30
    assert len(ids) == len(set(ids))
    for entry in entries:
        re.compile(entry["regex"], re.IGNORECASE)
        assert entry["confidence"] in {"possible", "likely", "confirmed"}
        assert entry["description"]


@pytest.mark.parametrize(
    ("snippet", "expected_type", "expected_id"),
    [
        ("$rows = DB::raw('status = ' . request('status'));", "sqli", "php-sqli-laravel-001"),
        ("$rows = $wpdb->get_results('SELECT * FROM t WHERE id=' . $_GET['id']);", "sqli", "php-sqli-wp-001"),
        ("return Http::get(request('url'));", "ssrf", "php-ssrf-001"),
        ("return new RedirectResponse($request->query->get('next'));", "open_redirect", "php-redirect-framework-001"),
        ("$user->update($request->all());", "mass_assignment", "php-mass-laravel-001"),
        ("{!! request('bio') !!}", "xss", "php-xss-blade-001"),
        ("$value = unserialize($_COOKIE['state']);", "deserialization", "php-deser-001"),
        ("$request->file('avatar')->move($dir, $request->file('avatar')->getClientOriginalName());", "unsafe_upload", "php-upload-laravel-001"),
        ("Log::info('request', $request->all());", "sensitive_data_exposure", "php-log-001"),
    ],
)
def test_php_patterns_require_concrete_source_and_sink(snippet, expected_type, expected_id):
    findings = _scan("php", f"<?php\n{snippet}\n")
    assert any(
        finding["vuln_type"] == expected_type and finding["pattern_id"] == expected_id
        for finding in findings
    ), findings


@pytest.mark.parametrize(
    "snippet",
    [
        "$stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id');",
        "$stmt->execute(['id' => $_GET['id']]);",
        "echo htmlspecialchars($_GET['name'], ENT_QUOTES, 'UTF-8');",
        "$user->update($request->only(['display_name', 'timezone']));",
        "return redirect()->route('dashboard');",
        "$response = Http::get(config('services.catalog.url'));",
        "$value = unserialize($trustedCache, ['allowed_classes' => false]);",
        "$rows = $wpdb->get_results($wpdb->prepare('SELECT * FROM t WHERE id = %d', $_GET['id']));",
        "$process = new Process(['/usr/bin/convert', '--', $safeInput, $safeOutput]);",
    ],
)
def test_safe_php_counterparts_do_not_match(snippet):
    assert _scan("php", f"<?php\n{snippet}\n") == []


@pytest.mark.parametrize(
    ("snippet", "expected_type", "expected_id"),
    [
        ('User.where("email = \'#{params[:email]}\'")', "sqli", "rb-sqli-001"),
        ('system("convert #{params[:options]} input.png output.png")', "cmdi", "rb-cmdi-002"),
        ("raw(params[:bio])", "xss", "rb-xss-002"),
        ("ERB.new(params[:template])", "ssti", "rb-ssti-001"),
        ("send_file(params[:path])", "path_traversal", "rb-path-001"),
        ("user.update(params[:user].permit!)", "mass_assignment", "rb-mass-002"),
        ("Marshal.load(params[:state])", "deserialization", "rb-deser-001"),
        ("Net::HTTP.get(URI(params[:url]))", "ssrf", "rb-ssrf-001"),
        ("redirect_to params[:next]", "open_redirect", "rb-redirect-rails-001"),
        ("Account.unscoped.find(params[:id])", "tenant_scope_bypass", "rb-tenant-001"),
        ("Rails.logger.info(params.to_unsafe_h)", "sensitive_data_exposure", "rb-log-001"),
    ],
)
def test_ruby_patterns_require_concrete_source_and_sink(snippet, expected_type, expected_id):
    findings = _scan("ruby", snippet)
    assert any(
        finding["vuln_type"] == expected_type and finding["pattern_id"] == expected_id
        for finding in findings
    ), findings


@pytest.mark.parametrize(
    "snippet",
    [
        "User.where(email: params[:email])",
        "user.update(params.require(:user).permit(:display_name, :timezone))",
        "redirect_to dashboard_path",
        "YAML.safe_load(params[:payload], permitted_classes: [], aliases: false)",
        "'<strong>Verified</strong>'.html_safe",
        "raw('<strong>Verified</strong>')",
        "system('/usr/bin/convert', '--', safe_input, safe_output)",
        "Net::HTTP.get(URI('https://catalog.example.test/health'))",
        "File.read(allowed_path)",
    ],
)
def test_safe_ruby_counterparts_do_not_match(snippet):
    assert _scan("ruby", snippet) == []
