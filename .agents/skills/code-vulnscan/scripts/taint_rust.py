#!/usr/bin/env python3
"""Evidence-oriented taint analysis for Rust web services.

The analyzer is intentionally lightweight. It tracks framework extractors and
request-derived variables through ordinary ``let`` assignments, then requires
the same variable to reach a security-sensitive sink. Broad API presence alone
is not reported as a taint path.
"""

from __future__ import annotations

import re
from pathlib import Path


RUST_SOURCES = {
    "actix_web": [
        r"\bweb::(?:Query|Path|Json|Form)\s*<",
        r"\bweb::(?:Bytes|Payload)\b",
        r"\.query_string\s*\(\s*\)",
        r"\.match_info\s*\(\s*\)",
        r"\.headers\s*\(\s*\)",
        r"\.cookie\s*\(",
    ],
    "axum": [
        r"\baxum::extract::(?:Query|Path|Json|Form|Multipart|RawQuery)\s*<",
        r"\bRequest\s*<\s*Body\s*>",
        r"\bHeaderMap\b",
        r"\bBytes\b",
    ],
    "warp": [
        r"\bwarp::query(?:::\s*<[^>]+>)?\s*\(",
        r"\bwarp::path::param(?:::\s*<[^>]+>)?\s*\(",
        r"\bwarp::body::(?:json|bytes|form|aggregate|stream)\s*\(",
        r"\bwarp::header(?:::\s*<[^>]+>)?\s*\(",
        r"\bwarp::cookie(?:::\s*<[^>]+>)?\s*\(",
    ],
    "rocket": [
        r"\brocket::serde::json::Json\s*<",
        r"\brocket::form::Form\s*<",
        r"\b(?:Data|TempFile)\s*<'[^>]*>",
    ],
    "generic": [
        r"\bstd::env::(?:args|var|var_os)\s*\(",
        r"\bstd::io::stdin\s*\(",
    ],
}


RUST_SINKS = {
    "sqli": [
        (r"\bsqlx::(?:query|query_as|query_scalar|raw_sql)\s*\(", "SQLx dynamic query"),
        (r"\bdiesel::sql_query\s*\(", "Diesel raw SQL query"),
        (r"\b(?:client|conn|connection|pool)\.(?:query|query_one|query_opt|execute|batch_execute)\s*\(", "Database query execution"),
    ],
    "cmdi": [
        (r"\b(?:std::process::)?Command::new\s*\(", "std::process::Command"),
        (r"\.args?\s*\(", "Command argument"),
        (r"\bduct::cmd\s*\(", "duct command execution"),
    ],
    "ssrf": [
        (r"\breqwest::(?:get|Client::new)\s*\(", "reqwest outbound request"),
        (r"\b(?:client|http_client)\.(?:get|post|put|patch|delete|request|execute)\s*\(", "HTTP client request"),
        (r"\b(?:http|hyper)::Request::builder\s*\(\)", "Hyper/HTTP request builder"),
        (r"\.uri\s*\(", "HTTP request URI"),
        (r"\b(?:hyper::)?Uri::(?:from_str|try_from)\s*\(", "Hyper URI construction"),
    ],
    "path_traversal": [
        (r"\b(?:tokio::)?fs::(?:read|read_to_string|write|copy|rename|remove_file|remove_dir_all|create_dir|create_dir_all|metadata)\s*\(", "Filesystem operation"),
        (r"\b(?:std::fs::)?File::(?:open|create|options)\s*\(", "File open/create"),
        (r"\bNamedFile::open(?:_async)?\s*\(", "Actix NamedFile open"),
    ],
    "open_redirect": [
        (r"\bRedirect::(?:to|temporary|permanent|found)\s*\(", "Framework redirect"),
        (r"\bHttpResponse::(?:Found|TemporaryRedirect|PermanentRedirect)\s*\(\)", "Actix redirect response"),
    ],
    "header_injection": [
        (r"\bHeaderValue::(?:from_bytes_unchecked|from_maybe_shared_unchecked)\s*\(", "Unchecked response header value"),
    ],
    "xss": [
        (r"\b(?:axum::response::)?Html\s*\(", "Axum raw HTML response"),
        (r"\b(?:content::)?RawHtml\s*\(", "Rocket raw HTML response"),
        (r"\b(?:Markup|PreEscaped)::(?:new_unchecked|from|new)\s*\(", "Explicit unescaped markup"),
        (r"\bHttpResponse::\w+\s*\(\).*\.content_type\s*\(\s*[\"']text/html", "Actix HTML response body"),
    ],
    "ssti": [
        (r"\bTera::one_off\s*\(", "Tera dynamic template"),
        (r"\.(?:add_raw_template|register_template_string|add_template|render_str)\s*\(", "Runtime template compilation"),
    ],
    "deserialization": [
        (r"\bbincode::(?:deserialize|decode_from_slice)\s*\(", "Bincode deserialization"),
        (r"\bbincode::options\s*\(\s*\).*\.deserialize\s*\(", "Configured Bincode deserialization"),
        (r"\.deserialize_from\s*\(", "Bincode stream deserialization"),
        (r"\brmp_serde::from_(?:slice|read)\s*\(", "MessagePack deserialization"),
        (r"\bpostcard::from_bytes\s*\(", "Postcard deserialization"),
        (r"\bserde_yaml::from_(?:str|slice|reader)\s*\(", "YAML deserialization"),
        (r"\bron::from_str\s*\(", "RON deserialization"),
    ],
}


_EXTRACTOR_PARAMETER_RE = re.compile(
    r"(?:(?P<destruct>"
    r"(?:actix_web::web::|web::|axum::extract::|rocket::serde::json::|rocket::form::)?"
    r"(?:Query|Path|Json|Form|RawQuery|Multipart|TypedHeader)"
    r")\s*\(\s*(?:mut\s+)?(?P<destruct_var>[A-Za-z_]\w*)\s*\)\s*:\s*[^,){]+"
    r"|(?P<named_var>[A-Za-z_]\w*)\s*:\s*(?P<named>"
    r"(?:actix_web::web::|web::|axum::extract::|rocket::serde::json::|rocket::form::)?"
    r"(?:Query|Path|Json|Form|RawQuery|Multipart)\s*<"
    r"|(?:actix_web::web::|web::)?(?:Bytes|Payload)\b"
    r"|HttpRequest\b|HeaderMap\b|Request\s*<\s*Body\s*>|Data\s*<'[^>]*>|TempFile\s*<'[^>]*>"
    r"))",
    re.MULTILINE,
)

_LET_RE = re.compile(
    r"^\s*let\s+(?:mut\s+)?(?P<variable>[A-Za-z_]\w*)"
    r"(?:\s*:\s*[^=]+)?\s*=\s*(?P<rhs>.+)"
)

_ASSIGN_RE = re.compile(
    r"^\s*(?P<variable>[A-Za-z_]\w*)\s*=\s*(?P<rhs>[^=].*)"
)

_FUNCTION_START_RE = re.compile(
    r"^\s*(?:(?:pub(?:\([^)]*\))?|async|unsafe|const|extern\s+\"C\")\s+)*fn\s+[A-Za-z_]\w*"
)

_ROCKET_ROUTE_RE = re.compile(
    r"#\[(?:get|post|put|delete|patch|head|options)\s*\(\s*[r#]*[\"'](?P<route>[^\"']+)",
    re.IGNORECASE,
)


def _source_type(text: str) -> str | None:
    for source_type, patterns in RUST_SOURCES.items():
        for pattern in patterns:
            if re.search(pattern, text):
                return source_type
    return None


def _code_without_literals(text: str) -> str:
    """Remove comments and literals before identifier matching."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"//.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"r(?P<hashes>#+)?\".*?\"(?P=hashes)", '""', text, flags=re.DOTALL)
    text = re.sub(r'b?"(?:\\.|[^"\\])*"', '""', text)
    return re.sub(r"b?'(?:\\.|[^'\\])'", "''", text)


def _var_in_code(variable: str, text: str) -> bool:
    """Match Rust variables, including captured ``format!(\"{name}\")`` args."""
    if re.search(rf"\{{\s*{re.escape(variable)}(?:\s*:[^}}]+)?\s*\}}", text):
        return True
    # Exclude method/path segments such as ``sqlx::query`` or
    # ``client.query`` when the request variable itself happens to be named
    # ``query``. A base expression like ``query.term`` still matches.
    return bool(re.search(
        rf"(?<![.:])\b{re.escape(variable)}\b", _code_without_literals(text)
    ))


def _statement(lines: list[str], index: int) -> tuple[int, int, str]:
    """Collect a bounded semicolon-delimited Rust statement/call chain."""
    start = index
    while start > 0 and index - start < 24:
        previous = lines[start - 1].rstrip()
        current = lines[start].lstrip()
        if ";" in previous or previous.endswith(("{", "}")):
            break
        if current.startswith((".", ")", ",")) or previous.endswith(("(", ",", ".", "=", "&", "+")):
            start -= 1
            continue
        if "let " in previous or "return " in previous:
            start -= 1
        break

    end = index
    paren_balance = 0
    for cursor in range(start, index + 1):
        paren_balance += lines[cursor].count("(") - lines[cursor].count(")")
    while end + 1 < len(lines) and end - index < 24:
        current = lines[end].rstrip()
        following = lines[end + 1].lstrip()
        if ";" in current and paren_balance <= 0:
            break
        if paren_balance > 0 or following.startswith((".", ")", ",")) or current.endswith(("(", ",", ".", "&", "+")):
            end += 1
            paren_balance += lines[end].count("(") - lines[end].count(")")
            continue
        break
    return start, end, " ".join(line.strip() for line in lines[start:end + 1])


def _sink_matches(statement: str) -> list[tuple[str, str, str]]:
    matches = []
    for sink_type, definitions in RUST_SINKS.items():
        for pattern, name in definitions:
            if re.search(pattern, statement, re.IGNORECASE):
                matches.append((sink_type, name, pattern))
    return matches


def _sanitized_types(rhs: str) -> set[str]:
    """Return sink classes neutralized by a value-producing sanitizer."""
    sanitized = set()
    if re.search(
        r"(?:html_escape::encode_(?:text|safe)|ammonia::clean|encode_double_quoted_attribute)\s*\(",
        rhs,
    ):
        sanitized.add("xss")
    return sanitized


def _extract_declared_sources(content: str, lines: list[str]) -> dict[int, list[dict]]:
    """Index framework extractor parameters and Rocket route parameters."""
    sources: dict[int, list[dict]] = {}

    rocket_context = bool(re.search(
        r"\brocket(?:::|\s*=)|#\[(?:get|post|put|delete|patch|head|options)\s*\(",
        content,
    ))
    for match in _EXTRACTOR_PARAMETER_RE.finditer(content):
        variable = match.group("destruct_var") or match.group("named_var")
        extractor = match.group("destruct") or match.group("named") or "request"
        line_number = content.count("\n", 0, match.start()) + 1
        framework = "rocket" if (
            "rocket" in extractor
            or extractor.startswith(("Data", "TempFile"))
            or (rocket_context and "web::" not in extractor and "axum::" not in extractor)
        ) else (
            "actix_web" if "web::" in extractor or extractor == "HttpRequest" else "axum"
        )
        sources.setdefault(line_number, []).append({
            "variable": variable,
            "source_line": line_number,
            "source_type": framework,
            "source_code": lines[line_number - 1].strip(),
        })

    # Rocket exposes plain function parameters named in route placeholders.
    for route_match in _ROCKET_ROUTE_RE.finditer(content):
        names = set(re.findall(r"<([A-Za-z_]\w*)>", route_match.group("route")))
        if not names:
            continue
        signature_start = content.find("fn ", route_match.end())
        if signature_start < 0 or signature_start - route_match.end() > 1200:
            continue
        brace = content.find("{", signature_start)
        if brace < 0:
            continue
        signature = content[signature_start:brace]
        for variable in names:
            parameter = re.search(rf"\b{re.escape(variable)}\s*:\s*[^,)]+", signature)
            if not parameter:
                continue
            absolute = signature_start + parameter.start()
            line_number = content.count("\n", 0, absolute) + 1
            sources.setdefault(line_number, []).append({
                "variable": variable,
                "source_line": line_number,
                "source_type": "rocket_route",
                "source_code": lines[line_number - 1].strip(),
            })

    # Warp passes extracted values into closures. Restrict closure inference to
    # a short window following a Warp filter source to avoid tainting arbitrary
    # iterator closures elsewhere in the file.
    warp_lines = [
        number for number, line in enumerate(lines, start=1)
        if _source_type(line) == "warp"
    ]
    for line_number, line in enumerate(lines, start=1):
        if not any(0 <= line_number - source_line <= 16 for source_line in warp_lines):
            continue
        closure = re.search(r"\|(?P<params>[^|]+)\|", line)
        if not closure:
            continue
        for raw_param in closure.group("params").split(","):
            variable_match = re.search(r"(?:mut\s+)?([A-Za-z_]\w*)", raw_param.strip())
            if not variable_match:
                continue
            variable = variable_match.group(1)
            sources.setdefault(line_number, []).append({
                "variable": variable,
                "source_line": line_number,
                "source_type": "warp",
                "source_code": line.strip(),
            })

    # Common Warp routes pass extracted values into a named handler rather
    # than an inline closure. Infer only request-like parameter names so
    # injected database/client/state filters are not marked as user input.
    named_handler_re = re.compile(
        r"warp::(?:query|path::param|body::(?:json|bytes|form)|header|cookie)"
        r"(?:(?!;).){0,1200}?\.(?:and_then|map)\s*\(\s*(?P<handler>[A-Za-z_]\w*)",
        re.DOTALL,
    )
    request_name_re = re.compile(
        r"^(?:params?|query|path|body|input|id|name|url|target|request|req|payload|form)$",
        re.IGNORECASE,
    )
    for handler_match in named_handler_re.finditer(content):
        handler = handler_match.group("handler")
        signature_match = re.search(
            rf"\bfn\s+{re.escape(handler)}\s*\((?P<params>[^)]*)\)",
            content,
            re.DOTALL,
        )
        if not signature_match:
            continue
        for parameter in signature_match.group("params").split(","):
            variable_match = re.search(r"(?:mut\s+)?([A-Za-z_]\w*)\s*:", parameter)
            if not variable_match or not request_name_re.match(variable_match.group(1)):
                continue
            variable = variable_match.group(1)
            absolute = signature_match.start("params") + signature_match.group("params").find(parameter)
            line_number = content.count("\n", 0, absolute) + 1
            sources.setdefault(line_number, []).append({
                "variable": variable,
                "source_line": line_number,
                "source_type": "warp",
                "source_code": lines[line_number - 1].strip(),
            })

    return sources


def _window(lines: list[str], source_line: int, sink_line: int) -> str:
    start = max(0, source_line - 1)
    end = min(len(lines), sink_line + 4)
    return "\n".join(lines[start:end])


def _parameterized_sql(statement: str) -> bool:
    """Recognize fixed SQL text with bound values, not dynamic SQL structure."""
    sqlx_literal = re.search(
        r"sqlx::(?:query|query_as|query_scalar)\s*\(\s*(?:r#+)?\"",
        statement,
    )
    diesel_literal = re.search(r"diesel::sql_query\s*\(\s*(?:r#+)?\"", statement)
    postgres_literal = re.search(
        r"\.(?:query|query_one|query_opt|execute)\s*\(\s*(?:r#+)?\"",
        statement,
    )
    if sqlx_literal or diesel_literal:
        return bool(re.search(r"\.bind(?:\s*::\s*<[^>]+>)?\s*\(", statement))
    if postgres_literal:
        return bool(re.search(r"\&\s*\[", statement))
    return False


def _command_flow_is_safe(statement: str, variable: str, window: str) -> bool:
    executable_is_tainted = bool(re.search(
        rf"Command::new\s*\(\s*&?\s*{re.escape(variable)}\b", statement
    ))
    shell = bool(re.search(
        r"Command::new\s*\(\s*[\"'](?:sh|bash|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?)[\"']",
        statement,
        re.IGNORECASE,
    ))
    if executable_is_tainted or shell:
        return bool(re.search(
            rf"(?:ALLOWED_COMMANDS|allowed_commands)\.contains\s*\(\s*&?{re.escape(variable)}\b",
            window,
        ))
    # A fixed executable plus an explicit end-of-options marker prevents the
    # common attacker-controlled option interpretation class.
    return bool(re.search(r"\.arg\s*\(\s*[\"']--[\"']\s*\)", statement))


def _mitigated(
    lines: list[str],
    source_line: int,
    sink_line: int,
    sink_type: str,
    statement: str,
    variable: str,
) -> bool:
    window = _window(lines, source_line, sink_line)
    if sink_type == "sqli":
        return _parameterized_sql(statement)
    if sink_type == "cmdi":
        return _command_flow_is_safe(statement, variable, window)
    if sink_type == "ssrf":
        parsed = bool(re.search(r"\bUrl::parse\s*\(", window))
        scheme = bool(re.search(r"\.scheme\s*\(\).*https|https.*\.scheme\s*\(", window, re.DOTALL))
        host = bool(re.search(
            r"(?:ALLOWED_(?:HOSTS|DESTINATIONS)|allowed_(?:hosts|destinations))"
            r"\.contains\s*\([^\n]*(?:host_str|host)\s*\(",
            window,
        ))
        return parsed and scheme and host
    if sink_type == "path_traversal":
        canonical = bool(re.search(r"\b(?:canonicalize|dunce::canonicalize)\s*\(", window))
        contained = bool(re.search(r"\.starts_with\s*\(", window))
        return canonical and contained
    if sink_type == "open_redirect":
        return bool(re.search(
            r"(?:ALLOWED_REDIRECTS|allowed_redirects)\.contains\s*\(", window
        ))
    if sink_type == "header_injection":
        return bool(re.search(r"HeaderValue::(?:from_str|try_from)\s*\(", window))
    if sink_type == "xss":
        return bool(re.search(
            r"(?:html_escape::encode_(?:text|safe)|ammonia::clean|encode_double_quoted_attribute)\s*\(",
            window,
        ))
    if sink_type == "deserialization":
        return bool(re.search(
            r"\.with_limit\s*\(|(?:RequestBodyLimitLayer|DefaultBodyLimit|ContentLengthLimit)",
            window,
        ))
    return False


def detect_rust_frameworks(content: str) -> list[str]:
    """Return Rust web frameworks evidenced by imports or qualified paths."""
    checks = {
        "actix-web": r"\b(?:actix_web|actix-web)\b",
        "axum": r"\baxum\b",
        "warp": r"\bwarp\b",
        "rocket": r"\brocket\b|#\[(?:get|post|put|delete|patch)\s*\(",
    }
    return [name for name, pattern in checks.items() if re.search(pattern, content)]


def analyze_rust(content: str, file_path: str) -> dict:
    """Track Rust request values through assignments to sensitive sinks."""
    results = {"sources": [], "sinks": [], "potential_paths": []}
    lines = content.splitlines()
    declared_sources = _extract_declared_sources(content, lines)
    tainted: dict[str, dict] = {}
    processed_sinks = set()

    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if _FUNCTION_START_RE.search(line):
            tainted.clear()

        for source in declared_sources.get(line_number, []):
            tainted[source["variable"]] = {**source, "sanitized_for": set()}
            results["sources"].append({
                "line": source["source_line"],
                "variable": source["variable"],
                "source_type": source["source_type"],
                "code": source["source_code"],
            })

        assignment = _LET_RE.search(line) or _ASSIGN_RE.search(line)
        if assignment:
            variable = assignment.group("variable")
            rhs = assignment.group("rhs")
            rhs_source = _source_type(rhs)
            new_taint = None
            if rhs_source:
                new_taint = {
                    "variable": variable,
                    "source_line": line_number,
                    "source_type": rhs_source,
                    "source_code": stripped,
                    "sanitized_for": _sanitized_types(rhs),
                }
                results["sources"].append({
                    "line": line_number,
                    "variable": variable,
                    "source_type": rhs_source,
                    "code": stripped,
                })
            else:
                for existing, info in list(tainted.items()):
                    if _var_in_code(existing, rhs):
                        new_taint = {
                            **info,
                            "variable": variable,
                            "sanitized_for": set(info.get("sanitized_for", set())) | _sanitized_types(rhs),
                        }
                        break
            if new_taint:
                tainted[variable] = new_taint
            else:
                tainted.pop(variable, None)

        direct_source = _source_type(line)
        if direct_source and not any(item["line"] == line_number for item in results["sources"]):
            results["sources"].append({
                "line": line_number,
                "variable": None,
                "source_type": direct_source,
                "code": stripped,
            })

        if not _sink_matches(line):
            continue
        statement_start, statement_end, statement = _statement(lines, line_number - 1)
        for sink_type, sink_name, sink_pattern in _sink_matches(statement):
            key = (statement_start, statement_end, sink_type)
            if key in processed_sinks:
                continue
            processed_sinks.add(key)
            results["sinks"].append({
                "line": line_number,
                "sink_type": sink_type,
                "sink_name": sink_name,
                "code": statement,
                "pattern": sink_pattern,
            })

            matched = False
            for variable, info in tainted.items():
                if not _var_in_code(variable, statement):
                    continue
                matched = True
                if sink_type in info.get("sanitized_for", set()):
                    continue
                if _mitigated(
                    lines,
                    info["source_line"],
                    line_number,
                    sink_type,
                    statement,
                    variable,
                ):
                    continue
                results["potential_paths"].append({
                    "source_line": info["source_line"],
                    "source_type": info["source_type"],
                    "source_code": info["source_code"],
                    "tainted_var": variable,
                    "sink_line": line_number,
                    "sink_type": sink_type,
                    "sink_name": sink_name,
                    "sink_code": statement,
                    "confidence": "likely",
                    "note": "Rust variable tracking: request-controlled value reaches sink",
                })

            if not matched:
                source_type = _source_type(statement)
                if source_type and not _mitigated(
                    lines,
                    statement_start + 1,
                    line_number,
                    sink_type,
                    statement,
                    "",
                ):
                    results["potential_paths"].append({
                        "source_line": statement_start + 1,
                        "source_type": source_type,
                        "source_code": statement,
                        "tainted_var": None,
                        "sink_line": line_number,
                        "sink_type": sink_type,
                        "sink_name": sink_name,
                        "sink_code": statement,
                        "confidence": "likely",
                        "note": "Direct Rust request source reaches sink",
                    })

    return results


def analyze_file_rust(file_path: str) -> dict:
    """Analyze one Rust file and return the scanner's standard taint contract."""
    content = Path(file_path).read_text(errors="replace")
    result = analyze_rust(content, file_path)
    result.update({
        "file": file_path,
        "language": "rust",
        "frameworks": detect_rust_frameworks(content),
        "total_sources": len(result["sources"]),
        "total_sinks": len(result["sinks"]),
        "total_potential_paths": len(result["potential_paths"]),
    })
    return result
