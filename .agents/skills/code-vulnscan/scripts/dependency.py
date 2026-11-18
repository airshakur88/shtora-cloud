#!/usr/bin/env python3
"""
Dependency vulnerability checker — scans manifests for known-vulnerable versions.

Usage:
  python3 scripts/dependency.py --path <dir> [--output <file>] [--online]

Checks: requirements.txt, Pipfile, pyproject.toml, package.json, pom.xml,
        build.gradle, build.gradle.kts, go.mod, Gemfile.lock, composer.json,
        Cargo.lock, Cargo.toml, .csproj, packages.config, package-lock.json,
        yarn.lock, pnpm-lock.yaml, poetry.lock, Pipfile.lock, composer.lock,
        go.sum
"""

import argparse
import json
import re
import sys
import tomllib
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.utils.languages import get_manifest_files

# KNOWN_VULNS — last refreshed 2025-01-15 — run scripts/refresh_cve_db.py to update
# Known vulnerable packages (curated list — agent should verify via live CVE DB)
# Format: (package_name, vulnerable_range, safe_version, cve, cvss, vuln_type, description)
KNOWN_VULNS = {
    "python": [
        ("django", "<2.2.28|<3.2.13|<4.0.4", ">=4.2.0", "CVE-2022-28347", 9.8, "sqli", "SQL injection via QuerySet.annotate()"),
        ("flask", "<2.3.2", ">=2.3.2", "CVE-2023-30861", 7.5, "session_security", "Session cookie bypass in debug mode"),
        ("pillow", "<9.3.0", ">=10.0.0", "CVE-2022-45199", 7.5, "dos", "Decompression bomb DoS"),
        ("pyyaml", "<6.0", ">=6.0", "CVE-2020-14343", 9.8, "rce", "Arbitrary code execution via yaml.load()"),
        ("cryptography", "<41.0.0", ">=41.0.0", "CVE-2023-49083", 7.5, "dos", "NULL pointer dereference"),
        ("requests", "<2.31.0", ">=2.31.0", "CVE-2023-32681", 6.1, "ssrf", "Proxy-Authorization header leak on redirects"),
        ("paramiko", "<3.4.0", ">=3.4.0", "CVE-2023-48795", 5.9, "mitm", "Terrapin SSH protocol downgrade"),
        ("lxml", "<4.9.3", ">=4.9.3", "CVE-2022-2309", 7.5, "xxe", "NULL pointer dereference / XXE"),
        ("sqlalchemy", "<1.4.49", ">=2.0.0", "CVE-2019-7164", 9.8, "sqli", "SQL injection via order_by()"),
        ("werkzeug", "<3.0.1", ">=3.0.1", "CVE-2023-46136", 7.5, "dos", "Multipart data parsing DoS"),
        ("jinja2", "<3.1.3", ">=3.1.3", "CVE-2024-22195", 5.4, "xss", "XSS via xmlattr filter"),
        ("aiohttp", "<3.9.0", ">=3.9.0", "CVE-2023-47641", 7.5, "path_traversal", "Static file path traversal"),
        ("urllib3", "<2.0.7", ">=2.0.7", "CVE-2023-45803", 4.2, "info_disclosure", "Sensitive data in HTTP headers"),
        ("celery", "<5.3.0", ">=5.3.0", "CVE-2021-23727", 9.8, "rce", "Command injection via pickle"),
        ("tornado", "<6.3.3", ">=6.3.3", "CVE-2023-28370", 6.1, "open_redirect", "Open redirect in StaticFileHandler via crafted URL"),
        ("starlette", "<0.36.2", ">=0.36.2", "CVE-2024-24762", 7.5, "dos", "Multipart form parsing DoS via infinite loop"),
        ("gunicorn", "<21.2.0", ">=21.2.0", "CVE-2024-1135", 7.5, "http_smuggling", "HTTP request smuggling via Transfer-Encoding header"),
        ("reportlab", "<3.6.13", ">=4.0.0", "CVE-2023-33733", 9.8, "rce", "Arbitrary code execution via malicious HTML in PDF generation"),
        ("setuptools", "<65.5.1", ">=65.5.1", "CVE-2022-40897", 5.9, "dos", "ReDoS in package_index URL parsing"),
        ("langchain", "<0.0.341", ">=0.0.341", "CVE-2023-46229", 9.8, "rce", "Arbitrary code execution via LLMChain eval injection"),
        ("httpx", "<0.23.0", ">=0.23.0", "CVE-2021-41945", 8.1, "ssrf", "SSRF via URL redirect with encoded host"),
        ("redis", "<4.5.4", ">=4.5.4", "CVE-2023-28859", 6.5, "ssrf", "SSRF via unvalidated Redis connection URL"),
        ("pymongo", "<4.6.2", ">=4.6.2", "CVE-2024-5629", 7.5, "dos", "Out-of-bounds read in BSON decoding"),
        ("django", "<4.2.0", ">=4.2.0", "CVE-2023-43665", 7.5, "dos", "ReDoS in EmailValidator and URLValidator"),
        ("django", "<4.1.3", ">=4.1.3", "CVE-2022-41323", 7.5, "dos", "Potential ReDoS in internationalized URLs"),
        ("numpy", "<1.22.0", ">=1.22.0", "CVE-2021-41495", 6.5, "dos", "NULL pointer dereference in numpy"),
        ("transformers", "<4.30.0", ">=4.30.0", "CVE-2023-48022", 9.8, "rce", "Arbitrary code execution via pickle in transformers"),
        ("gradio", "<3.34.0", ">=3.34.0", "CVE-2023-34239", 9.8, "rce", "Path traversal and arbitrary code execution"),
        ("fastapi", "<0.109.1", ">=0.109.1", "CVE-2024-24762", 7.5, "dos", "ReDoS via form parsing"),
        ("httpx", "<0.27.0", ">=0.27.0", "CVE-2024-35195", 5.9, "ssrf", "Unintended credential exposure in redirects"),
        ("ecdsa", "<0.18.0", ">=0.18.0", "CVE-2024-23342", 7.4, "timing_attack", "Minerva timing side-channel in ECDSA"),
        ("oauthlib", "<3.2.2", ">=3.2.2", "CVE-2022-36087", 6.5, "dos", "ReDoS in URI validation"),
        ("pyarrow", "<14.0.1", ">=14.0.1", "CVE-2023-47248", 9.8, "rce", "Arbitrary code execution via pickle in IPC"),
        ("mlflow", "<2.9.2", ">=2.9.2", "CVE-2024-27132", 9.8, "path_traversal", "Path traversal in model loading"),
        ("pytorch", "<2.1.2", ">=2.1.2", "CVE-2024-31580", 9.8, "rce", "Code execution via torch.load without weights_only=True"),
    ],
    "javascript": [
        ("lodash", "<4.17.21", ">=4.17.21", "CVE-2021-23337", 7.2, "rce", "Command injection via template()"),
        ("lodash", "<4.17.21", ">=4.17.21", "CVE-2020-8203", 7.4, "prototype_pollution", "Prototype pollution"),
        ("axios", "<1.6.0", ">=1.6.0", "CVE-2023-45857", 6.5, "csrf", "CSRF token leak via forged URL"),
        ("jsonwebtoken", "<9.0.0", ">=9.0.0", "CVE-2022-23529", 8.8, "rce", "Remote code execution via malformed JWT"),
        ("express", "<4.18.2", ">=4.18.2", "CVE-2022-24999", 7.5, "open_redirect", "qs prototype pollution"),
        ("qs", "<6.7.3", ">=6.7.3", "CVE-2022-24999", 7.5, "prototype_pollution", "Prototype pollution"),
        ("minimist", "<1.2.6", ">=1.2.6", "CVE-2021-44906", 9.8, "prototype_pollution", "Prototype pollution"),
        ("node-fetch", "<2.6.7|<3.1.1", ">=3.2.0", "CVE-2022-0235", 6.1, "info_disclosure", "Cookie and Authorization header leak"),
        ("path-to-regexp", "<1.9.0", ">=1.9.0", "CVE-2024-45296", 7.5, "redos", "ReDoS via backtracking regex"),
        ("semver", "<7.5.2", ">=7.5.2", "CVE-2022-25883", 7.5, "redos", "ReDoS via invalid version strings"),
        ("tough-cookie", "<4.1.3", ">=4.1.3", "CVE-2023-26136", 9.8, "prototype_pollution", "Prototype pollution"),
        ("word-wrap", "<1.2.4", ">=1.2.4", "CVE-2023-26115", 7.5, "redos", "ReDoS"),
        ("webpack", "<5.88.1", ">=5.88.1", "CVE-2023-28154", 9.8, "rce", "Cross-realm object access"),
        ("next", "<13.5.1", ">=13.5.1", "CVE-2023-46298", 7.5, "dos", "HTTP parameter pollution DoS"),
        ("xml2js", "<0.5.0", ">=0.5.0", "CVE-2023-0842", 7.5, "prototype_pollution", "Prototype pollution via __proto__ key in parsed XML"),
        ("cross-spawn", "<7.0.5", ">=7.0.5", "CVE-2024-21538", 7.5, "redos", "ReDoS via specially crafted shell argument string"),
        ("ua-parser-js", "<1.0.33", ">=1.0.33", "CVE-2022-25927", 7.5, "redos", "ReDoS via malformed User-Agent string"),
        ("protobufjs", "<7.2.4", ">=7.2.4", "CVE-2023-36665", 9.8, "prototype_pollution", "Prototype pollution in MessageFactory.fromObject"),
        ("tar", "<6.2.1", ">=6.2.1", "CVE-2024-28863", 6.5, "dos", "DoS via recursive symlink in tar archive"),
        ("passport", "<0.6.0", ">=0.6.0", "CVE-2022-25896", 7.4, "session_fixation", "Session fixation via lack of session regeneration on login"),
        ("ip", "<2.0.1", ">=2.0.1", "CVE-2024-29415", 8.1, "ssrf", "Private IP check bypass via ::ffff:127.0.0.1 notation"),
        ("jose", "<4.15.5", ">=4.15.5", "CVE-2024-28176", 7.5, "dos", "DoS via PBKDF2 large iteration count in JWE decrypt"),
        ("jsonwebtoken", "<9.0.0", ">=9.0.0", "CVE-2022-23541", 8.8, "auth_bypass", "Authentication bypass via algorithm confusion (RS256 vs HS256)"),
    ],
    "npm": [
        ("lodash", "<4.17.21", ">=4.17.21", "CVE-2021-23337", 7.2, "cmdi", "Command injection via template"),
        ("lodash", "<4.17.21", ">=4.17.21", "CVE-2020-8203", 7.4, "proto_pollution", "Prototype pollution via zipObjectDeep"),
        ("axios", "<0.21.2", ">=0.21.2", "CVE-2021-3749", 7.5, "dos", "Regular expression DoS in axios"),
        ("axios", "<1.6.0", ">=1.6.0", "CVE-2023-45857", 6.5, "ssrf", "SSRF via XSRF-TOKEN header leak"),
        ("express", "<4.19.2", ">=4.19.2", "CVE-2024-29041", 6.1, "open_redirect", "Open redirect in res.location()"),
        ("jsonwebtoken", "<9.0.0", ">=9.0.0", "CVE-2022-23529", 9.8, "auth_bypass", "Remote code execution via malicious JWK"),
        ("node-fetch", "<2.6.7", ">=2.6.7", "CVE-2022-0235", 6.1, "ssrf", "Exposure of sensitive information via redirect"),
        ("vm2", "<3.9.19", ">=3.9.19", "CVE-2023-29017", 10.0, "sandbox_escape", "Sandbox escape via exception handling"),
        ("semver", "<7.5.2", ">=7.5.2", "CVE-2022-25883", 7.5, "dos", "ReDoS in semver.satisfies()"),
        ("tough-cookie", "<4.1.3", ">=4.1.3", "CVE-2023-26136", 6.5, "proto_pollution", "Prototype pollution via psl.get"),
        ("next", "<14.1.1", ">=14.1.1", "CVE-2024-34351", 7.5, "ssrf", "SSRF in Server Actions"),
        ("next", "<13.5.1", ">=13.5.1", "CVE-2023-46298", 7.5, "dos", "DoS via malformed HTTP request"),
        ("tar", "<6.1.9", ">=6.1.9", "CVE-2021-37701", 8.6, "path_traversal", "Path traversal via relative path extraction"),
        ("minimatch", "<3.0.5", ">=3.0.5", "CVE-2022-3517", 7.5, "dos", "ReDoS in minimatch"),
        ("moment", "<2.29.4", ">=2.29.4", "CVE-2022-24785", 7.5, "path_traversal", "Path traversal in moment.locale()"),
    ],
    "java": [
        ("log4j-core", "<2.17.1", ">=2.17.1", "CVE-2021-44228", 10.0, "rce", "Log4Shell — JNDI injection RCE"),
        ("log4j-core", ">=2.15.0,<2.17.0", ">=2.17.0", "CVE-2021-45046", 9.0, "rce", "Log4Shell bypass"),
        ("spring-webmvc", "<5.3.18|<6.0.0", ">=5.3.28", "CVE-2022-22965", 9.8, "rce", "Spring4Shell RCE"),
        ("spring-security-core", "<5.7.5|<6.0.1", ">=5.7.11", "CVE-2022-31692", 9.8, "auth_bypass", "Authentication bypass"),
        ("jackson-databind", "<2.13.4.2", ">=2.14.0", "CVE-2022-42003", 7.5, "dos", "DoS via deep nesting"),
        ("jackson-databind", "<2.12.7.1", ">=2.14.0", "CVE-2021-46877", 7.5, "dos", "DoS via array wrapping"),
        ("commons-text", "<1.10.0", ">=1.10.0", "CVE-2022-42889", 9.8, "rce", "Text4Shell — interpolation RCE"),
        ("commons-collections", "<3.2.2", ">=3.2.2", "CVE-2015-7501", 9.8, "rce", "Deserialization RCE gadget chain"),
        ("xstream", "<1.4.20", ">=1.4.20", "CVE-2022-40151", 7.5, "dos", "DoS via crafted XML"),
        ("netty-codec-http", "<4.1.86", ">=4.1.90", "CVE-2022-41881", 7.5, "dos", "Stack overflow via malformed headers"),
        ("h2", "<2.1.214", ">=2.2.220", "CVE-2022-45868", 7.8, "rce", "Console access leads to RCE"),
        ("snakeyaml", "<2.0", ">=2.0", "CVE-2022-1471", 9.8, "rce", "Constructor deserialization RCE"),
        ("struts2-core", "<6.3.0", ">=6.3.0", "CVE-2023-50164", 9.8, "rce", "File upload path traversal leads to RCE via partial path-traversal attack"),
        ("spring-framework", "<5.3.31|<6.0.14", ">=6.0.14", "CVE-2023-20861", 6.5, "dos", "SpEL expression DoS via crafted expression in annotation"),
        ("tomcat-embed-core", "<10.1.16|<9.0.83|<8.5.96", ">=10.1.16", "CVE-2023-46589", 7.5, "http_smuggling", "HTTP request smuggling via invalid Transfer-Encoding header"),
        ("guava", "<32.0.0-jre", ">=32.0.0-jre", "CVE-2023-2976", 7.1, "path_traversal", "Predictable temp directory allows symlink race in Files.createTempDir()"),
        ("okhttp", "<4.12.0", ">=4.12.0", "CVE-2023-3635", 7.5, "dos", "GzipSource DoS via malformed Content-Encoding"),
        ("netty-all", "<4.1.100.Final", ">=4.1.100.Final", "CVE-2023-44487", 7.5, "dos", "HTTP/2 rapid reset attack amplification"),
        ("logback-core", "<1.4.12|<1.3.12", ">=1.4.12", "CVE-2023-6378", 9.8, "rce", "Deserialization of untrusted data via specially crafted receiver component"),
    ],
    "maven": [
        ("log4j-core", "<2.17.1", ">=2.17.1", "CVE-2021-44228", 10.0, "rce", "Log4Shell: JNDI injection"),
        ("log4j-core", "<2.17.1", ">=2.17.1", "CVE-2021-45105", 7.5, "dos", "Log4j2 DoS via recursive lookup"),
        ("spring-core", "<5.3.26", ">=5.3.26", "CVE-2022-22965", 9.8, "rce", "Spring4Shell: RCE via data binding"),
        ("spring-security-core", "<5.8.3", ">=5.8.3", "CVE-2023-20862", 7.5, "auth_bypass", "Authentication bypass in Spring Security"),
        ("jackson-databind", "<2.13.4", ">=2.13.4", "CVE-2022-42003", 7.5, "dos", "Deeply nested arrays cause StackOverflow"),
        ("struts2-core", "<2.5.33", ">=2.5.33", "CVE-2023-50164", 9.8, "rce", "File upload path traversal leading to RCE"),
        ("netty-handler", "<4.1.86", ">=4.1.86", "CVE-2023-34462", 6.5, "dos", "SniHandler DoS via memory exhaustion"),
        ("commons-text", "<1.10.0", ">=1.10.0", "CVE-2022-42889", 9.8, "rce", "Text4Shell: interpolation injection"),
        ("guava", "<32.0.0", ">=32.0.0", "CVE-2023-2976", 7.1, "path_traversal", "Path traversal in Guava's Files.createTempDir"),
    ],
    "go": [
        ("golang.org/x/net", "<0.17.0", ">=0.17.0", "CVE-2023-44487", 7.5, "dos", "HTTP/2 rapid reset attack DoS"),
        ("golang.org/x/crypto", "<0.13.0", ">=0.13.0", "CVE-2023-48795", 5.9, "mitm", "Terrapin SSH downgrade attack"),
        ("github.com/gin-gonic/gin", "<1.9.1", ">=1.9.1", "CVE-2023-29401", 4.3, "dos", "Large multipart form DoS"),
        ("github.com/dgrijalva/jwt-go", "<4.0.0", ">=4.0.0", "CVE-2020-26160", 7.5, "auth_bypass", "Audience claim check bypass allows token forgery when aud is a string not array"),
        ("google.golang.org/grpc", "<1.57.1", ">=1.57.1", "CVE-2023-44487", 7.5, "dos", "HTTP/2 rapid reset DDoS amplification attack"),
        ("golang.org/x/text", "<0.3.8", ">=0.3.8", "CVE-2022-32149", 7.5, "dos", "Panic via crafted Accept-Language header in language tag parsing"),
        ("github.com/go-jose/go-jose/v3", "<3.0.1", ">=3.0.1", "CVE-2023-26483", 7.5, "dos", "ECDH-ES with invalid public key causes DoS in JWE decryption"),
        ("golang.org/x/net", "<0.23.0", ">=0.23.0", "CVE-2024-45338", 7.5, "dos", "HTTP/2 CONTINUATION flood causes server DoS"),
    ],
    "ruby": [
        ("rails", "<7.0.8|<7.1.1", ">=7.1.1", "CVE-2023-38037", 5.4, "info_disclosure", "Information disclosure via ReDoS"),
        ("nokogiri", "<1.15.4", ">=1.15.4", "CVE-2023-45648", 5.3, "xxe", "XML namespace confusion"),
        ("devise", "<4.9.3", ">=4.9.3", "CVE-2019-5421", 7.5, "timing_attack", "Timing attack on password reset"),
        ("rack", "<2.2.8", ">=2.2.8", "CVE-2023-27539", 7.5, "dos", "ReDoS in header parsing"),
        ("activerecord", "<7.0.8|<7.1.1", ">=7.1.1", "CVE-2023-22795", 7.5, "dos", "ReDoS via crafted SQL string parameter in query method"),
        ("omniauth", "<2.1.2", ">=2.1.2", "CVE-2021-41136", 3.7, "timing_attack", "Timing attack via inconsistent request phase handling"),
        ("activesupport", "<7.0.8", ">=7.0.8", "CVE-2023-28362", 6.1, "xss", "XSS via ANSI character injection in log output rendered in browser"),
        ("carrierwave", "<1.3.4|<2.2.6", ">=2.2.6", "CVE-2023-49090", 7.5, "xxe", "SVG upload XXE allows file read via crafted SVG content"),
    ],
    "php": [
        ("laravel/framework", "<10.28.0", ">=10.28.0", "CVE-2023-43814", 6.5, "info_disclosure", "Debug mode info leak"),
        ("guzzlehttp/guzzle", "<7.5.0", ">=7.5.0", "CVE-2022-31090", 7.5, "ssrf", "SSRF via URL parsing"),
        ("symfony/http-foundation", "<6.3.1", ">=6.3.1", "CVE-2023-25575", 7.5, "dos", "ReDoS in header parsing"),
        ("phpoffice/phpspreadsheet", "<1.29.0", ">=1.29.0", "CVE-2024-25118", 8.8, "xxe", "XXE via XLSX files"),
        ("guzzlehttp/psr7", "<1.9.1|<2.4.5", ">=2.4.5", "CVE-2023-29197", 7.5, "header_injection", "Header injection via CRLF in URI values passed to PSR-7 methods"),
        ("symfony/http-kernel", "<6.3.5|<5.4.33", ">=6.3.5", "CVE-2023-46734", 6.1, "xss", "XSS via Content-Security-Policy nonce bypass in error pages"),
        ("nesbot/carbon", "<2.72.3", ">=2.72.3", "CVE-2023-42282", 7.5, "redos", "ReDoS via crafted date string in Carbon parse()"),
        ("phpseclib/phpseclib", "<3.0.19", ">=3.0.19", "CVE-2023-27560", 7.5, "dos", "Infinite loop in BER-encoded length decoding"),
    ],
    "rust": [
        ("openssl", "<0.10.55", ">=0.10.55", "CVE-2023-0286", 7.4, "dos", "X.400 GeneralName OOB read"),
        ("h2", "<0.3.17", ">=0.3.17", "CVE-2023-26964", 7.5, "dos", "HTTP/2 header resource exhaustion"),
        ("rustls", "<0.20.9|<0.21.7", ">=0.21.7", "CVE-2023-36619", 7.5, "tls", "Incorrect TLS handshake handling"),
        ("hyper", "<0.14.27", ">=0.14.27", "CVE-2023-44487", 7.5, "dos", "HTTP/2 rapid reset attack"),
        ("tokio", "<1.29.1", ">=1.29.1", "CVE-2023-22466", 5.3, "dos", "Thread count manipulation"),
        ("regex", "<1.5.5", ">=1.5.5", "CVE-2022-24713", 7.5, "dos", "ReDoS via specially crafted regex pattern causes stack overflow"),
        ("tar", "<0.4.38", ">=0.4.38", "CVE-2021-38193", 7.5, "path_traversal", "Path traversal during tar archive extraction via crafted path"),
        ("prost", "<0.12.0", ">=0.12.0", "CVE-2024-27308", 7.5, "dos", "DoS via crafted protobuf message exceeding recursive depth limit"),
    ],
    "dotnet": [
        ("Microsoft.AspNetCore.App", "<7.0.14|<8.0.0", ">=8.0.0", "CVE-2023-44487", 7.5, "dos", "HTTP/2 rapid reset attack"),
        ("System.Text.Json", "<7.0.4", ">=8.0.0", "CVE-2023-21173", 7.5, "dos", "DoS via large JSON"),
        ("Microsoft.Data.SqlClient", "<5.1.2", ">=5.1.2", "CVE-2024-0056", 8.7, "mitm", "SQL connection string injection"),
        ("Newtonsoft.Json", "<13.0.1", ">=13.0.3", "CVE-2024-21907", 7.5, "dos", "DoS via deep nesting ReDoS"),
        ("Microsoft.AspNetCore.Authentication.JwtBearer", "<8.0.0", ">=8.0.0", "CVE-2024-21319", 6.8, "auth_bypass", "Insufficient JWT audience validation allows cross-tenant token acceptance"),
        ("Microsoft.Identity.Client", "<4.60.1", ">=4.60.1", "CVE-2024-26186", 7.5, "auth_bypass", "MSAL token cache poisoning via crafted authority URI"),
        ("IdentityServer4", "<4.1.2", ">=4.1.2", "CVE-2022-23108", 8.1, "auth_bypass", "Authentication bypass via client_secret_jwt algorithm confusion"),
        ("Npgsql", "<8.0.1", ">=8.0.1", "CVE-2024-0057", 7.5, "mitm", "Improper TLS certificate validation allows MITM on PostgreSQL connections"),
    ],
}


def parse_version(v: str) -> tuple:
    """Parse a version string into a comparable tuple."""
    v = re.sub(r"[^\d.]", "", v)
    parts = v.split(".")
    result = []
    for p in parts[:4]:
        try:
            result.append(int(p))
        except ValueError:
            result.append(0)
    while len(result) < 4:
        result.append(0)
    return tuple(result)


def version_in_range(version: str, range_str: str) -> bool:
    """Check if a version matches a vulnerable range (e.g. '<2.28|<3.2.13')."""
    current = parse_version(version)
    for part in range_str.split("|"):
        part = part.strip()
        m = re.match(r"([<>]=?|==)\s*([\d.]+(?:\.[\d]+)*)", part)
        if not m:
            continue
        op, ver = m.group(1), m.group(2)
        target = parse_version(ver)
        if op == "<" and current < target:
            return True
        elif op == "<=" and current <= target:
            return True
        elif op == ">" and current > target:
            return True
        elif op == ">=" and current >= target:
            return True
        elif op == "==" and current == target:
            return True
    return False


def parse_requirements_txt(path: Path) -> list:
    deps = []
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        m = re.match(r"^([\w\-\.]+)\s*(?:==|>=|<=|~=|!=|>|<)\s*([\d\.]+)", line)
        if m:
            deps.append({"name": m.group(1).lower(), "version": m.group(2), "source": str(path)})
    return deps


def parse_package_json(path: Path) -> list:
    try:
        data = json.loads(path.read_text(errors="replace"))
    except (json.JSONDecodeError, OSError):
        return []
    deps = []
    for section in ("dependencies", "devDependencies", "peerDependencies"):
        for name, ver in data.get(section, {}).items():
            ver = re.sub(r"[^0-9.]", "", ver)
            if ver:
                deps.append({"name": name.lower(), "version": ver, "source": str(path),
                             "is_dev": section == "devDependencies"})
    return deps


def parse_pom_xml(path: Path) -> list:
    """Parse direct Maven dependencies and locally managed versions.

    Maven POMs are namespaced XML and commonly keep versions in ``properties``
    or ``dependencyManagement``.  Parsing with ElementTree is both less brittle
    than a regular expression and avoids treating build plugins or managed-only
    entries as runtime dependencies.  Imported BOM contents and remote parent
    POMs require Maven resolution and are intentionally left to the online/tool
    assisted follow-up described in the dependency auditor.
    """
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError):
        return []

    def local_name(element: ET.Element) -> str:
        return element.tag.rsplit("}", 1)[-1]

    def children(element: ET.Element, name: str) -> list:
        return [child for child in element if local_name(child) == name]

    def child_text(element: ET.Element, name: str) -> str:
        matches = children(element, name)
        return (matches[0].text or "").strip() if matches else ""

    properties = {}
    parent = next(iter(children(root, "parent")), None)
    parent_group = child_text(parent, "groupId") if parent is not None else ""
    parent_version = child_text(parent, "version") if parent is not None else ""
    project_group = child_text(root, "groupId") or parent_group
    project_version = child_text(root, "version") or parent_version
    project_artifact = child_text(root, "artifactId")
    properties.update({
        "project.groupId": project_group,
        "pom.groupId": project_group,
        "groupId": project_group,
        "project.artifactId": project_artifact,
        "pom.artifactId": project_artifact,
        "artifactId": project_artifact,
        "project.version": project_version,
        "pom.version": project_version,
        "version": project_version,
        "project.parent.groupId": parent_group,
        "parent.groupId": parent_group,
        "project.parent.version": parent_version,
        "parent.version": parent_version,
    })
    properties_element = next(iter(children(root, "properties")), None)
    if properties_element is not None:
        for prop in properties_element:
            properties[local_name(prop)] = (prop.text or "").strip()

    placeholder = re.compile(r"\$\{([^}]+)\}")

    def resolve(value: str) -> str:
        value = value.strip()
        for _ in range(10):
            resolved = placeholder.sub(lambda match: properties.get(match.group(1), match.group(0)), value)
            if resolved == value:
                break
            value = resolved
        return "" if placeholder.search(value) else value

    managed = {}

    def collect_managed(element: ET.Element, under_management: bool = False) -> None:
        name = local_name(element)
        under_management = under_management or name == "dependencyManagement"
        if name == "dependency" and under_management:
            group = resolve(child_text(element, "groupId"))
            artifact = resolve(child_text(element, "artifactId")).lower()
            version = resolve(child_text(element, "version"))
            if artifact and version:
                managed[(group.lower(), artifact)] = version
                managed[("", artifact)] = version
            return
        for child in element:
            collect_managed(child, under_management)

    collect_managed(root)
    deps = []

    def collect_dependencies(element: ET.Element, under_management: bool = False,
                             under_build: bool = False) -> None:
        name = local_name(element)
        under_management = under_management or name == "dependencyManagement"
        under_build = under_build or name in {"build", "plugin", "plugins"}
        if name == "dependency":
            if under_management:
                return
            group = resolve(child_text(element, "groupId"))
            artifact = resolve(child_text(element, "artifactId")).lower()
            version = resolve(child_text(element, "version"))
            if not version:
                version = managed.get((group.lower(), artifact), managed.get(("", artifact), ""))
            scope = resolve(child_text(element, "scope")).lower()
            if artifact and version:
                coordinate = f"{group}:{artifact}" if group else artifact
                deps.append({
                    "name": artifact,
                    "version": version,
                    "source": str(path),
                    "group": group.lower(),
                    "osv_name": coordinate.lower(),
                    "is_direct": True,
                    "is_dev": under_build or scope in {"test", "provided", "system"},
                    "scope": scope or "compile",
                })
            return
        for child in element:
            collect_dependencies(child, under_management, under_build)

    collect_dependencies(root)
    return deps


def parse_go_mod(path: Path) -> list:
    deps = []
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        m = re.match(r"^\s*([\w./\-]+)\s+v([\d.]+)", line)
        if m:
            deps.append({"name": m.group(1).lower(), "version": m.group(2), "source": str(path)})
    return deps


def parse_gemfile_lock(path: Path) -> list:
    deps = []
    in_specs = False
    for line in path.read_text(errors="replace").splitlines():
        if "GEM" in line or "specs:" in line:
            in_specs = True
        elif in_specs:
            m = re.match(r"\s{4}([\w\-]+)\s+\(([\d.]+)\)", line)
            if m:
                deps.append({"name": m.group(1).lower(), "version": m.group(2), "source": str(path)})
    return deps


def parse_composer_json(path: Path) -> list:
    try:
        data = json.loads(path.read_text(errors="replace"))
    except (json.JSONDecodeError, OSError):
        return []
    deps = []
    for section in ("require", "require-dev"):
        for name, ver in data.get(section, {}).items():
            ver = re.sub(r"[^0-9.]", "", ver)
            if ver and name != "php":
                deps.append({"name": name.lower(), "version": ver, "source": str(path)})
    return deps


def parse_cargo_toml(path: Path) -> list:
    """Parse Cargo.toml [dependencies] and [dev-dependencies] sections."""
    deps = []
    content = path.read_text(errors="replace")
    in_deps = False
    section = ""
    for line in content.splitlines():
        line_s = line.strip()
        if re.match(r'^\[(dev-dependencies|build-dependencies|dependencies)\]', line_s):
            in_deps = True
            section = line_s
            continue
        if line_s.startswith("[") and in_deps:
            in_deps = False
            continue
        if not in_deps:
            continue
        # name = "1.2.3"  or  name = { version = "1.2.3" }
        m = re.match(r'^([\w\-]+)\s*=\s*["\']([^"\']+)["\']', line_s)
        if m:
            deps.append({"name": m.group(1).lower(), "version": re.sub(r"[^0-9.]", "", m.group(2)), "source": str(path)})
            continue
        m = re.match(r'^([\w\-]+)\s*=\s*\{[^}]*version\s*=\s*["\']([^"\']+)["\']', line_s)
        if m:
            deps.append({"name": m.group(1).lower(), "version": re.sub(r"[^0-9.]", "", m.group(2)), "source": str(path)})
    return [d for d in deps if d["version"]]


def _xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _concrete_version(value: str) -> str:
    """Return a concrete package version without converting ranges to versions."""
    value = (value or "").strip().lstrip("v")
    if not re.match(r"^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$", value):
        return ""
    return value


def _parse_nuget_xml(path: Path, element_name: str) -> list:
    """Parse PackageReference/PackageVersion nodes regardless of XML namespace or attribute order."""
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError):
        return []

    properties = {}
    for property_group in root.iter():
        if _xml_local_name(property_group.tag) != "propertygroup":
            continue
        for child in property_group:
            value = (child.text or "").strip()
            if value:
                properties[_xml_local_name(child.tag)] = value

    placeholder = re.compile(r"\$\(([^)]+)\)")

    def resolve_msbuild_properties(value: str) -> str:
        """Resolve only properties declared in this project/props document."""
        value = (value or "").strip()
        for _ in range(10):
            resolved = placeholder.sub(
                lambda match: properties.get(match.group(1).lower(), match.group(0)),
                value,
            )
            if resolved == value:
                break
            value = resolved
        return value

    deps = []
    seen = set()
    for element in root.iter():
        if _xml_local_name(element.tag) != element_name.lower():
            continue
        attrs = {_xml_local_name(key): value for key, value in element.attrib.items()}
        name = (attrs.get("include") or attrs.get("update") or "").strip().lower()
        version = attrs.get("version", "")
        if not version:
            for child in element:
                if _xml_local_name(child.tag) in {"version", "versionoverride"}:
                    version = child.text or ""
                    break
        version = _concrete_version(resolve_msbuild_properties(version))
        key = (name, version)
        if name and version and key not in seen:
            seen.add(key)
            deps.append({
                "name": name,
                "version": version,
                "source": str(path),
                "is_direct": element_name.lower() == "packagereference",
            })
    return deps


def parse_csproj(path: Path) -> list:
    """Parse SDK-style or legacy .NET project PackageReference elements."""
    return _parse_nuget_xml(path, "PackageReference")


def parse_directory_packages_props(path: Path) -> list:
    """Parse centrally managed NuGet PackageVersion elements."""
    return _parse_nuget_xml(path, "PackageVersion")


def parse_packages_config(path: Path) -> list:
    """Parse packages.config (NuGet legacy format)."""
    content = path.read_text(errors="replace")
    deps = []
    for m in re.finditer(r'<package\s+id="([^"]+)"\s+version="([^"]+)"', content, re.IGNORECASE):
        ver = re.sub(r"[^0-9.]", "", m.group(2))
        if ver:
            deps.append({"name": m.group(1).lower(), "version": ver, "source": str(path)})
    return deps


def parse_packages_lock_json(path: Path) -> list:
    """Parse NuGet packages.lock.json across all target frameworks."""
    try:
        data = json.loads(path.read_text(errors="replace"))
    except (json.JSONDecodeError, OSError):
        return []

    deps = []
    seen = set()
    for packages in data.get("dependencies", {}).values():
        if not isinstance(packages, dict):
            continue
        for package_name, metadata in packages.items():
            if not isinstance(metadata, dict):
                continue
            version = _concrete_version(str(metadata.get("resolved", "")))
            key = (package_name.lower(), version)
            if version and key not in seen:
                seen.add(key)
                deps.append({
                    "name": package_name.lower(),
                    "version": version,
                    "source": str(path),
                    "is_direct": str(metadata.get("type", "")).lower() == "direct",
                })
    return deps


def parse_paket_lock(path: Path) -> list:
    """Parse resolved NuGet versions from paket.lock."""
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return []

    deps = []
    seen = set()
    in_nuget = False
    for line in lines:
        stripped = line.strip()
        if stripped == "NUGET":
            in_nuget = True
            continue
        if stripped and not line.startswith((" ", "\t")) and stripped != "NUGET":
            in_nuget = False
        if not in_nuget:
            continue
        match = re.match(r"^\s{4}([^\s(]+)\s+\(([^)]+)\)", line)
        if not match:
            continue
        name = match.group(1).lower()
        version = _concrete_version(match.group(2))
        key = (name, version)
        if version and key not in seen:
            seen.add(key)
            deps.append({
                "name": name,
                "version": version,
                "source": str(path),
                "is_direct": False,
            })
    return deps


def parse_build_gradle(path: Path) -> list:
    """Parse common Groovy and Kotlin Gradle dependency declarations."""
    try:
        content = path.read_text(errors="replace")
    except OSError:
        return []

    properties = {}
    # Root gradle.properties values are inherited by module build scripts, while
    # values nearer the module override them. Stop at the repository boundary.
    candidate_dirs = []
    found_project_root = False
    current = path.parent
    for _ in range(12):
        candidate_dirs.append(current)
        if ((current / ".git").exists() or (current / "settings.gradle").is_file()
                or (current / "settings.gradle.kts").is_file()):
            found_project_root = True
            break
        if current.parent == current:
            break
        current = current.parent
    # Without a project-root marker, do not consume unrelated host/user
    # gradle.properties files above the scanned module.
    property_dirs = candidate_dirs if found_project_root else [path.parent]
    for directory in reversed(property_dirs):
        prop_file = directory / "gradle.properties"
        if not prop_file.is_file():
            continue
        for line in prop_file.read_text(errors="replace").splitlines():
            match = re.match(r"^\s*([\w.-]+)\s*=\s*(.*?)\s*$", line)
            if match and not match.group(1).startswith(("#", "!")):
                properties[match.group(1)] = match.group(2)

    assignment_patterns = (
        r"(?m)^\s*(?:def|val|var)\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*['\"]([^'\"]+)['\"]",
        r"(?m)^\s*(?:ext\.)?([A-Za-z_]\w*)\s*=\s*['\"]([^'\"]+)['\"]",
        r"(?m)^\s*extra\[['\"]([^'\"]+)['\"]\]\s*=\s*['\"]([^'\"]+)['\"]",
    )
    for pattern in assignment_patterns:
        for match in re.finditer(pattern, content):
            properties[match.group(1)] = match.group(2)

    def resolve(value: str) -> str:
        for _ in range(10):
            previous = value
            value = re.sub(
                r"\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)",
                lambda match: properties.get(match.group(1) or match.group(2), match.group(0)),
                value,
            )
            if value == previous:
                break
        return value

    def exact_version(value: str) -> str:
        value = resolve(value).strip().split("@", 1)[0]
        if (not re.match(r"^\d", value) or "$" in value or "+" in value
                or value.startswith(("[", "("))):
            return ""
        return value

    configuration = (
        r"(?:[A-Za-z_]\w*)?(?:implementation|api|compile|compileOnly|runtimeOnly|"
        r"testImplementation|testRuntimeOnly|annotationProcessor|kapt|ksp|classpath)"
    )
    deps = []
    seen = set()

    def add(group: str, artifact: str, version: str, config: str) -> None:
        group = resolve(group).strip().lower()
        artifact = resolve(artifact).strip().lower()
        version = exact_version(version)
        key = (group, artifact, version, config.lower())
        if not group or not artifact or not version or key in seen:
            return
        seen.add(key)
        deps.append({
            "name": artifact,
            "version": version,
            "source": str(path),
            "group": group,
            "osv_name": f"{group}:{artifact}",
            "is_direct": True,
            "is_dev": "test" in config.lower() or config.lower() in {
                "annotationprocessor", "kapt", "ksp", "classpath"
            },
            "scope": config,
        })

    # String notation: implementation 'g:a:v', implementation("g:a:v"),
    # and implementation(platform("g:a:v")).
    string_pattern = re.compile(
        rf"\b({configuration})\b\s*(?:\(\s*)?(?:(?:enforcedPlatform|platform)\s*\(\s*)?"
        rf"(['\"])([^'\"\r\n]+)\2",
        re.IGNORECASE,
    )
    for match in string_pattern.finditer(content):
        coordinate = resolve(match.group(3)) if match.group(2) == '"' else match.group(3)
        parts = coordinate.split(":", 2)
        if len(parts) == 3:
            add(parts[0], parts[1], parts[2], match.group(1))

    # Map/named-argument notation in either DSL.
    argument_patterns = (
        re.compile(rf"\b({configuration})\b\s*\(([^)]{{0,1000}})\)", re.IGNORECASE | re.DOTALL),
        re.compile(rf"\b({configuration})\b\s+([^\r\n]+)", re.IGNORECASE),
    )
    for pattern in argument_patterns:
        for match in pattern.finditer(content):
            args = match.group(2)
            values = {}
            for key in ("group", "name", "version"):
                value_match = re.search(
                    rf"\b{key}\b\s*(?:=|:)\s*(?:['\"]([^'\"]+)['\"]|([A-Za-z_]\w*))",
                    args,
                )
                if value_match:
                    raw = value_match.group(1) or properties.get(value_match.group(2), value_match.group(2))
                    values[key] = raw
            if all(key in values for key in ("group", "name", "version")):
                add(values["group"], values["name"], values["version"], match.group(1))
    return deps


def parse_gradle_version_catalog(path: Path) -> list:
    """Parse Gradle version catalogs such as gradle/libs.versions.toml."""
    try:
        data = tomllib.loads(path.read_text(errors="replace"))
    except (tomllib.TOMLDecodeError, OSError):
        return []
    versions = data.get("versions", {})

    def version_value(value) -> str:
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            return str(value.get("required") or value.get("require") or value.get("strictly")
                       or value.get("prefer") or "")
        return ""

    deps = []
    for alias, declaration in data.get("libraries", {}).items():
        group = artifact = version = ""
        if isinstance(declaration, str):
            parts = declaration.split(":", 2)
            if len(parts) == 3:
                group, artifact, version = parts
        elif isinstance(declaration, dict):
            module = str(declaration.get("module", ""))
            if ":" in module:
                group, artifact = module.split(":", 1)
            else:
                group = str(declaration.get("group", ""))
                artifact = str(declaration.get("name", ""))
            version_spec = declaration.get("version", "")
            version = version_value(version_spec)
            ref = declaration.get("version.ref", "")
            if isinstance(version_spec, dict):
                ref = version_spec.get("ref", ref)
            if ref:
                version = version_value(versions.get(str(ref), ""))
        version = version.strip()
        if (not group or not artifact or not re.match(r"^\d", version)
                or "+" in version or version.startswith(("[", "("))):
            continue
        group = group.lower()
        artifact = artifact.lower()
        deps.append({
            "name": artifact,
            "version": version,
            "source": str(path),
            "group": group,
            "osv_name": f"{group}:{artifact}",
            "is_direct": True,
            "is_dev": False,
            "scope": "version_catalog",
            "catalog_alias": alias,
        })
    return deps


def parse_gradle_lockfile(path: Path) -> list:
    """Parse Gradle's resolved dependency lock state."""
    deps = []
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("empty="):
            continue
        coordinate = line.split("=", 1)[0]
        parts = coordinate.split(":")
        if len(parts) != 3 or not re.match(r"^\d", parts[2]):
            continue
        group = parts[0].strip().lower()
        artifact = parts[1].strip().lower()
        version = parts[2].strip()
        deps.append({
            "name": artifact,
            "version": version,
            "source": str(path),
            "group": group,
            "osv_name": f"{group}:{artifact}",
            "is_direct": False,
            "is_dev": False,
            "scope": "resolved_lock",
        })
    return deps


def parse_pyproject_toml(path: Path) -> list:
    """Parse pyproject.toml [project.dependencies] and [tool.poetry.dependencies]."""
    content = path.read_text(errors="replace")
    deps = []
    in_section = False
    for line in content.splitlines():
        line_s = line.strip()
        if re.match(r'^\[project\.dependencies\]|\[tool\.poetry\.dependencies\]', line_s):
            in_section = True
            continue
        if line_s.startswith("[") and in_section:
            in_section = False
            continue
        if not in_section:
            # Also parse PEP 508 inline list: dependencies = ["requests>=2.0", ...]
            m = re.search(r'"([\w\-\.]+)\s*(?:>=|==|~=|<=|!=|>|<)\s*([\d\.]+)', line_s)
            if m:
                deps.append({"name": m.group(1).lower(), "version": m.group(2), "source": str(path)})
            continue
        # name = ">=1.2.3"  (poetry format)
        m = re.match(r'^([\w\-\.]+)\s*=\s*["\'](?:[\^~>=<]*)([\d\.]+)', line_s)
        if m:
            deps.append({"name": m.group(1).lower(), "version": m.group(2), "source": str(path)})
    return [d for d in deps if d["version"]]


def parse_package_lock_json(path: Path) -> list:
    """Parse package-lock.json (npm v1/v2/v3 lockfile)."""
    try:
        data = json.loads(path.read_text(errors="replace"))
    except (json.JSONDecodeError, OSError):
        return []
    deps = []
    # v2/v3 format uses "packages" key
    if "packages" in data:
        for pkg_path, pkg_data in data["packages"].items():
            if pkg_path == "":
                continue  # skip root
            # Strip leading "node_modules/" to get name
            name = pkg_path
            if name.startswith("node_modules/"):
                name = name[len("node_modules/"):]
            version = pkg_data.get("version", "")
            if not version:
                continue
            # is_direct: no nested node_modules after stripping the leading one
            is_direct = "/" not in name.lstrip("@").split("/", 1)[-1] if name.startswith("@") else "/" not in name
            deps.append({
                "name": name.lower(),
                "version": version,
                "ecosystem": "npm",
                "is_direct": is_direct,
                "source": str(path),
            })
    elif "dependencies" in data:
        # v1 format
        for pkg_name, pkg_data in data["dependencies"].items():
            if "resolved" not in pkg_data:
                continue
            version = pkg_data.get("version", "")
            if not version:
                continue
            deps.append({
                "name": pkg_name.lower(),
                "version": version,
                "ecosystem": "npm",
                "is_direct": True,
                "source": str(path),
            })
    return deps


def parse_yarn_lock(path: Path) -> list:
    """Parse resolved npm packages from Yarn Classic and Yarn Berry lockfiles."""
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return []

    direct_metadata = {}
    try:
        package_json = json.loads((path.parent / "package.json").read_text(errors="replace"))
    except (json.JSONDecodeError, OSError):
        package_json = {}
    if isinstance(package_json, dict):
        for section in ("dependencies", "optionalDependencies", "peerDependencies"):
            values = package_json.get(section, {})
            if isinstance(values, dict):
                for name in values:
                    direct_metadata[name.lower()] = False
        values = package_json.get("devDependencies", {})
        if isinstance(values, dict):
            for name in values:
                direct_metadata.setdefault(name.lower(), True)

    def descriptor_name(descriptor: str) -> str:
        descriptor = descriptor.strip().strip('"\'')
        if any(protocol in descriptor for protocol in (
            "@workspace:", "@file:", "@link:", "@portal:", "@patch:",
        )):
            return ""
        if "@npm:" in descriptor:
            name = descriptor.split("@npm:", 1)[0]
        elif descriptor.startswith("@"):
            match = re.match(r"^(@[^/]+/[^@]+)@", descriptor)
            name = match.group(1) if match else ""
        else:
            name = descriptor.split("@", 1)[0]
        return name.lower()

    current_names = []
    deps = []
    seen = set()
    version_pattern = re.compile(
        r'^\s{2,}version(?:\s+|:\s*)(?:"([^"]+)"|\'([^\']+)\'|([^\s#]+))\s*$'
    )
    for line in lines:
        if line and not line[0].isspace() and line.rstrip().endswith(":"):
            header = line.rstrip()[:-1].strip()
            if header == "__metadata":
                current_names = []
                continue
            descriptors = re.split(r'"\s*,\s*"|\'\s*,\s*\'|,\s*', header)
            current_names = []
            for descriptor in descriptors:
                name = descriptor_name(descriptor)
                if name and name not in current_names:
                    current_names.append(name)
            continue
        if current_names:
            vm = version_pattern.match(line)
            if vm:
                version = _concrete_version(next(value for value in vm.groups() if value is not None))
                if version:
                    for name in current_names:
                        key = (name, version)
                        if key in seen:
                            continue
                        seen.add(key)
                        is_direct = name in direct_metadata
                        deps.append({
                            "name": name,
                            "version": version,
                            "ecosystem": "npm",
                            "is_direct": is_direct,
                            "is_dev": direct_metadata.get(name, False) if is_direct else False,
                            "source": str(path),
                        })
                current_names = []
    return deps


def parse_pnpm_lock(path: Path) -> list:
    """Parse resolved packages and directness from pnpm lockfiles through v9."""
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return []

    mapping_pattern = re.compile(
        r'^( *)(?:"([^"]+)"|\'([^\']+)\'|([^:#][^:]*?)):\s*(.*?)\s*$'
    )

    def mapping(line: str):
        match = mapping_pattern.match(line)
        if not match:
            return None
        key = next(value for value in match.group(2, 3, 4) if value is not None).strip()
        return len(match.group(1)), key, match.group(5).strip()

    def resolved_version(value: str) -> str:
        value = value.strip().strip('"\'')
        if not value:
            return ""
        value = value.split("(", 1)[0]
        if value.startswith("npm:") and "@" in value:
            value = value.rsplit("@", 1)[-1]
        if value.startswith(("workspace:", "link:", "file:", "git+", "http:", "https:")):
            return ""
        return _concrete_version(value)

    def package_identity(raw_key: str):
        raw_key = raw_key.strip().strip('"\'').lstrip("/")
        raw_key = raw_key.split("(", 1)[0]
        if raw_key.startswith("@") and raw_key.count("/") >= 2:
            possible_name, possible_version = raw_key.rsplit("/", 1)
            version = resolved_version(possible_version)
            if version:
                return possible_name.lower(), version
        if not raw_key.startswith("@") and "/" in raw_key:
            possible_name, possible_version = raw_key.rsplit("/", 1)
            version = resolved_version(possible_version)
            if version:
                return possible_name.lower(), version
        if "@" not in raw_key.lstrip("@"):
            return None
        name, raw_version = raw_key.rsplit("@", 1)
        version = resolved_version(raw_version)
        if not name or not version:
            return None
        return name.lower(), version

    direct_pairs = {}
    top_section = ""
    dependency_section = None
    current_direct_name = ""
    package_entries = []
    for line in lines:
        parsed = mapping(line)
        if not parsed:
            continue
        indent, key, value = parsed
        key_lower = key.lower()
        if indent == 0:
            top_section = key_lower
            dependency_section = None
            current_direct_name = ""

        if top_section == "packages" and indent == 2:
            identity = package_identity(key)
            if identity:
                package_entries.append(identity)
            continue

        dependency_kind = None
        if top_section in {"dependencies", "devdependencies", "optionaldependencies"}:
            if indent == 0:
                dependency_section = (indent, top_section)
                continue
        elif top_section == "importers" and indent == 4 and key_lower in {
            "dependencies", "devdependencies", "optionaldependencies",
        }:
            dependency_section = (indent, key_lower)
            current_direct_name = ""
            continue

        if dependency_section is None:
            continue
        section_indent, dependency_kind = dependency_section
        if indent <= section_indent and not (indent == 0 and top_section == dependency_kind):
            dependency_section = None
            current_direct_name = ""
            continue
        if indent == section_indent + 2:
            current_direct_name = key_lower
            version = resolved_version(value)
            if version:
                pair = (current_direct_name, version)
                is_dev = dependency_kind == "devdependencies"
                direct_pairs[pair] = direct_pairs.get(pair, True) and is_dev
            continue
        if indent == section_indent + 4 and current_direct_name and key_lower == "version":
            version = resolved_version(value)
            if version:
                pair = (current_direct_name, version)
                is_dev = dependency_kind == "devdependencies"
                direct_pairs[pair] = direct_pairs.get(pair, True) and is_dev

    deps = []
    seen = set()
    for name, version in package_entries:
        key = (name, version)
        if key in seen:
            continue
        seen.add(key)
        is_direct = key in direct_pairs
        deps.append({
            "name": name,
            "version": version,
            "ecosystem": "npm",
            "is_direct": is_direct,
            "is_dev": direct_pairs.get(key, False) if is_direct else False,
            "source": str(path),
        })
    return deps


def parse_pipfile(path: Path) -> list:
    """Parse exact, registry-backed dependencies declared in a Pipfile."""
    try:
        data = tomllib.loads(path.read_text(errors="replace"))
    except (tomllib.TOMLDecodeError, OSError):
        return []

    deps = []
    for section, is_dev in (("packages", False), ("dev-packages", True)):
        declarations = data.get(section, {})
        if not isinstance(declarations, dict):
            continue
        for package_name, declaration in declarations.items():
            raw_version = declaration.get("version", "") if isinstance(declaration, dict) else declaration
            if not isinstance(raw_version, str):
                continue
            raw_version = raw_version.strip()
            if raw_version.startswith("==") and not raw_version.startswith("==="):
                raw_version = raw_version[2:]
            version = _concrete_version(raw_version)
            if not version:
                continue
            deps.append({
                "name": package_name.lower(),
                "version": version,
                "ecosystem": "pypi",
                "is_direct": True,
                "is_dev": is_dev,
                "source": str(path),
            })
    return deps


def parse_poetry_lock(path: Path) -> list:
    """Parse poetry.lock (TOML [[package]] blocks via regex)."""
    deps = []
    try:
        content = path.read_text(errors="replace")
    except OSError:
        return []
    # Split on [[package]] blocks
    blocks = re.split(r'\[\[package\]\]', content)
    for block in blocks[1:]:  # skip leading content before first [[package]]
        name_m = re.search(r'^name\s*=\s*"([^"]+)"', block, re.MULTILINE)
        ver_m = re.search(r'^version\s*=\s*"([^"]+)"', block, re.MULTILINE)
        if name_m and ver_m:
            deps.append({
                "name": name_m.group(1).lower(),
                "version": ver_m.group(1),
                "ecosystem": "pypi",
                "is_direct": False,
                "source": str(path),
            })
    return deps


def parse_pipfile_lock(path: Path) -> list:
    """Parse Pipfile.lock (JSON format)."""
    try:
        data = json.loads(path.read_text(errors="replace"))
    except (json.JSONDecodeError, OSError):
        return []
    deps = []
    for section, is_direct in (("default", True), ("develop", False)):
        for pkg_name, pkg_data in data.get(section, {}).items():
            version = pkg_data.get("version", "")
            # Strip leading == from version specifier
            version = version.lstrip("=")
            if version:
                deps.append({
                    "name": pkg_name.lower(),
                    "version": version,
                    "ecosystem": "pypi",
                    "is_direct": is_direct,
                    "source": str(path),
                })
    return deps


def parse_composer_lock(path: Path) -> list:
    """Parse composer.lock (JSON format)."""
    try:
        data = json.loads(path.read_text(errors="replace"))
    except (json.JSONDecodeError, OSError):
        return []
    deps = []
    for section, is_direct in (("packages", True), ("packages-dev", False)):
        for pkg in data.get(section, []):
            name = pkg.get("name", "")
            version = pkg.get("version", "")
            # Strip leading 'v' from version if present
            version = version.lstrip("v")
            if name and version:
                deps.append({
                    "name": name.lower(),
                    "version": version,
                    "ecosystem": "packagist",
                    "is_direct": is_direct,
                    "source": str(path),
                })
    return deps


def parse_cargo_lock(path: Path) -> list:
    """Parse Cargo.lock (TOML [[package]] blocks via regex)."""
    deps = []
    try:
        content = path.read_text(errors="replace")
    except OSError:
        return []
    blocks = re.split(r'\[\[package\]\]', content)
    for block in blocks[1:]:
        name_m = re.search(r'^name\s*=\s*"([^"]+)"', block, re.MULTILINE)
        ver_m = re.search(r'^version\s*=\s*"([^"]+)"', block, re.MULTILINE)
        if name_m and ver_m:
            deps.append({
                "name": name_m.group(1).lower(),
                "version": ver_m.group(1),
                "ecosystem": "crates.io",
                "is_direct": False,
                "source": str(path),
            })
    return deps


def parse_go_sum(path: Path) -> list:
    """Parse go.sum (deduplicated by module name)."""
    deps = {}
    try:
        content = path.read_text(errors="replace")
    except OSError:
        return []
    pattern = re.compile(r'^([^\s]+)\s+v([0-9][^\s]+)\s+')
    for line in content.splitlines():
        m = pattern.match(line)
        if m:
            module = m.group(1).lower()
            version = m.group(2)
            # Keep entry (dedup by module name — last wins, preserving latest)
            deps[module] = {
                "name": module,
                "version": version,
                "ecosystem": "go",
                "is_direct": False,
                "source": str(path),
            }
    return list(deps.values())


PARSERS = {
    "requirements.txt": ("python", parse_requirements_txt),
    "requirements-dev.txt": ("python", parse_requirements_txt),
    "requirements-prod.txt": ("python", parse_requirements_txt),
    "pipfile": ("pypi", parse_pipfile),
    "pyproject.toml": ("python", parse_pyproject_toml),
    "package.json": ("javascript", parse_package_json),
    "pom.xml": ("java", parse_pom_xml),
    "build.gradle": ("java", parse_build_gradle),
    "build.gradle.kts": ("java", parse_build_gradle),
    "libs.versions.toml": ("java", parse_gradle_version_catalog),
    "gradle.lockfile": ("java", parse_gradle_lockfile),
    "go.mod": ("go", parse_go_mod),
    "gemfile.lock": ("ruby", parse_gemfile_lock),
    "composer.json": ("php", parse_composer_json),
    "cargo.toml": ("rust", parse_cargo_toml),
    "packages.config": ("dotnet", parse_packages_config),
    "packages.lock.json": ("dotnet", parse_packages_lock_json),
    "directory.packages.props": ("dotnet", parse_directory_packages_props),
    "paket.lock": ("dotnet", parse_paket_lock),
    # Lockfile parsers (Task 4.1)
    "package-lock.json": ("npm", parse_package_lock_json),
    "npm-shrinkwrap.json": ("npm", parse_package_lock_json),
    "yarn.lock": ("npm", parse_yarn_lock),
    "pnpm-lock.yaml": ("npm", parse_pnpm_lock),
    "poetry.lock": ("pypi", parse_poetry_lock),
    "pipfile.lock": ("pypi", parse_pipfile_lock),
    "composer.lock": ("packagist", parse_composer_lock),
    "cargo.lock": ("crates.io", parse_cargo_lock),
    "go.sum": ("go", parse_go_sum),
}


def check_dependencies(base_path: Path, online: bool = False) -> dict:
    all_findings = []
    all_deps = []
    manifests_found = []

    manifests = get_manifest_files(base_path)
    for manifest in manifests:
        name_lower = manifest.name.lower()
        # Handle variable-name .NET project manifests.
        if name_lower.endswith((".csproj", ".fsproj", ".vbproj")):
            ecosystem, parser = "dotnet", parse_csproj
        elif name_lower.endswith(".versions.toml"):
            ecosystem, parser = "java", parse_gradle_version_catalog
        elif name_lower not in PARSERS:
            continue
        else:
            ecosystem, parser = PARSERS[name_lower]
        deps = parser(manifest)
        manifests_found.append({"file": str(manifest.relative_to(base_path)), "ecosystem": ecosystem, "deps": len(deps)})
        all_deps.extend([(ecosystem, d) for d in deps])

    # Track CVEs already found via KNOWN_VULNS to avoid duplicates from OSV
    seen_cves: set = set()

    for ecosystem, dep in all_deps:
        pkg_name = dep["name"]
        version = dep["version"]
        vulns = KNOWN_VULNS.get(ecosystem, [])
        for pkg, vuln_range, safe_ver, cve, cvss, vuln_type, description in vulns:
            if pkg.lower() == pkg_name and version_in_range(version, vuln_range):
                seen_cves.add(f"{pkg_name}:{cve}")
                all_findings.append({
                    "package": pkg,
                    "ecosystem": ecosystem,
                    "current_version": version,
                    "vulnerable_range": vuln_range,
                    "safe_version": safe_ver,
                    "cve": cve,
                    "cvss": cvss,
                    "vuln_type": vuln_type,
                    "description": description,
                    "is_dev": dep.get("is_dev", False),
                    "manifest": dep.get("source", ""),
                    "severity": "critical" if cvss >= 9.0 else "high" if cvss >= 7.0 else "medium" if cvss >= 4.0 else "low",
                    "status": "candidate",
                    "source": "known_vulns",
                })

    # Live OSV.dev lookup (Task 4.2) — gated behind online flag
    if online:
        try:
            from scripts.cve_osv import query_osv, osv_vulns_to_findings
            # Ecosystem name mapping from internal names to OSV ecosystem names
            osv_ecosystem_map = {
                "python": "PyPI",
                "pypi": "PyPI",
                "javascript": "npm",
                "npm": "npm",
                "java": "Maven",
                "maven": "Maven",
                "go": "Go",
                "ruby": "RubyGems",
                "php": "Packagist",
                "packagist": "Packagist",
                "rust": "crates.io",
                "crates.io": "crates.io",
                "dotnet": "NuGet",
            }
            for ecosystem, dep in all_deps:
                pkg_name = dep["name"]
                query_name = dep.get("osv_name", pkg_name)
                version = dep["version"]
                osv_eco = osv_ecosystem_map.get(ecosystem, ecosystem)
                osv_vulns = query_osv(query_name, version, osv_eco, offline=False)
                osv_findings = osv_vulns_to_findings(osv_vulns, query_name, version, dep.get("source", ""))
                for f in osv_findings:
                    dedup_key = f"{pkg_name}:{f['cve']}"
                    if dedup_key not in seen_cves:
                        seen_cves.add(dedup_key)
                        all_findings.append({
                            "package": pkg_name,
                            "ecosystem": ecosystem,
                            "current_version": version,
                            "vulnerable_range": "see OSV",
                            "safe_version": "see OSV",
                            "cve": f["cve"],
                            "cvss": f["cvss"],
                            "vuln_type": f["vuln_type"],
                            "description": f["description"],
                            "is_dev": dep.get("is_dev", False),
                            "manifest": dep.get("source", ""),
                            "severity": f["severity"],
                            "status": "candidate",
                            "source": "osv.dev",
                        })
        except ImportError:
            print("Warning: cve_osv module not available; skipping live OSV lookup.", file=sys.stderr)

    all_findings.sort(key=lambda x: -x["cvss"])

    return {
        "manifests": manifests_found,
        "total_deps_checked": len(all_deps),
        "findings": all_findings,
        "summary": {
            "critical": sum(1 for f in all_findings if f["severity"] == "critical"),
            "high": sum(1 for f in all_findings if f["severity"] == "high"),
            "medium": sum(1 for f in all_findings if f["severity"] == "medium"),
            "low": sum(1 for f in all_findings if f["severity"] == "low"),
        }
    }


def main():
    parser = argparse.ArgumentParser(description="Code-VulnScan dependency auditor")
    parser.add_argument("--path", required=True, help="Path to scan")
    parser.add_argument("--output", help="Output JSON file")
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--online", action="store_true",
                        help="Query api.osv.dev for live CVE data (sends package names/versions)")
    args = parser.parse_args()

    base = Path(args.path)
    if not base.exists():
        print(f"Error: path not found: {base}", file=sys.stderr)
        sys.exit(1)

    print(f"Scanning dependencies in: {base}", file=sys.stderr)
    if args.online:
        print("Live OSV.dev lookup enabled (--online)", file=sys.stderr)
    results = check_dependencies(base, online=args.online)

    indent = 2 if args.pretty else None
    output_str = json.dumps(results, indent=indent)

    if args.output:
        Path(args.output).write_text(output_str)
        print(f"Results written to: {args.output}", file=sys.stderr)
    else:
        print(output_str)

    s = results["summary"]
    print(f"\nDependency scan: {len(results['findings'])} vulnerable packages found "
          f"({s['critical']} critical, {s['high']} high, {s['medium']} medium)",
          file=sys.stderr)

    for f in results["findings"][:15]:
        print(f"  [{f['severity'].upper():8}] {f['package']} {f['current_version']} — {f['cve']} — {f['description'][:60]}",
              file=sys.stderr)

    print("\nNote: verify exploitability using sub-skills/dependency-auditor.md", file=sys.stderr)


if __name__ == "__main__":
    main()
