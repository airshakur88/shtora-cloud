"""Precision checks for deterministic C#/.NET security patterns."""

import json
import re
from pathlib import Path

from scripts.utils.patterns import scan_file_for_candidates


ROOT = Path(__file__).parent.parent
PATTERNS_FILE = ROOT / "resources" / "patterns" / "csharp_patterns.json"


def _types(code: str) -> set[str]:
    findings = scan_file_for_candidates(Path("Example.cs"), code, "csharp")
    return {finding["vuln_type"] for finding in findings}


def test_csharp_pattern_file_is_valid_and_every_regex_compiles():
    patterns = json.loads(PATTERNS_FILE.read_text())
    assert patterns
    for category, entries in patterns.items():
        assert entries, category
        for entry in entries:
            assert {"id", "regex", "vuln_type", "confidence", "description"} <= entry.keys()
            re.compile(entry["regex"], re.IGNORECASE)


def test_precise_interpolated_sql_patterns_cover_ado_ef_and_dapper():
    code = '''
var ado = new SqlCommand($"SELECT * FROM users WHERE name = '{name}'", connection);
var ef = context.Users.FromSqlRaw($"SELECT * FROM users WHERE name = '{name}'");
var rows = connection.Query<User>($"SELECT * FROM users WHERE name = '{name}'");
'''
    assert "sqli" in _types(code)


def test_parameterized_data_access_does_not_match_sql_patterns():
    code = '''
var command = new SqlCommand("SELECT * FROM users WHERE name = @name", connection);
command.Parameters.Add("@name", SqlDbType.NVarChar).Value = name;
var ef = context.Users.FromSqlInterpolated($"SELECT * FROM users WHERE name = {name}");
var rows = connection.Query<User>("SELECT * FROM users WHERE name = @name", new { name });
command.ExecuteReader();
'''
    assert "sqli" not in _types(code)
    assert "cmdi" not in _types(code)


def test_ordinary_xml_construction_is_not_a_pattern_finding():
    code = '''
var settings = new XmlReaderSettings {
    DtdProcessing = DtdProcessing.Prohibit,
    XmlResolver = null
};
using var reader = XmlReader.Create(stream, settings);
'''
    assert "xxe" not in _types(code)


def test_explicit_unsafe_deserialization_tls_and_xml_settings_match():
    code = '''
var value = new BinaryFormatter().Deserialize(stream);
settings.TypeNameHandling = TypeNameHandling.Auto;
handler.ServerCertificateCustomValidationCallback = (_, _, _, _) => true;
xmlSettings.DtdProcessing = DtdProcessing.Parse;
'''
    types = _types(code)
    assert {"deserialization", "tls_bypass", "xxe"} <= types
