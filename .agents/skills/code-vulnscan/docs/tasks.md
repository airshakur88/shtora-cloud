# Code-VulnScan Skill — Task Tracker

Status legend: `[ ]` pending · `[~]` in progress · `[x]` done

---

## Setup & IDE Support

- [x] `install.sh` supports claude, codex, antigravity, cursor, windsurf, continue, copilot, cline, global, project, all
- [x] `install.ps1` (PowerShell/Windows) — mirrors install.sh, all targets
- [x] Each IDE target installs in that IDE's native format:
  - claude/codex/antigravity → `skills/` directory (native SKILL.md support)
  - cursor → `.cursor/rules/code-vulnscan.mdc` (Cursor MDC format)
  - windsurf → `.windsurf/rules/code-vulnscan.md` (Windsurf rules directory)
  - copilot → `.github/copilot-instructions.md`
  - cline → `.clinerules` (with block markers for idempotent updates)
  - continue → `.continue/prompts/vulnscan.prompt` (slash command format)
- [x] `--online` mode (curl/Invoke-WebRequest latest release archive)
- [x] `install.sh.sha256` checksum file
- [x] `install.ps1.sha256` checksum file
- [x] Release archive checksum assets are fetched and verified before extraction; missing or mismatched checksums fail closed
- [ ] **Zed editor target** (`--target zed`) — `.zed/settings.json` AI context
- [ ] **Aider target** (`--target aider`) — `.aider.conf.yml` convention file

---

## Language Pattern Files (resources/patterns/)

| File                       | Status   | Notes                                                                                                                                                                           |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `python_patterns.json`     | [x] Done | SQLi, CMDi, path traversal, XSS/SSTI, SSRF, deserialization, crypto, auth                                                                                                       |
| `javascript_patterns.json` | [x] Done | XSS, SQLi, CMDi, path traversal, SSRF, prototype pollution, crypto                                                                                                              |
| `java_patterns.json`       | [x] Done | First-class JVM web sources/sinks, framework-aware injection, and high-signal candidate patterns                                                                                |
| `php_patterns.json`        | [x] Done | PHP plus Laravel/WordPress web sources, SQLi, CMDi, path traversal, XSS, SSRF, redirects, mass assignment, deserialization                                                      |
| `go_patterns.json`         | [x] Done | SQLi, CMDi, path traversal, SSRF, crypto, XSS                                                                                                                                   |
| `generic_patterns.json`    | [x] Done | Secrets, debug mode, TLS bypass, IaC                                                                                                                                            |
| `ruby_patterns.json`       | [x] Done | Rails/Rack sources, SQLi, CMDi, XSS, path traversal, SSRF, redirects, mass assignment, deserialization, crypto                                                                  |
| `csharp_patterns.json`     | [x] Done | ASP.NET sources, SQLi, CMDi, path traversal, XSS, XXE, deserialization, SSRF, redirects, auth/configuration, crypto                                                             |
| `c_patterns.json`          | [x] Done | Buffer overflow (gets/strcpy/sprintf/scanf %s), format string, integer overflow in alloc, use-after-free, null pointer, TOCTOU, dangerous functions — 7 categories, 35 patterns |
| `rust_patterns.json`       | [x] Done | Actix/Axum/Warp/Rocket web sources and SQL, command, URL, path, redirect, template, deserialization, header, numeric, and unsafe/FFI risks                                      |
| `kotlin_patterns.json`     | [x] Done | SQLi (string templates), CMDi, path traversal, deserialization, crypto, Android-specific (WebView/MODE_WORLD/LogCat), SSRF — 7 categories, 33 patterns                          |
| `swift_patterns.json`      | [x] Done | SQLite exec, CMDi (Process/NSTask), path traversal, Keychain misuse, ATS bypass, CommonCrypto weak algos, WebView, deep link — 8 categories, 26 patterns                        |
| `bash_patterns.json`       | [x] Done | eval injection, unquoted expansion, PATH injection, curl-pipe-bash RCE, info disclosure (set -x), temp file TOCTOU, hardcoded secrets — 7 categories, 30 patterns               |
| `yaml_patterns.json`       | [x] Done | K8s privileged/RBAC/network, GitHub Actions injection, GitLab CI, Docker Compose — 6 categories, 56 patterns                                                                    |

---

## Script Completeness (scripts/)

### scan.py

- [x] File enumeration + SQLite state management
- [x] Pattern-match sweep across all language files
- [x] `--status-only`, `--update-findings` commands
- [x] **`--resume` flag** — skips already-scanned files using SQLite state
- [x] **IaC-specific pass** — `enumerate_iac_files()` dedicated enumeration for Dockerfile, `*.tf`, GitHub Actions, GitLab CI, Docker Compose, K8s manifests
- [x] **`--min-severity` flag** — accepted in argparse (severity filtering in report.py)
- [ ] Severity-based filtering applied at sweep time (currently filtering happens at report stage)

### taint.py

- [x] Python AST-based taint analysis (proper source/sink/variable tracking within functions)
- [x] **JS/PHP variable-assignment taint** — `analyze_with_variable_tracking()` parses `const/let/var name = req.*` and `$var = $_REQUEST[*]` assignments, tracks tainted_vars dict, propagates taint through assignments
- [x] **Go pattern-based source/sink** — `GO_SOURCES` (Gin, stdlib, Chi, Echo, Fiber) + `GO_SINKS` (fmt.Sprintf SQLi, exec.Command CMDi, http.Get SSRF, os.Open path traversal)
- [x] **Java variable-aware taint** — Spring/Jakarta/Servlet/JAX-RS request sources and JVM SQL, command, file, HTTP, expression, XML, LDAP/XPath, deserialization, and response sinks
- [x] **Kotlin variable-aware taint** — Spring/Ktor sources, SQL, command, file, SSRF, redirect, XSS, deserialization, XML, and context-specific sanitizers
- [x] **C# variable-aware taint** — ASP.NET binding sources through ADO.NET/Dapper, process, file, HTTP, Razor, redirect, XML, and deserialization sinks
- [x] **Rust variable-aware taint** — Actix/Axum/Warp/Rocket extractors through SQLx/Diesel, process, HTTP, file, template, redirect, and serde sinks
- [x] **Taint state semantics** — clean reassignment kills stale taint, copies preserve it, sanitizer effects remain sink-specific, and function/method scopes do not leak
- [ ] **JavaScript AST taint** — true interprocedural call graph tracking
- [ ] **Cross-file interprocedural taint** — follow tainted variable into functions defined in other files

### secrets.py

- [x] Shannon entropy scoring
- [x] **45+ named credential patterns** — AWS, GitHub, Stripe, Slack, OpenAI, Azure Storage/Client Secret, GCP service account, Twilio, Heroku, npm, Docker Hub, Vault, Databricks, Vercel, SendGrid, PagerDuty, SSH/EC private keys, JWT tokens
- [x] False positive filtering (placeholder detection)
- [x] **`--git-history` flag** — scans git log -p diff output for secrets in committed code, deduplicates by (commit, file, line, type), attaches commit metadata

### dependency.py

- [x] Python (requirements.txt, Pipfile, pyproject.toml), JavaScript (package.json plus Yarn/pnpm locks), Java (pom.xml), Go (go.mod), Ruby (Gemfile.lock), PHP (composer.json)
- [x] **`Cargo.toml`** — Rust dependency parsing + RustSec CVEs
- [x] **`.csproj` / `packages.config`** — C#/.NET NuGet dependency parsing
- [x] **`build.gradle` / `build.gradle.kts`** — Gradle dependency block parsing (Groovy + Kotlin DSL)
- [x] **Maven/Gradle effective metadata** — POM properties and same-POM dependency management, full OSV coordinates, Gradle properties/version catalogs/locks
- [x] **Modern lock and central metadata** — pnpm v9, Yarn Classic/Berry, exact Pipfile entries, and namespaced `Directory.Packages.props` property resolution
- [x] **`pyproject.toml`** — PEP 517/518 + Poetry dependency parsing
- [x] **CVE database expanded to 100+ entries** — Python, JavaScript, Java, Go, Ruby, PHP, Rust, .NET coverage

### report.py

- [x] Markdown, JSON schema 2.0, SARIF v2.1.0 output
- [x] Canonical finding contract: stable ID, name, severity, exploitability, CVSS score/vector, OWASP, CWE, description, impact, assets, locations, confidence/status, evidence/taint path, prerequisites, remediation, and references
- [x] Backward-compatible rendering for legacy findings with explicit `Not assessed` fallbacks
- [x] Automatic final Markdown/HTML/JSON/SARIF generation after every completed review, including a validated empty findings set
- [x] Primary `<target>/Vulnscan_results.md` generated on every completed scan, including zero-finding reports
- [x] Severity grouping, taint path display, remediation checklist
- [x] **HTML report format** — standalone HTML with inline CSS, dark mode, ASCII bar chart, collapsible `<details>/<summary>` sections, severity badge color coding, taint path numbered list
- [ ] **CSV export** — for importing into Jira, Linear, GitHub Issues
- [ ] **GitHub Issues creation** — optional `--create-issues` flag using `gh` CLI

### regex_analyzer.py

- [x] **New script** — ReDoS detection: nested quantifier analysis, alternation common-prefix detection, complexity estimation (catastrophic/exponential/polynomial/linear), severity classification, remediation guidance

---

## Sub-Skills (sub-skills/)

| File                                  | Status                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan-strategy.md`                    | [x] Done                                                                                                                                                |
| `taint-analyzer.md`                   | [x] Done                                                                                                                                                |
| `input-validator.md`                  | [x] Done                                                                                                                                                |
| `business-logic-analyzer.md`          | [x] Done                                                                                                                                                |
| `api-security-reviewer.md`            | [x] Done                                                                                                                                                |
| `auth-reviewer.md`                    | [x] Done                                                                                                                                                |
| `crypto-reviewer.md`                  | [x] Done                                                                                                                                                |
| `secret-detector.md`                  | [x] Done                                                                                                                                                |
| `config-security-reviewer.md`         | [x] Done                                                                                                                                                |
| `iac-security-reviewer.md`            | [x] Done                                                                                                                                                |
| `memory-safety-analyzer.md`           | [x] Done                                                                                                                                                |
| `error-handling-reviewer.md`          | [x] Done                                                                                                                                                |
| `dependency-auditor.md`               | [x] Done                                                                                                                                                |
| `vuln-classifier.md`                  | [x] Done                                                                                                                                                |
| `false-positive-filter.md`            | [x] Done                                                                                                                                                |
| `report-generator.md`                 | [x] Done                                                                                                                                                |
| `regex-analyzer.md`                   | [x] Done — ReDoS detection, catastrophic backtracking, complexity estimation, remediation guidance                                                      |
| `graphql-security-reviewer.md`        | [x] Done — introspection, depth/complexity limits, batching abuse, field-level auth, N+1, subscription auth, SSRF via stitching, type confusion         |
| `mobile-security-reviewer.md`         | [x] Done — Android: WebView, exported components, allowBackup, insecure TrustManager; iOS: Keychain, ATS, UIWebView, URL scheme hijacking, cert pinning |
| `java-security-reviewer.md`           | [x] Done — Java/JVM framework routing, trust boundaries, framework protections, and manual exploitability checks                                        |
| `react-security-reviewer.md`          | [x] Done — React/Next.js/browser security                                                                                                               |
| `go-security-reviewer.md`             | [x] Done — Go HTTP/gRPC/service security                                                                                                                |
| `php-security-reviewer.md`            | [x] Done — Laravel, Symfony, WordPress, Drupal, Yii, CodeIgniter, and custom PHP                                                                        |
| `ruby-security-reviewer.md`           | [x] Done — Rails, Sinatra/Rack, and Hanami                                                                                                              |
| `dotnet-security-reviewer.md`         | [x] Done — ASP.NET Core, MVC, minimal APIs, Razor/Blazor, EF Core, and Dapper                                                                           |
| `rust-security-reviewer.md`           | [x] Done — Actix-web, Axum, Warp, Rocket, SQLx, and Diesel                                                                                              |
| `application-vuln-reviewer.md`        | [x] Done — application authorization, workflow, upload, and abuse cases                                                                                 |
| `architecture-security-reviewer.md`   | [x] Done — trust boundaries, tenant isolation, workers, connectors, and service privileges                                                              |
| `infrastructure-security-reviewer.md` | [x] Done — cloud, runtime, network, storage, IAM, and supply-chain posture                                                                              |

---

## Resource Files (resources/)

| File                                           | Status                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `resources/references/owasp-top10.md`          | [x] Done                                                            |
| `resources/references/false-positive-guide.md` | [x] Done                                                            |
| `resources/references/cwe-taxonomy.md`         | [x] Done — 29 CWE entries with ID, name, CVSS range, OWASP category |
| `resources/report-templates/sarif_schema.json` | [ ] Not started                                                     |

---

## Tests (tests/)

- [x] **`tests/test_scripts.py`** — unit tests: TestEntropy (8), TestLanguageDetection (7), TestPatternMatching (6), TestTaintAnalysis (4), TestDependencyParsing (7), TestCVEDetection (3), TestRegexAnalyzer (3)
- [x] **`tests/fixtures/vuln_python.py`** — Flask app: SQLi (f-string), CMDi (shell=True), path traversal, pickle deserialization, hardcoded secrets
- [x] **`tests/fixtures/vuln_javascript.js`** — Express app: SQLi (template literal), CMDi (exec), XSS (innerHTML), path traversal, hardcoded secrets
- [x] **`tests/fixtures/vuln_go.go`** — Go HTTP handlers: SQLi (fmt.Sprintf), CMDi (exec.Command bash -c), hardcoded password
- [x] **Java regression corpus** — 12 vulnerable and 11 safe Java cases plus Maven/Gradle, framework-routing, and mitigation gates
- [x] **Polyglot web regression corpus** — vulnerable and safe Kotlin, PHP, Ruby, C#, and Rust web fixtures with framework routing and source-to-sink checks
- [x] **Modern dependency regression corpus** — pnpm v9, Yarn Classic/Berry, Pipfile, Maven/Gradle metadata, and NuGet central-package properties
- [x] **CI workflow** — least-privilege, commit-pinned Actions compile analyzers, run tests, enforce the reviewed benchmark baseline, and package tagged releases
- [x] **Report contract regression coverage** — all required fields across Markdown/HTML/JSON/SARIF, legacy findings, database migration, nearest-route metadata, automatic completion, and zero-finding artifacts

---

## Documentation

- [x] **`CONTRIBUTING.md`** — how to add language patterns, sub-skills, CVEs, IDE targets
- [x] **`SECURITY.md`** — responsible disclosure policy, scope, response times
- [x] **Update `README.md`** — corrected IDE install paths, polyglot web capabilities, 29 sub-skills, canonical reports, checksummed packages, and git history scan
- [x] **`docs/architecture.md`** — architecture diagram, language routing, state/report lifecycle, correctness boundaries, and extension points

---

## Priority Order

### P0 — DONE ✓

1. ~~`ruby_patterns.json`~~ — done
2. ~~`csharp_patterns.json`~~ — done
3. ~~`c_patterns.json`~~ — done
4. ~~`rust_patterns.json`~~ — done
5. ~~`kotlin_patterns.json`~~ — done
6. ~~`swift_patterns.json`~~ — done
7. ~~`bash_patterns.json`~~ — done
8. ~~`yaml_patterns.json`~~ — done
9. ~~`dependency.py` Cargo.toml/.csproj/build.gradle parsing~~ — done
10. ~~`scan.py` IaC pass + `--resume` flag~~ — done
11. ~~`regex_analyzer.py`~~ — done

### P1 — DONE ✓

12. ~~`regex-analyzer.md` sub-skill~~ — done
13. ~~`resources/references/cwe-taxonomy.md`~~ — done
14. ~~CVE database expansion (60 → 100+ CVEs)~~ — done
15. ~~JavaScript / Go / PHP improved taint analysis in `taint.py`~~ — done (variable tracking)
16. ~~`graphql-security-reviewer.md`~~ — done
17. ~~Git history secret scanning in `secrets.py`~~ — done
18. ~~HTML report format in `report.py`~~ — done
19. ~~`tests/` with fixtures~~ — done
20. ~~`CONTRIBUTING.md` + `SECURITY.md`~~ — done
21. ~~Update `README.md`~~ — done

### P2 — DONE ✓

22. ~~`docs/architecture.md` — architecture diagram and workflow explanation~~ — done
23. ~~`.github/workflows/ci.yml` — compile, pytest, tagged packaging, and release publishing~~ — done

### P3 — Nice to have

24. ~~`install.ps1.sha256`~~ — done
25. Aider / Zed install targets
26. CSV export + GitHub Issues creation in `report.py`
27. `resources/report-templates/sarif_schema.json`
28. Severity filtering at sweep time in `scan.py` (currently post-scan)
29. True AST-based JS interprocedural taint analysis
