//! Tauri shell for the signals-media testbed page.
//!
//! Two jobs, and no more:
//!
//! 1. **Print what the page reports.** The page invokes `report(step, ok,
//!    detail)`; every line lands on stdout as `[testbed] OK  step: detail`.
//!    With `TESTBED_EXIT_ON_SUMMARY=1` the process exits when the page emits
//!    `SUMMARY` — that is what makes a run scriptable.
//!
//! 2. **The Linux (WebKitGTK) media plumbing.** Copied from the spike at
//!    `spikes/webkitgtk-media-probe/main.rs` (findings in `FINDINGS.md`
//!    beside it): `enable_media_stream` + `enable_media_capabilities` on the
//!    `WebKitSettings`, a `permission-request` handler that allows (WebKit's
//!    default handler DENIES, which is why `getUserMedia` fails with
//!    `NotAllowedError` in a stock Tauri app), then a `reload()` so the page
//!    runs under the new settings.
//!
//!    Deliberately NOT set: `enable_webrtc`. The spike proved it inert —
//!    WebRTC is compiled out of WebKitGTK 2.52 in both nixpkgs and Ubuntu
//!    24.04 (`ENABLE_EXPERIMENTAL_FEATURES=OFF`), the setting reads back
//!    `true` and `RTCPeerConnection` still does not exist. Setting it would
//!    only suggest it does something.
//!
//! The page's URL query arrives as `window.__TESTBED_QUERY`, injected here
//! from `TESTBED_URL_QUERY`, rather than as a real search string on the asset
//! URL: `WebviewUrl::App` takes a path, and a query smuggled through it is
//! not portable across Tauri's per-platform asset protocols.
//!
//! On Android the same env var is read at **compile** time as well, because
//! there is no way to hand an env var to the app process from `adb`: the
//! operator bakes the query into the APK with
//! `TESTBED_URL_QUERY='…' tauri android build --debug`. Runtime still wins
//! where a runtime value exists, so desktop behaviour is unchanged. This
//! keeps `window.__TESTBED_QUERY` the ONE way a query reaches the page on
//! every platform — the `windows[0].url` route in `tauri.conf.json` would be
//! a second one, and the window is built here, not from the config.
//!
//! **Why this is a library and not just a `main`.** Android does not run a
//! Rust `main`: the APK is a Java app that `System.loadLibrary`s a cdylib and
//! calls into it, so `tauri android build` runs `cargo build --lib` and fails
//! with *"no library targets found"* against a bin-only crate. Hence the
//! split: everything lives here in `run()`, behind
//! `#[cfg_attr(mobile, tauri::mobile_entry_point)]` (which on mobile emits
//! the `JNI_OnLoad`-side entry the generated Kotlin calls), and `src/main.rs`
//! is a three-line desktop shim that calls it. `mobile` and `desktop` are
//! cfgs set by `tauri-build` in `build.rs`.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// True once the Linux webview settings have been applied and `reload()`
/// called. The spike's guard, kept for its reason: until then the page is
/// running under WebKit's defaults (no media permission), and its verdict
/// describes a run nobody asked for. Observed 2026-09-10: the flag flips
/// during `setup` and the `reload()` preempts the first load before it runs
/// any script at all — exactly one `page Started`/`Finished` pair reaches
/// stdout and the page's `env` report reads `nav=navigate`. The guard is
/// kept for the case where that timing is not so kind.
static SETTINGS_APPLIED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn report(app: AppHandle, step: String, ok: bool, detail: String) {
    println!(
        "[testbed] {} {}: {}",
        if ok { "OK  " } else { "FAIL" },
        step,
        detail
    );
    let settled = !cfg!(target_os = "linux") || SETTINGS_APPLIED.load(Ordering::SeqCst);
    if step == "SUMMARY" && settled && std::env::var("TESTBED_EXIT_ON_SUMMARY").is_ok() {
        println!("[testbed] done (ok={})", ok);
        // Exit code carries the verdict so a shell can gate on it. (The spike
        // always exited 0; a testbed that is meant to be scripted should not.)
        app.exit(if ok { 0 } else { 1 });
    }
}

/// The page query: runtime `TESTBED_URL_QUERY`, else the one baked in at
/// compile time (the Android route — see the module header), else the
/// selftest default.
fn page_query() -> String {
    // An empty value is absent at both layers: an empty runtime var falls
    // through to the baked query, an empty baked one to the default. Gradle
    // and cargo-ndk both pass empty strings along rather than unsetting them.
    let nonempty = |s: String| if s.is_empty() { None } else { Some(s) };
    std::env::var("TESTBED_URL_QUERY")
        .ok()
        .and_then(nonempty)
        .or_else(|| option_env!("TESTBED_URL_QUERY").map(str::to_string).and_then(nonempty))
        .unwrap_or_else(|| "mode=selftest&auto=1".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let query = page_query();
    // The query is operator-supplied, but it still crosses into a script
    // literal; escape the two characters that could close it.
    let escaped = query.replace('\\', "\\\\").replace('"', "\\\"");
    let init = format!("window.__TESTBED_QUERY = \"?{}\";", escaped);
    println!("[testbed] query: ?{}", query);

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![report])
        .setup(move |app| {
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("signals-media testbed")
                .inner_size(1000.0, 820.0)
                .initialization_script(&init)
                // Page-load tracing: without it, "the page never ran" and
                // "the page ran and said nothing" look identical on stdout.
                .on_page_load(|w, payload| {
                    println!(
                        "[testbed] page {:?} {}",
                        payload.event(),
                        payload.url()
                    );
                    let _ = w;
                })
                .build()?;

            // --- Linux (WebKitGTK) media plumbing; see the module header and
            // --- spikes/webkitgtk-media-probe/main.rs.
            win.with_webview(|w| {
                #[cfg(target_os = "linux")]
                {
                    use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
                    let wv = w.inner();
                    if let Some(s) = WebViewExt::settings(&wv) {
                        s.set_enable_media_stream(true);
                        s.set_enable_media_capabilities(true);
                        println!(
                            "[testbed] webkit settings: media_stream={} media_capabilities={} (webrtc left alone: compiled out)",
                            s.enables_media_stream(),
                            s.enables_media_capabilities()
                        );
                    } else {
                        println!("[testbed] no WebKitSettings on the webview");
                    }
                    wv.connect_permission_request(|_, req| {
                        req.allow();
                        true
                    });
                    SETTINGS_APPLIED.store(true, Ordering::SeqCst);
                    println!("[testbed] reloading under the new settings");
                    wv.reload();
                }
                #[cfg(not(target_os = "linux"))]
                {
                    let _ = w;
                }
            })?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri run");
}
