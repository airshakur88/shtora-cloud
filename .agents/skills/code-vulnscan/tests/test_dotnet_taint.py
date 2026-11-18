"""Focused source-to-sink and false-positive tests for C#/.NET analysis."""

from scripts.taint_csharp import (
    analyze_csharp,
    analyze_dotnet_configuration,
    analyze_file_csharp,
)


def _paths(code: str, sink_type: str) -> list[dict]:
    return [
        path
        for path in analyze_csharp(code, "Example.cs")["potential_paths"]
        if path["sink_type"] == sink_type
    ]


def test_fromquery_parameter_flows_to_interpolated_sql_not_command_injection():
    code = '''
class UsersController : ControllerBase
{
    [HttpGet("search")]
    public IActionResult Search([FromQuery] string term)
    {
        using var command = new SqlCommand($"SELECT * FROM users WHERE name = '{term}'", connection);
        using var reader = command.ExecuteReader();
        return Ok();
    }
}
'''
    result = analyze_csharp(code, "UsersController.cs")
    sql_paths = [path for path in result["potential_paths"] if path["sink_type"] == "sqli"]

    assert len(sql_paths) == 1
    assert sql_paths[0]["tainted_var"] == "term"
    assert sql_paths[0]["source_line"] < sql_paths[0]["sink_line"]
    assert not any(path["sink_type"] == "cmdi" for path in result["potential_paths"])
    assert not any(sink["sink_type"] == "cmdi" for sink in result["sinks"])


def test_action_parameters_without_individual_binding_attributes_are_sources():
    code = '''
class FilesController : ControllerBase
{
    [HttpGet("download/{name}")]
    public IActionResult Download(string name)
    {
        return PhysicalFile(Path.Combine(_root, name), "application/octet-stream");
    }
}
'''
    paths = _paths(code, "path_traversal")
    assert len(paths) == 1
    assert paths[0]["tainted_var"] == "name"
    assert paths[0]["source_type"] == "mvc_action_parameter"


def test_minimal_api_dto_and_string_parameters_are_sources_but_services_are_not():
    code = '''
app.MapPost("/preview", async (PreviewRequest input, HttpClient client, CancellationToken cancellationToken) =>
{
    return await client.GetStringAsync(input.Target, cancellationToken);
});
'''
    result = analyze_csharp(code, "Program.cs")
    paths = [path for path in result["potential_paths"] if path["sink_type"] == "ssrf"]
    source_names = {source.get("variable") for source in result["sources"]}

    assert len(paths) == 1
    assert paths[0]["tainted_var"] == "input"
    assert "input" in source_names
    assert "client" not in source_names
    assert "cancellationToken" not in source_names


def test_minimal_api_sources_do_not_leak_to_later_handler_with_same_name():
    code = '''
app.MapGet("/unsafe", (string url, HttpClient client) =>
    client.GetStringAsync(url));

app.MapGet("/safe", (HttpClient client) =>
{
    const string url = "https://api.example.test/health";
    return client.GetStringAsync(url);
});
'''
    paths = _paths(code, "ssrf")
    assert len(paths) == 1
    assert "unsafe" in paths[0]["source_code"]


def test_dapper_parameter_object_and_ef_interpolated_api_are_clean():
    code = '''
class SearchController : ControllerBase
{
    [HttpGet]
    public object Search([FromQuery] string term)
    {
        var first = connection.Query<User>(
            "SELECT * FROM users WHERE name = @term", new { term });
        return context.Users.FromSqlInterpolated(
            $"SELECT * FROM users WHERE name = {term}").ToList();
    }
}
'''
    assert _paths(code, "sqli") == []


def test_ef_raw_and_dapper_interpolated_queries_are_reported():
    code = '''
class SearchController : ControllerBase
{
    [HttpGet]
    public object Search([FromQuery] string term)
    {
        var first = context.Users.FromSqlRaw($"SELECT * FROM users WHERE name = '{term}'");
        return connection.Query<User>($"SELECT * FROM users WHERE name = '{term}'");
    }
}
'''
    assert len(_paths(code, "sqli")) == 2


def test_html_encoding_breaks_xss_path_but_blazor_markup_string_is_reported():
    safe = '''
class PreviewController : ControllerBase
{
    [HttpGet]
    public object Preview([FromQuery] string html)
    {
        var encoded = HtmlEncoder.Default.Encode(html);
        return Html.Raw(encoded);
    }
}
'''
    unsafe = '''
class PreviewComponent
{
    [Parameter] public string Content { get; set; } = "";
    public MarkupString Render() => (MarkupString)Content;
}
'''
    assert _paths(safe, "xss") == []
    paths = _paths(unsafe, "xss")
    assert len(paths) == 1
    assert paths[0]["tainted_var"] == "Content"


def test_path_canonicalization_and_containment_suppress_traversal():
    safe = '''
class FilesController : ControllerBase
{
    [HttpGet]
    public string Read([FromQuery] string name)
    {
        var root = Path.GetFullPath(_root) + Path.DirectorySeparatorChar;
        var candidate = Path.GetFullPath(Path.Combine(root, name));
        if (!candidate.StartsWith(root, StringComparison.Ordinal)) throw new UnauthorizedAccessException();
        return File.ReadAllText(candidate);
    }
}
'''
    unsafe = '''
class FilesController : ControllerBase
{
    [HttpGet]
    public string Read([FromQuery] string name)
    {
        var candidate = Path.Combine(_root, name);
        return File.ReadAllText(candidate);
    }
}
'''
    assert _paths(safe, "path_traversal") == []
    assert len(_paths(unsafe, "path_traversal")) == 1


def test_ssrf_requires_scheme_and_host_allowlist_to_suppress():
    safe = '''
class ProxyController : ControllerBase
{
    [HttpGet]
    public async Task<string> Get([FromQuery] string target)
    {
        var uri = new Uri(target);
        if (uri.Scheme != Uri.UriSchemeHttps || !AllowedHosts.Contains(uri.Host)) throw new Exception();
        return await client.GetStringAsync(uri);
    }
}
'''
    unsafe = '''
class ProxyController : ControllerBase
{
    [HttpGet]
    public Task<string> Get([FromQuery] string target)
    {
        var uri = new Uri(target);
        return client.GetStringAsync(uri);
    }
}
'''
    assert _paths(safe, "ssrf") == []
    assert len(_paths(unsafe, "ssrf")) == 1


def test_local_redirect_validation_suppresses_open_redirect():
    safe = '''
class LoginController : Controller
{
    [HttpGet]
    public IActionResult Done([FromQuery] string returnUrl)
    {
        if (!Url.IsLocalUrl(returnUrl)) return BadRequest();
        return Redirect(returnUrl);
    }
}
'''
    unsafe = safe.replace(
        'if (!Url.IsLocalUrl(returnUrl)) return BadRequest();',
        '// missing local URL validation',
    )
    assert _paths(safe, "open_redirect") == []
    assert len(_paths(unsafe, "open_redirect")) == 1


def test_xml_reader_mitigation_requires_both_dtd_and_resolver_controls():
    safe = '''
class XmlController : ControllerBase
{
    [HttpPost]
    public void Parse([FromBody] string payload)
    {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
        using var reader = XmlReader.Create(new StringReader(payload), settings);
    }
}
'''
    unsafe = safe.replace("DtdProcessing.Prohibit", "DtdProcessing.Parse").replace(
        "XmlResolver = null", "XmlResolver = new XmlUrlResolver()"
    )
    assert _paths(safe, "xxe") == []
    assert len(_paths(unsafe, "xxe")) == 1


def test_process_start_info_argument_assignment_is_tracked():
    code = '''
class ToolsController : ControllerBase
{
    [HttpPost]
    public void Run([FromForm] string command)
    {
        var startInfo = new ProcessStartInfo { FileName = "/bin/sh", Arguments = "-c " + command };
        Process.Start(startInfo);
    }
}
'''
    paths = _paths(code, "cmdi")
    assert paths
    assert all(path["tainted_var"] in {"command", "startInfo"} for path in paths)


def test_configuration_candidates_are_high_signal():
    findings = analyze_dotnet_configuration(
        '''
options.ServerCertificateCustomValidationCallback = (_, _, _, _) => true;
settings.TypeNameHandling = TypeNameHandling.Auto;
settings.DtdProcessing = DtdProcessing.Parse;
'''
    )
    assert {finding["issue"] for finding in findings} == {
        "Outbound TLS certificate validation always succeeds",
        "Newtonsoft.Json polymorphic type loading is enabled",
        "XML DTD processing is explicitly enabled",
    }


def test_analyze_file_csharp_exports_standard_result_shape(tmp_path):
    source = tmp_path / "EchoController.cs"
    source.write_text(
        '''class EchoController : ControllerBase {
  [HttpGet] public object Echo([FromQuery] string value) => Html.Raw(value);
}'''
    )
    result = analyze_file_csharp(str(source))

    assert result["file"] == str(source)
    assert result["language"] == "csharp"
    assert result["total_sources"] == 1
    assert result["total_potential_paths"] == 1
    assert "configuration_findings" in result
