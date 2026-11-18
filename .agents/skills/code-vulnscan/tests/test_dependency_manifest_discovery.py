"""Regression coverage for manifest discovery and resolved .NET dependencies."""

from scripts.dependency import (
    check_dependencies,
    parse_csproj,
    parse_directory_packages_props,
    parse_packages_lock_json,
    parse_paket_lock,
)
from scripts.utils.languages import get_manifest_files


def test_discovers_supported_lockfiles_and_named_dotnet_projects(tmp_path):
    names = {
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "poetry.lock",
        "Pipfile.lock",
        "go.sum",
        "Cargo.lock",
        "composer.lock",
        "packages.lock.json",
        "Directory.Packages.props",
        "paket.lock",
        "Web.csproj",
        "Worker.fsproj",
        "Legacy.vbproj",
    }
    for name in names:
        (tmp_path / name).write_text("")

    (tmp_path / "TARGET").mkdir()
    ignored = tmp_path / "TARGET" / "Generated.csproj"
    ignored.write_text("")

    discovered = {path.name for path in get_manifest_files(tmp_path)}
    assert names <= discovered
    assert ignored not in get_manifest_files(tmp_path)


def test_csproj_parser_handles_namespace_attribute_order_and_child_version(tmp_path):
    project = tmp_path / "Web.csproj"
    project.write_text(
        """<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup>
    <PackageReference Version="13.0.1" Include="Newtonsoft.Json" />
    <PackageReference Include="Npgsql"><Version>8.0.1</Version></PackageReference>
    <PackageReference Include="Central.Versioned" />
  </ItemGroup>
</Project>"""
    )

    dependencies = {item["name"]: item for item in parse_csproj(project)}
    assert dependencies["newtonsoft.json"]["version"] == "13.0.1"
    assert dependencies["npgsql"]["version"] == "8.0.1"
    assert "central.versioned" not in dependencies


def test_central_nuget_and_lockfiles_feed_dependency_checks(tmp_path):
    central = tmp_path / "Directory.Packages.props"
    central.write_text(
        """<Project><ItemGroup>
  <PackageVersion Include="Newtonsoft.Json" Version="12.0.3" />
</ItemGroup></Project>"""
    )
    lock = tmp_path / "packages.lock.json"
    lock.write_text(
        """{
  "version": 1,
  "dependencies": {
    "net8.0": {
      "Npgsql": {"type": "Direct", "requested": "[7.0.0, )", "resolved": "7.0.0"},
      "Newtonsoft.Json": {"type": "Transitive", "resolved": "12.0.3"}
    }
  }
}"""
    )

    central_deps = parse_directory_packages_props(central)
    lock_deps = {item["name"]: item for item in parse_packages_lock_json(lock)}
    assert central_deps[0]["name"] == "newtonsoft.json"
    assert lock_deps["npgsql"]["is_direct"] is True
    assert lock_deps["newtonsoft.json"]["is_direct"] is False

    result = check_dependencies(tmp_path)
    assert any(
        finding["package"] == "Newtonsoft.Json" and finding["current_version"] == "12.0.3"
        for finding in result["findings"]
    )


def test_paket_lock_parser_reads_only_resolved_nuget_entries(tmp_path):
    lock = tmp_path / "paket.lock"
    lock.write_text(
        """NUGET
  remote: https://api.nuget.org/v3/index.json
    Newtonsoft.Json (13.0.1)
      System.Runtime.Serialization.Primitives (4.3.0)
GITHUB
  remote: example/repository
    file.txt (abc123)
"""
    )

    dependencies = {item["name"]: item for item in parse_paket_lock(lock)}
    assert dependencies["newtonsoft.json"]["version"] == "13.0.1"
    assert "file.txt" not in dependencies
