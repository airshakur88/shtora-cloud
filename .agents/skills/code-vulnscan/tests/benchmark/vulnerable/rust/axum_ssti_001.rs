// BENCHMARK: vulnerable - ssti
use axum::extract::Json;

async fn preview(Json(payload): Json<Preview>) -> String {
    let template = payload.template.clone();
    Tera::one_off(&template, &tera::Context::new(), false)
}
