"""Scan roots must not be excluded merely because of their directory name."""

from pathlib import Path

from scripts.scan import enumerate_iac_files
from scripts.utils.files import enumerate_files


def test_source_root_named_like_ignored_build_directory_is_scanned(tmp_path):
    scan_root = tmp_path / "target"
    scan_root.mkdir()
    (scan_root / "app.py").write_text("print('scannable')\n")
    dependency_output = scan_root / "build"
    dependency_output.mkdir()
    (dependency_output / "generated.py").write_text("print('skip')\n")

    files = enumerate_files(scan_root)

    assert [item["relative"] for item in files] == ["app.py"]


def test_source_root_under_tests_directory_is_not_all_treated_as_test_code(tmp_path):
    scan_root = tmp_path / "tests" / "application"
    scan_root.mkdir(parents=True)
    (scan_root / "app.py").write_text("print('production source')\n")
    (scan_root / "app_test.py").write_text("print('actual test')\n")

    files = enumerate_files(scan_root)

    assert [item["relative"] for item in files] == ["app.py"]


def test_iac_root_named_like_ignored_build_directory_is_scanned(tmp_path):
    scan_root = tmp_path / "build"
    scan_root.mkdir()
    (scan_root / "Dockerfile").write_text("FROM scratch\n")
    nested_target = scan_root / "target"
    nested_target.mkdir()
    (nested_target / "ignored.tf").write_text("resource \"x\" \"y\" {}\n")

    files = enumerate_iac_files(scan_root)

    assert [item["path"].name for item in files] == ["Dockerfile"]
