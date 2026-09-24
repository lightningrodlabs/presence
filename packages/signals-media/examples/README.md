# Examples

Two hosts, from smallest to real. Both are the code the
[integration guide](../README.md#integration) describes in prose, made
concrete; where an example leans on a documented rule its comment names the
README section that states it.

| File | What it is |
|---|---|
| [`minimal-host.ts`](minimal-host.ts) | The smallest thing that works: one host record for both carriers, `getUserMedia` devices, a 48 kHz `AudioContext` unlocked by a click, a `FilmstripPlayback` painting into an `<img>` per peer. The transport is an interface you supply — a WebSocket broadcast relay is the easy one. No Holochain. |
| [`holochain-host.ts`](holochain-host.ts) | The full one, over `@holochain/client`: a call-membership set that *is* the target set, a ping/pong loop feeding `decideSignalsMediaCadence`, a `media-hello` capability handshake behind `batchEligible()`, the per-peer carrier switch, refcounted devices, and per-peer video with A/V skew reporting. |
| [`holochain-zome.rs`](holochain-zome.rs) | The coordinator-zome half of the Holochain example — `send_message` and `recv_remote_signal`, copied from Presence's room zome. |

## How they are checked

The two TypeScript files are typechecked, not run:

```sh
npm run typecheck        # tsc --noEmit over src, then tsc -p tsconfig.examples.json
```

`tsconfig.examples.json` maps `@lightningrodlabs/signals-media` and
`@lightningrodlabs/signals-media/opus-wasm` onto `src/`, so the examples import
the package by its published name with no build step. They compile under the
package's own `strict` + `noUnusedLocals` + `noUnusedParameters`, so a
signature that drifts breaks the typecheck.

They are examples, not tests: no runner, no mocks, no assertions. Reading them
is the point.

**`holochain-zome.rs` is reference only** — no gate in this package compiles
Rust. Drop it into your own coordinator zome and build it there.

## The three lines you change first

1. **The zome and role names.** `ROLE_NAME` and `ZOME_NAME` at the top of
   `holochain-host.ts` are Presence's; yours will differ, as will the
   `fn_name` if you do not paste `holochain-zome.rs` verbatim.
2. **The roster.** `joinCall(peer)` / `leaveCall(peer)` are called by your
   application, from whatever already knows who is in the call. The set they
   maintain is `host.targets()` — nothing else decides who receives media.
3. **The transport.** In `minimal-host.ts` that is the `Channel` interface;
   in `holochain-host.ts` it is `sendTo` plus the `client.on('signal')`
   dispatch. The library never touches either — it calls `host.send` and you
   call `receiveFrame`.

Everything else — the `media-hello` / `media-ping` / `media-pong` message
names, the `voice-batch-v1` capability string, the ping interval, the EWMA
constant — is application vocabulary the library never sees. Rename freely;
just keep both ends of your channel agreeing.
