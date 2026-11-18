#!/usr/bin/env python3
"""Evidence-oriented C#/.NET web taint analysis.

The analyzer intentionally favors explicit source-to-sink evidence over API
presence.  It understands ASP.NET Core MVC/Razor binding, minimal APIs, and
common .NET data-access and output APIs while remaining dependency-free.
"""

from __future__ import annotations

import re
from pathlib import Path


# Request and externally controlled data sources.  These expressions are also
# used when deciding whether the RHS of an assignment introduces taint.
CSHARP_SOURCES = {
    "aspnet_request": [
        r"(?:HttpContext\.)?Request\.(?:Query|Form|RouteValues|Headers|Cookies)\s*\[",
        r"(?:HttpContext\.)?Request\.QueryString(?:\.Value)?\b",
        r"(?:HttpContext\.)?Request\.Body\b",
        r"(?:HttpContext\.)?Request\.ReadFormAsync\s*\(",
        r"(?:HttpContext\.)?Request\.ReadFromJsonAsync\s*<",
        r"httpContext\.Request\.(?:Query|Form|RouteValues|Headers|Cookies|Body)\b",
    ],
    "blazor": [
        r"NavigationManager\.Uri\b",
        r"Navigation\.Uri\b",
    ],
    "generic": [
        r"Environment\.GetEnvironmentVariable\s*\(",
        r"Console\.ReadLine\s*\(",
        r"\bargs\s*\[",
    ],
}


# Sinks are deliberately broader than the pattern file: a sink is only emitted
# as a potential path when a tracked value occurs in the same statement.
CSHARP_SINKS = {
    "sqli": [
        (r"new\s+(?:Sql|Npgsql|MySql|OleDb|Odbc)Command\s*\(", "ADO.NET command text"),
        (r"\.CommandText\s*=", "ADO.NET CommandText assignment"),
        (r"\.(?:FromSqlRaw|ExecuteSqlRaw(?:Async)?|SqlQueryRaw)\s*\(", "EF Core raw SQL"),
        (
            r"\.(?:Query|QueryAsync|QueryFirst|QueryFirstAsync|QueryFirstOrDefault|"
            r"QueryFirstOrDefaultAsync|QuerySingle|QuerySingleAsync|Execute|ExecuteAsync)"
            r"(?:\s*<[^>]+>)?\s*\(",
            "Dapper SQL execution",
        ),
    ],
    "cmdi": [
        (r"\bProcess\.Start\s*\(", "Process.Start"),
        (r"new\s+ProcessStartInfo\s*\(", "ProcessStartInfo executable"),
        (r"(?:\.|\b)(?:FileName|Arguments)\s*=", "ProcessStartInfo command configuration"),
    ],
    "path_traversal": [
        (
            r"\bFile\.(?:ReadAllText|ReadAllTextAsync|ReadAllBytes|ReadAllBytesAsync|"
            r"WriteAllText|WriteAllTextAsync|WriteAllBytes|WriteAllBytesAsync|Open|"
            r"OpenRead|OpenWrite|Delete|Move|Copy)\s*\(",
            "filesystem operation",
        ),
        (r"new\s+FileStream\s*\(", "FileStream path"),
        (r"\bDirectory\.(?:GetFiles|EnumerateFiles|Delete|Move|CreateDirectory)\s*\(", "directory operation"),
        (r"\bPhysicalFile\s*\(", "ASP.NET physical file response"),
    ],
    "ssrf": [
        (
            r"\.(?:GetAsync|GetStringAsync|GetByteArrayAsync|PostAsync|PutAsync|"
            r"PatchAsync|DeleteAsync|SendAsync)\s*\(",
            "HttpClient outbound request",
        ),
        (r"new\s+HttpRequestMessage\s*\(", "HttpRequestMessage destination"),
        (r"\b(?:WebRequest|HttpWebRequest)\.Create\s*\(", "WebRequest destination"),
        (r"\.(?:DownloadString|DownloadData|OpenRead)\s*\(", "WebClient outbound request"),
    ],
    "xss": [
        (r"(?:@?Html|HtmlHelper)\.Raw\s*\(", "raw Razor HTML"),
        (r"new\s+HtmlString\s*\(", "raw HTML string"),
        (r"(?:new\s+)?MarkupString\s*\(", "Blazor MarkupString"),
        (r"\(\s*MarkupString\s*\)", "Blazor MarkupString cast"),
        (r"Response\.WriteAsync\s*\(", "raw HTTP response output"),
        (r"\bContent\s*\(", "MVC content response"),
    ],
    "open_redirect": [
        (r"(?<!Local)Redirect(?:Permanent|PreserveMethod|PermanentPreserveMethod)?\s*\(", "ASP.NET redirect"),
        (r"Response\.Redirect\s*\(", "HTTP response redirect"),
    ],
    "deserialization": [
        (r"(?:BinaryFormatter|SoapFormatter|LosFormatter|ObjectStateFormatter)\b.*\.Deserialize\s*\(", "unsafe formatter deserialization"),
        (r"NetDataContractSerializer\b.*\.(?:Deserialize|ReadObject)\s*\(", "NetDataContractSerializer deserialization"),
    ],
    "xxe": [
        (r"\.(?:Load|LoadXml)\s*\(", "XML document parsing"),
        (r"XmlReader\.Create\s*\(", "XML reader parsing"),
        (r"new\s+(?:XPathDocument|XmlTextReader)\s*\(", "XML parser construction"),
    ],
    "ssti": [
        (r"\.(?:CompileRenderStringAsync|CompileRenderAsync|ParseAsync)\s*\(", "dynamic template compilation"),
        (r"(?:Template|RazorTemplateEngine)\.Parse\s*\(", "dynamic template parsing"),
    ],
    "ldap_injection": [
        (r"\.(?:Filter|Path)\s*=", "LDAP filter or path assignment"),
        (r"new\s+DirectorySearcher\s*\(", "LDAP search filter"),
    ],
    "nosqli": [
        (r"BsonDocument\.Parse\s*\(", "MongoDB raw BSON query"),
        (r"JsonFilterDefinition<[^>]+>\s*\(", "MongoDB JSON filter"),
    ],
}


_BINDING_ATTRIBUTES = {
    "FromQuery",
    "FromRoute",
    "FromBody",
    "FromForm",
    "FromHeader",
    "FromCookie",
    "AsParameters",
    "BindProperty",
    "SupplyParameterFromQuery",
    "Parameter",
}

_NON_TEXT_SCALARS = {
    "bool", "byte", "sbyte", "short", "ushort", "int", "uint", "long",
    "ulong", "float", "double", "decimal", "char", "guid", "datetime",
    "datetimeoffset", "timespan", "dateonly", "timeonly", "cancellationtoken",
}

_INJECTED_TYPES = {
    "httpresponse", "claimsprincipal", "cancellationtoken", "linkgenerator",
    "iwebhostenvironment", "ihostenvironment", "iconfiguration", "iserviceprovider",
    "httpclient", "httpclientfactory", "ihttpclientfactory", "ilogger", "iloggerfactory",
}

_ASSIGN_RE = re.compile(
    r"^\s*(?:(?:await\s+)?using\s+)?"
    r"(?:(?:(?:const|readonly)\s+)?(?:var|[A-Za-z_$][\w.$<>,?\[\]]*)\s+)?"
    r"(?P<variable>[A-Za-z_$][\w$]*)\s*=(?!=|>)\s*(?P<rhs>.+)",
)
_PROPERTY_ASSIGN_RE = re.compile(
    r"^\s*(?P<object>[A-Za-z_$][\w$]*)\.(?P<property>[A-Za-z_$][\w$]*)\s*=\s*(?P<rhs>.+)"
)
_METHOD_START_RE = re.compile(
    r"^\s*(?:(?:public|private|protected|internal|static|virtual|override|sealed|async|partial|new)\s+)+"
    r"(?:[\w.$<>,?\[\]]+\s+)+[A-Za-z_$][\w$]*\s*\("
)


def _source_on_line(text: str) -> tuple[str | None, str | None]:
    for source_type, patterns in CSHARP_SOURCES.items():
        for pattern in patterns:
            if re.search(pattern, text, re.IGNORECASE):
                return source_type, pattern
    return None, None


def _sink_matches(text: str) -> list[tuple[str, str, str]]:
    matches = []
    for sink_type, patterns in CSHARP_SINKS.items():
        for pattern, name in patterns:
            if re.search(pattern, text, re.IGNORECASE | re.DOTALL):
                matches.append((sink_type, name, pattern))
    return matches


def _code_without_literals(text: str) -> str:
    """Remove comments/literals but retain C# interpolation expressions."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"//.*$", "", text, flags=re.MULTILINE)

    interpolation = []
    for match in re.finditer(r"\$@?\"(?:\"\"|\\.|[^\"])*\"|@\$\"(?:\"\"|\\.|[^\"])*\"", text):
        interpolation.extend(re.findall(r"(?<!\{)\{(?!\{)(.*?)(?<!\})\}(?!\})", match.group(0)))
    text = re.sub(r"\$@?\"(?:\"\"|\\.|[^\"])*\"|@\$\"(?:\"\"|\\.|[^\"])*\"", " ", text)
    text = re.sub(r"@?\"(?:\"\"|\\.|[^\"])*\"", " ", text)
    text = re.sub(r"'(?:\\.|[^'\\])'", " ", text)
    return text + " " + " ".join(interpolation)


def _var_in_code(variable: str, text: str) -> bool:
    return bool(re.search(r"\b" + re.escape(variable) + r"\b", _code_without_literals(text)))


def _line_at_offset(content: str, offset: int) -> int:
    return content.count("\n", 0, offset) + 1


def _split_parameters(parameters: str, base_offset: int) -> list[tuple[str, str, str, int]]:
    """Return (name, type, attributes, relative-offset) for a parameter list."""
    pieces = []
    start = 0
    angle = square = paren = 0
    for index, char in enumerate(parameters):
        if char == "<":
            angle += 1
        elif char == ">" and angle:
            angle -= 1
        elif char == "[":
            square += 1
        elif char == "]" and square:
            square -= 1
        elif char == "(":
            paren += 1
        elif char == ")" and paren:
            paren -= 1
        elif char == "," and not (angle or square or paren):
            pieces.append((parameters[start:index], start))
            start = index + 1
    pieces.append((parameters[start:], start))

    parsed = []
    for raw, relative in pieces:
        raw = raw.strip()
        if not raw:
            continue
        attributes = " ".join(re.findall(r"\[([^\]]+)\]", raw))
        declaration = re.sub(r"\[[^\]]+\]", " ", raw)
        declaration = declaration.split("=", 1)[0].strip()
        declaration = re.sub(r"\b(?:ref|out|in|params|this)\s+", "", declaration)
        match = re.search(
            r"(?P<type>[A-Za-z_$][\w.$]*(?:\s*<[^>]+>)?(?:\[\])?\??)\s+"
            r"(?P<name>[A-Za-z_$][\w$]*)\s*$",
            declaration,
        )
        if match:
            parsed.append((match.group("name"), match.group("type"), attributes, base_offset + relative))
    return parsed


def _is_taintable_parameter(type_name: str, attributes: str = "") -> bool:
    normalized = re.sub(r"[?\[\]]", "", type_name).split(".")[-1].lower()
    if normalized in _NON_TEXT_SCALARS:
        return False
    if normalized in _INJECTED_TYPES or normalized.endswith("dbcontext"):
        return False
    if "FromServices" in attributes:
        return False
    return True


def _parameter_sources(content: str) -> dict[int, list[dict]]:
    """Index explicitly-bound, action, minimal-API, and Blazor inputs."""
    sources: dict[int, list[dict]] = {}

    def add(name: str, type_name: str, source_type: str, offset: int, attributes: str = ""):
        if not _is_taintable_parameter(type_name, attributes):
            return
        line = _line_at_offset(content, offset)
        entry = {
            "variable": name,
            "source_type": source_type,
            "source_line": line,
            "source_code": content.splitlines()[line - 1].strip(),
        }
        if not any(existing["variable"] == name for existing in sources.get(line, [])):
            sources.setdefault(line, []).append(entry)

    # Explicit MVC/Razor/Blazor binding.  This also catches attributes split
    # over lines, which the previous generic C# analyzer missed.
    attr_names = "|".join(sorted(_BINDING_ATTRIBUTES, key=len, reverse=True))
    explicit_re = re.compile(
        rf"\[(?P<attribute>{attr_names})\b[^\]]*\]\s*"
        rf"(?:(?:public|private|protected|internal|static|required|init)\s+)*"
        rf"(?P<type>[A-Za-z_$][\w.$]*(?:\s*<[^>]+>)?(?:\[\])?\??)\s+"
        rf"(?P<name>[A-Za-z_$][\w$]*)",
        re.MULTILINE,
    )
    for match in explicit_re.finditer(content):
        add(match.group("name"), match.group("type"), match.group("attribute"), match.start("name"), match.group(0))

    # Attributed controller/page action parameters are model-bound even when
    # an individual parameter does not carry [FromQuery]/[FromBody].
    action_re = re.compile(
        r"(?P<attrs>(?:\s*\[[^\]]+\]\s*)+)"
        r"(?:(?:public|protected|internal|static|virtual|override|async|sealed|new)\s+)+"
        r"[\w.$<>,?\[\]]+\s+(?P<name>[A-Za-z_$][\w$]*)\s*\((?P<params>[^)]*)\)",
        re.MULTILINE | re.DOTALL,
    )
    for match in action_re.finditer(content):
        attrs = match.group("attrs")
        if not re.search(r"\[(?:Http(?:Get|Post|Put|Patch|Delete|Head|Options)|Route|AcceptVerbs)\b", attrs):
            continue
        for name, type_name, param_attrs, offset in _split_parameters(match.group("params"), match.start("params")):
            add(name, type_name, "mvc_action_parameter", offset, param_attrs)

    # Razor Page OnGet/OnPost handler parameters are model-bound by convention.
    page_re = re.compile(
        r"(?:(?:public|protected|internal|async|virtual|override)\s+)+"
        r"[\w.$<>,?\[\]]+\s+On(?:Get|Post|Put|Patch|Delete)[A-Za-z_$]*\s*"
        r"\((?P<params>[^)]*)\)",
        re.MULTILINE | re.DOTALL,
    )
    for match in page_re.finditer(content):
        for name, type_name, attrs, offset in _split_parameters(match.group("params"), match.start("params")):
            add(name, type_name, "razor_page_parameter", offset, attrs)

    # Minimal API lambda parameters.  DI service types are filtered, while
    # scalar/string/DTO parameters and HttpRequest remain request sources.
    minimal_re = re.compile(
        r"\.Map(?:Get|Post|Put|Patch|Delete|Methods)\s*\(\s*"
        r"(?:\$?@?\"(?:\\.|[^\"])*\")\s*,\s*(?:async\s*)?"
        r"\((?P<params>.*?)\)\s*=>",
        re.MULTILINE | re.DOTALL,
    )
    for match in minimal_re.finditer(content):
        for name, type_name, attrs, offset in _split_parameters(match.group("params"), match.start("params")):
            add(name, type_name, "minimal_api_parameter", offset, attrs)

    return sources


def _statement_containing(lines: list[str], index: int) -> tuple[int, int, str]:
    start = index
    for _ in range(24):
        if start == 0 or re.search(r"[;{}]\s*$", lines[start - 1]):
            break
        start -= 1
    end = index
    for _ in range(24):
        if end >= len(lines) - 1 or ";" in lines[end]:
            break
        end += 1
    # Preserve line boundaries so ``//`` stripping cannot erase a later line
    # in the same multiline statement window.
    return start, end, "\n".join(line.strip() for line in lines[start : end + 1])


def _window(lines: list[str], source_line: int, sink_line: int, radius: int = 35) -> str:
    start = max(0, min(source_line, sink_line) - radius - 1)
    end = min(len(lines), sink_line + 2)
    return "\n".join(lines[start:end])


def _sink_is_mitigated(
    lines: list[str], source_line: int, sink_line: int, sink_type: str, statement: str
) -> bool:
    context = _window(lines, source_line, sink_line)

    if sink_type == "sqli":
        # Interpolation/concatenation into query structure is never rescued by
        # an unrelated parameter call elsewhere in the method.
        dangerous_shape = bool(re.search(r"\$@?\"|\+\s*[A-Za-z_$]|String\.(?:Format|Concat)\s*\(", statement))
        if dangerous_shape:
            return False
        if re.search(r"\.(?:FromSqlInterpolated|ExecuteSqlInterpolated)\s*\(", statement):
            return True
        # EF FromSqlRaw composite placeholders and Dapper anonymous/DynamicParameters
        # bind values passed as later arguments.
        if re.search(r"\.(?:FromSqlRaw|ExecuteSqlRaw(?:Async)?)\s*\(\s*\"[^\"]*\{\d+\}[^\"]*\"\s*,", statement):
            return True
        if re.search(r"\.(?:Query\w*|Execute(?:Async)?)(?:\s*<[^>]+>)?\s*\(\s*\"[^\"]*[@:][A-Za-z_]\w*[^\"]*\"\s*,\s*(?:new\s*\{|new\s+DynamicParameters|[A-Za-z_$]\w*)", statement):
            return True
        return False

    if sink_type == "xss":
        if re.search(r"(?:HtmlEncoder\.Default\.Encode|HttpUtility\.HtmlEncode|WebUtility\.HtmlEncode|AntiXssEncoder\.HtmlEncode)\s*\(", statement):
            return True
        # MVC Content defaults to text/plain; only explicit HTML is an XSS sink.
        if re.search(r"\bContent\s*\(", statement) and not re.search(r"text/html", statement, re.IGNORECASE):
            return True
        return False

    if sink_type == "path_traversal":
        if re.search(r"Path\.GetFileName\s*\(", statement):
            return True
        normalized = bool(re.search(r"Path\.GetFullPath\s*\(|\.GetFullPath\s*\(", context))
        contained = bool(re.search(r"\.StartsWith\s*\(|Path\.GetRelativePath\s*\(", context))
        traversal_rejected = bool(re.search(r"(?:StartsWith\s*\(\s*[\"']\.\.[/\\\\]|IsPathFullyQualified|\.Contains\s*\(\s*[\"']\.\.)", context))
        return (normalized and contained) or traversal_rejected

    if sink_type == "ssrf":
        scheme_checked = bool(re.search(r"\.Scheme\b|UriSchemeHttps|UriSchemeHttp", context))
        host_allowlisted = bool(re.search(
            r"(?:Allowed|Trusted)(?:Hosts|Destinations|Origins)\s*\.Contains\s*\(.*\.Host|"
            r"(?:allowed|trusted)(?:Hosts|Destinations|Origins)\s*\.Contains\s*\(.*\.Host",
            context,
            re.IGNORECASE,
        ))
        redirects_revalidated = not re.search(r"AllowAutoRedirect\s*=\s*true", context, re.IGNORECASE)
        return scheme_checked and host_allowlisted and redirects_revalidated

    if sink_type == "open_redirect":
        return bool(re.search(r"Url\.IsLocalUrl\s*\(|LocalRedirect\s*\(", context))

    if sink_type == "xxe":
        resolver_disabled = bool(re.search(r"XmlResolver\s*=\s*null", context))
        dtd_disabled = bool(re.search(r"DtdProcessing\s*=\s*DtdProcessing\.(?:Prohibit|Ignore)", context))
        return resolver_disabled and dtd_disabled

    if sink_type == "ldap_injection":
        return bool(re.search(r"(?:LdapFilterEncode|EscapeFilterValue|Encoder\.LdapFilterEncode)\s*\(", context))

    return False


def _sanitized_types(rhs: str) -> set[str]:
    sanitized = set()
    if re.search(r"(?:HtmlEncoder\.Default\.Encode|HttpUtility\.HtmlEncode|WebUtility\.HtmlEncode|AntiXssEncoder\.HtmlEncode)\s*\(", rhs):
        sanitized.add("xss")
    if re.search(r"(?:LdapFilterEncode|EscapeFilterValue|Encoder\.LdapFilterEncode)\s*\(", rhs):
        sanitized.add("ldap_injection")
    if re.search(r"Path\.GetFileName\s*\(", rhs):
        sanitized.add("path_traversal")
    return sanitized


def analyze_csharp(content: str, file_path: str = "<memory>") -> dict:
    """Analyze C# or Razor source and return evidence-oriented taint paths."""
    results = {"sources": [], "sinks": [], "potential_paths": []}
    lines = content.splitlines()
    parameter_sources = _parameter_sources(content)
    tainted: dict[str, dict] = {}
    persistent_tainted: dict[str, dict] = {}
    processed_sinks: set[tuple[int, int, str, str]] = set()

    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()

        # Avoid same-name variables leaking between controller actions.
        if _METHOD_START_RE.search(line) or re.search(r"\.Map(?:Get|Post|Put|Patch|Delete|Methods)\s*\(", line):
            tainted = {name: dict(info) for name, info in persistent_tainted.items()}

        for source in parameter_sources.get(line_number, []):
            variable = source["variable"]
            tainted[variable] = {**source, "sanitized_for": set(), "taint_line": line_number}
            if source["source_type"] in {"Parameter", "SupplyParameterFromQuery", "BindProperty"}:
                persistent_tainted[variable] = dict(tainted[variable])
            results["sources"].append({
                "line": source["source_line"],
                "variable": variable,
                "source_type": source["source_type"],
                "code": source["source_code"],
            })

        source_type, source_pattern = _source_on_line(line)
        assignment = _ASSIGN_RE.search(line)
        if assignment:
            variable = assignment.group("variable")
            rhs = assignment.group("rhs")
            rhs_source, rhs_pattern = _source_on_line(rhs)
            new_taint = None
            if rhs_source:
                new_taint = {
                    "variable": variable,
                    "source_line": line_number,
                    "source_code": stripped,
                    "source_type": rhs_source,
                    "sanitized_for": _sanitized_types(rhs),
                    "taint_line": line_number,
                }
                if not any(item["line"] == line_number and item.get("variable") == variable for item in results["sources"]):
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
                            "taint_line": line_number,
                        }
                        break
            # An assignment replaces the old value. A fixed RHS (or a
            # sanitizer applied to a fixed value) must therefore kill stale
            # taint; propagation above still preserves the original source.
            if new_taint:
                tainted[variable] = new_taint
            else:
                tainted.pop(variable, None)

        # Track object properties assigned from request data.  This matters for
        # ProcessStartInfo.Command/Arguments and similar builder APIs.
        property_assignment = _PROPERTY_ASSIGN_RE.search(line)
        if property_assignment:
            obj = property_assignment.group("object")
            prop = property_assignment.group("property")
            rhs = property_assignment.group("rhs")
            rhs_source, _ = _source_on_line(rhs)
            origin = None
            if rhs_source:
                origin = {
                    "source_line": line_number,
                    "source_code": stripped,
                    "source_type": rhs_source,
                    "sanitized_for": _sanitized_types(rhs),
                    "taint_line": line_number,
                }
            else:
                for existing, info in tainted.items():
                    if _var_in_code(existing, rhs):
                        origin = info
                        break
            if origin:
                tainted[obj] = {
                    **origin,
                    "variable": obj,
                    "tainted_property": prop,
                    "sanitized_for": set(origin.get("sanitized_for", set())) | _sanitized_types(rhs),
                }
            elif tainted.get(obj, {}).get("tainted_property") == prop:
                # Clear only the aggregate state introduced by this property;
                # component/model sources stored under their own variable name
                # remain available across method boundaries.
                tainted.pop(obj, None)

        if source_type and not any(item["line"] == line_number for item in results["sources"]):
            results["sources"].append({
                "line": line_number,
                "variable": None,
                "source_type": source_type,
                "code": stripped,
                "pattern": source_pattern,
            })

        if not _sink_matches(line):
            continue
        statement_start, statement_end, statement = _statement_containing(lines, line_number - 1)
        for sink_type, sink_name, sink_pattern in _sink_matches(statement):
            # XML .Load is ambiguous; require an XML-related receiver/constructor.
            if sink_type == "xxe" and not re.search(r"Xml|XDocument|XPath", statement, re.IGNORECASE):
                continue
            # ProcessStartInfo FileName/Arguments patterns must belong to process setup.
            if sink_type == "cmdi" and re.search(r"(?:\.|\b)(?:FileName|Arguments)\s*=", statement):
                if not re.search(r"ProcessStartInfo|\b(?:psi|startInfo|processInfo)\b", statement, re.IGNORECASE):
                    continue
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
                # Do not treat a just-declared sink result as if its LHS flowed
                # into the RHS (for example ``var cmd = new SqlCommand(...q)``).
                if (
                    assignment
                    and assignment.group("variable") == variable
                    and info.get("taint_line") == line_number
                ):
                    continue
                if not _var_in_code(variable, statement):
                    continue
                if sink_type in info.get("sanitized_for", set()):
                    continue
                if _sink_is_mitigated(lines, info["source_line"], line_number, sink_type, statement):
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
                    "note": "Variable-tracking: ASP.NET/.NET input flows to sink",
                })
                matched = True

            if not matched:
                direct_type, _ = _source_on_line(statement)
                if direct_type and not _sink_is_mitigated(
                    lines, statement_start + 1, line_number, sink_type, statement
                ):
                    results["potential_paths"].append({
                        "source_line": statement_start + 1,
                        "source_type": direct_type,
                        "source_code": statement,
                        "tainted_var": None,
                        "sink_line": line_number,
                        "sink_type": sink_type,
                        "sink_name": sink_name,
                        "sink_code": statement,
                        "confidence": "likely",
                        "note": "Direct ASP.NET request source reaches sink",
                    })

    return results


def analyze_dotnet_configuration(content: str) -> list[dict]:
    """Return high-signal ASP.NET configuration candidates for manual review."""
    findings = []
    lines = content.splitlines()
    rules = [
        (
            r"SetIsOriginAllowed\s*\(\s*[^=]*=>\s*true\s*\).*AllowCredentials\s*\(",
            "high",
            "Credentialed CORS accepts every origin",
        ),
        (
            r"ServerCertificateCustomValidationCallback\s*=\s*[^=]*=>\s*true",
            "high",
            "Outbound TLS certificate validation always succeeds",
        ),
        (
            r"DangerousAcceptAnyServerCertificateValidator",
            "high",
            "Outbound TLS certificate validation is disabled",
        ),
        (
            r"TypeNameHandling\s*=\s*TypeNameHandling\.(?!None\b)\w+",
            "high",
            "Newtonsoft.Json polymorphic type loading is enabled",
        ),
        (
            r"DtdProcessing\s*=\s*DtdProcessing\.Parse",
            "high",
            "XML DTD processing is explicitly enabled",
        ),
    ]
    for index, line in enumerate(lines, start=1):
        for pattern, severity, issue in rules:
            if re.search(pattern, line):
                findings.append({
                    "line": index,
                    "severity": severity,
                    "issue": issue,
                    "code": line.strip(),
                })
    return findings


def analyze_file_csharp(file_path: str) -> dict:
    """Analyze one C#/.NET source file using the scanner's standard schema."""
    content = Path(file_path).read_text(encoding="utf-8", errors="replace")
    result = analyze_csharp(content, file_path)
    result["configuration_findings"] = analyze_dotnet_configuration(content)
    result["file"] = file_path
    result["language"] = "csharp"
    result["total_sources"] = len(result["sources"])
    result["total_sinks"] = len(result["sinks"])
    result["total_potential_paths"] = len(result["potential_paths"])
    return result


__all__ = ["analyze_csharp", "analyze_file_csharp", "analyze_dotnet_configuration"]
