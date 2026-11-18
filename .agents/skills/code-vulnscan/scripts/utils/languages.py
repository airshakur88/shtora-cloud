"""Language and framework detection utilities."""

import re
from pathlib import Path

EXTENSION_MAP = {
    ".py": "python",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".jsx": "javascript",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".jsp": "java",
    ".jspx": "java",
    ".jspf": "java",
    ".tag": "java",
    ".tagx": "java",
    ".go": "go",
    ".php": "php",
    ".rb": "ruby",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".cshtml": "csharp",
    ".razor": "csharp",
    ".rs": "rust",
    ".swift": "swift",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".tf": "terraform",
    ".tfvars": "terraform",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".json": "json",
    ".xml": "xml",
    ".html": "html",
    ".htm": "html",
    ".jinja": "jinja2",
    ".jinja2": "jinja2",
    ".j2": "jinja2",
    ".twig": "twig",
    ".erb": "erb",
    ".ejs": "ejs",
    ".hbs": "handlebars",
    ".mustache": "mustache",
    ".blade.php": "php",
    ".dockerfile": "dockerfile",
    ".env": "dotenv",
    ".ini": "ini",
    ".toml": "toml",
    ".properties": "properties",
}

FRAMEWORK_SIGNALS = {
    "python": {
        "flask": ["from flask import", "import flask", "Flask(__name__)", "@app.route"],
        "django": ["from django", "import django", "django.db", "INSTALLED_APPS"],
        "fastapi": ["from fastapi", "import fastapi", "FastAPI()", "@app.get", "@router.get"],
        "tornado": ["import tornado", "tornado.web"],
        "aiohttp": ["from aiohttp", "import aiohttp", "web.Application()"],
        "pyramid": ["from pyramid", "import pyramid"],
    },
    "javascript": {
        "express": ["require('express')", "from 'express'", "express()", "app.get(", "router.get("],
        "nextjs": ["from 'next'", "require('next')", "getServerSideProps", "getStaticProps"],
        "nestjs": ["@Module", "@Controller", "@Injectable", "from '@nestjs"],
        "koa": ["require('koa')", "from 'koa'", "new Koa()"],
        "hapi": ["require('@hapi/hapi')", "Hapi.server("],
        "react": ["from 'react'", "require('react')", "React.createElement", "useState", "useEffect"],
        "vue": ["from 'vue'", "createApp(", "Vue.component("],
    },
    "java": {
        "spring": ["@SpringBootApplication", "@RestController", "@Controller", "@Service", "@Repository",
                   "org.springframework"],
        "spring_boot": ["@SpringBootApplication", "@EnableAutoConfiguration", "org.springframework.boot"],
        "spring_mvc": ["org.springframework.web", "@RestController", "@RequestMapping", "@GetMapping",
                       "@PostMapping", "DispatcherServlet"],
        "spring_security": ["org.springframework.security", "@EnableWebSecurity", "SecurityFilterChain",
                            "WebSecurityConfigurerAdapter"],
        "spring_data": ["org.springframework.data", "JpaRepository", "CrudRepository", "PagingAndSortingRepository"],
        "struts": ["import org.apache.struts", "ActionSupport"],
        "jersey": ["org.glassfish.jersey", "com.sun.jersey", "import javax.ws.rs", "import jakarta.ws.rs"],
        "dropwizard": ["io.dropwizard"],
        "jakarta_ee": ["jakarta.platform", "jakarta.enterprise", "javax.enterprise", "jakarta.ejb", "javax.ejb",
                       "@ApplicationScoped", "@Stateless"],
        "jax_rs": ["javax.ws.rs", "jakarta.ws.rs", "@Path(", "@Produces(", "@Consumes("],
        "servlet": ["javax.servlet", "jakarta.servlet", "HttpServlet", "HttpServletRequest", "doGet", "doPost"],
        "jsf": ["javax.faces", "jakarta.faces", "FacesContext", "@FacesConfig"],
        "hibernate": ["org.hibernate", "SessionFactory", "Hibernate.initialize"],
        "jpa": ["javax.persistence", "jakarta.persistence", "@Entity", "EntityManager"],
        "micronaut": ["io.micronaut", "@MicronautTest", "Micronaut.run"],
        "quarkus": ["io.quarkus", "@QuarkusMain", "@QuarkusTest", "Quarkus.run"],
    },
    "kotlin": {
        "spring": ["@SpringBootApplication", "@RestController", "@Service", "org.springframework"],
        "spring_boot": ["@SpringBootApplication", "org.springframework.boot"],
        "spring_mvc": ["org.springframework.web", "@RestController", "@RequestMapping", "@GetMapping"],
        "spring_security": ["org.springframework.security", "@EnableWebSecurity", "SecurityFilterChain"],
        "spring_data": ["org.springframework.data", "JpaRepository", "CrudRepository"],
        "jakarta_ee": ["jakarta.enterprise", "javax.enterprise", "jakarta.ejb", "javax.ejb"],
        "jax_rs": ["javax.ws.rs", "jakarta.ws.rs", "@Path(", "@Produces("],
        "servlet": ["javax.servlet", "jakarta.servlet", "HttpServlet"],
        "jsf": ["javax.faces", "jakarta.faces", "FacesContext"],
        "hibernate": ["org.hibernate", "SessionFactory"],
        "jpa": ["javax.persistence", "jakarta.persistence", "@Entity", "EntityManager"],
        "micronaut": ["io.micronaut", "@MicronautTest", "Micronaut.run"],
        "quarkus": ["io.quarkus", "@QuarkusMain", "@QuarkusTest", "Quarkus.run"],
        "ktor": ["io.ktor", "ApplicationCall", "Route.", "routing {", "call.receive", "call.respond"],
    },
    "php": {
        "laravel": ["use Illuminate", "App\\", "artisan", "Eloquent"],
        "symfony": ["use Symfony", "Symfony\\Component"],
        "wordpress": ["wp_query", "get_post", "add_action", "WP_"],
        "codeigniter": ["CI_Controller", "$this->load->model"],
        "drupal": ["Drupal\\Core", "\\Drupal::", "hook_form_alter", "ControllerBase"],
        "yii": ["yii\\web", "yii\\rest", "Yii::$app", "ActiveController"],
    },
    "ruby": {
        "rails": ["Rails.application", "ActiveRecord::Base", "ActionController", "has_many", "belongs_to"],
        "sinatra": ["require 'sinatra'", "Sinatra::Base"],
        "hanami": ["Hanami::App", "Hanami::Action", "require \"hanami\"", "require 'hanami'"],
    },
    "go": {
        "gin": ['"github.com/gin-gonic/gin"', "gin.Default()", "gin.New()"],
        "echo": ['"github.com/labstack/echo"', "echo.New()"],
        "fiber": ['"github.com/gofiber/fiber"', "fiber.New()"],
        "chi": ['"github.com/go-chi/chi"'],
        "gorilla": ['"github.com/gorilla/mux"'],
        "stdlib": ["net/http", "http.HandleFunc", "http.ServeMux"],
    },
    "csharp": {
        "aspnet_core": ["Microsoft.AspNetCore", "WebApplication.CreateBuilder", "ControllerBase", "[ApiController]"],
        "aspnet_mvc": ["System.Web.Mvc", "Microsoft.AspNetCore.Mvc", "[HttpGet", "[HttpPost", "[Route("],
        "minimal_api": ["MapGet(", "MapPost(", "MapPut(", "MapDelete(", "MapGroup("],
        "blazor": ["Microsoft.AspNetCore.Components", "ComponentBase", "@page ", "NavigationManager"],
        "ef_core": ["Microsoft.EntityFrameworkCore", "DbContext", "DbSet<", "FromSqlRaw("],
        "dapper": ["using Dapper", ".QueryAsync<", ".ExecuteAsync("],
    },
    "rust": {
        "actix_web": ["actix_web", "HttpServer::new", "web::Data", "#[get(\"", "#[post(\""],
        "axum": ["axum::", "Router::new", ".route(", "State<", "Extension<"],
        "warp": ["warp::", "warp::path", "warp::serve"],
        "rocket": ["#[macro_use] extern crate rocket", "rocket::", "#[launch]", "#[get(\"", "#[post(\""],
    },
}

SKIP_DIRS = {
    "node_modules", ".git", "vendor", "__pycache__", ".tox", "venv", ".venv",
    "env", ".env", "dist", "build", "target", ".gradle", ".mvn",
    "coverage", ".coverage", "htmlcov", ".pytest_cache", ".mypy_cache",
    "site-packages", "eggs", ".eggs", "migrations", "static", "assets",
    "public", "media", "uploads", ".idea", ".vscode", ".DS_Store",
}

SOURCE_EXTENSIONS = set(
    ext for ext, lang in EXTENSION_MAP.items()
    if lang in {"python", "javascript", "typescript", "java", "kotlin", "go",
                "php", "ruby", "c", "cpp", "csharp", "rust", "swift", "bash"}
)

CONFIG_EXTENSIONS = {".yaml", ".yml", ".json", ".xml", ".env", ".ini", ".toml",
                     ".properties", ".tf", ".tfvars", ".dockerfile"}


def detect_language(file_path: Path) -> str:
    name = file_path.name.lower()
    if name == "dockerfile":
        return "dockerfile"
    if name == ".env" or name.startswith(".env."):
        return "dotenv"
    if name == "gemfile" or name == "gemfile.lock":
        return "ruby"
    if name in ("makefile", "gnumakefile"):
        return "make"
    if name.endswith(".blade.php"):
        return "php"
    ext = file_path.suffix.lower()
    return EXTENSION_MAP.get(ext, "unknown")


def detect_frameworks(file_path: Path, content: str, language: str) -> list:
    found = []
    # JavaScript frameworks are commonly authored in TypeScript; keep the
    # language identity for analyzers while sharing framework signals.
    signal_language = "javascript" if language == "typescript" else language
    signals = FRAMEWORK_SIGNALS.get(signal_language, {})
    for framework, patterns in signals.items():
        if any(p in content for p in patterns):
            found.append(framework)
    return found


def is_test_file(file_path: Path) -> bool:
    parts = {p.lower() for p in file_path.parts}
    if "test" in parts or "tests" in parts or "spec" in parts or "__tests__" in parts:
        return True
    name = file_path.stem.lower()
    return (name.startswith("test_") or name.endswith("_test") or
            name.startswith("spec_") or name.endswith("_spec") or
            name.endswith(".test") or name.endswith(".spec"))


def is_generated_file(file_path: Path) -> bool:
    name = file_path.name.lower()
    generated_indicators = [
        "bundle.js", "bundle.min.js", ".min.js", ".min.css",
        "package-lock.json", "yarn.lock", "poetry.lock", "pipfile.lock",
        ".pb.go", "_pb2.py", "_pb2_grpc.py", "*.generated.",
    ]
    return any(name.endswith(ind.lstrip("*")) for ind in generated_indicators)


def should_skip_dir(dir_path: Path) -> bool:
    return dir_path.name.lower() in SKIP_DIRS or dir_path.name.startswith(".")


def get_manifest_files(base_path: Path) -> list:
    manifests = []
    manifest_names = {
        "requirements.txt", "requirements-dev.txt", "requirements-prod.txt",
        "pipfile", "pipfile.lock", "pyproject.toml", "poetry.lock", "setup.py", "setup.cfg",
        "package.json", "pom.xml", "build.gradle", "build.gradle.kts",
        "libs.versions.toml", "gradle.lockfile",
        "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
        "go.mod", "go.sum", "gemfile", "gemfile.lock", "composer.json", "composer.lock",
        "cargo.toml", "cargo.lock", "packages.config", "packages.lock.json",
        "directory.packages.props", "paket.dependencies", "paket.lock",
    }
    manifest_suffixes = {".csproj", ".fsproj", ".vbproj"}
    for p in base_path.rglob("*"):
        name_lower = p.name.lower()
        if p.is_file() and (
            name_lower in manifest_names
            or name_lower.endswith(".versions.toml")
            or p.suffix.lower() in manifest_suffixes
        ):
            if not any(part.lower() in SKIP_DIRS for part in p.parts):
                manifests.append(p)
    return sorted(manifests)
