#!/usr/bin/env python3
"""Evidence-oriented Java/JVM taint analysis with lightweight variable tracking."""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# ── Java source patterns (request input) ─────────────────────────────────────

JAVA_SOURCES = {
    "spring_mvc": [
        r"@RequestParam\b",
        r"@PathVariable\b",
        r"@RequestBody\b",
        r"@RequestHeader\b",
        r"@CookieValue\b",
        r"@ModelAttribute\b",
        r"\.getParameter\s*\(",
        r"\.getQueryString\s*\(",
        r"\.getHeader\s*\(",
        r"\.getInputStream\s*\(",
        r"\.getCookies\s*\(",
    ],
    "servlet": [
        r"request\.getParameter\s*\(",
        r"request\.getParameterValues\s*\(",
        r"request\.getAttribute\s*\(",
        r"request\.getInputStream\s*\(",
        r"request\.getReader\s*\(",
        r"request\.getPart(?:s)?\s*\(",
    ],
    "jax_rs": [
        r"@(?:QueryParam|PathParam|HeaderParam|CookieParam|FormParam|MatrixParam|BeanParam)\b",
    ],
    "micronaut": [r"@(?:QueryValue|PathVariable|Header|CookieValue|Body)\b"],
    "generic": [
        r"System\.in\b",
        r"args\[",
        r"System\.getenv\s*\(",
        r"System\.getProperty\s*\(",
    ],
}

# ── Java sink patterns ────────────────────────────────────────────────────────

JAVA_SINKS = {
    "sqli": [
        (r"\.\s*(?:executeQuery|executeUpdate)\s*\(", "JDBC Statement execution"),
        (r"\b(?:stmt|statement|jdbcTemplate|namedParameterJdbcTemplate)\s*\.\s*(?:execute|query|update)\s*\(", "JDBC statement/template execution"),
        (r"\.prepareStatement\s*\(\s*\".*\+", "PreparedStatement with concatenation"),
        (r"\.\s*(?:createNativeQuery|createQuery|createSQLQuery)\s*\(", "JPA/Hibernate query execution"),
    ],
    "cmdi": [
        (r"Runtime\.getRuntime\s*\(\s*\)\.exec\s*\(", "Runtime.exec()"),
        (r"\b(?:runtime|rt)\.exec\s*\(", "Runtime.exec()"),
        (r"new\s+ProcessBuilder\s*\(", "ProcessBuilder"),
        (r"ProcessBuilder\.command\s*\(", "ProcessBuilder.command()"),
    ],
    "path_traversal": [
        (r"new\s+File\s*\(", "File instantiation with user input"),
        (r"Files\.(?:readAllBytes|readString|write|writeString|copy|move|delete)\s*\(", "Files I/O operation"),
        (r"new\s+FileInputStream\s*\(", "FileInputStream with user input"),
    ],
    "xxe": [
        (r"\b(?:builder|documentBuilder|saxParser|xmlReader|xmlParser)\.parse\s*\(", "XML parser input"),
    ],
    "expression_injection": [
        (r"\.parseExpression\s*\(", "Spring expression evaluation"),
        (r"(?:ELProcessor|ExpressionFactory|ValueExpression|MethodExpression).*\.(?:eval|createValueExpression|createMethodExpression)\s*\(", "Jakarta EL evaluation"),
    ],
    "ssti": [
        (r"new\s+Template\s*\(", "FreeMarker Template instantiation"),
        (r"ScriptEngine\.eval\s*\(", "ScriptEngine eval with user data"),
    ],
    "ldap_injection": [
        (r"\b(?:dirContext|ldapTemplate|ldapContext|ldap)\.search\s*\(", "LDAP search filter"),
    ],
    "xpath_injection": [
        (r"\.evaluate\s*\(", "XPath expression evaluation"),
    ],
    "deserialization": [
        (r"XMLDecoder\s*\(", "XMLDecoder deserialization"),
        (r"ObjectInputStream\s*\(", "Java object deserialization"),
        (r"readObject\s*\(\s*\)", "readObject() deserialization"),
    ],
    "ssrf": [
        (r"new\s+URL\s*\(", "URL with user-controlled string"),
        (r"\b(?:httpClient|client|restTemplate|webClient)\s*\.\s*(?:send|execute|getForObject|getForEntity|postForObject|postForEntity|exchange)\s*\(", "Outbound HTTP call"),
        (r"\.openConnection\s*\(", "URLConnection request"),
        (r"\.uri\s*\(", "Reactive HTTP request URI"),
    ],
    "xss": [
        (r"(?:\w+\.getWriter\s*\(\s*\)|\bout)\s*\.\s*(?:print|println|write)\s*\(", "HTTP response write"),
        (r"<%=", "JSP expression output"),
    ],
    "open_redirect": [
        (r"\.sendRedirect\s*\(", "Servlet redirect"),
        (r"Response\.(?:seeOther|temporaryRedirect)\s*\(", "JAX-RS redirect"),
    ],
}

# ── Java sanitizer patterns ───────────────────────────────────────────────────

JAVA_SANITIZERS = {
    "sqli": [
        r"PreparedStatement\.set(?:String|Int|Long|Date|Boolean)\s*\(",
        r"\.setParameter\s*\(",        # Hibernate
        r"@Query\s*\(",                # Spring Data named params
        r"ESAPI\.encoder\s*\(",
    ],
    "cmdi": [
        r"ESAPI\.encoder\s*\(\s*\)\.encodeForOS",
    ],
    "xss": [
        r"ESAPI\.encoder\s*\(\s*\)\.encodeForHTML",
        r"Jsoup\.clean\s*\(",
        r"StringEscapeUtils\.escapeHtml",
        r"HtmlUtils\.htmlEscape\s*\(",
    ],
    "ssrf": [
        r"ALLOWED_(?:HOSTS|DESTINATIONS)\.contains\s*\(",
        r"allowed(?:Hosts|Destinations)\.contains\s*\(",
    ],
    "xxe": [
        r"disallow-doctype-decl[^\n]*true",
        r"external-(?:general|parameter)-entities[^\n]*false",
        r"ACCESS_EXTERNAL_(?:DTD|SCHEMA|STYLESHEET)[^\n]*[\"']\s*[\"']",
    ],
    "deserialization": [r"\.setObjectInputFilter\s*\(", r"ObjectInputFilter\.Config\.createFilter\s*\("],
    "ldap_injection": [r"\{\d+\}", r"LdapEncoder\.", r"encodeFilterValue\s*\("],
    "open_redirect": [r"ALLOWED_(?:REDIRECTS|HOSTS)\.contains\s*\("],
    "path_traversal": [
        r"Paths\.get\s*\(.+\)\.normalize\s*\(\s*\)",
        r"\.toRealPath\s*\(\s*\)",
    ],
}

# ── ORM safe patterns ─────────────────────────────────────────────────────────

JAVA_ORM_SAFE = [
    r"PreparedStatement\b",
    r"@NamedQuery\b",
    r"@Query\s*\([^)]*:[\w]+\b",   # named params
    r"CriteriaBuilder\b",
    r"CriteriaQuery\b",
    r"Specification\b",
    r"JpaRepository\b",
    r"\.findById\s*\(",
    r"\.findAll\s*\(",
    r"\.save\s*\(",
]

# ── Variable assignment regex ─────────────────────────────────────────────────

_JAVA_ASSIGN_RE = re.compile(
    r"^\s*(?:final\s+)?(?:var|[\w.$<>\[\],?]+)\s+(\w+)\s*=\s*(.+)"
)

_ANNOTATED_PARAMETER_RE = re.compile(
    r"@(?P<annotation>RequestParam|PathVariable|RequestBody|RequestHeader|CookieValue|"
    r"ModelAttribute|QueryParam|PathParam|HeaderParam|CookieParam|FormParam|MatrixParam|"
    r"BeanParam|QueryValue|Header|Body)\b(?:\s*\([^)]*\))?\s*"
    r"(?:@[\w.$]+(?:\s*\([^)]*\))?\s*)*(?:final\s+)?"
    r"[\w.$<>\[\],?]+\s+(?P<variable>[A-Za-z_$][\w$]*)",
    re.MULTILINE,
)

_METHOD_START_RE = re.compile(
    r"^\s*(?:(?:public|protected|private|static|final|synchronized|abstract|native)\s+)*"
    r"(?:<[^>]+>\s+)?[\w.$<>\[\],?]+\s+[A-Za-z_$][\w$]*\s*\("
)


def _is_source_line(line: str) -> tuple:
    """Return (source_type, pattern) if line matches a source, else (None, None)."""
    for src_type, patterns in JAVA_SOURCES.items():
        for pattern in patterns:
            if re.search(pattern, line):
                return src_type, pattern
    return None, None


def _is_sink_line(line: str, response_writer_vars=()) -> list:
    """Return list of (sink_type, sink_name) matches for sinks in this line."""
    matches = []
    for sink_type, sink_list in JAVA_SINKS.items():
        for pattern, sink_name in sink_list:
            if re.search(pattern, line):
                matches.append((sink_type, sink_name, pattern))
    for variable in response_writer_vars:
        pattern = rf"\b{re.escape(variable)}\s*\.\s*(?:print|println|write)\s*\("
        if re.search(pattern, line):
            matches.append(("xss", "HttpServletResponse writer output", pattern))
    return matches


def _has_sanitizer(lines: list, start: int, end: int, sink_type: str) -> bool:
    """Check if any sanitizer for sink_type appears between start and end line indices."""
    sanitizer_patterns = JAVA_SANITIZERS.get(sink_type, [])
    for idx in range(start, min(end + 1, len(lines))):
        for pattern in sanitizer_patterns:
            if re.search(pattern, lines[idx]):
                return True
    return False


def _sink_is_mitigated(lines: list, source_line: int, sink_line: int,
                       sink_type: str, statement: str) -> bool:
    """Require a context-appropriate mitigation, not merely a generic validator."""
    start = max(0, min(source_line - 1, sink_line - 1) - 30)
    end = min(len(lines), sink_line + 1)
    window = "\n".join(
        "" if line.lstrip().startswith("//") else line for line in lines[start:end]
    )
    window = re.sub(r"/\*.*?\*/", "", window, flags=re.DOTALL)
    if sink_type == "sqli":
        return bool(re.search(r"\.setParameter\s*\(|\.set(?:String|Int|Long|Boolean|Date)\s*\(", statement))
    if sink_type == "ssrf":
        has_scheme = bool(re.search(r"getScheme\s*\(\)|\.scheme\s*\(", window))
        has_host_allowlist = bool(re.search(
            r"(?:ALLOWED_(?:HOSTS|DESTINATIONS)|allowed(?:Hosts|Destinations))\.contains\s*\(", window
        ))
        return has_scheme and has_host_allowlist
    if sink_type == "xxe":
        return bool(re.search(r"disallow-doctype-decl[^\n]*true", window)) or len(re.findall(
            r"external-(?:general|parameter)-entities[^\n]*false", window
        )) >= 2
    if sink_type == "path_traversal":
        normalized = bool(re.search(r"\.normalize\s*\(\)|\.toRealPath\s*\(", window))
        contained = bool(re.search(r"\.startsWith\s*\(", window))
        allowlisted = bool(re.search(r"ALLOWED_(?:FILES|PATHS)\.contains\s*\(", window))
        return (normalized and contained) or allowlisted
    return _has_sanitizer(lines, start, end - 1, sink_type)


def _statement_containing(lines: list, index: int) -> tuple[int, int, str]:
    """Return a small semicolon-delimited statement around ``index``."""
    if lines[index].strip() in {"{", "}"}:
        return index, index, lines[index].strip()
    start = index
    for _ in range(20):
        if start == 0 or re.search(r"[;{}]\s*$", lines[start - 1]):
            break
        start -= 1
    end = index
    for _ in range(20):
        if end >= len(lines) - 1 or ";" in lines[end]:
            break
        end += 1
    return start, end, " ".join(line.strip() for line in lines[start:end + 1])


def _matches_orm_safe(line: str) -> bool:
    """Return True if the line matches an ORM-safe pattern."""
    for pattern in JAVA_ORM_SAFE:
        if re.search(pattern, line):
            return True
    return False


def _var_in_line(var_name: str, line: str) -> bool:
    """Return true when ``var_name`` occurs as code, not in a literal/comment."""
    code = re.sub(r'"(?:\\.|[^"\\])*"', '""', line)
    code = re.sub(r"'(?:\\.|[^'\\])*'", "''", code)
    code = re.sub(r"/\*.*?\*/", "", code, flags=re.DOTALL)
    code = re.sub(r"//.*$", "", code, flags=re.MULTILINE)
    return bool(re.search(r'\b' + re.escape(var_name) + r'\b', code))


def analyze_java(content: str, file_path: str) -> dict:
    """Line-by-line Java taint analysis with variable tracking."""
    results = {"sources": [], "sinks": [], "potential_paths": []}
    lines = content.splitlines()

    # tainted_vars: var_name -> {"source_line": int, "source_code": str, "source_type": str}
    tainted_vars: dict = {}

    # Index annotation sources by line so source state is introduced only when
    # control reaches the method declaration. Pre-seeding the whole file would
    # let a later method's same-named parameter create a backward taint path.
    annotated_sources_by_line = {}
    for match in _ANNOTATED_PARAMETER_RE.finditer(content):
        variable = match.group("variable")
        source_line = content.count("\n", 0, match.start("variable")) + 1
        source_code = lines[source_line - 1].strip() if source_line <= len(lines) else match.group(0).strip()
        source_type = match.group("annotation")
        annotated_sources_by_line.setdefault(source_line, []).append({
            "source_line": source_line,
            "source_code": source_code,
            "source_type": source_type,
            "variable": variable,
        })

    response_writer_vars = set(re.findall(
        r"(?:PrintWriter|var)\s+([A-Za-z_$][\w$]*)\s*=\s*"
        r"[A-Za-z_$][\w$]*\.getWriter\s*\(\s*\)",
        content,
    ))

    processed_sinks = set()

    for i, line in enumerate(lines, start=1):
        stripped = line.strip()

        # Keep the lightweight tracker method-local. This prevents variables
        # from one controller action flowing into a later action solely because
        # they share a name.
        if _METHOD_START_RE.search(line):
            tainted_vars.clear()

        for source in annotated_sources_by_line.get(i, []):
            variable = source["variable"]
            tainted_vars[variable] = {
                "source_line": source["source_line"],
                "source_code": source["source_code"],
                "source_type": source["source_type"],
            }
            results["sources"].append({
                "line": source["source_line"],
                "variable": variable,
                "source_type": source["source_type"],
                "code": source["source_code"],
            })

        # ── Step 1: Detect source appearances and variable assignments ────────
        src_type, src_pattern = _is_source_line(line)

        # Check for typed variable assignment: TypeName varName = <rhs>
        assign_match = _JAVA_ASSIGN_RE.search(line)
        if assign_match:
            var_name = assign_match.group(1)
            rhs = assign_match.group(2)

            # If RHS contains a source pattern, taint the variable
            rhs_src_type, _ = _is_source_line(rhs)
            if rhs_src_type:
                tainted_vars[var_name] = {
                    "source_line": i,
                    "source_code": stripped,
                    "source_type": rhs_src_type,
                }
                if not any(s["line"] == i and s.get("variable") == var_name for s in results["sources"]):
                    results["sources"].append({
                        "line": i,
                        "variable": var_name,
                        "source_type": rhs_src_type,
                        "code": stripped,
                    })

            # Propagate taint: if RHS references an already-tainted variable
            for existing_var, info in list(tainted_vars.items()):
                if _var_in_line(existing_var, rhs) and var_name not in tainted_vars:
                    tainted_vars[var_name] = {
                        "source_line": info["source_line"],
                        "source_code": info["source_code"],
                        "source_type": info["source_type"],
                    }
                    break

        # Record bare source appearances (no assignment capture)
        if src_type and not any(s["line"] == i for s in results["sources"]):
            results["sources"].append({
                "line": i,
                "variable": None,
                "source_type": src_type,
                "code": stripped,
            })

        # ── Step 2: Detect sinks ──────────────────────────────────────────────
        # A sink token must occur on the current line. The surrounding statement
        # is then collected only to recover multiline arguments; looking ahead
        # from annotation/signature lines would create duplicate, early sinks.
        if not _is_sink_line(line, response_writer_vars):
            continue
        statement_start, statement_end, statement = _statement_containing(lines, i - 1)
        sink_matches = _is_sink_line(statement, response_writer_vars)
        for sink_type, sink_name, sink_pattern in sink_matches:
            sink_key = (statement_start, statement_end, sink_type, sink_name)
            if sink_key in processed_sinks:
                continue
            processed_sinks.add(sink_key)

            # Check ORM safe patterns — if sink line matches a safe ORM pattern
            # and the usage looks like a parameter (not string concatenation), skip
            if _matches_orm_safe(statement) and "+" not in statement:
                continue

            results["sinks"].append({
                "line": i,
                "sink_type": sink_type,
                "sink_name": sink_name,
                "code": statement,
            })

            # ── Step 3: Match tainted variables to sinks ──────────────────────
            matched_via_var = False
            for var_name, info in tainted_vars.items():
                if _var_in_line(var_name, statement):
                    src_line_idx = info["source_line"] - 1  # 0-based
                    sink_line_idx = i - 1                   # 0-based

                    if _sink_is_mitigated(
                        lines, info["source_line"], i, sink_type, statement
                    ):
                        continue

                    results["potential_paths"].append({
                        "source_line": info["source_line"],
                        "source_type": info["source_type"],
                        "source_code": info["source_code"],
                        "tainted_var": var_name,
                        "sink_line": i,
                        "sink_type": sink_type,
                        "sink_name": sink_name,
                        "sink_code": statement,
                        "confidence": "likely",
                        "note": "Variable-tracking: tainted variable flows to sink",
                    })
                    matched_via_var = True

            # Direct source calls inside the sink statement are evidence-based;
            # mere source/sink proximity is not.
            if not matched_via_var:
                direct_type, _ = _is_source_line(statement)
                if direct_type:
                    direct_line = statement_start + 1
                    if _sink_is_mitigated(lines, direct_line, i, sink_type, statement):
                        continue
                    results["potential_paths"].append({
                        "source_line": direct_line,
                        "source_type": direct_type,
                        "source_code": statement,
                        "tainted_var": None,
                        "sink_line": i,
                        "sink_type": sink_type,
                        "sink_name": sink_name,
                        "sink_code": statement,
                        "confidence": "likely",
                        "note": "Direct request source reaches sink in the same statement",
                    })

    return results


def analyze_java_annotations(content: str) -> list:
    """Scan for dangerous Java annotation combinations."""
    findings = []
    lines = content.splitlines()

    for i, line in enumerate(lines, start=1):
        stripped = line.strip()

        # @CrossOrigin without origins restriction
        if re.search(r"@CrossOrigin\b", stripped):
            if not re.search(r"origins\s*=", stripped):
                findings.append({
                    "line": i,
                    "annotation": "@CrossOrigin",
                    "severity": "medium",
                    "issue": "CORS: @CrossOrigin without origins restriction allows any origin",
                    "code": stripped,
                })

        # @RequestMapping without method restriction
        if re.search(r"@RequestMapping\b", stripped):
            if not re.search(r"method\s*=", stripped):
                findings.append({
                    "line": i,
                    "annotation": "@RequestMapping",
                    "severity": "medium",
                    "issue": "@RequestMapping without method restriction accepts all HTTP methods",
                    "code": stripped,
                })

    return findings


def analyze_file_java(file_path: str) -> dict:
    """Analyze a Java file for taint paths. Returns the standard dict format."""
    content = Path(file_path).read_text(errors="replace")
    result = analyze_java(content, file_path)
    annotation_findings = analyze_java_annotations(content)
    result["annotation_findings"] = annotation_findings
    result["file"] = file_path
    result["language"] = "java"
    result["total_sources"] = len(result["sources"])
    result["total_sinks"] = len(result["sinks"])
    result["total_potential_paths"] = len(result["potential_paths"])
    return result
