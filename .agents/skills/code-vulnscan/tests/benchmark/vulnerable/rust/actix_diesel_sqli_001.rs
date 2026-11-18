// BENCHMARK: vulnerable - sqli
use actix_web::{web, HttpResponse};

async fn lookup(query: web::Query<Search>, conn: web::Data<Db>) -> HttpResponse {
    let sql = format!("SELECT * FROM users WHERE email = '{}'", query.email);
    let rows = diesel::sql_query(sql).load(conn.get_ref());
    HttpResponse::Ok().json(rows)
}
