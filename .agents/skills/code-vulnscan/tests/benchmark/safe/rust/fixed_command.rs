// BENCHMARK: safe - fixed executable with an end-of-options marker
use axum::extract::Query;
use std::process::Command;

async fn inspect(Query(params): Query<Archive>) {
    Command::new("tar")
        .arg("--list")
        .arg("--")
        .arg(&params.path)
        .output();
}
