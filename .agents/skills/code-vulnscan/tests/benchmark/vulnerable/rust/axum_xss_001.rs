// BENCHMARK: vulnerable - xss
use axum::{extract::Query, response::Html};

async fn search(Query(params): Query<SearchParams>) -> Html<String> {
    let term = params.term.clone();
    Html(format!("<h1>Results for {term}</h1>"))
}
