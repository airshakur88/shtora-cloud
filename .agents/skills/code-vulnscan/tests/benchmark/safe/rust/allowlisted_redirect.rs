// BENCHMARK: safe - exact local redirect allowlist
use axum::{extract::Query, response::Redirect};

static ALLOWED_REDIRECTS: &[&str] = &["/", "/account"];

async fn login(Query(params): Query<LoginParams>) -> Redirect {
    let destination = params.next.clone();
    if !ALLOWED_REDIRECTS.contains(&destination.as_str()) {
        return Redirect::to("/");
    }
    Redirect::to(&destination)
}
