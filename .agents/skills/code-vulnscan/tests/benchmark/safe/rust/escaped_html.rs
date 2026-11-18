// BENCHMARK: safe - contextual HTML text encoding
use axum::{extract::Query, response::Html};

async fn search(Query(params): Query<Search>) -> Html<String> {
    let escaped = html_escape::encode_text(&params.term);
    Html(escaped.into_owned())
}
