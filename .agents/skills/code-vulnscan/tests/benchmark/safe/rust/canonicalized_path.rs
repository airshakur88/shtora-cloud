// BENCHMARK: safe - canonicalized path constrained to a trusted base
use axum::extract::Path;

async fn download(Path(name): Path<String>) {
    let base = dunce::canonicalize("/srv/downloads")?;
    let candidate = dunce::canonicalize(base.join(&name))?;
    if !candidate.starts_with(&base) {
        return Err("path rejected");
    }
    tokio::fs::read(candidate).await?;
}
