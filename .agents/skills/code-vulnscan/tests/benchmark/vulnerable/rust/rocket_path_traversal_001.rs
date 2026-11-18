// BENCHMARK: vulnerable - path_traversal
use rocket::fs::NamedFile;

#[get("/files/<name>")]
async fn download(name: &str) -> Option<NamedFile> {
    let path = format!("/srv/downloads/{name}");
    NamedFile::open(path).await.ok()
}
