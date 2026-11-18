// BENCHMARK: safe - fixed SQL with a bound value
use axum::extract::{Query, State};

async fn users(Query(params): Query<Search>, State(pool): State<PgPool>) {
    sqlx::query("SELECT * FROM users WHERE name = $1")
        .bind(&params.name)
        .fetch_all(&pool)
        .await;
}
