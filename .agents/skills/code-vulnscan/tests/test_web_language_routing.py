"""Framework detection and route extraction for newly first-class web stacks."""

from pathlib import Path

import pytest

from scripts.orchestrate import PHASES, build_phase_payload
from scripts.routes import extract_routes, extract_routes_from_project
from scripts.scan import detect_project_frameworks
from scripts.utils.files import enumerate_files
from scripts.utils.languages import detect_frameworks, detect_language


@pytest.mark.parametrize(
    ("language", "content", "expected"),
    [
        ("kotlin", "import io.ktor.server.routing.*\nfun Application.module() { routing { } }", {"ktor"}),
        ("typescript", "import { Controller } from '@nestjs/common';\n@Controller('/users') export class Users {}", {"nestjs"}),
        ("csharp", "using Microsoft.AspNetCore.Mvc;\n[ApiController] class Users : ControllerBase {}", {"aspnet_core", "aspnet_mvc"}),
        ("csharp", "var app = WebApplication.CreateBuilder(args); app.MapGet(\"/\", () => \"ok\");", {"aspnet_core", "minimal_api"}),
        ("php", "use Drupal\\Core\\Controller\\ControllerBase;", {"drupal"}),
        ("php", "use yii\\rest\\ActiveController;", {"yii"}),
        ("ruby", "require 'hanami'\nclass App < Hanami::App; end", {"hanami"}),
        ("rust", "use actix_web::{get, HttpServer};\n#[get(\"/users\")]", {"actix_web"}),
        ("rust", "use axum::{Router, routing::get};\nRouter::new().route(\"/users\", get(users))", {"axum"}),
        ("rust", "let api = warp::path(\"users\");", {"warp"}),
        ("rust", "#[launch] fn rocket() { rocket::build() }", {"rocket"}),
    ],
)
def test_framework_detection(language, content, expected):
    assert expected <= set(detect_frameworks(Path("Example"), content, language))


@pytest.mark.parametrize(
    ("framework", "content", "expected"),
    [
        ("ktor", 'get("/users") { }\npost("/users") { }', {("GET", "/users"), ("POST", "/users")}),
        ("laravel", "Route::get('/users', handler);", {("GET", "/users")}),
        ("laravel", "Route::match(['get', 'post'], '/users', handler);", {("ANY", "/users")}),
        ("symfony", "#[Route('/users', methods: ['GET'])]", {("ANY", "/users")}),
        ("wordpress", "register_rest_route('demo/v1', '/users', []);", {("ANY", "/users")}),
        ("sinatra", "get '/users' do\nend", {("GET", "/users")}),
        ("rails", "resources :users", {("ANY", "/users")}),
        ("aspnet", 'app.MapPost("/users", CreateUser);', {("POST", "/users")}),
        ("aspnet", '[HttpGet("/users")]', {("GET", "/users")}),
        ("rust", '#[get("/users")]\nasync fn users() {}', {("GET", "/users")}),
        ("rust", '.route("/users", post(create_user))', {("POST", "/users")}),
        ("rust", '.route("/users", routing::get(list_users))', {("GET", "/users")}),
        ("rust", '.route("/users", web::post().to(create_user))', {("POST", "/users")}),
        ("rust", 'warp::path!("users" / String)', {("ANY", "/users")}),
    ],
)
def test_route_extraction(framework, content, expected):
    routes = extract_routes(content, "example", framework)
    assert expected <= {(route["method"], route["path"]) for route in routes}


def test_polyglot_framework_and_route_detection_is_not_prefix_or_global_framework_limited(tmp_path):
    files = []
    for index in range(55):
        path = tmp_path / f"module_{index:02d}.py"
        path.write_text("value = 1\n")
        files.append({"path": path, "language": "python"})

    flask = tmp_path / "app.py"
    flask.write_text("from flask import Flask\napp = Flask(__name__)\n@app.route('/python')\ndef route(): pass\n")
    files.insert(0, {"path": flask, "language": "python"})
    rust = tmp_path / "api.rs"
    rust.write_text('use axum::{Router, routing::get};\nRouter::new().route("/rust", get(handler));\n')
    files.append({"path": rust, "language": "rust"})

    frameworks = detect_project_frameworks(files)
    assert {"flask", "axum"} <= set(frameworks)

    routes = extract_routes_from_project(tmp_path, files, frameworks)
    assert {("ANY", "/python"), ("GET", "/rust")} <= {
        (route["method"], route["path"]) for route in routes
    }


def test_ktor_route_extraction_does_not_treat_http_client_calls_as_routes():
    routes = extract_routes(
        'get("/users") { client.get("https://example.test/users") }',
        "Routes.kt",
        "ktor",
    )
    assert [(route["method"], route["path"]) for route in routes] == [("GET", "/users")]


@pytest.mark.parametrize("filename", ["Index.cshtml", "Users.razor"])
def test_razor_templates_are_detected_and_enumerated_as_csharp(tmp_path, filename):
    template = tmp_path / filename
    template.write_text('@page "/users"\n@using Microsoft.AspNetCore.Components\n')
    assert detect_language(template) == "csharp"
    assert [(item["relative"], item["language"]) for item in enumerate_files(tmp_path)] == [
        (filename, "csharp")
    ]


def test_language_reviewer_phases_cover_emitted_specialized_pattern_types():
    assert {"cors", "insecure_random"} <= set(PHASES["dotnet"]["vuln_types"])
    assert {
        "ffi", "bounds_check_bypass", "integer_overflow", "integer_truncation",
        "header_injection", "insecure_random",
    } <= set(PHASES["rust"]["vuln_types"])
    assert {"code_execution", "info_disclosure"} <= set(PHASES["java"]["vuln_types"])


def test_language_reviewer_phase_filters_by_language_before_applying_limit():
    findings = [
        {
            "id": f"py-{index}", "language": "python", "vuln_type": "sqli",
            "title": "Python SQL injection", "file_path": "app.py", "line_start": index + 1,
        }
        for index in range(60)
    ]
    findings.extend([
        {
            "id": "java-1", "language": "java", "vuln_type": "sqli",
            "title": "Java SQL injection", "file_path": "App.java", "line_start": 7,
        },
        {
            "id": "php-1", "language": "php", "vuln_type": "sqli",
            "title": "PHP SQL injection", "file_path": "index.php", "line_start": 8,
        },
    ])

    payload = build_phase_payload("java", findings, {"id": "run"}, max_findings=1)

    assert payload["finding_count"] == 1
    assert [finding["id"] for finding in payload["findings"]] == ["java-1"]
