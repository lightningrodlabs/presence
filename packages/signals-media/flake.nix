{
  description = "signals-media — Opus voice and low-fps JPEG video over any message channel";

  # Derived from the android-service-runtime-0.7 spike's flake, with the
  # holonix input dropped: nothing here needs a Holochain toolchain. nixpkgs is
  # pinned to the rev that spike resolved (WebKitGTK 2.52.5 — the version the
  # WebKitGTK media probe measured), so the testbed's webview matches the probe.
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/2f5a153c270b70cb0f8c11f46d96d6d3bc39f4e3";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, rust-overlay }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ (import rust-overlay) ];
            config = {
              allowUnfree = true; # Android SDK/NDK are unfree
              android_sdk.accept_license = true;
            };
          };

          # Rust toolchain for the Tauri testbed. Channel, components and
          # cross-compilation targets come from ./rust-toolchain.toml so nix and
          # rustup users stay in sync.
          rust = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

          # Android SDK + NDK for the Android WebView leg of the testbed matrix.
          ndkVersion = "28.2.13676358";
          androidComposition = pkgs.androidenv.composeAndroidPackages {
            platformVersions = [ "34" "36" ];
            buildToolsVersions = [ "34.0.0" ];
            includeNDK = true;
            ndkVersions = [ ndkVersion ];
            cmakeVersions = [ "3.22.1" ];
            includeEmulator = false;
            includeSystemImages = false;
          };
          androidSdk = androidComposition.androidsdk;
          androidHome = "${androidSdk}/libexec/android-sdk";
          ndkHome = "${androidHome}/ndk/${ndkVersion}";

          # System libraries to build/run a Tauri v2 desktop app on Linux.
          tauriDeps = with pkgs; [
            webkitgtk_4_1
            gtk3
            gdk-pixbuf
            glib
            glib-networking
            librsvg
            libsoup_3
            dbus
            openssl
          ];

          # GStreamer is WebKitGTK's media backend: getUserMedia, <video>
          # decode and the camera path all run through it. The probe found blank
          # camera frames and an `autovideoflip not found` log when
          # gst-plugins-bad was missing, and had to hand-build
          # GST_PLUGIN_SYSTEM_PATH_1_0; with the plugin packages listed here the
          # gstreamer setup hook exports that variable for us.
          gstDeps = with pkgs.gst_all_1; [
            gstreamer
            gst-plugins-base
            gst-plugins-good
            gst-plugins-bad
            gst-libav
          ];
        in
        {
          default = pkgs.mkShell {
            packages = [
              rust
              androidSdk
            ] ++ gstDeps ++ (with pkgs; [
              cargo-ndk # build Rust -> Android jniLibs
              cmake
              nodejs_22
              pnpm
              jdk17 # Gradle
              pkg-config
              libnice # WebRTC ICE for the GStreamer stack
              pipewire # screen/camera capture portal backend
              shared-mime-info
              gsettings-desktop-schemas
              # Browsers for the testbed's Chromium gate, from the pin (present
              # at this nixpkgs rev) rather than `npx playwright install`.
              playwright-driver.browsers
            ]);

            buildInputs = tauriDeps;

            shellHook = ''
              export ANDROID_HOME="${androidHome}"
              export ANDROID_SDK_ROOT="${androidHome}"
              export ANDROID_NDK="${ndkHome}"
              export ANDROID_NDK_ROOT="${ndkHome}"
              export ANDROID_NDK_HOME="${ndkHome}"
              export NDK_HOME="${ndkHome}"

              # cargo-ndk exports plain CC/CXX/AR pointing at the NDK clang,
              # which also hijacks *host* compiles. The HOST_* variants take
              # precedence in the `cc` crate for host-targeted units.
              export HOST_CC=gcc
              export HOST_CXX=g++
              export HOST_AR=ar

              # TLS for the nix webkit (glib-networking's GIO module). Additive
              # on purpose: GIO_MODULE_DIR would override the module search path
              # for every GLib app launched from this shell.
              export GIO_EXTRA_MODULES=${pkgs.glib-networking}/lib/gio/modules
              # webkitgtk >= 2.44 requires a working EGL display in its web
              # process and aborts with EGL_BAD_PARAMETER without one. nixpkgs'
              # libglvnd only searches /run/opengl-driver — a NixOS-only path —
              # so on other distros supply a vendor list: the host's native
              # drivers first, then nixpkgs Mesa as the fallback.
              if [ ! -e /run/opengl-driver ] && [ -z "$__EGL_VENDOR_LIBRARY_FILENAMES" ] && [ -z "$__EGL_VENDOR_LIBRARY_DIRS" ]; then
                export __EGL_VENDOR_LIBRARY_DIRS=/etc/glvnd/egl_vendor.d:/usr/share/glvnd/egl_vendor.d:${pkgs.mesa}/share/glvnd/egl_vendor.d
              fi
              # GTK schema lookup for the nix webkit; GSETTINGS_SCHEMAS_PATH is
              # filled by the glib setup hook from the schemas in `packages`.
              export XDG_DATA_DIRS=$GSETTINGS_SCHEMAS_PATH:$XDG_DATA_DIRS

              # Use the pinned browsers; never let playwright download its own.
              export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
              export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

              export PS1='\[\033[1;35m\][signals-media:\w]\$\[\033[0m\] '
            '';
          };
        });
    };
}
