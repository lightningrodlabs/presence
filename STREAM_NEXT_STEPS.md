# Streaming transport — the mic-source architecture

The design that produced `MicSource`/`CameraSource` and made voice-over-signals a
second transport for the microphone rather than a parallel feature. Decided
2026-04-11 on `feature/voice-over-signals`, now merged and shipping.

The full working notes — three open questions, their sign-offs, and two
pre-flight code passes — are in this file's git history. What follows is the
part that still governs code.

## The problem it solved

Voice-over-signals first shipped as a parallel module alongside the WebRTC audio
path. That was the wrong shape: voice and WebRTC-audio are not two features, they
are **two transports for the same conceptual thing — the user's microphone.** The
symptoms were diagnostic of the shape:

- A "waiting for connection" overlay stuck around when WebRTC was off, even
  though Holochain room membership was fine.
- Two simultaneous `getUserMedia` calls, one from WebRTC and one from the voice
  module, competed for the same input device.
- Mute state, device-picker state and AGC/NS settings lived inside the WebRTC
  code path and could not be reused.

## The rules that came out of it

**The audio source is lifted out of WebRTC.** `MicSource` owns the
`getUserMedia` call, the selected device id and the mute flag, and exposes a
`MediaStreamTrack`. WebRTC's `audioOn`/`audioOff` is one consumer; voice's
`MediaStreamTrackProcessor` is another. Ownership is refcounted, which is why two
carriers can coexist without fighting over the microphone and why muting behaves
uniformly across them. `CameraSource` follows the same shape for video.

**"The mic" is the user's mental model; transport is plumbing.** Mute and
device-pick UX is identical regardless of which transport carries the audio, and
lives in the `mic` module rather than in either transport.

**The overlay waits on bytes, not on a peer connection.** "Waiting for
connection" was always wrong — the connection (Holochain room membership) is
established, and the agent circle indicates it. The condition is "agent in room
AND no media flowing yet", not "no WebRTC peer connection".

**Modules carry an acquisition phase.** `ModuleStateEnvelope` has
`phase: 'acquiring' | 'active'`; the pane renderer filters share tiles by phase.
`mic` is `acquiring` across the permission prompt, and `screen-share` activates
as `acquiring`, transitions to `active` on stream arrival, and deactivates
directly from `acquiring` if the picker is cancelled. This is the genuinely
shared cross-source concept, and it lives at the module-framework level.

## Still deferred

**A generalized `StreamSource<T>` abstraction — and its trigger condition is now
met.** This was deferred in April because only `MicSource` was designed in depth,
per-source surfaces (AEC/NS/AGC, display-media picker, `facingMode`, sensor
sampling) don't compress, and the unification breaks on non-`MediaStreamTrack`
sources. The stated condition for revisiting was "when `MicSource` plus at least
one other concrete source exist and have diverged in ways a base class would have
prevented." **`CameraSource` now exists** (`ui/src/camera-source.ts`), so the
comparison is available — make the call on the evidence rather than deferring
again by default.

Also still deferred, unchanged: renaming the `video` module (worth doing, noisy);
squelch and module transitions; an unreliable-datagram path through kitsune2
(only if measured signal latency under load proves unacceptable); native
Moss-side AEC or audio capture.
