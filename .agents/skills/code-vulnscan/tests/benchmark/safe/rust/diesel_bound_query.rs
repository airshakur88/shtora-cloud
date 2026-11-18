// BENCHMARK: safe - Diesel raw SQL with a bound value
use actix_web::web;
use diesel::sql_types::Text;

async fn users(query: web::Query<Search>, conn: web::Data<Db>) {
    diesel::sql_query("SELECT * FROM users WHERE name = $1")
        .bind::<Text, _>(&query.name)
        .load(conn.get_ref());
}
