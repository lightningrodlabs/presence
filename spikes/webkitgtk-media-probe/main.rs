//! SPIKE (throwaway): opens one Tauri window on the probe page and prints
//! every `report` line to stdout. With PROBE_ENABLE_WEBKIT_MEDIA=1 it first
//! flips WebKitGTK's media-stream / WebRTC settings and auto-allows
//! permission requests — the two things a Tauri app author would have to do
//! themselves — then reloads so the probe runs under those settings.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

static SETTINGS_APPLIED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn report(app: AppHandle, step: String, ok: bool, detail: String) {
    println!("[probe] {} {}: {}", if ok { "OK  " } else { "FAIL" }, step, detail);
    let enable = std::env::var("PROBE_ENABLE_WEBKIT_MEDIA").is_ok();
    if step == "SUMMARY" && (!enable || SETTINGS_APPLIED.load(Ordering::SeqCst)) {
        println!("[probe] done (settings_enabled={})", enable);
        app.exit(0);
    }
}

fn main() {
    let enable = std::env::var("PROBE_ENABLE_WEBKIT_MEDIA").is_ok();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![report])
        .setup(move |app| {
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("webkit probe")
                .inner_size(900.0, 900.0)
                .build()?;
            if enable {
                win.with_webview(|w| {
                    #[cfg(target_os = "linux")]
                    {
                        use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
                        let wv = w.inner();
                        if let Some(s) = WebViewExt::settings(&wv) {
                            s.set_enable_media_stream(true);
                            s.set_enable_webrtc(true);
                            s.set_enable_media_capabilities(true);
                            println!(
                                "[probe] webkit settings applied: media_stream={} webrtc={} media_capabilities={}",
                                s.enables_media_stream(),
                                s.enables_webrtc(),
                                s.enables_media_capabilities()
                            );
                        } else {
                            println!("[probe] no WebKitSettings on the webview");
                        }
                        wv.connect_permission_request(|_, req| {
                            println!("[probe] permission request: {:?} -> allow", req);
                            req.allow();
                            true
                        });
                        SETTINGS_APPLIED.store(true, Ordering::SeqCst);
                        println!("[probe] reloading under the new settings");
                        wv.reload();
                    }
                })?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri run");
}
