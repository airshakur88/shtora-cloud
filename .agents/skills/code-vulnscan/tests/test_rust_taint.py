"""Focused dataflow coverage for Rust web-service analysis."""

from pathlib import Path

from scripts.taint_rust import analyze_file_rust, analyze_rust, detect_rust_frameworks


def _sink_types(content: str) -> set[str]:
    return {item["sink_type"] for item in analyze_rust(content, "inline.rs")["potential_paths"]}


def test_framework_detection_covers_primary_rust_web_stacks():
    content = """
use actix_web::web;
use axum::Router;
use warp::Filter;
use rocket::get;
"""
    assert set(detect_rust_frameworks(content)) == {"actix-web", "axum", "warp", "rocket"}


def test_actix_and_axum_extractors_flow_through_assignments():
    actix = """
async fn search(query: web::Query<Search>, pool: web::Data<PgPool>) {
    let sql = format!("SELECT * FROM users WHERE name = '{}'", query.name);
    sqlx::query(&sql).fetch_all(pool.get_ref()).await;
}
"""
    axum = """
async fn proxy(Query(params): Query<Proxy>) {
    let target = params.url.clone();
    reqwest::get(&target).await;
}
"""
    assert _sink_types(actix) == {"sqli"}
    assert _sink_types(axum) == {"ssrf"}


def test_warp_closure_and_rocket_route_parameters_are_sources():
    warp = """
let route = warp::query::<RunParams>()
    .and_then(|params: RunParams| async move {
        let command = params.command;
        Command::new("sh").arg("-c").arg(command).output()
    });
"""
    rocket = """
#[get("/files/<name>")]
async fn file(name: &str) {
    let path = format!("/srv/files/{name}");
    tokio::fs::read(path).await;
}
"""
    assert _sink_types(warp) == {"cmdi"}
    assert _sink_types(rocket) == {"path_traversal"}


def test_warp_named_handler_receives_extracted_request_data():
    content = """
fn routes() {
    let route = warp::query::<Proxy>().and_then(proxy);
}
async fn proxy(params: Proxy) {
    reqwest::get(&params.url).await;
}
"""
    assert _sink_types(content) == {"ssrf"}


def test_reqwest_and_hyper_uri_sinks_are_traced():
    reqwest = """
async fn proxy(Query(params): Query<Proxy>) {
    reqwest::get(&params.url).await;
}
"""
    hyper = """
async fn proxy(Query(params): Query<Proxy>) {
    let target = params.url.clone();
    http::Request::builder().uri(target).body(Body::empty());
}
"""
    assert _sink_types(reqwest) == {"ssrf"}
    assert _sink_types(hyper) == {"ssrf"}


def test_sqlx_and_diesel_binding_are_not_sql_injection():
    sqlx = """
async fn search(Query(params): Query<Search>, State(pool): State<PgPool>) {
    sqlx::query("SELECT * FROM users WHERE name = $1")
        .bind(&params.name)
        .fetch_all(&pool).await;
}
"""
    diesel = """
async fn search(query: web::Query<Search>, conn: web::Data<Db>) {
    diesel::sql_query("SELECT * FROM users WHERE name = $1")
        .bind::<Text, _>(&query.name)
        .load(conn.get_ref());
}
"""
    assert _sink_types(sqlx) == set()
    assert _sink_types(diesel) == set()


def test_context_appropriate_mitigations_suppress_paths():
    safe_url = """
static ALLOWED_HOSTS: &[&str] = &["api.example.com"];
async fn proxy(Query(params): Query<Proxy>, client: reqwest::Client) {
    let parsed = Url::parse(&params.url)?;
    if parsed.scheme() != "https" || !ALLOWED_HOSTS.contains(&parsed.host_str().unwrap_or("")) {
        return Err("blocked");
    }
    client.get(parsed).send().await?;
}
"""
    safe_path = """
async fn file(Path(name): Path<String>) {
    let base = dunce::canonicalize("/srv/files")?;
    let candidate = dunce::canonicalize(base.join(name))?;
    if !candidate.starts_with(&base) { return Err("blocked"); }
    tokio::fs::read(candidate).await?;
}
"""
    safe_html = """
async fn page(Query(params): Query<Page>) -> Html<String> {
    let escaped = html_escape::encode_text(&params.name);
    Html(escaped.into_owned())
}
"""
    assert _sink_types(safe_url) == set()
    assert _sink_types(safe_path) == set()
    assert _sink_types(safe_html) == set()


def test_redirect_html_template_header_and_deserializer_sinks():
    cases = {
        "open_redirect": """
async fn login(Query(params): Query<Login>) { Redirect::to(&params.next); }
""",
        "xss": """
async fn page(Query(params): Query<Page>) { Html(format!("<b>{}</b>", params.name)); }
""",
        "ssti": """
async fn preview(Json(body): Json<Preview>) { Tera::one_off(&body.template, &Context::new(), false); }
""",
        "header_injection": """
async fn header(Query(params): Query<Header>) { unsafe { HeaderValue::from_bytes_unchecked(params.value.as_bytes()) }; }
""",
        "deserialization": """
async fn import(body: web::Bytes) { let value: Import = bincode::deserialize(&body)?; }
""",
    }
    for expected, content in cases.items():
        assert expected in _sink_types(content), expected


def test_analyze_file_rust_exports_standard_contract(tmp_path: Path):
    source = tmp_path / "handler.rs"
    source.write_text(
        "use axum::extract::Query;\n"
        "async fn proxy(Query(params): Query<P>) { reqwest::get(&params.url).await; }\n"
    )
    result = analyze_file_rust(str(source))
    assert result["language"] == "rust"
    assert result["file"] == str(source)
    assert result["frameworks"] == ["axum"]
    assert result["total_sources"] == len(result["sources"])
    assert result["total_sinks"] == len(result["sinks"])
    assert result["total_potential_paths"] == len(result["potential_paths"])
    assert result["total_potential_paths"] == 1
