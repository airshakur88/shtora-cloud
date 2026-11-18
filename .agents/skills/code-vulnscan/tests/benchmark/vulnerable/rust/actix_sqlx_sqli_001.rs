// BENCHMARK: vulnerable - sqli
use actix_web::{get, web, HttpResponse};
use sqlx::PgPool;

#[get("/users")]
async fn users(query: web::Query<Search>, pool: web::Data<PgPool>) -> HttpResponse {
    let sql = format!("SELECT * FROM users WHERE name = '{}'", query.name);
    let rows = sqlx::query(&sql).fetch_all(pool.get_ref()).await;
    HttpResponse::Ok().json(rows)
}
