"""Kotlin/JVM web taint analysis regression tests."""

from scripts.taint import analyze_file
from scripts.taint_kotlin import analyze_file_kotlin


def _types(result):
    return {path["sink_type"] for path in result["potential_paths"]}


def test_spring_annotated_parameter_flows_to_native_query(tmp_path):
    source = tmp_path / "UsersController.kt"
    source.write_text(
        """import org.springframework.web.bind.annotation.*
@RestController
class UsersController(private val entityManager: EntityManager) {
  @GetMapping("/users")
  fun users(@RequestParam name: String): Any {
    val sql = "SELECT * FROM users WHERE name = '$name'"
    return entityManager.createNativeQuery(sql).resultList
  }
}
"""
    )

    result = analyze_file_kotlin(str(source))
    paths = [path for path in result["potential_paths"] if path["sink_type"] == "sqli"]
    assert len(paths) == 1
    assert paths[0]["tainted_var"] == "sql"
    assert paths[0]["source_line"] == 5
    assert paths[0]["sink_line"] == 7


def test_ktor_request_sources_reach_ssrf_path_and_redirect_sinks(tmp_path):
    source = tmp_path / "Routes.kt"
    source.write_text(
        """fun Route.external(client: HttpClient) {
  get("/fetch") {
    val target = call.request.queryParameters["url"]!!
    client.get(target)
  }
  get("/files") {
    val name = call.parameters["name"]!!
    call.respondFile(File("/srv/files", name))
  }
  get("/redirect") {
    val next = call.parameters["next"]!!
    call.respondRedirect(next)
  }
}
"""
    )

    assert {"ssrf", "path_traversal", "open_redirect"} <= _types(analyze_file_kotlin(str(source)))


def test_parameter_binding_and_context_specific_validation_suppress_paths(tmp_path):
    source = tmp_path / "SafeController.kt"
    source.write_text(
        """class SafeController(private val entityManager: EntityManager) {
  fun search(@RequestParam name: String): Any {
    return entityManager.createNativeQuery("SELECT * FROM users WHERE name = :name")
      .setParameter("name", name)
      .resultList
  }
  suspend fun fetch(call: ApplicationCall, client: HttpClient) {
    val target = call.parameters["url"]!!
    val parsed = URI.create(target)
    if (parsed.scheme != "https" || !allowedHosts.contains(parsed.host)) return
    client.get(target)
  }
  fun read(@RequestParam name: String): ByteArray {
    val root = Paths.get("/srv/files").toRealPath()
    val candidate = root.resolve(name).normalize()
    require(candidate.startsWith(root))
    return Files.readAllBytes(candidate)
  }
}
"""
    )

    assert _types(analyze_file_kotlin(str(source))) == set()


def test_kotlin_dispatcher_uses_dedicated_analyzer(tmp_path):
    source = tmp_path / "CommandController.kt"
    source.write_text(
        """class CommandController {
  fun run(@RequestParam command: String) {
    Runtime.getRuntime().exec(command)
  }
}
"""
    )

    result = analyze_file(str(source))
    assert result["language"] == "kotlin"
    assert _types(result) == {"cmdi"}


def test_unrelated_parameter_binding_does_not_sanitize_dynamic_sql(tmp_path):
    source = tmp_path / "MixedQueryController.kt"
    source.write_text(
        '''class MixedQueryController(private val entityManager: EntityManager) {
  fun search(@RequestParam name: String): Any {
    val sql = "SELECT * FROM users WHERE name = '$name' AND active = :active"
    return entityManager.createNativeQuery(sql)
      .setParameter("active", true)
      .resultList
  }
}
'''
    )

    assert _types(analyze_file_kotlin(str(source))) == {"sqli"}


def test_taint_state_is_method_local_and_forward_only(tmp_path):
    source = tmp_path / "ScopedController.kt"
    source.write_text(
        """class ScopedController {
  fun safe(name: String) {
    Runtime.getRuntime().exec(name)
  }
  fun unsafe(@RequestParam name: String) {
    Runtime.getRuntime().exec(name)
  }
}
"""
    )

    paths = analyze_file_kotlin(str(source))["potential_paths"]
    assert len(paths) == 1
    assert paths[0]["sink_line"] == 6


def test_ktor_routes_do_not_share_taint_and_plain_text_is_not_xss(tmp_path):
    source = tmp_path / "Routes.kt"
    source.write_text(
        """fun Route.routes() {
  get("/plain") {
    val value = call.parameters["value"]!!
    call.respondText(value)
  }
  get("/safe-command") {
    val value = "fixed"
    Runtime.getRuntime().exec(value)
  }
}
"""
    )

    assert _types(analyze_file_kotlin(str(source))) == set()


def test_ktor_html_response_with_request_data_is_xss(tmp_path):
    source = tmp_path / "HtmlRoute.kt"
    source.write_text(
        """fun Route.html() {
  get("/html") {
    val value = call.parameters["value"]!!
    call.respondText(value, ContentType.Text.Html)
  }
}
"""
    )

    assert _types(analyze_file_kotlin(str(source))) == {"xss"}
