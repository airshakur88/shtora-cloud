// BENCHMARK: safe - trusted named template with untrusted context data
use axum::extract::Query;

async fn page(Query(params): Query<Page>, templates: Tera) -> String {
    let mut context = tera::Context::new();
    context.insert("name", &params.name);
    templates.render("profile.html", &context)
}
