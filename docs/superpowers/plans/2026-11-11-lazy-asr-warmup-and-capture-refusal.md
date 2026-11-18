# Presence: lazy transcription warm-up and typed capture refusal

Written for: an agent working in this repository (Presence, branch `main-0.7`, UI in `ui/`), with no other context.

Status: landed 2026-11-18 on `main-0.7` (Task 1 on branch `fix/lazy-asr-warmup`, Task 2 on `fix/capture-refusal-row`, with the amendments marked under each task). Written 2026-11-11. The Moss side is on the Moss branch `fix/lazy-audio-asr-services` (PR #270 against `main-0.7`, commits cc5bdb21 and 8ce122ff) and is not yet published to npm.

## Why

Moss measured two costs that Presence causes on every host:

1. Presence calls `asr.warmUp()` in `TranscriptionModule.bind()` (`ui/src/room/modules/transcription.ts`, about line 329). `bind()` runs when a room mounts, so opening the Presence tab loads the whisper model (about 320 MB of memory for minutes) on every host that has Transcription on, even when nobody transcribes. Moss now refuses that call for a Tool the user never allowed to transcribe, so the call fails on most hosts and is wasted on the rest.
2. Moss no longer probes its audio capture backend when a Tool loads. A Tool that cannot capture on this machine now learns that from the request itself, as a typed refusal. Presence shows its system audio row from the presence of `captureAudioSources` alone, so on such a host the row shows and the request fails with a generic error.

## Moss changes you build against

These are in `@theweave/api` on the Moss branch `fix/lazy-audio-asr-services`, in `libs/api/src/audio-source-capture.ts` and `libs/api/src/asr.ts`:

- `captureAudioSources()` still resolves `null` when the user cancels the picker. It now rejects with an `AudioSourceUnavailableError` when the host refuses before any picker opens. The error has `reason: 'unsupported' | 'disabled'`. `unsupported` means the capture backend cannot run on this machine. `disabled` means the user switched the Audio Sources service off.
- `isAudioSourceUnavailableError(e)` is the type guard. Use it, not `instanceof`. Presence bundles its own copy of `@theweave/api`, and the Moss iframe throws from another copy, so `instanceof` never matches.
- `asr.warmUp()` now rejects unless Transcription is on in Moss and the user already gave transcription consent to Presence. Moss asks for that consent at the first `openSession()`, never at `warmUp()`.

The published `@theweave/api` does not carry these yet. Before you start, run `npm view @theweave/api versions --json` and look for a version newer than the one in `ui/package.json`. If there is none, link the local build: in the Moss checkout run `yarn workspace @theweave/api build`, then in `ui/` point the dependency at `file:../../moss/libs/api` for the duration of the work and restore the version range before you commit. Do not commit the `file:` dependency.

## Task 1: move the warm-up out of `bind()`

Landed as written. Review added two test rows (a host whose `asr` has no `warmUp`, and a self-originated request) and a comment on the declined-prompt cost.

Goal: the model loads only when this user is about to transcribe.

1. Read `ui/src/room/modules/transcription.ts` from line 300 to line 350 and `ui/src/room/room-view.ts` from line 700 to line 745.
2. Find the test that asserts the warm-up in `bind()`. Run `grep -rn warmUp ui/src` and read every hit, including `ui/src/room/modules/__tests__/transcription-starting.test.ts`.
3. Write the failing tests first:
   - `bind()` does not call `warmUp()`.
   - When a peer's transcription request becomes pending for this user (the `pendingRequests.update` branch in the request handler, about line 527), the module calls `warmUp()` once and ignores a rejection.
4. Delete the `warmUp()` call and its comment from `bind()`.
5. Add the `warmUp()` call where the pending request is recorded. Guard it the same way the old code did: `typeof asr?.warmUp === 'function'`, and `.catch(() => undefined)`. A rejection is expected on a host where this user never consented.
6. Do not add a warm-up to `startCapture()` or to `_toggleTranscriptionRequest()`. Both open a session at once, and `openSession()` loads the model itself.
7. Run `cd ui && npx vitest run`.

## Task 2: hide the system audio row on a host refusal

Landed with amendments (owner decisions, 2026-11-13 and 2026-11-18):

- The row is not hidden. It renders with the reason in its own label, as the other blocks do, and the view owns the copy.
- `unsupported` disables the row for the room visit. `disabled` keeps the row clickable as a retry, and the decision is `{ ok: true, hostRefused: 'disabled' }`.
- No published `@theweave/api` exported `isAudioSourceUnavailableError`, so Presence reads the error's name and reason in `audioSourceRefusalOf` (`ui/src/mic-output-policy.ts`), a declared parallel copy. No `file:` link was used.
- A click that ends in a refusal reopens the mic menu, because the click closed the menu before the host answered (review finding).
- Every outcome that is not a refusal clears a stored refusal (review finding).

Goal: a host that cannot capture hides the row after the first refusal, and a user cancel keeps the row.

1. Read `ui/src/streams-store.ts` around `systemAudioOn()` (about line 2180) and `ui/src/mic-output-policy.ts` from line 60 to line 100 (`decideSystemAudioRequest`, `SystemAudioRequestBlock`, `SystemAudioRequestInput`).
2. Write the failing tests first, next to the existing policy tests (`ui/src/presence-policy.test.ts` or the file that tests `decideSystemAudioRequest`):
   - `decideSystemAudioRequest` with `hostRefused: 'unsupported'` returns a block with a user-readable title that says this computer cannot capture.
   - `decideSystemAudioRequest` with `hostRefused: 'disabled'` returns a block whose title says the Audio Sources service is off in Moss.
   - `systemAudioOn()` on a seam that rejects with an error that passes `isAudioSourceUnavailableError` records the reason, writes no intent, and does not emit the generic `error` event.
   - `systemAudioOn()` on a seam that resolves `null` records nothing and the row stays enabled.
3. Add `hostRefused?: 'unsupported' | 'disabled'` to `SystemAudioRequestInput` and a `'host-refused'` block to `SystemAudioRequestBlock`.
4. In `StreamsStore`, keep the refusal in a private field, feed it to `decideSystemAudioRequest` in the `systemAudioRequest` getter, and set it in the `catch` of `systemAudioOn()` when `isAudioSourceUnavailableError(e)` is true. Keep the existing generic error path for every other exception.
5. Make the row render disabled with the block's title, the same way the other blocks already render. Do not add a new visual style.
6. Run `cd ui && npx vitest run` and the UI typecheck.

## Verification in Moss

From the Moss checkout run `yarn tool-dev-presence` (the Moss side builds and links the local Presence UI). Open a room in Presence, then read the Moss log file under `~/.config/org.lightningrodlabs.moss-0.16/0.16.0-dev/a/logs/we.log`. No `[whisper-server]` line must appear until a transcription request is pending or a session opens. Then turn transcription on in the room, and make sure that the model loads once and transcribes.

## Out of scope

Do not change the transcription payload protocol, the request and accept flow, or the Moss side. Do not add a settings switch for the warm-up.
