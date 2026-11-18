#!/usr/bin/env python3
"""Evidence-oriented Kotlin/JVM taint analysis for server applications."""

import re
from pathlib import Path


KOTLIN_SOURCES = {
    "spring_mvc": [
        r"@(?:RequestParam|PathVariable|RequestBody|RequestHeader|CookieValue|ModelAttribute)\b",
    ],
    "jax_rs": [
        r"@(?:QueryParam|PathParam|HeaderParam|CookieParam|FormParam|MatrixParam|BeanParam)\b",
    ],
    "micronaut": [r"@(?:QueryValue|PathVariable|Header|CookieValue|Body)\b"],
    "ktor": [
        r"\bcall\.parameters\s*\[",
        r"\bcall\.request\.queryParameters\s*\[",
        r"\bcall\.request\.headers\s*\[",
        r"\bcall\.request\.cookies\s*\[",
        r"\bcall\.receive(?:Text|Parameters|Multipart)?\s*(?:<[^>]+>)?\s*\(",
        r"\bcall\.receiveParameters\s*\(",
    ],
    "servlet": [
        r"\brequest\.getParameter(?:Values)?\s*\(",
        r"\brequest\.getHeader\s*\(",
        r"\brequest\.(?:inputStream|reader)\b",
    ],
    "generic": [r"\bSystem\.getenv\s*\(", r"\breadLine\s*\(", r"\bargs\s*\["],
}


KOTLIN_SINKS = {
    "sqli": [
        (r"\.(?:createNativeQuery|createQuery|createSQLQuery)\s*\(", "JPA/Hibernate query"),
        (r"\.(?:executeQuery|executeUpdate|execute)\s*\(", "JDBC statement execution"),
        (r"\b(?:rawQuery|execSQL)\s*\(", "Android/raw SQL execution"),
        (r"\b(?:jdbcTemplate|namedParameterJdbcTemplate)\.(?:query|update|execute)\s*\(", "JDBC template execution"),
    ],
    "cmdi": [
        (r"Runtime\.getRuntime\s*\(\s*\)\.exec\s*\(", "Runtime.exec"),
        (r"\bProcessBuilder\s*\(", "ProcessBuilder"),
        (r"\bprocessBuilder\s*\(", "Kotlin process builder"),
    ],
    "path_traversal": [
        (r"\bFile\s*\(", "Kotlin/Java File"),
        (r"\bPaths\.get\s*\(", "Paths.get"),
        (r"\bFiles\.(?:readAllBytes|readString|write|writeString|copy|move|delete)\s*\(", "NIO file operation"),
    ],
    "ssrf": [
        (r"\bURL\s*\(", "URL construction"),
        (r"\bURI\.create\s*\(", "URI construction"),
        (r"\.url\s*\(", "HTTP request URL"),
        (r"\b(?:restTemplate|webClient|httpClient|client)\.(?:getForObject|getForEntity|postForObject|exchange|send|request|get|post)\s*\(", "Outbound HTTP request"),
    ],
    "xss": [
        (r"\bcall\.respondText\s*\(", "Ktor text/HTML response"),
        (r"\.(?:print|println|write)\s*\(", "HTTP response output"),
    ],
    "open_redirect": [
        (r"\bcall\.respondRedirect\s*\(", "Ktor redirect"),
        (r"\.sendRedirect\s*\(", "Servlet redirect"),
    ],
    "expression_injection": [
        (r"\.parseExpression\s*\(", "Spring expression evaluation"),
        (r"\bScriptEngine.*\.eval\s*\(", "Script engine evaluation"),
    ],
    "ldap_injection": [(r"\b(?:ldapTemplate|dirContext|ldapContext)\.search\s*\(", "LDAP search")],
    "xpath_injection": [(r"\.evaluate\s*\(", "XPath evaluation")],
    "deserialization": [
        (r"\bObjectInputStream\s*\(", "Java object deserialization"),
        (r"\.readObject\s*\(", "Java object deserialization"),
        (r"\bXMLDecoder\s*\(", "XMLDecoder deserialization"),
    ],
    "xxe": [(r"\b(?:documentBuilder|saxParser|xmlReader|builder)\.parse\s*\(", "XML parsing")],
}


_ANNOTATED_PARAMETER_RE = re.compile(
    r"@(?P<annotation>RequestParam|PathVariable|RequestBody|RequestHeader|CookieValue|ModelAttribute|"
    r"QueryParam|PathParam|HeaderParam|CookieParam|FormParam|MatrixParam|BeanParam|"
    r"QueryValue|Header|Body)\b(?:\s*\([^)]*\))?\s*"
    r"(?:val\s+|var\s+)?(?P<variable>[A-Za-z_$][\w$]*)\s*:\s*[\w.$<>,?\[\]]+",
    re.MULTILINE,
)

_ASSIGN_RE = re.compile(
    r"^\s*(?:(?:val|var)\s+)?([A-Za-z_$][\w$]*)"
    r"(?:\s*:\s*[\w.$<>,?\[\] ]+)?\s*=\s*(.+)"
)

_FUNCTION_START_RE = re.compile(
    r"^\s*(?:(?:public|protected|private|internal|open|override|suspend|inline|tailrec|operator|infix)\s+)*"
    r"fun\s+(?:<[^>]+>\s*)?[A-Za-z_$][\w$]*\s*\("
)

_ROUTE_START_RE = re.compile(
    r"^\s*(?:get|post|put|delete|patch|options|head|route)\s*\(\s*[\"']"
)


def _source_type(text: str):
    for source_type, patterns in KOTLIN_SOURCES.items():
        for pattern in patterns:
            if re.search(pattern, text):
                return source_type
    return None


def _code_without_literals(text: str) -> str:
    text = re.sub(r'""".*?"""', '""', text, flags=re.DOTALL)
    text = re.sub(r'"(?:\\.|[^"\\])*"', '""', text)
    text = re.sub(r"'(?:\\.|[^'\\])*'", "''", text)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    return re.sub(r"//.*$", "", text, flags=re.MULTILINE)


def _var_in_code(variable: str, text: str) -> bool:
    """Match ordinary variables and Kotlin string-template interpolation."""
    if re.search(rf"\$(?:\{{\s*)?{re.escape(variable)}\b", text):
        return True
    return bool(re.search(rf"\b{re.escape(variable)}\b", _code_without_literals(text)))


def _statement(lines: list[str], index: int) -> tuple[int, int, str]:
    """Collect a compact Kotlin call chain around a sink line."""
    start = index
    balance = 0
    while start > 0 and index - start < 12:
        previous = lines[start - 1].rstrip()
        current = lines[start].lstrip()
        if current.startswith((".", ")", ",")) or previous.endswith(("(", ",", ".", "=", "+")):
            start -= 1
            continue
        break

    end = index
    for cursor in range(start, index + 1):
        balance += lines[cursor].count("(") - lines[cursor].count(")")
    while end + 1 < len(lines) and end - index < 12:
        next_line = lines[end + 1].lstrip()
        if balance > 0 or next_line.startswith((".", ")", ",")) or lines[end].rstrip().endswith(("(", ",", ".", "+")):
            end += 1
            balance += lines[end].count("(") - lines[end].count(")")
            continue
        break
    return start, end, " ".join(line.strip() for line in lines[start:end + 1])


def _sink_matches(statement: str) -> list[tuple[str, str, str]]:
    matches = []
    for sink_type, definitions in KOTLIN_SINKS.items():
        for pattern, name in definitions:
            if re.search(pattern, statement):
                matches.append((sink_type, name, pattern))
    return matches


def _sanitized_types(rhs: str) -> set[str]:
    """Return sink classes neutralized by an assignment expression."""
    sanitized = set()
    if re.search(r"(?:encodeForHTML|escapeHtml|htmlEscape|Jsoup\.clean)\s*\(", rhs):
        sanitized.add("xss")
    if re.search(r"(?:LdapEncoder\.|encodeFilterValue\s*\()", rhs):
        sanitized.add("ldap_injection")
    return sanitized


def _mitigated(
    lines: list[str], source_line: int, sink_line: int, sink_type: str,
    statement: str, tainted_var: str | None = None,
) -> bool:
    start = max(0, source_line - 1)
    end = min(len(lines), sink_line + 5)
    window = "\n".join(lines[start:end])
    if sink_type == "sqli":
        binding = bool(re.search(
            r"\.setParameter\s*\(|\.set(?:String|Int|Long|Boolean|Date)\s*\(",
            statement,
        ))
        if not binding:
            return False
        # A binding elsewhere in the call chain does not make dynamic query
        # text safe. The tainted value must be used only as a bound parameter.
        query_call = re.search(
            r"\.(?:createNativeQuery|createQuery|createSQLQuery|query|update|execute)\s*\(\s*([^,)]*)",
            statement,
        )
        return not (
            tainted_var
            and query_call
            and _var_in_code(tainted_var, query_call.group(1))
        )
    if sink_type == "ssrf":
        has_scheme_check = bool(re.search(r"\.scheme\b|getScheme\s*\(", window))
        has_host_check = bool(re.search(
            r"(?:ALLOWED_(?:HOSTS|DESTINATIONS)|allowed(?:Hosts|Destinations))\.contains\s*\(", window
        ))
        return has_scheme_check and has_host_check
    if sink_type == "path_traversal":
        normalized = bool(re.search(r"\.normalize\s*\(\)|\.toRealPath\s*\(", window))
        contained = bool(re.search(r"\.startsWith\s*\(", window))
        return normalized and contained
    if sink_type == "xss":
        if "respondText" in statement and not re.search(
            r"ContentType\.Text\.Html|contentType\s*=\s*ContentType\.Text\.Html", statement
        ):
            return True
        return bool(re.search(r"(?:encodeForHTML|escapeHtml|htmlEscape|Jsoup\.clean)\s*\(", statement))
    if sink_type == "open_redirect":
        return bool(re.search(r"(?:ALLOWED_REDIRECTS|allowedRedirects)\.contains\s*\(", window))
    if sink_type == "deserialization":
        return bool(re.search(r"setObjectInputFilter\s*\(|ObjectInputFilter", window))
    if sink_type == "xxe":
        return bool(re.search(r"disallow-doctype-decl[^\n]*true", window)) or len(re.findall(
            r"external-(?:general|parameter)-entities[^\n]*false", window
        )) >= 2
    if sink_type == "ldap_injection":
        return bool(re.search(r"LdapEncoder\.|encodeFilterValue\s*\(|\{\d+}", statement))
    return False


def analyze_kotlin(content: str, file_path: str) -> dict:
    """Track Kotlin request values through assignments to security-sensitive sinks."""
    results = {"sources": [], "sinks": [], "potential_paths": []}
    lines = content.splitlines()
    tainted: dict[str, dict] = {}

    annotated_sources: dict[int, list[dict]] = {}
    for match in _ANNOTATED_PARAMETER_RE.finditer(content):
        variable = match.group("variable")
        line = content.count("\n", 0, match.start("variable")) + 1
        annotated_sources.setdefault(line, []).append({
            "variable": variable,
            "source_line": line,
            "source_type": match.group("annotation"),
            "source_code": lines[line - 1].strip(),
        })

    processed_sinks = set()
    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if _FUNCTION_START_RE.search(line) or _ROUTE_START_RE.search(line):
            tainted.clear()

        for source in annotated_sources.get(line_number, []):
            tainted[source["variable"]] = {**source, "sanitized_for": set()}
            results["sources"].append({
                "line": source["source_line"],
                "variable": source["variable"],
                "source_type": source["source_type"],
                "code": source["source_code"],
            })

        assignment = _ASSIGN_RE.search(line)
        if assignment:
            variable, rhs = assignment.group(1), assignment.group(2)
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
            key = (statement_start, statement_end, sink_type, sink_name)
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
                    lines, info["source_line"], line_number, sink_type,
                    statement, variable,
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
                    "note": "Kotlin variable tracking: request-controlled value reaches sink",
                })

            if not matched:
                source_type = _source_type(statement)
                if source_type and not _mitigated(
                    lines, statement_start + 1, line_number, sink_type, statement
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
                        "note": "Direct Kotlin request source reaches sink",
                    })
    return results


def analyze_file_kotlin(file_path: str) -> dict:
    content = Path(file_path).read_text(errors="replace")
    result = analyze_kotlin(content, file_path)
    result.update({
        "file": file_path,
        "language": "kotlin",
        "total_sources": len(result["sources"]),
        "total_sinks": len(result["sinks"]),
        "total_potential_paths": len(result["potential_paths"]),
    })
    return result
