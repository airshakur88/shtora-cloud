"""Regression coverage for Java/JVM dependency and project discovery."""

from pathlib import Path

import pytest

from scripts.dependency import (
    check_dependencies,
    parse_build_gradle,
    parse_gradle_lockfile,
    parse_gradle_version_catalog,
    parse_pom_xml,
)
from scripts.utils.files import enumerate_files
from scripts.utils.languages import detect_frameworks, detect_language, get_manifest_files


def by_name(dependencies):
    return {dependency["name"]: dependency for dependency in dependencies}


def test_maven_resolves_namespace_properties_and_dependency_management(tmp_path):
    pom = tmp_path / "pom.xml"
    pom.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>example.app</groupId><artifactId>demo</artifactId><version>1.0</version>
  <properties>
    <log4j.version>2.14.1</log4j.version>
    <junit.version>${project.version}.1</junit.version>
  </properties>
  <dependencyManagement><dependencies>
    <dependency>
      <groupId>org.apache.logging.log4j</groupId>
      <artifactId>log4j-core</artifactId>
      <version>${log4j.version}</version>
    </dependency>
    <dependency>
      <groupId>managed.only</groupId><artifactId>not-runtime</artifactId><version>9.9</version>
    </dependency>
  </dependencies></dependencyManagement>
  <dependencies>
    <dependency>
      <artifactId>log4j-core</artifactId><groupId>org.apache.logging.log4j</groupId>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId>
      <version>${junit.version}</version><scope>test</scope>
    </dependency>
  </dependencies>
</project>
"""
    )

    deps = by_name(parse_pom_xml(pom))
    assert deps["log4j-core"]["version"] == "2.14.1"
    assert deps["log4j-core"]["osv_name"] == "org.apache.logging.log4j:log4j-core"
    assert deps["junit-jupiter"]["version"] == "1.0.1"
    assert deps["junit-jupiter"]["is_dev"] is True
    assert "not-runtime" not in deps


def test_maven_managed_log4j_reaches_known_vulnerability_check(tmp_path):
    (tmp_path / "pom.xml").write_text(
        """<project><properties><log4j.version>2.14.1</log4j.version></properties>
<dependencyManagement><dependencies><dependency>
  <groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId>
  <version>${log4j.version}</version>
</dependency></dependencies></dependencyManagement>
<dependencies><dependency><groupId>org.apache.logging.log4j</groupId>
  <artifactId>log4j-core</artifactId>
</dependency></dependencies></project>"""
    )
    result = check_dependencies(tmp_path)
    assert "CVE-2021-44228" in {finding["cve"] for finding in result["findings"]}


def test_maven_online_lookup_uses_full_coordinate(tmp_path, monkeypatch):
    (tmp_path / "pom.xml").write_text(
        """<project><dependencies><dependency>
<groupId>com.example.security</groupId><artifactId>same-name</artifactId><version>1.2.3</version>
</dependency></dependencies></project>"""
    )
    calls = []

    def fake_query(package, version, ecosystem, offline=False):
        calls.append((package, version, ecosystem, offline))
        return []

    monkeypatch.setattr("scripts.cve_osv.query_osv", fake_query)
    check_dependencies(tmp_path, online=True)
    assert calls == [("com.example.security:same-name", "1.2.3", "Maven", False)]


def test_gradle_groovy_and_kotlin_declarations_resolve_versions(tmp_path):
    (tmp_path / ".git").mkdir()
    (tmp_path / "gradle.properties").write_text("log4jVersion=2.14.1\n")
    groovy = tmp_path / "build.gradle"
    groovy.write_text(
        """dependencies {
  implementation "org.apache.logging.log4j:log4j-core:$log4jVersion"
  runtimeOnly group: 'com.fasterxml.jackson.core', name: 'jackson-databind', version: '2.12.0'
  testImplementation('org.junit.jupiter:junit-jupiter:5.9.1')
}
"""
    )
    kotlin = tmp_path / "build.gradle.kts"
    kotlin.write_text(
        """val nettyVersion = "4.1.85.Final"
dependencies {
  implementation("io.netty:netty-handler:$nettyVersion")
  compileOnly(group = "org.projectlombok", name = "lombok", version = "1.18.30")
}
"""
    )

    groovy_deps = by_name(parse_build_gradle(groovy))
    kotlin_deps = by_name(parse_build_gradle(kotlin))
    assert groovy_deps["log4j-core"]["version"] == "2.14.1"
    assert groovy_deps["jackson-databind"]["osv_name"] == "com.fasterxml.jackson.core:jackson-databind"
    assert groovy_deps["junit-jupiter"]["is_dev"] is True
    assert kotlin_deps["netty-handler"]["version"] == "4.1.85.Final"
    assert kotlin_deps["lombok"]["version"] == "1.18.30"


def test_gradle_version_catalog_and_lockfile(tmp_path):
    catalog = tmp_path / "security.versions.toml"
    catalog.write_text(
        """[versions]
log4j = "2.14.1"

[libraries]
log4j-core = { module = "org.apache.logging.log4j:log4j-core", version.ref = "log4j" }
jackson = { group = "com.fasterxml.jackson.core", name = "jackson-databind", version = "2.12.0" }
guava = "com.google.guava:guava:31.0-jre"
unversioned = { module = "org.example:managed-elsewhere" }
"""
    )
    lockfile = tmp_path / "gradle.lockfile"
    lockfile.write_text(
        """# This is a Gradle generated file.
org.apache.logging.log4j:log4j-core:2.14.1=runtimeClasspath
io.netty:netty-handler:4.1.85.Final=compileClasspath,runtimeClasspath
empty=testRuntimeClasspath
"""
    )

    catalog_deps = by_name(parse_gradle_version_catalog(catalog))
    lock_deps = by_name(parse_gradle_lockfile(lockfile))
    assert catalog_deps["log4j-core"]["version"] == "2.14.1"
    assert catalog_deps["jackson-databind"]["version"] == "2.12.0"
    assert catalog_deps["guava"]["version"] == "31.0-jre"
    assert "managed-elsewhere" not in catalog_deps
    assert lock_deps["netty-handler"]["version"] == "4.1.85.Final"
    assert lock_deps["netty-handler"]["is_direct"] is False


def test_jvm_manifest_discovery_includes_catalog_and_lock_but_skips_build_output(tmp_path):
    expected = {
        "pom.xml", "build.gradle", "build.gradle.kts", "libs.versions.toml",
        "company.versions.toml", "gradle.lockfile",
    }
    for name in expected:
        path = tmp_path / ("gradle" if name == "libs.versions.toml" else "") / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
    target_manifest = tmp_path / "target" / "pom.xml"
    target_manifest.parent.mkdir()
    target_manifest.write_text("")

    discovered = {path.name for path in get_manifest_files(tmp_path)}
    assert expected <= discovered
    assert target_manifest not in get_manifest_files(tmp_path)


@pytest.mark.parametrize("suffix", [".jsp", ".jspx", ".jspf", ".tag", ".tagx"])
def test_java_server_templates_are_detected_and_enumerated(tmp_path, suffix):
    template = tmp_path / f"account{suffix}"
    template.write_text('<%= request.getParameter("name") %>')
    assert detect_language(template) == "java"
    files = enumerate_files(tmp_path)
    assert [entry["relative"] for entry in files] == [template.name]
    assert files[0]["language"] == "java"


@pytest.mark.parametrize(
    ("language", "content", "expected"),
    [
        ("java", "import org.springframework.boot.SpringApplication; @SpringBootApplication", {"spring", "spring_boot"}),
        ("java", "import org.springframework.security.web.SecurityFilterChain;", {"spring", "spring_security"}),
        ("java", "import org.springframework.data.jpa.repository.JpaRepository;", {"spring", "spring_data"}),
        ("java", "import org.springframework.web.bind.annotation.GetMapping;", {"spring", "spring_mvc"}),
        ("java", "import jakarta.enterprise.context.ApplicationScoped;", {"jakarta_ee"}),
        ("java", "import jakarta.ws.rs.Path; @Path(\"/items\")", {"jax_rs"}),
        ("java", "import jakarta.servlet.http.HttpServlet;", {"servlet"}),
        ("java", "import jakarta.faces.context.FacesContext;", {"jsf"}),
        ("java", "import jakarta.persistence.Entity; @Entity", {"jpa"}),
        ("java", "import org.hibernate.SessionFactory;", {"hibernate"}),
        ("java", "import io.micronaut.runtime.Micronaut;", {"micronaut"}),
        ("java", "import io.quarkus.runtime.Quarkus;", {"quarkus"}),
        ("kotlin", "import io.quarkus.test.junit.QuarkusTest", {"quarkus"}),
    ],
)
def test_modern_jvm_framework_detection(language, content, expected):
    detected = set(detect_frameworks(Path("Example.java"), content, language))
    assert expected <= detected
