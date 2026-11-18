// BENCHMARK: safe - transport and decoder limits
use actix_web::web;
use bincode::Options;

async fn import(body: web::Bytes) {
    let object: Import = bincode::options()
        .with_limit(1_048_576)
        .deserialize(&body)?;
    save(object);
}
