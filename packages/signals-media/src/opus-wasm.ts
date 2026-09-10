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

function encodeNow(
  handle: OpusEncoderHandle,
  pcm: Float32Array,
  timestampUs: number,
  onPacket: (p: OpusPacket) => void,
  onError: (e: unknown) => void
): void {
  try {
    const data = handle.encodeFloat(pcm);
    onPacket({ type: 'key', timestampUs, data });
  } catch (e) {
    onError(e);
  }
}

function decodeNow(
  handle: OpusDecoderHandle,
  packet: OpusPacket,
  onPcm: (pcm: Float32Array, timestampUs: number) => void,
  onError: (e: unknown) => void
): void {
  try {
    const pcm = handle.decodeFloat(packet.data);
    onPcm(pcm, packet.timestampUs);
  } catch (e) {
    onError(e);
  }
}

function warnQueueOverflow(kind: 'encoder' | 'decoder'): void {
  console.warn(
    `voice: wasm ${kind} queue exceeded ${WASM_PENDING_MAX} frames before libopus-wasm was ready; dropping oldest`
  );
}

function createEncoderFacade(
  onPacket: (p: OpusPacket) => void,
  onError: (e: unknown) => void
): OpusEncoder {
  let handle: OpusEncoderHandle | null = null;
  let closed = false;
  let failed = false;
  let warned = false;
  const pending: QueuedEncode[] = [];

  const readyPromise = libCreateEncoder(ENCODER_OPTIONS);
  readyPromise.then(
    h => {
      if (closed) {
        h.free();
        return;
      }
      handle = h;
      for (const { pcm, timestampUs } of pending) {
        encodeNow(h, pcm, timestampUs, onPacket, onError);
      }
      pending.length = 0;
    },
    e => {
      if (closed) return;
      failed = true;
      pending.length = 0;
      onError(e);
    }
  );

  return {
    encode(pcm: Float32Array, timestampUs: number): void {
      if (closed || failed) return;
      if (handle) {
        encodeNow(handle, pcm, timestampUs, onPacket, onError);
        return;
      }
      if (pending.length >= WASM_PENDING_MAX) {
        pending.shift();
        if (!warned) {
          warned = true;
          warnQueueOverflow('encoder');
        }
      }
      pending.push({ pcm: pcm.slice(), timestampUs });
    },
    async flush(): Promise<void> {
      // libopus-wasm's encoder handle has no flush() — awaiting readyPromise
      // is what guarantees any pre-ready queue has drained (the drain
      // callback above was attached first, so it always runs before this
      // await resolves), which is the only flush semantics this backend has.
      try {
        await readyPromise;
      } catch {
        // already reported via onError above
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      pending.length = 0;
      if (handle) {
        handle.free();
        handle = null;
      }
    },
  };
}

function createDecoderFacade(
  onPcm: (pcm: Float32Array, timestampUs: number) => void,
  onError: (e: unknown) => void
): OpusDecoder {
  let handle: OpusDecoderHandle | null = null;
  let closed = false;
  let failed = false;
  let warned = false;
  const pending: OpusPacket[] = [];

  libCreateDecoder(DECODER_OPTIONS).then(
    h => {
      if (closed) {
        h.free();
        return;
      }
      handle = h;
      for (const packet of pending) {
        decodeNow(h, packet, onPcm, onError);
      }
      pending.length = 0;
    },
    e => {
      if (closed) return;
      failed = true;
      pending.length = 0;
      onError(e);
    }
  );

  return {
    decode(packet: OpusPacket): void {
      if (closed || failed) return;
      if (handle) {
        decodeNow(handle, packet, onPcm, onError);
        return;
      }
      if (pending.length >= WASM_PENDING_MAX) {
        pending.shift();
        if (!warned) {
          warned = true;
          warnQueueOverflow('decoder');
        }
      }
      pending.push({
        type: packet.type,
        timestampUs: packet.timestampUs,
        data: packet.data.slice(),
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      pending.length = 0;
      if (handle) {
        handle.free();
        handle = null;
      }
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
