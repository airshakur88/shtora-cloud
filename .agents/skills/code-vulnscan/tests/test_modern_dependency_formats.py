"""Regression tests for modern lockfiles and property-backed manifests."""

import json

from scripts.dependency import (
    check_dependencies,
    parse_directory_packages_props,
    parse_pipfile,
    parse_pnpm_lock,
    parse_yarn_lock,
)


def _by_name(dependencies):
    return {dependency["name"]: dependency for dependency in dependencies}


def test_directory_packages_props_resolves_local_msbuild_properties(tmp_path):
    props = tmp_path / "Directory.Packages.props"
    props.write_text(
        """<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <NewtonsoftVersion>12.0.3</NewtonsoftVersion>
    <JsonVersion>$(NewtonsoftVersion)</JsonVersion>
    <VersionRange>[1.0.0,2.0.0)</VersionRange>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="$(JsonVersion)" />
    <PackageVersion Include="Range.Package" Version="$(VersionRange)" />
    <PackageVersion Include="Inherited.Package" Version="$(UndefinedVersion)" />
  </ItemGroup>
</Project>"""
    )

    dependencies = _by_name(parse_directory_packages_props(props))

    assert dependencies["newtonsoft.json"]["version"] == "12.0.3"
    assert dependencies["newtonsoft.json"]["is_direct"] is False
    assert "range.package" not in dependencies
    assert "inherited.package" not in dependencies


def test_pipfile_parses_only_exact_registry_versions_and_is_dispatched(tmp_path):
    pipfile = tmp_path / "Pipfile"
    pipfile.write_text(
        """[packages]
requests = "==2.30.0"
django = {version = "4.2.0", extras = ["argon2"]}
flask = ">=2.0"
urllib3 = "*"
local-package = {path = "."}

[dev-packages]
pytest = "==8.2.1"
dynamic = {version = "==1.*"}
"""
    )

    dependencies = _by_name(parse_pipfile(pipfile))

    assert set(dependencies) == {"requests", "django", "pytest"}
    assert dependencies["requests"]["is_direct"] is True
    assert dependencies["requests"]["is_dev"] is False
    assert dependencies["pytest"]["is_dev"] is True

    result = check_dependencies(tmp_path)
    manifest = next(item for item in result["manifests"] if item["file"] == "Pipfile")
    assert manifest == {"file": "Pipfile", "ecosystem": "pypi", "deps": 3}


def test_pnpm_v9_packages_include_direct_dev_and_transitive_metadata(tmp_path):
    lock = tmp_path / "pnpm-lock.yaml"
    lock.write_text(
        """lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      lodash:
        specifier: ^4.17.0
        version: 4.17.20
      '@scope/direct':
        specifier: 1.2.3
        version: 1.2.3(peer-lib@3.0.0)
    devDependencies:
      semver:
        specifier: ^7.5.0
        version: 7.5.1

packages:
  lodash@4.17.20:
    resolution: {integrity: sha512-example}
  '@scope/direct@1.2.3(peer-lib@3.0.0)':
    resolution: {integrity: sha512-example}
  semver@7.5.1:
    resolution: {integrity: sha512-example}
  transitive@2.0.0:
    resolution: {integrity: sha512-example}
  'local-package@file:../local-package':
    resolution: {directory: ../local-package, type: directory}
"""
    )

    dependencies = _by_name(parse_pnpm_lock(lock))

    assert set(dependencies) == {"lodash", "@scope/direct", "semver", "transitive"}
    assert dependencies["lodash"]["is_direct"] is True
    assert dependencies["lodash"]["is_dev"] is False
    assert dependencies["@scope/direct"]["version"] == "1.2.3"
    assert dependencies["@scope/direct"]["is_direct"] is True
    assert dependencies["semver"]["is_direct"] is True
    assert dependencies["semver"]["is_dev"] is True
    assert dependencies["transitive"]["is_direct"] is False

    result = check_dependencies(tmp_path)
    manifest = next(item for item in result["manifests"] if item["file"] == "pnpm-lock.yaml")
    assert manifest["ecosystem"] == "npm"
    assert manifest["deps"] == 4


def test_yarn_berry_and_classic_resolved_versions_are_supported(tmp_path):
    package_json = tmp_path / "package.json"
    package_json.write_text(json.dumps({
        "dependencies": {"lodash": "^4.17.0"},
        "devDependencies": {"semver": "^7.5.0"},
    }))
    berry = tmp_path / "yarn.lock"
    berry.write_text(
        """__metadata:
  version: 8
  cacheKey: 10c0

"lodash@npm:^4.17.0":
  version: 4.17.20
  resolution: "lodash@npm:4.17.20"

"semver@npm:^7.5.0":
  version: "7.5.1"
  resolution: "semver@npm:7.5.1"

"transitive@npm:^2.0.0":
  version: 2.1.0
  resolution: "transitive@npm:2.1.0"

"workspace-pkg@workspace:.":
  version: 0.0.0-use.local
  resolution: "workspace-pkg@workspace:."
"""
    )

    dependencies = _by_name(parse_yarn_lock(berry))

    assert set(dependencies) == {"lodash", "semver", "transitive"}
    assert dependencies["lodash"]["is_direct"] is True
    assert dependencies["lodash"]["is_dev"] is False
    assert dependencies["semver"]["is_direct"] is True
    assert dependencies["semver"]["is_dev"] is True
    assert dependencies["transitive"]["is_direct"] is False

    classic_dir = tmp_path / "classic"
    classic_dir.mkdir()
    classic = classic_dir / "yarn.lock"
    classic.write_text(
        """"@scope/pkg@^1.0.0", "@scope/pkg@~1.2.0":
  version "1.2.3"
  resolved "https://registry.yarnpkg.com/@scope/pkg/-/pkg-1.2.3.tgz"

plain@^2.0.0:
  version "2.4.0"
"""
    )

    classic_dependencies = _by_name(parse_yarn_lock(classic))
    assert classic_dependencies["@scope/pkg"]["version"] == "1.2.3"
    assert classic_dependencies["plain"]["version"] == "2.4.0"
