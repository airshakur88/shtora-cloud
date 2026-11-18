# Code-VulnScan Skill

A deep, flow-aware vulnerability scanning skill for AI coding assistants. Finds real, exploitable vulnerabilities — not just keyword matches.

[![Supported IDEs](https://img.shields.io/badge/IDEs-Claude%20%7C%20Codex%20%7C%20Cursor%20%7C%20Windsurf%20%7C%20Copilot%20%7C%20Cline%20%7C%20Continue%20%7C%20Antigravity-blue)]()
[![Languages](https://img.shields.io/badge/Languages-10%2B-green)]()
[![CVEs](https://img.shields.io/badge/CVE%20Database-100%2B-orange)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What it does

- **Taint-flow analysis** — traces user input from sources to dangerous sinks (Python AST plus variable-aware JS/TS, PHP, Ruby, Go, Java, Kotlin, C#, and Rust analyzers)
- **Java/Kotlin JVM application security** — Spring, Ktor, Jakarta EE/Servlet/JAX-RS, Hibernate/JPA, Struts, Micronaut, and Quarkus entry points; JVM injection, expression-language, deserialization, XML, auth, Actuator/admin, and archive/file risks
- **PHP web application security** — Laravel, Symfony, WordPress, Drupal, Yii, and custom PHP authorization, binding, ORM/template, SSRF, upload/archive, deserialization, and worker risks
- **Ruby web application security** — Rails, Sinatra/Rack, and Hanami callback/policy, strong-parameter, ORM/template, URL/file, session, and job risks
- **.NET web application security** — ASP.NET Core/MVC/minimal APIs/Blazor, EF Core/Dapper, endpoint authorization, overposting, Razor output, parsers, files, and hosted services
- **Rust web service security** — Actix-web, Axum, Warp, and Rocket extractors, SQL/process/HTTP/file sinks, serde/async limits, and unsafe boundaries
- **React/Next.js security** — DOM XSS, open redirects, token storage, postMessage, hydration leaks, client-only auth
- **Go service security** — request binding, SQL/command/SSRF/file sinks, templates, HTTP hardening, concurrency races
- **Architecture security** — trust boundaries, tenant isolation, async workers, confused deputy paths, service privileges
- **Infrastructure security** — cloud IAM, network exposure, storage, KMS/secrets, runtime posture, CI/CD trust
- **Application-layer vulns** — account recovery, CSRF, uploads, cache leaks, workflow abuse, rate limits
- **Input validation review** — checks allowlists, regex anchoring, encoding bypasses, type juggling
- **Business logic analysis** — race conditions, TOCTOU, state machine bypasses, price manipulation
- **API security** — IDOR/BOLA, mass assignment, rate limiting gaps, GraphQL depth/complexity attacks
- **Auth & session review** — auth bypass, IDOR, JWT flaws, session fixation, privilege escalation
- **Cryptography review** — weak algorithms, ECB mode, insecure RNG, hardcoded keys
- **Secret detection** — entropy-based scanning + 45+ pattern rules for API keys, passwords, private keys; optional git history scan
- **Configuration audit** — debug mode, security headers, CORS, CSP, TLS misconfigurations
- **IaC security** — Dockerfile, Kubernetes, Terraform, GitHub Actions, GitLab CI, Docker Compose
- **Memory safety** — buffer overflows, use-after-free, format strings (C/C++/unsafe Rust)
- **ReDoS detection** — catastrophic backtracking analysis: nested quantifiers, alternation prefix overlap, complexity estimation
- **GraphQL security** — introspection exposure, depth/complexity limits, batching abuse, field-level auth gaps
- **Mobile security** — Android WebView/exported components, iOS ATS/Keychain/UIWebView, deep link hijacking
- **Error handling review** — stack trace leaks, enumeration oracles, sensitive data in logs
- **Dependency CVEs** — checks Maven/Gradle (including properties, version catalogs, and locks), pnpm/Yarn, Pipenv, NuGet central packages, and other ecosystem manifests against 100+ known-vulnerable version ranges

**False positives are reduced** through a three-pass verification protocol: source reachability → path completeness → exploitability context.

## Supported Languages

Python, JavaScript/TypeScript, Java/Kotlin, Go, PHP, Ruby, C/C++, C#, Rust, Swift, Bash — plus infrastructure files (Dockerfile, Kubernetes YAML, Terraform HCL, GitHub Actions, GitLab CI, Docker Compose).

## IDE Compatibility

| IDE                                 | Target flag            | Installed file                                |
| ----------------------------------- | ---------------------- | --------------------------------------------- |
| Claude Code (CLI/Desktop)           | `--target claude`      | `~/.claude/skills/code-vulnscan/`             |
| Claude Code / Cowork (project/team) | `--target cowork`      | `<project>/.claude/skills/code-vulnscan/`     |
| OpenAI Codex                        | `--target codex`       | `~/.codex/skills/code-vulnscan/`              |
| Cursor AI                           | `--target cursor`      | `<project>/.cursor/rules/code-vulnscan.mdc`   |
| Windsurf                            | `--target windsurf`    | `<project>/.windsurf/rules/code-vulnscan.md`  |
| GitHub Copilot Chat                 | `--target copilot`     | `<project>/.github/copilot-instructions.md`   |
| Cline (VS Code)                     | `--target cline`       | `<project>/.clinerules`                       |
| Continue.dev                        | `--target continue`    | `<project>/.continue/prompts/vulnscan.prompt` |
| Antigravity                         | `--target antigravity` | `<project>/.agent/skills/code-vulnscan/`      |

## Installation

All `--online` commands below download the latest release package automatically.
Release packages are verified against their published SHA-256 asset before extraction; a missing or mismatched package checksum fails closed.

### Quick install (no cloning required)

**Linux / macOS:**

```bash
# Default: installs to every target at once
curl -fsSL https://raw.githubusercontent.com/Bhanunamikaze/Code-VulnScan-Skill/main/install.sh | bash -s -- --online

# Claude Code only
curl -fsSL https://raw.githubusercontent.com/Bhanunamikaze/Code-VulnScan-Skill/main/install.sh | bash -s -- --online --target claude

# User-wide (Claude + Codex)
curl -fsSL https://raw.githubusercontent.com/Bhanunamikaze/Code-VulnScan-Skill/main/install.sh | bash -s -- --online --target global

# Every target, scoped to a project
curl -fsSL https://raw.githubusercontent.com/Bhanunamikaze/Code-VulnScan-Skill/main/install.sh | bash -s -- --online --target all --project-dir /path/to/your/project
```

**Windows (PowerShell):**

```powershell
# Download installer and checksum, verify, then run with --online
irm https://raw.githubusercontent.com/Bhanunamikaze/Code-VulnScan-Skill/main/install.ps1 -OutFile install.ps1
irm https://raw.githubusercontent.com/Bhanunamikaze/Code-VulnScan-Skill/main/install.ps1.sha256 -OutFile install.ps1.sha256
$expected = (Get-Content .\install.ps1.sha256).Split()[0]
$actual = (Get-FileHash .\install.ps1 -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "install.ps1 checksum mismatch" }

# Default: installs to every target at once
powershell -ExecutionPolicy Bypass -File .\install.ps1 --online

# Claude Code only
powershell -ExecutionPolicy Bypass -File .\install.ps1 --online --target claude

# Every target, scoped to a project
powershell -ExecutionPolicy Bypass -File .\install.ps1 --online --target all --project-dir C:\path\to\your\project

```

### From source

```bash
git clone https://github.com/Bhanunamikaze/Code-VulnScan-Skill.git
cd Code-VulnScan-Skill

# Claude Code (most common)
bash install.sh --target claude

# Codex
bash install.sh --target codex

# Claude Cowork / project-scoped (installs to .claude/skills/, commit to git to share with team)
bash install.sh --target cowork --project-dir /path/to/your/project

# GitHub Copilot Chat (writes .github/copilot-instructions.md)
bash install.sh --target copilot --project-dir /path/to/your/project

# Cursor AI (writes .cursor/rules/code-vulnscan.mdc)
bash install.sh --target cursor --project-dir /path/to/your/project

# Windsurf (writes .windsurf/rules/code-vulnscan.md)
bash install.sh --target windsurf --project-dir /path/to/your/project

# Cline VS Code extension (appends to .clinerules)
bash install.sh --target cline --project-dir /path/to/your/project

# Continue.dev (writes .continue/prompts/vulnscan.prompt)
bash install.sh --target continue --project-dir /path/to/your/project

# User-wide (Claude + Codex)
bash install.sh --target global

# All project-local IDEs at once
bash install.sh --target project --project-dir /path/to/your/project

# Every target at once
bash install.sh --target all --project-dir /path/to/your/project

# With Python deps for local scripts
bash install.sh --target claude --install-deps
```

**Windows (PowerShell) — from source:**

```powershell
# Claude Code
.\install.ps1 --target claude

# Cursor AI
.\install.ps1 --target cursor --project-dir C:\path\to\project

# All targets
.\install.ps1 --target all --project-dir C:\path\to\project
```

**Safer remote install (with checksum verification):**

```bash
curl -fsSLO https://raw.githubusercontent.com/Bhanunamikaze/Code-VulnScan-Skill/main/install.sh
curl -fsSLO https://raw.githubusercontent.com/Bhanunamikaze/Code-VulnScan-Skill/main/install.sh.sha256
sha256sum -c install.sh.sha256
bash install.sh --online
```

## Usage

After installing, restart your agent session, then:

```
vulnscan scan /path/to/codebase
```

Or naturally:

```
Find security vulnerabilities in this codebase
Scan for SQL injection and XSS in this Flask app
Review this Spring Boot service for Java/JVM vulnerabilities
Review this Ktor service for Kotlin/JVM vulnerabilities
Review this ASP.NET Core API for authorization and injection flaws
Review this Laravel or Rails application for framework-specific vulnerabilities
Review this Axum service for extractor, SQL, SSRF, and process-execution flaws
Check for hardcoded secrets
Audit the authentication logic
Are there any vulnerable dependencies?
Give me a full security report in SARIF format
Give me an HTML security report
Check the Kubernetes configs for misconfigurations
Find IDOR vulnerabilities in the API
Analyze GraphQL schema for security issues
Check for ReDoS vulnerabilities in the regex patterns
Scan git history for committed secrets
Review iOS and Android code for insecure storage
```

## Output formats

- **Markdown** — human-readable report with taint paths, code snippets, remediation
- **HTML** — standalone report with dark mode, collapsible sections, severity badges, code blocks
- **SARIF** — integrates with GitHub Advanced Security, VS Code Security extensions, CI/CD
- **JSON** — machine-readable for custom tooling

Every completed review generates all four formats automatically, even when the
validated finding set is empty. The primary human-readable report is also
written to `<scanned-project>/Vulnscan_results.md`; structured artifacts are
saved as `workspace/report_<run_id>.<ext>` plus
`workspace/confirmed_findings.json`.

Every vulnerability includes Vulnerability Name, Severity, Exploitability,
CVSS Score and Vector, OWASP Category, Vulnerability Description, Impact,
Affected Assets, and Remediation Guidelines. Reports also retain a stable
finding ID, CWE, confidence and validation status, exact locations, masked
evidence/taint flow, attack prerequisites, and references.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the scan flow, component boundaries, language routing, state model, and extension points.

```
Code-VulnScan-Skill/
├── SKILL.md                          # Main skill orchestration (read by agent)
├── CONTRIBUTING.md                   # How to add patterns, sub-skills, CVEs
├── SECURITY.md                       # Responsible disclosure policy
├── install.sh                        # Multi-IDE installer (Linux/macOS)
├── install.ps1                       # Multi-IDE installer (Windows/PowerShell)
├── sub-skills/                       # Specialized security reviewers
│   ├── scan-strategy.md
│   ├── taint-analyzer.md
│   ├── input-validator.md
│   ├── business-logic-analyzer.md
│   ├── application-vuln-reviewer.md
│   ├── api-security-reviewer.md
│   ├── react-security-reviewer.md
│   ├── go-security-reviewer.md
│   ├── java-security-reviewer.md
│   ├── php-security-reviewer.md
│   ├── ruby-security-reviewer.md
│   ├── dotnet-security-reviewer.md
│   ├── rust-security-reviewer.md
│   ├── architecture-security-reviewer.md
│   ├── infrastructure-security-reviewer.md
│   ├── auth-reviewer.md
│   ├── crypto-reviewer.md
│   ├── secret-detector.md
│   ├── config-security-reviewer.md
│   ├── iac-security-reviewer.md
│   ├── memory-safety-analyzer.md
│   ├── error-handling-reviewer.md
│   ├── dependency-auditor.md
│   ├── vuln-classifier.md
│   ├── false-positive-filter.md
│   ├── report-generator.md
│   ├── regex-analyzer.md             # ReDoS / catastrophic backtracking
│   ├── graphql-security-reviewer.md  # GraphQL-specific attack surface
│   └── mobile-security-reviewer.md  # iOS / Android security
├── scripts/                          # Deterministic Python helpers
│   ├── scan.py                       # Main orchestrator + SQLite state + IaC pass
│   ├── taint.py                      # Taint dispatcher + shared Python/JS/TS/PHP/Ruby analysis
│   ├── taint_java.py                 # Java/JVM request-to-sink taint tracking
│   ├── taint_kotlin.py               # Kotlin/Spring/Ktor request-to-sink tracking
│   ├── taint_csharp.py                # ASP.NET/.NET request-to-sink tracking
│   ├── taint_rust.py                  # Rust web extractor-to-sink tracking
│   ├── taint_go.py                   # Go request-to-sink taint tracking
│   ├── secrets.py                    # Entropy + 45+ pattern rules + git history scan
│   ├── dependency.py                 # Dependency CVE checker, including Maven/Gradle resolution metadata
│   ├── report.py                     # Report generator (MD/HTML/JSON/SARIF)
│   ├── regex_analyzer.py             # ReDoS complexity estimator
│   └── utils/
│       ├── db.py                     # SQLite state management
│       ├── languages.py              # Language/framework detection
│       ├── files.py                  # File enumeration
│       ├── patterns.py               # Pattern matching engine
│       └── entropy.py                # Shannon entropy for secret detection
├── resources/
│   ├── patterns/                     # Per-language source/sink patterns (14 files)
│   │   ├── python_patterns.json
│   │   ├── javascript_patterns.json
│   │   ├── java_patterns.json
│   │   ├── php_patterns.json
│   │   ├── go_patterns.json
│   │   ├── ruby_patterns.json
│   │   ├── csharp_patterns.json
│   │   ├── c_patterns.json
│   │   ├── rust_patterns.json
│   │   ├── kotlin_patterns.json
│   │   ├── swift_patterns.json
│   │   ├── bash_patterns.json
│   │   ├── yaml_patterns.json
│   │   └── generic_patterns.json
│   └── references/
│       ├── owasp-top10.md
│       ├── cwe-taxonomy.md           # 29 CWE entries with CVSS ranges and OWASP mapping
│       └── false-positive-guide.md
├── tests/
│   ├── test_scripts.py               # Unit tests (pytest)
│   ├── test_java_*.py                # JVM taint, routing, dependency, and FP regressions
│   ├── benchmark/                    # Labeled vulnerable and safe corpus
│   └── fixtures/                     # Intentionally vulnerable code samples
│       ├── vuln_python.py
│       ├── vuln_javascript.js
│       └── vuln_go.go
└── workspace/                        # Scan state, intermediate outputs, reports
```

## How findings are verified

Every candidate finding passes three mandatory verification passes before being reported:

1. **Source reachability** — Is the input genuinely user-controlled? (Not hardcoded, not trusted-only)
2. **Path completeness** — Does the tainted value actually reach the sink with no effective sanitization?
3. **Exploitability context** — Can an attacker realistically trigger this in context?

Only **Confirmed** and **Likely** findings appear in the final report.

## Running the scripts locally

```bash
pip install -r requirements.txt

# Scan a codebase for secrets
python3 scripts/secrets.py --path /path/to/repo --pretty

# Scan git history for committed secrets
python3 scripts/secrets.py --path /path/to/repo --git-history --max-commits 500

# Check dependencies for CVEs
python3 scripts/dependency.py --path /path/to/repo --pretty

# Detect ReDoS in a codebase
python3 scripts/regex_analyzer.py --path /path/to/repo --pretty

# Run all tests
python3 -m pytest tests/ -v
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add language patterns, sub-skills, CVEs, and IDE install targets.

## Security

See [SECURITY.md](SECURITY.md) for the responsible disclosure policy.
