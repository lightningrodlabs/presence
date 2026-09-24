//! Desktop entry point. The app itself is `src/lib.rs` — read that; the
//! split exists because the Android build links a cdylib and never runs a
//! Rust `main` (see the library's module header).

fn main() {
    signals_media_testbed_lib::run()
}
