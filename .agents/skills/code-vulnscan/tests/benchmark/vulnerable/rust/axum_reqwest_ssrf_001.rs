// BENCHMARK: vulnerable - ssrf
use axum::extract::Query;

async fn proxy(Query(params): Query<ProxyParams>) -> String {
    let target = params.url.clone();
    reqwest::get(&target).await.text().await
}
