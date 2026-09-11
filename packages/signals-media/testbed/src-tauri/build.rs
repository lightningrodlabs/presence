fn main() {
    // `src/main.rs`'s `page_query()` reads TESTBED_URL_QUERY through
    // `option_env!` so that an Android APK can carry the query it was built
    // with (no env var reaches an app process from `adb`). Without this line
    // cargo would not know that changing the variable invalidates the crate,
    // and a rebuild would silently ship the previous query.
    println!("cargo:rerun-if-env-changed=TESTBED_URL_QUERY");
    tauri_build::build()
}
