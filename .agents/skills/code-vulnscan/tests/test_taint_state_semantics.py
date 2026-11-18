"""Cross-language regression coverage for assignment and scope taint state."""

import pytest

from scripts.taint import analyze_with_variable_tracking
from scripts.taint_csharp import analyze_csharp
from scripts.taint_kotlin import analyze_kotlin
from scripts.taint_rust import analyze_rust


def _analyze(language: str, code: str) -> dict:
    if language in {"javascript", "typescript", "php", "ruby"}:
        return analyze_with_variable_tracking(code, f"inline.{language}", language)
    if language == "csharp":
        return analyze_csharp(code, "Inline.cs")
    if language == "kotlin":
        return analyze_kotlin(code, "Inline.kt")
    if language == "rust":
        return analyze_rust(code, "inline.rs")
    raise AssertionError(f"unsupported test language: {language}")


@pytest.mark.parametrize(
    ("language", "sink_type", "code"),
    [
        ("javascript", "ssrf", '''
function proxy(req) {
  let url = req.query.url;
  url = "https://fixed.example.test";
  fetch(url);
}
'''),
        ("typescript", "ssrf", '''
function proxy(req: Request) {
  let url: string = req.query.url;
  url = "https://fixed.example.test";
  fetch(url);
}
'''),
        ("php", "cmdi", '''
function run() {
  $command = $_GET["command"];
  $command = "date";
  exec($command);
}
'''),
        ("ruby", "ssrf", '''
def proxy
  url = params[:url]
  url = "https://fixed.example.test"
  Net::HTTP.get(URI(url))
end
'''),
        ("csharp", "ssrf", '''
class ProxyController : ControllerBase {
  [HttpGet] public Task<string> Proxy([FromQuery] string url) {
    url = "https://fixed.example.test";
    return client.GetStringAsync(url);
  }
}
'''),
        ("kotlin", "ssrf", '''
fun proxy(call: ApplicationCall, client: HttpClient) {
  var url = call.parameters["url"]!!
  url = "https://fixed.example.test"
  client.get(url)
}
'''),
        ("rust", "ssrf", '''
async fn proxy(Query(params): Query<Proxy>) {
    let mut url = params.url.clone();
    url = "https://fixed.example.test".to_string();
    reqwest::get(&url).await;
}
'''),
    ],
)
def test_clean_reassignment_kills_old_taint(language, sink_type, code):
    paths = _analyze(language, code)["potential_paths"]
    assert not [path for path in paths if path["sink_type"] == sink_type]


@pytest.mark.parametrize(
    ("language", "sink_type", "copy_name", "code"),
    [
        ("javascript", "ssrf", "copy", '''
function proxy(req) {
  const url = req.query.url;
  const copy = url;
  fetch(copy);
}
'''),
        ("typescript", "ssrf", "copy", '''
function proxy(req: Request) {
  const url: string = req.query.url;
  const copy: string = url;
  fetch(copy);
}
'''),
        ("php", "cmdi", "copy", '''
function run() {
  $command = $_GET["command"];
  $copy = $command;
  exec($copy);
}
'''),
        ("ruby", "ssrf", "copy", '''
def proxy
  url = params[:url]
  copy = url
  Net::HTTP.get(URI(copy))
end
'''),
        ("csharp", "ssrf", "copy", '''
class ProxyController : ControllerBase {
  [HttpGet] public Task<string> Proxy([FromQuery] string url) {
    var copy = url;
    return client.GetStringAsync(copy);
  }
}
'''),
        ("kotlin", "ssrf", "copy", '''
fun proxy(call: ApplicationCall, client: HttpClient) {
  val url = call.parameters["url"]!!
  val copy = url
  client.get(copy)
}
'''),
        ("rust", "ssrf", "copy", '''
async fn proxy(Query(params): Query<Proxy>) {
    let url = params.url.clone();
    let copy = url.clone();
    reqwest::get(&copy).await;
}
'''),
    ],
)
def test_tainted_copy_preserves_original_flow(language, sink_type, copy_name, code):
    paths = [
        path for path in _analyze(language, code)["potential_paths"]
        if path["sink_type"] == sink_type
    ]
    assert paths
    assert {path["tainted_var"] for path in paths} == {copy_name}


@pytest.mark.parametrize(
    ("language", "code"),
    [
        ("javascript", '''
function capture(req) {
  const value = req.query.url;
}
function helper(value) {
  fetch(value);
}
'''),
        ("typescript", '''
function capture(req: Request) {
  const value: string = req.query.url;
}
function helper(value: string) {
  fetch(value);
}
'''),
        ("php", '''
function capture() {
  $value = $_GET["command"];
}
function helper($value) {
  exec($value);
}
'''),
        ("ruby", '''
def capture
  value = params[:url]
end
def helper(value)
  Net::HTTP.get(URI(value))
end
'''),
        ("csharp", '''
class Helpers {
  [HttpGet] public void Capture([FromQuery] string value) { }
  private Task Helper(string value) {
    return client.GetStringAsync(value);
  }
}
'''),
        ("kotlin", '''
fun capture(@RequestParam value: String) { }
fun helper(value: String) {
  client.get(value)
}
'''),
        ("rust", '''
async fn capture(Query(value): Query<Proxy>) { }
async fn helper(value: String) {
    reqwest::get(&value).await;
}
'''),
    ],
)
def test_same_variable_name_does_not_leak_between_functions(language, code):
    assert _analyze(language, code)["potential_paths"] == []


@pytest.mark.parametrize(
    ("language", "code"),
    [
        ("javascript", '''
class Proxy {
  capture(req) {
    const value = req.query.url;
  }
  helper(value) {
    fetch(value);
  }
}
'''),
        ("typescript", '''
class Proxy {
  public capture(req: Request): void {
    const value: string = req.query.url;
  }
  private helper(value: string): Promise<Response> {
    return fetch(value);
  }
}
'''),
    ],
)
def test_javascript_class_methods_have_independent_taint_state(language, code):
    assert _analyze(language, code)["potential_paths"] == []


@pytest.mark.parametrize(
    ("language", "code"),
    [
        ("javascript", '''
function page(req) {
  let html = req.query.html;
  html = DOMPurify.sanitize(html);
  element.innerHTML = html;
}
'''),
        ("typescript", '''
function page(req: Request) {
  let html: string = req.query.html;
  html = DOMPurify.sanitize(html);
  element.innerHTML = html;
}
'''),
        ("php", '''
function page() {
  $html = $_GET["html"];
  $html = htmlspecialchars($html, ENT_QUOTES, "UTF-8");
  echo $html;
}
'''),
        ("ruby", '''
def page
  html = params[:html]
  html = ERB::Util.html_escape(html)
  render html: html
end
'''),
        ("csharp", '''
class PageController : ControllerBase {
  [HttpGet] public object Page([FromQuery] string html) {
    html = HtmlEncoder.Default.Encode(html);
    return Html.Raw(html);
  }
}
'''),
        ("kotlin", '''
fun page(call: ApplicationCall) {
  var html = call.parameters["html"]!!
  html = escapeHtml(html)
  call.respondText(html, ContentType.Text.Html)
}
'''),
        ("rust", '''
async fn page(Query(params): Query<Page>) -> Html<String> {
    let mut html = params.html.clone();
    html = ammonia::clean(&html);
    Html(html)
}
'''),
    ],
)
def test_sanitizer_reassignment_clears_relevant_taint(language, code):
    assert _analyze(language, code)["potential_paths"] == []


@pytest.mark.parametrize(
    ("language", "code"),
    [
        ("javascript", '''
function run(req) {
  let command = req.query.command;
  command = escapeHtml(command);
  child_process.exec(command);
}
'''),
        ("php", '''
function run() {
  $command = $_GET["command"];
  $command = htmlspecialchars($command, ENT_QUOTES, "UTF-8");
  exec($command);
}
'''),
        ("ruby", '''
def run
  command = params[:command]
  command = ERB::Util.html_escape(command)
  system(command)
end
'''),
    ],
)
def test_context_specific_sanitizer_does_not_hide_other_sink_types(language, code):
    paths = _analyze(language, code)["potential_paths"]
    assert {path["sink_type"] for path in paths} == {"cmdi"}
