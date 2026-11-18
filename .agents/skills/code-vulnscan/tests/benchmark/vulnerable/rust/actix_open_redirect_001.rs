// BENCHMARK: vulnerable - open_redirect
use actix_web::{http::header, web, HttpResponse};

async fn login(query: web::Query<LoginParams>) -> HttpResponse {
    let next = query.next.clone();
    HttpResponse::Found()
        .append_header((header::LOCATION, next))
        .finish()
}
