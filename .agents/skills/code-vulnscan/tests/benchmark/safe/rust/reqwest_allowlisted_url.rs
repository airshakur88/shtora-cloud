// BENCHMARK: safe - parsed HTTPS URL with an exact host allowlist
use axum::extract::Query;
use url::Url;

static ALLOWED_HOSTS: &[&str] = &["api.example.com"];

async fn proxy(Query(params): Query<ProxyParams>, client: reqwest::Client) {
    let parsed = Url::parse(&params.url)?;
    if parsed.scheme() != "https"
        || !ALLOWED_HOSTS.contains(&parsed.host_str().unwrap_or(""))
    {
        return Err("destination rejected");
    }
    client.get(parsed).send().await?;
}
