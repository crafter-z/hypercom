#[path = "../cli.rs"]
mod cli;
// Compile the same wire contract as the host, without the Tauri runtime.
#[path = "../automation/wire.rs"]
mod wire;

fn main() {
    std::process::exit(cli::run(std::env::args().skip(1)));
}
