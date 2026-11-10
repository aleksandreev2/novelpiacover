#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archive;
mod desktop;
mod model;
mod monitor;
mod novelpia;

fn main() {
    if let Err(error) = desktop::run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
