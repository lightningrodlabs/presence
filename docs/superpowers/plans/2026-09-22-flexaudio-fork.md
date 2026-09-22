# flexaudio Fork Implementation Plan (Plan 1 of 4: native capture)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `lightningrodlabs/flexaudio` fork exclude an Electron host's own playback on Linux and macOS, prove it with a self-exclusion smoke test, and publish it as `@lightningrodlabs/flexaudio` so Moss can depend on it.

**Architecture:** flexaudio is a Rust workspace (`crates/flexaudio-core` types, `crates/flexaudio` facade, one `flexaudio-os-*` backend crate per OS, `crates/flexaudio-napi` N-API binding). Two defects are fixed at their source: Linux pid resolution reads `application.process.id` before `pipewire.sec.pid` (Fix 1), and the system-loopback path on every backend accepts a pid *set* to exclude, exposed as the napi option `excludePids` (Fix 2). A real-PipeWire smoke test is the acceptance test for both. The fork is then re-scoped for publishing.

**Tech Stack:** Rust 1.98.1 (workspace MSRV 1.85; napi/vad crates 1.91), `pipewire` 0.10 crate, `objc2-core-audio`, `windows` crate, napi-rs 2 (`@napi-rs/cli` ^2.18), Node 22, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-22-audio-source-capture-design.md` (Presence repo), Section 1 and the Platform matrix.

## Global Constraints

- Work happens in `../flexaudio` (`/home/eric/code/metacurrency/holochain/flexaudio`), remotes `origin` = `lightningrodlabs/flexaudio`, `upstream` = `Studio-Sadola/flexaudio`; base commit `e36ca9f` (upstream `main` at fork time).
- Build/test on the owner's machine only inside this shell (the host has PipeWire 1.6 runtime but no dev headers; a nix-built `.node` loads only under nix's Node because of glibc symbol versions):
  ```bash
  cd /home/eric/code/metacurrency/holochain/flexaudio
  nix develop --impure --expr 'let pkgs = (builtins.getFlake "nixpkgs").legacyPackages.x86_64-linux; in pkgs.mkShell { nativeBuildInputs = [ pkgs.pkg-config pkgs.rustc pkgs.cargo pkgs.clang pkgs.nodejs_22 pkgs.pulseaudio ]; buildInputs = [ pkgs.pipewire pkgs.alsa-lib ]; LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib"; }' -c <command>
  ```
  Every `cargo`/`node` command below is run through that `-c`.
- Upstream's gate: `cargo fmt --all --check`, `cargo clippy ... --all-targets -- -D warnings`, `cargo doc` with `RUSTDOCFLAGS=-D warnings`, `cargo test` for the Linux crate list in `.github/workflows/ci.yml` — every task ends green on all four.
- Upstream code comments are Japanese; new comments in this fork are English. Do not translate existing comments.
- Commit messages: plain, no co-author trailers (Presence/Moss CLAUDE.md rule).
- Branches: `fix/pipewire-pulse-pid` (Tasks 1–2), `feat/exclude-pids` (Tasks 3–6, based on the first), `lightningrodlabs/publish` (Task 7, based on the second). The first two are also the upstream PR branches (Task 8), so they must not contain scope/workflow renames.
- The fixed wire format for Moss is not this repo's concern; Moss requests `outputRate: 48000, outputChannels: 1, chunkMs: 20` (spec Section 1).

## File structure

| Path | Responsibility |
|---|---|
| `crates/flexaudio-napi/__test__/exclude-smoke.mjs` (new) | Real-PipeWire self-exclusion smoke test: tone children, null sink, Goertzel, `processes()` pid assertion |
| `crates/flexaudio-napi/__test__/tone-wav.mjs` (new) | Writes a 16-bit stereo sine WAV without external tools |
| `crates/flexaudio-os-linux/src/lib.rs` | Fix 1 pid props helper + registry arms; Fix 2 `PidSelect::Exclude(HashSet)`, `PwSystemBackend.exclude_pids` |
| `crates/flexaudio-os-linux/src/processes.rs` | Fix 1 in the enumeration path |
| `crates/flexaudio-core/src/types.rs` | `StreamConfig.exclude_pids` |
| `crates/flexaudio/src/lib.rs`, `crates/flexaudio/src/stream.rs` | thread `exclude_pids` to `build_system_backend`; copy it on `switch_source` |
| `crates/flexaudio-os-macos/src/system.rs` | `MacSystemBackend.exclude_pids` → `TapKind::ExcludeProcesses(ids)` |
| `crates/flexaudio-os-windows/src/system.rs` | `WasapiSystemBackend.exclude_pids` → EXCLUDE tree root |
| `crates/flexaudio-napi/src/lib.rs`, `index.d.ts`, `README.md` | `excludePids` option |
| `.github/workflows/ci.yml` | `smoke-linux-pipewire` job |
| `crates/flexaudio-napi/package.json`, `.github/workflows/release-npm.yml`, `README.md` | scope rename, darwin x64 target |
| `CHANGELOG.md` | Unreleased rows |

---

### Task 1: Self-exclusion smoke test (red)

**Files:**
- Create: `crates/flexaudio-napi/__test__/tone-wav.mjs`
- Create: `crates/flexaudio-napi/__test__/exclude-smoke.mjs`
- Modify: `crates/flexaudio-napi/__test__/run-smoke.sh` (no change to what it runs; document the new script in its header comment)

**Interfaces:**
- Consumes: the built addon at `__test__/flexaudio.node` (copied by `run-smoke.sh` from `target/release/libflexaudio_napi.so`); `openStream(opts, onChunk, onEvent)`, `processes()` as in `index.d.ts`.
- Produces: `exclude-smoke.mjs` exit code 0/1; env `FLEX_SMOKE_SINK` (existing null-sink node name to reuse), `FLEX_SMOKE_KEEP_SINK=1` (skip destroy).

- [ ] **Step 1: Create the branch**

```bash
cd /home/eric/code/metacurrency/holochain/flexaudio
git checkout -b fix/pipewire-pulse-pid e36ca9f
```

- [ ] **Step 2: Write the WAV generator**

`crates/flexaudio-napi/__test__/tone-wav.mjs`:

```js
// Writes a 16-bit PCM stereo WAV of a pure sine so the smoke test needs no
// external audio tools. Amplitude is linear full-scale (0.5 = -6 dBFS).
import { writeFileSync } from 'node:fs';

export function writeToneWav(path, { freqHz, seconds, rate = 48000, amplitude = 0.5 }) {
  const channels = 2;
  const frames = Math.round(seconds * rate);
  const dataBytes = frames * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28); buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * freqHz * i) / rate) * amplitude * 32767);
    buf.writeInt16LE(s, o); buf.writeInt16LE(s, o + 2); o += 4;
  }
  writeFileSync(path, buf);
}
```

- [ ] **Step 3: Write the smoke test**

`crates/flexaudio-napi/__test__/exclude-smoke.mjs`:

```js
// Self-exclusion smoke test against a REAL PipeWire session (not CI-mock).
//
// Two children play tones into a null sink: A = 1 kHz via libpulse (paplay,
// the path Electron/Chromium uses), B = 3 kHz via native PipeWire (pw-play).
// The addon must (1) list A under A's real pid, (2) capture B but not A when
// A's pid is excluded from a `system` capture, (3) capture both when nothing
// is excluded. Requires: pw-cli, pw-play, paplay on PATH; XDG_RUNTIME_DIR set.
//
// Detector: Goertzel at exact FFT bins. The bin index is round(N*f/rate) —
// the +0.5 variant lands one bin off and reads a pure tone as silence.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeToneWav } from './tone-wav.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const flex = require(join(here, 'flexaudio.node'));

const RATE = 48000;
const CAPTURE_SECONDS = 4;
const PRESENT_MIN = 0.05;   // amplitude of a tone that is being captured
const ABSENT_MAX = 0.005;   // amplitude of a tone that must not leak

function fail(msg) { console.error(`SMOKE FAILED: ${msg}`); process.exitCode = 1; }

function goertzel(samples, freq) {
  const n = samples.length;
  const k = Math.round((n * freq) / RATE);
  const w = (2 * Math.PI * k) / n;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = samples[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / (n / 2);
}

async function capture(opts) {
  const mono = [];
  const events = [];
  const stream = flex.openStream(
    { outputRate: RATE, outputChannels: 1, chunkMs: 20, ...opts },
    (chunk) => { for (let i = 0; i < chunk.data.length; i++) mono.push(chunk.data[i]); },
    (ev) => events.push(ev.type),
  );
  await new Promise((r) => setTimeout(r, CAPTURE_SECONDS * 1000));
  await stream.stop();
  const s = Float32Array.from(mono.slice(RATE)); // drop the first second (link-up)
  return { amp1k: goertzel(s, 1000), amp3k: goertzel(s, 3000), events, chunks: mono.length / 960 };
}

function expect(label, r, want1k, want3k) {
  const ok1 = want1k ? r.amp1k >= PRESENT_MIN : r.amp1k <= ABSENT_MAX;
  const ok3 = want3k ? r.amp3k >= PRESENT_MIN : r.amp3k <= ABSENT_MAX;
  console.log(`[${label}] amp1k=${r.amp1k.toFixed(4)} amp3k=${r.amp3k.toFixed(4)} chunks=${r.chunks} events=${[...new Set(r.events)]}`);
  if (!ok1 || !ok3) fail(`${label}: expected 1k ${want1k ? 'present' : 'absent'}, 3k ${want3k ? 'present' : 'absent'}`);
}

const sinkName = process.env.FLEX_SMOKE_SINK || `flexaudio-smoke-${process.pid}`;
const ownSink = !process.env.FLEX_SMOKE_SINK;
if (ownSink) {
  execSync(`pw-cli create-node adapter '{ factory.name=support.null-audio-sink node.name=${sinkName} media.class=Audio/Sink object.linger=true audio.position=[FL FR] }'`, { stdio: 'ignore' });
}
const dir = mkdtempSync(join(tmpdir(), 'flexaudio-smoke-'));
writeToneWav(join(dir, '1k.wav'), { freqHz: 1000, seconds: 30 });
writeToneWav(join(dir, '3k.wav'), { freqHz: 3000, seconds: 30 });

const a = spawn('paplay', ['--volume=65536', join(dir, '1k.wav')], { env: { ...process.env, PULSE_SINK: sinkName }, stdio: 'ignore' });
const b = spawn('pw-play', ['--target', sinkName, '--volume', '1.0', join(dir, '3k.wav')], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2000));
console.log(`children: paplay(1k, libpulse) pid=${a.pid}  pw-play(3k, native) pid=${b.pid}  sink=${sinkName}`);

try {
  // (1) processes() lists the libpulse child under its real pid.
  const list = await flex.processes();
  const rowA = list.find((p) => p.pid === a.pid);
  console.log('[processes]', JSON.stringify(list.map((p) => ({ pid: p.pid, name: p.name, executable: p.executable }))));
  if (!rowA) fail(`processes() has no entry with pid ${a.pid} (paplay); libpulse clients resolve to pipewire-pulse's pid`);
  else if (!['paplay', 'pacat'].includes(rowA.executable)) fail(`pid ${a.pid} listed with executable ${rowA.executable}`);

  // (2) exclusion by the libpulse child's real pid.
  expect('exclude-A', await capture({ kind: 'system', excludePids: [a.pid] }), false, true);
  // (3) control: nothing excluded, both present.
  expect('control', await capture({ kind: 'system' }), true, true);
} finally {
  a.kill(); b.kill();
  rmSync(dir, { recursive: true, force: true });
  if (ownSink && !process.env.FLEX_SMOKE_KEEP_SINK) {
    try { execSync(`pw-cli destroy ${sinkName}`, { stdio: 'ignore' }); } catch {}
  }
}
if (process.exitCode) process.exit(process.exitCode);
console.log('SMOKE OK');
```

- [ ] **Step 4: Build the addon and run the smoke test; confirm it fails for the right reason**

```bash
nix develop --impure --expr '...' -c bash -c 'cargo build -p flexaudio-napi --release && cp target/release/libflexaudio_napi.so crates/flexaudio-napi/__test__/flexaudio.node && node crates/flexaudio-napi/__test__/exclude-smoke.mjs'
```

Expected: `SMOKE FAILED: processes() has no entry with pid <A>` and `exclude-A: expected 1k absent` (the `excludePids` option is unknown today, so the capture is a plain system capture and 1 kHz leaks). Exit code 1. If `pw-cli create-node` fails, PipeWire is not reachable from the shell: check `echo $XDG_RUNTIME_DIR` and `pw-cli info 0` first.

- [ ] **Step 5: Document the script in `run-smoke.sh`'s header (do not add it to the mock run)**

Add after the existing header comment:

```bash
# exclude-smoke.mjs is NOT run here: it needs a real PipeWire session
# (pw-cli, pw-play, paplay). CI runs it in the smoke-linux-pipewire job.
```

- [ ] **Step 6: Commit**

```bash
git add crates/flexaudio-napi/__test__/tone-wav.mjs crates/flexaudio-napi/__test__/exclude-smoke.mjs crates/flexaudio-napi/__test__/run-smoke.sh
git commit -m "test(napi): real-PipeWire self-exclusion smoke test (red: libpulse pid, excludePids)"
```

---

### Task 2: Fix 1 — resolve libpulse clients to their real pid (Linux)

**Files:**
- Modify: `crates/flexaudio-os-linux/src/lib.rs` (registry `global` arms near line 1010–1045; `resolve_node_pid` docs at 669–686; module doc near 728; tests module at 2309+)
- Modify: `crates/flexaudio-os-linux/src/processes.rs` (Client arm near line 187, Node arm near 205)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)

**Interfaces:**
- Produces: `pub(crate) fn pid_from_props(app_process_id: Option<&str>, sec_pid: Option<&str>) -> Option<u32>` in `lib.rs`, used by both files.

- [ ] **Step 1: Write the failing unit test**

In `crates/flexaudio-os-linux/src/lib.rs` inside `mod tests`, after `resolve_node_pid_via_client_table`:

```rust
    /// libpulse clients reach PipeWire through pipewire-pulse, so their Client's
    /// `pipewire.sec.pid` is pipewire-pulse's pid; the app's own pid is only in
    /// `application.process.id` (on the Client and on its stream Nodes).
    /// Measured 2026-09-22: Moss/Chrome/Zoom all resolved to pid 3020.
    #[test]
    fn pid_from_props_prefers_application_process_id() {
        // libpulse client: app pid wins over the daemon's socket-peer pid.
        assert_eq!(pid_from_props(Some("28551"), Some("3020")), Some(28551));
        // native client without application.process.id: sec.pid is the answer.
        assert_eq!(pid_from_props(None, Some("13394")), Some(13394));
        // node props carry no sec.pid at all.
        assert_eq!(pid_from_props(Some("42"), None), Some(42));
        // garbage / zero app pid falls back to sec.pid; nothing usable → None.
        assert_eq!(pid_from_props(Some("nope"), Some("7")), Some(7));
        assert_eq!(pid_from_props(Some("0"), Some("7")), Some(7));
        assert_eq!(pid_from_props(None, None), None);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p flexaudio-os-linux pid_from_props -- --nocapture`
Expected: compile error `cannot find function pid_from_props`.

- [ ] **Step 3: Implement the helper next to `resolve_node_pid`**

```rust
/// Resolve a registry object's owning process from its properties.
///
/// `application.process.id` is preferred: for libpulse clients (Electron,
/// Chromium, most desktop apps) the daemon-assigned `pipewire.sec.pid` is
/// pipewire-pulse's own pid, and only `application.process.id` (set by
/// libpulse / libpipewire from the client's own props) names the app. It is
/// self-declared, which is acceptable for capture selection and self-exclusion.
/// `pipewire.sec.pid` is the fallback for clients that declare nothing.
pub(crate) fn pid_from_props(app_process_id: Option<&str>, sec_pid: Option<&str>) -> Option<u32> {
    let parse = |s: Option<&str>| s.and_then(|s| s.parse::<u32>().ok()).filter(|p| *p != 0);
    parse(app_process_id).or_else(|| parse(sec_pid))
}
```

- [ ] **Step 4: Use it in the capture registry (lib.rs)**

Client arm (currently `let Some(pid_str) = props.get(*pw::keys::SEC_PID) else { return; }; let Ok(pid) = pid_str.parse::<u32>() else { return; };`):

```rust
                    pw::types::ObjectType::Client => {
                        let Some(pid) = pid_from_props(
                            props.get(*pw::keys::APP_PROCESS_ID),
                            props.get(*pw::keys::SEC_PID),
                        ) else {
                            return;
                        };
```

Node arm (`app_pid: props.get(*pw::keys::SEC_PID)...`):

```rust
                        // Stream nodes of libpulse clients carry the app's pid
                        // directly; native nodes usually carry nothing and fall
                        // back to the client table.
                        let app_pid = pid_from_props(props.get(*pw::keys::APP_PROCESS_ID), None);
```

Update the two Japanese doc comments that assert "PID は Client の pipewire.sec.pid に常在する" (the `setup_pw_process` doc around line 728 and the Client-arm comment) by appending one English sentence: `// application.process.id takes precedence — see pid_from_props.` Leave the Japanese text in place.

- [ ] **Step 5: Use it in the enumeration path (processes.rs)**

Client arm:

```rust
                    pw::types::ObjectType::Client => {
                        let Some(pid) = pid_from_props(
                            props.get(*pw::keys::APP_PROCESS_ID),
                            props.get(*pw::keys::SEC_PID),
                        ) else {
                            return;
                        };
```

Node arm: `app_pid: pid_from_props(props.get(*pw::keys::APP_PROCESS_ID), None),` and add `pid_from_props` to the `use crate::{...}` line.

- [ ] **Step 6: Run the unit tests and the gate**

```bash
cargo test -p flexaudio-os-linux
cargo fmt --all --check && cargo clippy -p flexaudio -p flexaudio-core -p flexaudio-cli -p flexaudio-mic -p flexaudio-os-linux -p flexaudio-vad -p flexaudio-napi -p flexaudio-encode -p flexaudio-denoise -p flexaudio-ffi -p flexaudio-py --all-targets -- -D warnings
```

Expected: all pass, including the existing `resolve_node_pid_via_client_table`.

- [ ] **Step 7: Rebuild the addon and rerun the smoke test**

Same command as Task 1 Step 4. Expected: the `[processes]` line now shows paplay under its real pid with `executable: "pacat"` (paplay is a symlink to pacat) or `"paplay"`, and no `processes()` failure. `exclude-A` still fails (no `excludePids` yet) — that is Task 3's red.

- [ ] **Step 8: CHANGELOG and commit**

Under `## [Unreleased]` add:

```markdown
### Fixed
- **Linux: libpulse clients now resolve to their own pid.** Process capture,
  exclusion and `processes()` read `application.process.id` before
  `pipewire.sec.pid`; the latter is pipewire-pulse's pid for every client that
  speaks the PulseAudio protocol (Electron/Chromium, Zoom, …), so those apps
  were listed as one process and could not be excluded individually.
```

```bash
git add crates/flexaudio-os-linux/src/lib.rs crates/flexaudio-os-linux/src/processes.rs CHANGELOG.md
git commit -m "fix(linux): resolve libpulse clients by application.process.id, not pipewire.sec.pid"
```

---

### Task 3: Fix 2 — `exclude_pids` in core, facade and the Linux backend

**Files:**
- Modify: `crates/flexaudio-core/src/types.rs` (`StreamConfig` ~line 291–345, `Default` ~348, tests ~439)
- Modify: `crates/flexaudio/src/lib.rs` (`build_system_backend` ~282–315, its two call sites ~212 and ~266)
- Modify: `crates/flexaudio/src/stream.rs` (`switch_source` config copy ~806–812)
- Modify: `crates/flexaudio-os-linux/src/lib.rs` (`PwSystemBackend` struct/new/start ~100–230; `PwProcessBackend::start` ~420–427; `PidSelect` ~694–716; `setup_pw_process` ~749–1180: `capture_node_name`, `target_client_id`, both registry closures, `try_link` ~848–900)

**Interfaces:**
- Produces: `StreamConfig.exclude_pids: Vec<u32>` (default empty; system source only; combined with `exclude_self`); `PwSystemBackend::with_exclude_pids(self, Vec<u32>) -> Self`; `build_system_backend(exclude_self: bool, exclude_pids: Vec<u32>, device_id: Option<String>)`.
- Consumed by Tasks 4 and 5 under exactly these names.

- [ ] **Step 1: Failing core test**

In `crates/flexaudio-core/src/types.rs` tests, extend the `StreamConfig::default()` test (the one asserting `c.mode == ProcessMode::Include` near line 439) with:

```rust
        assert!(c.exclude_pids.is_empty(), "no pids excluded by default");
```

Run: `cargo test -p flexaudio-core` → compile error `no field exclude_pids`.

- [ ] **Step 2: Add the field**

In `StreamConfig` after `exclude_self`:

```rust
    /// Additional pids whose playback is excluded from a system-loopback
    /// capture (system source only; ignored by mic/process, applied to the
    /// system side of `Mix`). Combined with [`exclude_self`](Self::exclude_self):
    /// the effective exclusion set is `exclude_pids ∪ {self if exclude_self}`.
    /// An Electron host passes its whole helper-process tree here, because the
    /// process that renders audio is a helper, not the pid the addon runs in.
    /// Windows honours one process *tree*: `exclude_self` wins, else the first
    /// entry's tree (see `flexaudio-os-windows::WasapiSystemBackend`).
    pub exclude_pids: Vec<u32>,
```

In `Default`: `exclude_pids: Vec::new(),`. Update the `Default` doc list (`exclude_self = false, ...`) to mention `exclude_pids = []`.

- [ ] **Step 3: Thread it through the facade**

`crates/flexaudio/src/lib.rs`:

```rust
fn build_system_backend(
    exclude_self: bool,
    exclude_pids: Vec<u32>,
    device_id: Option<String>,
) -> Result<Box<dyn CaptureBackend>> {
    #[cfg(target_os = "linux")]
    {
        Ok(Box::new(
            flexaudio_os_linux::PwSystemBackend::new(exclude_self, device_id)
                .with_exclude_pids(exclude_pids),
        ))
    }
    #[cfg(target_os = "windows")]
    {
        Ok(Box::new(
            flexaudio_os_windows::WasapiSystemBackend::new(exclude_self, device_id)
                .with_exclude_pids(exclude_pids),
        ))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(
            flexaudio_os_macos::MacSystemBackend::new(exclude_self, device_id)
                .with_exclude_pids(exclude_pids),
        ))
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = (exclude_self, exclude_pids, device_id);
        Err(flexaudio_core::types::Error::Unsupported)
    }
}
```

Both call sites: `build_system_backend(config.exclude_self, config.exclude_pids.clone(), config.device_id.clone())?` and `build_system_backend(config.exclude_self, config.exclude_pids.clone(), config.mix_system_device_id.clone())?`.

`crates/flexaudio/src/stream.rs` `switch_source` copy: add `exclude_pids: new_config.exclude_pids,` after `exclude_self`. Update the doc comment list on line 772 to include `exclude_pids`.

(macOS/Windows `with_exclude_pids` do not exist yet — the Linux gate compiles only Linux crates, so this compiles now; Task 4 adds them before the Windows/macOS CI jobs run.)

- [ ] **Step 4: Failing Linux tests**

In `crates/flexaudio-os-linux/src/lib.rs` tests:

```rust
    #[test]
    fn pid_select_exclude_takes_a_set() {
        use std::collections::HashSet;
        let sel = PidSelect::Exclude(HashSet::from([10, 20]));
        assert!(sel.is_subject_pid(10) && sel.is_subject_pid(20) && !sel.is_subject_pid(30));
        // Exclude links every RESOLVED pid outside the set; unresolved waits.
        assert!(sel.selects(Some(30)));
        assert!(!sel.selects(Some(20)));
        assert!(!sel.selects(None));
        let inc = PidSelect::Include(7);
        assert!(inc.selects(Some(7)) && !inc.selects(Some(8)) && !inc.selects(None));
        assert_eq!(inc.node_key(), "7");
        assert_eq!(sel.node_key(), "excl-10");
    }

    #[test]
    fn system_backend_exclude_pids_builder() {
        let be = PwSystemBackend::new(false, None).with_exclude_pids(vec![5, 6]);
        assert_eq!(be.exclude_pids(), &[5, 6]);
        assert!(!be.exclude_self());
    }
```

Run: `cargo test -p flexaudio-os-linux pid_select` → compile errors.

- [ ] **Step 5: Rework `PidSelect`**

Replace the enum and impl (~694–716):

```rust
/// Node-selection predicate for the fan-in capture loop.
///
/// `Include(pid)` links the one output node owned by `pid`; `Exclude(set)`
/// links every resolved output node whose pid is NOT in `set` (used by
/// `ProcessMode::Exclude`, `exclude_self`, and `exclude_pids`).
#[derive(Clone, PartialEq, Eq)]
enum PidSelect {
    Include(u32),
    Exclude(std::collections::HashSet<u32>),
}

impl PidSelect {
    /// Is `pid` one of the pids this predicate is *about* (the included pid, or
    /// a member of the exclusion set)? Used to track those Clients for
    /// `global_remove`.
    fn is_subject_pid(&self, pid: u32) -> bool {
        match self {
            PidSelect::Include(p) => *p == pid,
            PidSelect::Exclude(set) => set.contains(&pid),
        }
    }

    /// Should a node whose pid resolved to `resolved` be linked? An unresolved
    /// pid (`None`) is never linked — the Client may still be on its way.
    fn selects(&self, resolved: Option<u32>) -> bool {
        match (self, resolved) {
            (PidSelect::Include(p), Some(r)) => *p == r,
            (PidSelect::Exclude(set), Some(r)) => !set.contains(&r),
            (_, None) => false,
        }
    }

    /// Suffix for this capture stream's `node.name` (registry-visible, unique
    /// enough to avoid colliding with another concurrent capture).
    fn node_key(&self) -> String {
        match self {
            PidSelect::Include(p) => p.to_string(),
            PidSelect::Exclude(set) => format!("excl-{}", set.iter().min().copied().unwrap_or(0)),
        }
    }
}
```

`capture_node_name(target_pid: u32)` becomes `fn capture_node_name(key: &str) -> String { format!("flexaudio-capture-{key}") }` and its call site `capture_node_name(&select.node_key())`.

- [ ] **Step 6: Adapt `setup_pw_process` and `try_link` to the non-`Copy` predicate**

- `target_client_id: Rc<Cell<Option<u32>>>` becomes `let target_client_ids: Rc<RefCell<std::collections::HashSet<u32>>> = Rc::new(RefCell::new(HashSet::new()));` (rename all three clones `target_client_for_global` / `target_client_for_remove` / the original accordingly).
- Client arm: `if pid == select.pid() { target_client_for_global.set(Some(global.id)); }` → `if select_for_global.is_subject_pid(pid) { target_client_for_global.borrow_mut().insert(global.id); }`.
- `global_remove`: `let was_target_client = target_client_for_remove.get() == Some(id);` → `let was_target_client = target_client_for_remove.borrow().contains(&id);` and `if was_target_client { target_client_for_remove.set(None); }` → `target_client_for_remove.borrow_mut().remove(&id);`.
- Before registering the listeners: `let select_for_global = select.clone(); let select_for_remove = select.clone();` and pass `&select_for_global` / `&select_for_remove` to the `try_link` calls in each closure. Change `try_link`'s parameter to `select: &PidSelect`; inside it `if let PidSelect::Include(_) = select` → `if matches!(select, PidSelect::Include(_))`, and the `targets` computation becomes:

```rust
        let targets: Vec<u32> = {
            let nodes = nodes.borrow();
            let client_pid = client_pid.borrow();
            let linked = linked.borrow();
            let mut ids: Vec<u32> = nodes
                .iter()
                .filter(|(id, entry)| {
                    !linked.contains_key(id) && select.selects(resolve_node_pid(entry, &client_pid))
                })
                .map(|(&id, _)| id)
                .collect();
            if matches!(select, PidSelect::Include(_)) {
                ids.truncate(1); // Include links one representative node
            }
            ids
        };
```

- `run_pw_process_loop(select: PidSelect, ...)` keeps ownership; `setup_pw_process(select: PidSelect, ...)` too.

- [ ] **Step 7: The two backends' `start`**

`PwProcessBackend::start`:

```rust
        let select = match self.mode {
            ProcessMode::Include => PidSelect::Include(self.target_pid),
            ProcessMode::Exclude => PidSelect::Exclude(std::collections::HashSet::from([self.target_pid])),
        };
```

`PwSystemBackend`: add field `exclude_pids: Vec<u32>` (init `Vec::new()` in `new`), plus:

```rust
    /// Exclude these pids' playback in addition to `exclude_self` (fan-in
    /// path). Empty = no change.
    pub fn with_exclude_pids(mut self, pids: Vec<u32>) -> Self {
        self.exclude_pids = pids;
        self
    }

    /// The extra excluded pids.
    pub fn exclude_pids(&self) -> &[u32] {
        &self.exclude_pids
    }
```

In `start`, replace the `exclude_self` bool plumbing:

```rust
        let mut excluded: std::collections::HashSet<u32> = self.exclude_pids.iter().copied().collect();
        if self.exclude_self {
            excluded.insert(std::process::id());
        }
        // A non-empty exclusion set means the fan-in path (link every app output
        // except the excluded pids); empty means the sink-monitor path.
        let fan_in = !excluded.is_empty();
        let device_id = self.device_id.clone();
        if !fan_in {
            /* existing DeviceNotFound pre-check, unchanged */
        }
        ...
        let handle = thread::Builder::new()
            .name(if fan_in { "flexaudio-pw-system-excl" } else { "flexaudio-pw-system" }.into())
            .spawn(move || {
                if fan_in {
                    run_pw_process_loop(PidSelect::Exclude(excluded), sink, stop_rx, &ready_tx);
                } else {
                    run_pw_loop(device_id, sink, stop_rx, &ready_tx);
                }
            })
```

- [ ] **Step 8: Gate and unit tests**

```bash
cargo test -p flexaudio-os-linux -p flexaudio-core -p flexaudio
cargo fmt --all --check && cargo clippy <Linux crate list> --all-targets -- -D warnings && RUSTDOCFLAGS=-D\ warnings cargo doc --no-deps <Linux doc crate list>
```

Expected: green. If any `StreamConfig { .. }` literal without `..Default::default()` fails to compile, add `exclude_pids: Vec::new(),` there.

- [ ] **Step 9: Commit**

```bash
git checkout -b feat/exclude-pids
git add crates/flexaudio-core/src/types.rs crates/flexaudio/src/lib.rs crates/flexaudio/src/stream.rs crates/flexaudio-os-linux/src/lib.rs
git commit -m "feat(core,linux): exclude_pids — exclude a set of pids from system loopback"
```

---

### Task 4: Fix 2 on macOS and Windows backends

**Files:**
- Modify: `crates/flexaudio-os-macos/src/system.rs` (struct ~52–70, `new` ~88–96, `start` closure ~128–165, tests ~262+)
- Modify: `crates/flexaudio-os-windows/src/system.rs` (struct ~57–66, `new` ~85–98, `start` ~257–275, `run_system_thread` ~326–345)

**Interfaces:**
- Produces: `MacSystemBackend::with_exclude_pids(self, Vec<u32>) -> Self`, `WasapiSystemBackend::with_exclude_pids(self, Vec<u32>) -> Self` (names fixed by Task 3's facade).

These crates only compile on their OS; the owner's machine can `cargo check` neither. Write them carefully, run `cargo fmt --all --check`, and rely on the Windows/macOS CI jobs (Task 6 runs the full workflow on the PR).

- [ ] **Step 1: macOS — failing test**

In `crates/flexaudio-os-macos/src/system.rs` tests:

```rust
    #[test]
    fn exclude_pids_builder_is_stored() {
        let be = MacSystemBackend::new(false, None).with_exclude_pids(vec![11, 12]);
        assert_eq!(be.exclude_pids, vec![11, 12]);
        assert!(!be.exclude_self);
    }
```

- [ ] **Step 2: macOS — implement**

Struct: add `/// Extra pids excluded from the tap (see StreamConfig::exclude_pids). exclude_pids: Vec<u32>,`; `new`: `exclude_pids: Vec::new(),`; builder:

```rust
    /// Exclude these pids' output in addition to `exclude_self`. Each pid is
    /// translated to its Core Audio process object at `start`; pids with no
    /// audio object (not producing sound) are skipped, not errors.
    pub fn with_exclude_pids(mut self, pids: Vec<u32>) -> Self {
        self.exclude_pids = pids;
        self
    }
```

In `start`, before the spawn: `let mut excluded: Vec<u32> = self.exclude_pids.clone(); if exclude_self { excluded.push(std::process::id()); }` (move `excluded` into the closure) and replace `let kind = if exclude_self { match translate_pid_to_object(std::process::id() as i32) {...} }` with:

```rust
                let kind = if !excluded.is_empty() {
                    // Exclusion beats device_id: a global tap on the default output
                    // minus every excluded process that currently has an audio object.
                    let mut ids = Vec::with_capacity(excluded.len());
                    for pid in excluded {
                        match translate_pid_to_object(pid as i32) {
                            Ok(0) => {}
                            Ok(object_id) => ids.push(object_id),
                            Err(e) => {
                                let _ = ready_tx.send(Err(e));
                                return;
                            }
                        }
                    }
                    TapKind::ExcludeProcesses(ids)
                } else if let Some(name) = device_id {
```

(The `else if` / `else` arms stay as they are.) Update the module doc lines 8–14 with one English sentence: `// exclude_pids extends the exclusion set with arbitrary pids (Electron helper tree).`

- [ ] **Step 3: Windows — failing test**

In `crates/flexaudio-os-windows/src/system.rs` tests (there is a `mod tests`; if not, add one under `#[cfg(test)]`):

```rust
    #[test]
    fn exclude_pids_switches_to_process_loopback_format() {
        let be = WasapiSystemBackend::new(false, None).with_exclude_pids(vec![4242]);
        assert_eq!(be.exclude_pids, vec![4242]);
        assert_eq!(be.native, PROCESS_LOOPBACK_FORMAT);
        assert_eq!(be.exclude_root(), Some(4242));
        let selfy = WasapiSystemBackend::new(true, None).with_exclude_pids(vec![4242]);
        assert_eq!(selfy.exclude_root(), Some(std::process::id()));
        assert_eq!(WasapiSystemBackend::new(false, None).exclude_root(), None);
    }
```

- [ ] **Step 4: Windows — implement**

Struct: `exclude_pids: Vec<u32>`; `new`: `exclude_pids: Vec::new(),`; add:

```rust
    /// Exclude a process tree in addition to `exclude_self`. WASAPI process
    /// loopback takes exactly ONE tree per client, so only one root is honoured:
    /// `exclude_self` (this process's tree) wins, otherwise the first pid's tree.
    /// Callers that need several unrelated trees excluded must open several
    /// captures. Switches the native format to the process-loopback format.
    pub fn with_exclude_pids(mut self, pids: Vec<u32>) -> Self {
        self.exclude_pids = pids;
        if !self.exclude_pids.is_empty() {
            self.native = PROCESS_LOOPBACK_FORMAT;
        }
        self
    }

    /// The pid whose process tree the EXCLUDE loopback is opened on, if any.
    pub fn exclude_root(&self) -> Option<u32> {
        if self.exclude_self {
            Some(std::process::id())
        } else {
            self.exclude_pids.first().copied()
        }
    }
```

`start`: replace `let exclude_self = self.exclude_self;` with `let exclude_root = self.exclude_root();` and call `run_system_thread(exclude_root, device_id, sink, stop_flag, ready_tx)`. `run_system_thread(exclude_root: Option<u32>, ...)`:

```rust
    let setup = if let Some(root) = exclude_root {
        unsafe { crate::process::setup_process_loopback(root, ProcessMode::Exclude) }
    } else {
        unsafe { setup_system_loopback(device_id.as_deref(), &sink) }
    };
```

Update its doc comment's two bullets to say `exclude_root == None` / `Some(root)`.

- [ ] **Step 5: Format, CHANGELOG, commit**

```bash
cargo fmt --all --check
```

CHANGELOG `## [Unreleased]`:

```markdown
### Added
- **`StreamConfig::exclude_pids` / N-API `excludePids`.** System-loopback
  capture can exclude a set of pids in addition to `exclude_self`. Electron
  hosts render audio from a helper process, so excluding the addon's own pid
  was not enough on Linux and macOS. Linux: fan-in over every app output whose
  pid is outside the set. macOS: every pid is added to the tap's exclude list.
  Windows: one process tree — `exclude_self` wins, otherwise the first pid.
```

```bash
git add crates/flexaudio-os-macos/src/system.rs crates/flexaudio-os-windows/src/system.rs CHANGELOG.md
git commit -m "feat(macos,windows): honour exclude_pids on the system-loopback backends"
```

---

### Task 5: `excludePids` in the N-API binding; smoke test green

**Files:**
- Modify: `crates/flexaudio-napi/src/lib.rs` (`OpenOptions` ~558–572, `build_config` ~864–895, tests `options_with_kind` ~2333 and after `build_config_defaults`)
- Regenerate: `crates/flexaudio-napi/index.d.ts` (via `napi build`)
- Modify: `crates/flexaudio-napi/README.md`

**Interfaces:**
- Produces: `OpenOptions.excludePids?: number[]` (system/mix only).

- [ ] **Step 1: Failing unit test**

After `build_config_defaults`:

```rust
    #[test]
    fn build_config_exclude_pids() {
        let mut opts = options_with_kind("system");
        opts.exclude_pids = Some(vec![100, 200]);
        let cfg = build_config(&opts).unwrap();
        assert_eq!(cfg.exclude_pids, vec![100, 200]);
        assert!(!cfg.exclude_self);
        let cfg = build_config(&options_with_kind("system")).unwrap();
        assert!(cfg.exclude_pids.is_empty());
    }
```

Add `exclude_pids: None,` to `options_with_kind`. Run `cargo test -p flexaudio-napi build_config_exclude_pids` → compile error.

- [ ] **Step 2: Implement**

`OpenOptions`, after `exclude_self`:

```rust
    /// Pids whose playback is excluded from a `system` capture (also the system
    /// side of `mix`), in addition to `excludeSelf`. An Electron host passes its
    /// whole process tree (`app.getAppMetrics()` pids). Ignored by mic/process.
    /// Windows honours one process tree: `excludeSelf` wins, else the first pid.
    pub exclude_pids: Option<Vec<u32>>,
```

`build_config`: `exclude_pids: options.exclude_pids.clone().unwrap_or_default(),` after `exclude_self`.

- [ ] **Step 3: Regenerate `index.d.ts`/`index.js`**

```bash
cd crates/flexaudio-napi && npm install && npx napi build --platform --release
git diff --stat index.d.ts index.js   # index.d.ts gains excludePids; index.js unchanged
cp flexaudio.linux-x64-gnu.node __test__/flexaudio.node
```

- [ ] **Step 4: Run the smoke test — green**

```bash
node crates/flexaudio-napi/__test__/exclude-smoke.mjs
```

Expected output ends with `SMOKE OK`; `[exclude-A] amp1k=0.00xx amp3k=0.4x…`, `[control] amp1k=0.4x… amp3k=0.4x…`. Then run the mock suite too: `bash crates/flexaudio-napi/__test__/run-smoke.sh` → all `OK`.

- [ ] **Step 5: README**

In `crates/flexaudio-napi/README.md`, after the "Picking a process to capture" section:

```markdown
## Excluding your own app (Electron hosts)

`excludeSelf: true` excludes the process the addon runs in. Electron and
Chromium render audio from a *helper* process, so also pass every pid of your
process tree:

```js
const pids = app.getAppMetrics().map((m) => m.pid);   // main + helpers
const stream = openStream({ kind: 'system', excludeSelf: true, excludePids: pids }, onChunk, onEvent);
```

Linux and macOS exclude every listed pid. Windows excludes one process *tree*
(`excludeSelf` wins, otherwise the first pid) — for an Electron host that is
the whole app, since helpers are children of the main process.
```

- [ ] **Step 6: Gate and commit**

```bash
cargo fmt --all --check && cargo clippy <Linux crate list> --all-targets -- -D warnings && cargo test -p flexaudio-napi
git add crates/flexaudio-napi/src/lib.rs crates/flexaudio-napi/index.d.ts crates/flexaudio-napi/README.md
git commit -m "feat(napi): excludePids option; self-exclusion smoke test passes"
```

---

### Task 6: CI job running the smoke test on a real headless PipeWire

**Files:**
- Modify: `.github/workflows/ci.yml` (add a job after `napi-contract`; keep the `dtolnay/rust-toolchain@1.98.1` pin so `toolchain-pin-guard` stays green)

- [ ] **Step 1: Add the job**

```yaml
  smoke-linux-pipewire:
    name: Self-exclusion smoke (Linux / real PipeWire)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.98.1
      - uses: Swatinem/rust-cache@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install PipeWire (dev headers + a runnable session)
        run: |
          sudo apt-get update
          sudo apt-get install -y libpipewire-0.3-dev libclang-dev libasound2-dev \
            pipewire pipewire-pulse pipewire-bin wireplumber pulseaudio-utils dbus
      - name: Start a headless PipeWire session
        run: |
          export XDG_RUNTIME_DIR=/tmp/xdg-smoke
          mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
          eval "$(dbus-launch --sh-syntax)"
          echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" >> "$GITHUB_ENV"
          echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" >> "$GITHUB_ENV"
          pipewire & sleep 1
          wireplumber & sleep 1
          pipewire-pulse & sleep 1
          pw-cli info 0
      - name: Build the addon
        run: |
          cargo build -p flexaudio-napi --release
          cp target/release/libflexaudio_napi.so crates/flexaudio-napi/__test__/flexaudio.node
      - name: Self-exclusion smoke test
        run: node crates/flexaudio-napi/__test__/exclude-smoke.mjs
```

- [ ] **Step 2: Push the branch and watch the workflow**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the self-exclusion smoke test on a headless PipeWire session"
git push -u origin feat/exclude-pids
gh run watch --repo lightningrodlabs/flexaudio $(gh run list --repo lightningrodlabs/flexaudio --branch feat/exclude-pids --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: every job green, including `Build & Test (Windows / WASAPI)`, `Build & Test (macOS / Core Audio Taps)` (Task 4's code compiles) and the new smoke job. If the smoke job cannot create the null sink, the usual cause is `wireplumber` needing the session bus — the `dbus-launch` line above is there for that; the second usual cause is the runner's `pipewire` package lacking `pipewire-pulse` (check `apt-cache policy pipewire-pulse`). Fix in this task; do not mark the job `continue-on-error`.

- [ ] **Step 3: Also push the first branch**

```bash
git push -u origin fix/pipewire-pulse-pid
```

---

### Task 7: Publish as `@lightningrodlabs/flexaudio`

**Files:**
- Modify: `crates/flexaudio-napi/package.json` (`name`, `napi.triples.additional`, `optionalDependencies`)
- Modify: `.github/workflows/release-npm.yml` (header comment scope; matrix + darwin x64)
- Modify: `README.md`, `crates/flexaudio-napi/README.md` (install line; a "Fork" note at the top)
- Modify: `RELEASING.md` (fork's release note)

- [ ] **Step 1: Branch**

```bash
git checkout -b lightningrodlabs/publish feat/exclude-pids
```

- [ ] **Step 2: Rename the scope**

`package.json`: `"name": "@lightningrodlabs/flexaudio"`; `optionalDependencies` keys → `@lightningrodlabs/flexaudio-linux-x64-gnu`, `-linux-arm64-gnu`, `-win32-x64-msvc`, `-win32-arm64-msvc`, `-darwin-arm64`, plus `"@lightningrodlabs/flexaudio-darwin-x64": "0.3.0"`; `napi.triples.additional` gains `"x86_64-apple-darwin"`. `version` stays `0.3.0` (upstream's unreleased number; the fork publishes `0.3.0-lrl.1` — set `"version": "0.3.0-lrl.1"` and the same in every `optionalDependencies` value).

`release-npm.yml`: matrix add `- runner: macos-latest\n            target: x86_64-apple-darwin` (napi cross-builds Intel from an arm64 runner; `dtolnay/rust-toolchain` receives the target via `targets:` already); header comment: scope is `@lightningrodlabs`, secret `NPM_TOKEN` is a granular token for that scope. Nothing else in the workflow references the scope — `napi create-npm-dir` derives package names from `package.json`.

- [ ] **Step 3: Fork note in both READMEs (top)**

```markdown
> **Fork.** This is `lightningrodlabs/flexaudio`, published to npm as
> `@lightningrodlabs/flexaudio` while upstream's npm publication is blocked.
> Changes over upstream `e36ca9f`: libpulse pid resolution (upstream PR #TBD),
> `excludePids` (upstream PR #TBD), the real-PipeWire smoke job. Once upstream
> publishes with both merged, Moss switches back and this fork is archived.
```

Replace `#TBD` with the PR numbers from Task 8 in that task's last step.

- [ ] **Step 4: Dry run, then publish**

```bash
git add -A crates/flexaudio-napi/package.json .github/workflows/release-npm.yml README.md crates/flexaudio-napi/README.md RELEASING.md
git commit -m "chore: publish the fork as @lightningrodlabs/flexaudio (adds darwin x64)"
git push -u origin lightningrodlabs/publish
gh workflow run "Release (npm)" --repo lightningrodlabs/flexaudio --ref lightningrodlabs/publish -f dry_run=true
```

Watch the run; all six build jobs and the dry-run publish must pass. The owner adds the `NPM_TOKEN` secret (granular, publish rights on `@lightningrodlabs`), then:

```bash
git checkout main && git merge --no-ff lightningrodlabs/publish -m "Merge lightningrodlabs/publish: excludePids, libpulse pid fix, npm scope"
git push origin main
git tag v0.3.0-lrl.1 && git push origin v0.3.0-lrl.1
```

- [ ] **Step 5: Verify the registry, never trust the workflow log**

```bash
npm view @lightningrodlabs/flexaudio version optionalDependencies
npm pack @lightningrodlabs/flexaudio-linux-x64-gnu@0.3.0-lrl.1 --dry-run
```

Expected: `0.3.0-lrl.1` with six platform packages. Record the versions in `RELEASING.md` under a "lightningrodlabs releases" table.

---

### Task 8: Upstream PRs

- [ ] **Step 1: Open PR 1 (Fix 1) against `Studio-Sadola/flexaudio:main`**

```bash
gh pr create --repo Studio-Sadola/flexaudio --head lightningrodlabs:fix/pipewire-pulse-pid --base main \
  --title "fix(linux): resolve libpulse clients by application.process.id" \
  --body-file - <<'EOF'
`pipewire.sec.pid` on a Client is pipewire-pulse's own pid for every libpulse client (Electron/Chromium, Zoom, …), so `processes()` listed them all under one pid and per-pid exclusion could not target them. This reads `application.process.id` first (present on both the Client and its stream Nodes) and falls back to `pipewire.sec.pid`.

Measured on PipeWire 1.6.8 / pipewire-pulse: before, `paplay` was listed as `{pid: 3020, executable: "pipewire"}` and `mode:'exclude'` on its real pid excluded nothing; after, it is listed under its own pid and the exclusion holds. The added `exclude-smoke.mjs` reproduces this against a real session (it is not wired into `run-smoke.sh`; a CI job for it is in a follow-up PR).
EOF
```

- [ ] **Step 2: Open PR 2 (Fix 2 + CI job), based on PR 1**

```bash
gh pr create --repo Studio-Sadola/flexaudio --head lightningrodlabs:feat/exclude-pids --base main \
  --title "feat: exclude_pids — exclude a pid set from system loopback (all three backends)" \
  --body-file - <<'EOF'
Adds `StreamConfig::exclude_pids` / N-API `excludePids`, composed with `exclude_self`. Motivation: Electron hosts render audio from a helper process, so `exclude_self` alone does not exclude the app on Linux (single-pid fan-in predicate) or macOS (single object in the tap's exclude list). Windows already excluded a process tree; there the first pid's tree (or self's) is used and documented.

Linux: `PidSelect::Exclude` becomes a set; the Client tracking for `global_remove` becomes a set too. macOS: every pid translated to its process object, `Ok(0)` skipped. Also adds a CI job that runs the real-PipeWire self-exclusion smoke test on a headless session (pipewire + wireplumber + pipewire-pulse, null sink, `paplay` + `pw-play` children, Goertzel).

Builds on #<PR 1 number>.
EOF
```

- [ ] **Step 3: Record the PR numbers**

Replace `#TBD` in both README fork notes (Task 7 Step 3) with the numbers; commit on `main` as `docs: link upstream PRs`.

---

## Self-review

- **Spec coverage.** Fix 1 → Task 2; Fix 2 → Tasks 3–5; smoke test as acceptance → Tasks 1, 5, 6; lazy-require/capabilities → Moss's plan (Plan 2), not this repo; floors → CHANGELOG/README text only, enforced by upstream's version gates already; scope/publish/darwin x64 → Task 7; upstream PRs → Task 8. macOS manual smoke run is not a task here: it needs the owner's Mac and is listed in the spec's definition of done for the whole feature.
- **Placeholders.** `#TBD` in Task 7 is deliberate and resolved by Task 8 Step 3; `<Linux crate list>` refers to the exact list quoted in Task 2 Step 6.
- **Type consistency.** `exclude_pids: Vec<u32>` (core) / `with_exclude_pids(Vec<u32>)` (three backends) / `exclude_pids: Option<Vec<u32>>` (napi) / `excludePids` (JS); `PidSelect::Exclude(HashSet<u32>)`, `is_subject_pid`, `selects`, `node_key` used identically in Task 3 Steps 4–6.
