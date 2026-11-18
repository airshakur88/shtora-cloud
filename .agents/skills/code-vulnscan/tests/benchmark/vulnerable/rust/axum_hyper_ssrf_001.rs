// BENCHMARK: vulnerable - ssrf
use axum::extract::Query;
use hyper::{Body, Request};

async fn proxy(Query(params): Query<ProxyParams>) -> Request<Body> {
    let target = params.url.clone();
    Request::builder().uri(target).body(Body::empty())
}
