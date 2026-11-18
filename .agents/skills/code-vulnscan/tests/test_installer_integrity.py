"""Release-installer integrity and packaging regression gates."""

import hashlib
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).parent.parent


def _expected_checksum(path: Path) -> str:
    return path.read_text().split()[0].lower()


def test_committed_installer_checksums_match_sources():
    for source_name in ("install.sh", "install.ps1"):
        source = ROOT / source_name
        expected = _expected_checksum(ROOT / f"{source_name}.sha256")
        assert len(expected) == 64
        assert hashlib.sha256(source.read_bytes()).hexdigest() == expected


def test_bash_online_package_is_verified_before_extraction():
    installer = (ROOT / "install.sh").read_text()
    verification = 'verify_sha256 "${TEMP_DIR}/package.tar.gz"'
    extraction = 'tar -xz -C "${TEMP_DIR}" --strip-components=1 -f "${TEMP_DIR}/package.tar.gz"'
    assert verification in installer
    assert installer.index(verification) < installer.index(extraction)
    assert "refusing unverified package" in installer
    assert "release package checksum mismatch" in installer
    assert "falling back to source archive" not in installer.lower()
    assert "falling back to main branch archive" not in installer.lower()
    subprocess.run(["bash", "-n", str(ROOT / "install.sh")], check=True)


def test_powershell_online_package_is_verified_before_extraction():
    installer = (ROOT / "install.ps1").read_text()
    assert "Get-FileHash -LiteralPath $zipPath -Algorithm SHA256" in installer
    assert installer.index("$actualHash =") < installer.index("Expand-Archive -Path $zipPath")
    assert "refusing unverified package" in installer
    assert "release package checksum mismatch" in installer
    assert "falling back to source archive" not in installer.lower()
    assert "falling back to main branch archive" not in installer.lower()


def test_bash_installer_rejects_traversal_skill_name_before_overwrite(tmp_path):
    codex_home = tmp_path / "codex-home"
    victim = codex_home / "victim"
    victim.mkdir(parents=True)
    sentinel = victim / "keep.txt"
    sentinel.write_text("preserve me")
    env = os.environ.copy()
    env.update({"CODEX_HOME": str(codex_home), "HOME": str(tmp_path / "home")})

    result = subprocess.run(
        [
            "bash", str(ROOT / "install.sh"), "--source", "local",
            "--target", "codex", "--skill-name", "../victim", "--force",
        ],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
    )

    assert result.returncode != 0
    assert "invalid --skill-name" in result.stderr
    assert sentinel.read_text() == "preserve me"


def test_powershell_installer_rejects_non_component_skill_names():
    installer = (ROOT / "install.ps1").read_text()
    assert "$SKILL_NAME -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$'" in installer


def test_release_workflow_publishes_installer_and_archive_checksums():
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    for asset in (
        "code-vulnscan-skill-${TAG_NAME}.tar.gz.sha256",
        "code-vulnscan-skill-${TAG_NAME}.zip.sha256",
        "install.sh.sha256",
        "install.ps1.sha256",
    ):
        assert asset in workflow
