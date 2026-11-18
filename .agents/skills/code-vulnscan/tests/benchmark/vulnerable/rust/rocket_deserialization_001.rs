// BENCHMARK: vulnerable - deserialization
use rocket::data::{Data, ToByteUnit};

#[post("/import", data = "<body>")]
async fn import(body: Data<'_>) {
    let bytes = body.open(64.mebibytes()).into_bytes().await.value;
    let object: Import = bincode::deserialize(&bytes).expect("invalid import");
    save(object);
}
