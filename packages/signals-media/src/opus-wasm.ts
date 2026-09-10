/**
 * The WASM Opus backend — fallback `OpusCodec` for engines with no WebCodecs
 * AUDIO (Apple WebKit before Safari 26; design spec decision 5b). Reachable
 * ONLY via the `./opus-wasm` package subpath — never imported from
 * `index.ts` or any other source file, so a host that never needs it never
 * pays to load the WASM module.
 *
 * `types.ts`'s `OpusCodec.createEncoder`/`createDecoder` must be SYNCHRONOUS
 * (R6) — the receive path is synchronous end to end
 * (`VoiceCarrier.openPeer`/`receiveFrame`, `types.ts`). `libopus-wasm`
 * cannot honor that directly: its `createEncoder`/`createDecoder` are always
 * Promise-returning, even once the module is warm, because its internal
 * `getModule()` is an unexported `async function` and there is no exported
 * synchronous "construct from an already-loaded module" primitive
 * (confirmed by reading `libopus-wasm@0.3.0`'s `dist/index.js` — investigated
 * for this task; see the NEEDS_CONTEXT analysis this file's task report
 * keeps for the record). Controller ruling R7 resolves that by keeping R6
 * and making the facades below QUEUE: `encode`/`decode` calls made before
 * the real handle resolves are buffered (bounded, oldest-dropped) and
 * drained in order once it does; after that they pass straight through.
 *
 * `libopus-wasm` functions used (README + `dist/index.d.ts`,
 * `libopus-wasm@^0.3.0`): `loadLibopus()` (module warm-up — `wasmOpus`'s
 * only async step; the module promise it forces is cached internally, so
 * later `createEncoder`/`createDecoder` calls pay no load cost, only the
 * unavoidable microtask hop of a resolved Promise), `createEncoder(options)`,
 * `createDecoder(options)`, `Application.Voip`; on the resolved handles:
 * `encodeFloat(pcm)`, `decodeFloat(packet)`, `free()`.
 *
 * Encoder/decoder configuration matches the WebCodecs backend
 * (`opus-webcodecs.ts`): 48 kHz mono, 960-sample (20 ms) frames, ~24 kbps,
 * VoIP application. Packet `type` is always `'key'` (Opus has no delta
 * frames; the field exists for wire compatibility).
 *
 * Constrains: src/voice-carrier.ts (its consumer via `VoiceHost.codec`),
 * src/types.ts (the seam).
 */

import {
  Application,
  createDecoder as libCreateDecoder,
  createEncoder as libCreateEncoder,
  loadLibopus,
  type OpusDecoderHandle,
  type OpusEncoderHandle,
  type SampleRate,
} from 'libopus-wasm';
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from './voice-capture.js';
import type { OpusCodec, OpusDecoder, OpusEncoder, OpusPacket } from './types.js';

const OPUS_BITRATE = 24000;

/**
 * Bounded facade queue depth: 1 s of 20 ms audio. Exceeding it drops the
 * OLDEST queued item — the same newest-wins preference the playout
 * scheduler has — and logs once per facade.
 */
export const WASM_PENDING_MAX = 50;

// `VOICE_SAMPLE_RATE` (voice-capture.ts) is typed `number`, not a literal —
// it is always 48000, one of libopus-wasm's five allowed `SampleRate`
// values, so this cast documents that constraint rather than widening past it.
const CODEC_SAMPLE_RATE = VOICE_SAMPLE_RATE as SampleRate;

const ENCODER_OPTIONS = {
  sampleRate: CODEC_SAMPLE_RATE,
  channels: 1 as const,
  application: Application.Voip,
  bitrate: OPUS_BITRATE,
  frameSize: VOICE_FRAME_SAMPLES,
};

const DECODER_OPTIONS = {
  sampleRate: CODEC_SAMPLE_RATE,
  channels: 1 as const,
};

interface QueuedEncode {
  pcm: Float32Array;
  timestampUs: number;
}

function warnQueueOverflow(kind: 'encoder' | 'decoder'): void {
  console.warn(
    `voice: wasm ${kind} queue exceeded ${WASM_PENDING_MAX} frames before libopus-wasm was ready; dropping oldest`
  );
}

interface QueuedFacadeConfig<THandle, TItem> {
  /** The real (Promise-returning) `libopus-wasm` factory call. */
  acquire: () => Promise<THandle>;
  /** The real synchronous call for one item. May throw. */
  dispatch: (handle: THandle, item: TItem) => void;
  /** Defensive copy taken when an item must be queued past this tick. */
  copy: (item: TItem) => TItem;
  /** Releases the handle — called on close, or on resolve-after-close. */
  free: (handle: THandle) => void;
  onError: (e: unknown) => void;
  warnKind: 'encoder' | 'decoder';
}

/**
 * One synchronous facade (R6) over one Promise-returning `libopus-wasm`
 * factory (R7): `push` queues items made before `acquire()` resolves —
 * bounded by `WASM_PENDING_MAX`, oldest dropped with one `console.warn` per
 * facade — and drains them through `dispatch`, in order, the moment the
 * handle is ready; after that `push` calls `dispatch` directly. A rejected
 * `acquire()` reports `onError` once, drops the queue, and makes every later
 * `push` a no-op. `close()` is idempotent: clears the queue and frees the
 * handle immediately if already resolved, or the moment it resolves
 * afterward. Shared by both `createEncoderFacade` and `createDecoderFacade`
 * — a second copy of this control flow is exactly the duplication this
 * helper exists to prevent.
 *
 * Reentrancy invariant: `dispatch` must not call back into this facade's
 * `push` synchronously — drain order is not preserved if it does.
 */
function createQueuedFacade<THandle, TItem>(
  config: QueuedFacadeConfig<THandle, TItem>
): { push: (item: TItem) => void; close: () => void; ready: Promise<THandle> } {
  let handle: THandle | null = null;
  let closed = false;
  let failed = false;
  let warned = false;
  const pending: TItem[] = [];

  const runDispatch = (h: THandle, item: TItem): void => {
    try {
      config.dispatch(h, item);
    } catch (e) {
      config.onError(e);
    }
  };

  const ready = config.acquire();
  ready.then(
    h => {
      if (closed) {
        config.free(h);
        return;
      }
      handle = h;
      for (const item of pending) {
        runDispatch(h, item);
      }
      pending.length = 0;
    },
    e => {
      if (closed) return;
      failed = true;
      pending.length = 0;
      config.onError(e);
    }
  );

  return {
    push(item: TItem): void {
      if (closed || failed) return;
      if (handle) {
        runDispatch(handle, item);
        return;
      }
      if (pending.length >= WASM_PENDING_MAX) {
        pending.shift();
        if (!warned) {
          warned = true;
          warnQueueOverflow(config.warnKind);
        }
      }
      pending.push(config.copy(item));
    },
    close(): void {
      if (closed) return;
      closed = true;
      pending.length = 0;
      if (handle) {
        config.free(handle);
        handle = null;
      }
    },
    ready,
  };
}

function createEncoderFacade(
  onPacket: (p: OpusPacket) => void,
  onError: (e: unknown) => void
): OpusEncoder {
  const facade = createQueuedFacade<OpusEncoderHandle, QueuedEncode>({
    acquire: () => libCreateEncoder(ENCODER_OPTIONS),
    dispatch: (handle, { pcm, timestampUs }) => {
      const data = handle.encodeFloat(pcm);
      onPacket({ type: 'key', timestampUs, data });
    },
    copy: ({ pcm, timestampUs }) => ({ pcm: pcm.slice(), timestampUs }),
    free: handle => handle.free(),
    onError,
    warnKind: 'encoder',
  });

  return {
    encode(pcm: Float32Array, timestampUs: number): void {
      facade.push({ pcm, timestampUs });
    },
    async flush(): Promise<void> {
      // libopus-wasm's encoder handle has no flush() — awaiting facade.ready
      // is what guarantees any pre-ready queue has drained (the facade's own
      // drain callback was attached first, so it always runs before this
      // await resolves), which is the only flush semantics this backend has.
      try {
        await facade.ready;
      } catch {
        // already reported via onError above
      }
    },
    close(): void {
      facade.close();
    },
  };
}

function createDecoderFacade(
  onPcm: (pcm: Float32Array, timestampUs: number) => void,
  onError: (e: unknown) => void
): OpusDecoder {
  const facade = createQueuedFacade<OpusDecoderHandle, OpusPacket>({
    acquire: () => libCreateDecoder(DECODER_OPTIONS),
    dispatch: (handle, packet) => {
      const pcm = handle.decodeFloat(packet.data);
      onPcm(pcm, packet.timestampUs);
    },
    copy: packet => ({ type: packet.type, timestampUs: packet.timestampUs, data: packet.data.slice() }),
    free: handle => handle.free(),
    onError,
    warnKind: 'decoder',
  });

  return {
    decode(packet: OpusPacket): void {
      facade.push(packet);
    },
    close(): void {
      facade.close();
    },
  };
}

/**
 * Instantiates the WASM module once. Hosts call this at startup and pass the
 * result through `VoiceHost.codec`/`FilmstripHost` equivalents (voice only,
 * per the design spec). `loadLibopus()` is `libopus-wasm`'s documented
 * warm-up primitive ("Loads the module; returns the bundled libopus
 * version"); it caches the module promise internally, so every
 * `createEncoder`/`createDecoder` call the returned facades make afterward
 * pays no load cost.
 */
export async function wasmOpus(): Promise<OpusCodec> {
  await loadLibopus();
  return {
    name: 'wasm',
    createEncoder: createEncoderFacade,
    createDecoder: createDecoderFacade,
  };
}
