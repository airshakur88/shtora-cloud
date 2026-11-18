// BENCHMARK: vulnerable - cmdi
use std::process::Command;

fn route() {
    let endpoint = warp::query::<RunParams>()
        .and_then(|params: RunParams| async move {
            let command = params.command;
            Command::new("sh").arg("-c").arg(command).output()
        });
}
