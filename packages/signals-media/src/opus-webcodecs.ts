/**
 * The WebCodecs Opus backend — the default `OpusCodec` (design spec decision
 * 5b). Chromium provides `AudioEncoder`/`AudioDecoder` natively, WebKitGTK
 * over GStreamer, Apple WebKit only from Safari 26; hosts on older Apple
 * builds pass `wasmOpus()` through `VoiceHost.codec` instead.
 *
 * The encoder/decoder configuration here is Presence's
 * (`ui/src/room/modules/voice.ts` @ ab90584, `startCapture` and `openPeer`):
 * 48 kHz mono, 24 kbps, 20 ms frames. Changing it changes the wire.
 *
 * Constrains: src/voice-carrier.ts (its consumer), src/types.ts (the seam).
 */

import { VOICE_SAMPLE_RATE } from './voice-capture.js';
import type { OpusCodec, OpusDecoder, OpusEncoder, OpusPacket } from './types.js';

/** WebCodecs types are not in lib.dom for this TS target, so use locals. */
type AnyEncodedAudioChunk = any;
type AnyAudioData = any;

const OPUS_BITRATE = 24000;

/**
 * The WebCodecs backend, or null when this engine has no WebCodecs AUDIO
 * (the video codecs alone are not enough — Safari 16.4–18.x ship exactly
 * that).
 */
export function webCodecsOpus(): OpusCodec | null {
  const g = globalThis as any;
  if (!g.AudioEncoder || !g.AudioDecoder || !g.EncodedAudioChunk || !g.AudioData) {
    return null;
  }
  return {
    name: 'webcodecs',

    createEncoder(
      onPacket: (p: OpusPacket) => void,
      onError: (e: unknown) => void
    ): OpusEncoder {
      const enc = new g.AudioEncoder({
        output: (chunk: AnyEncodedAudioChunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          onPacket({ type: chunk.type, timestampUs: chunk.timestamp, data });
        },
        error: (e: unknown) => onError(e),
      });
      enc.configure({
        codec: 'opus',
        sampleRate: VOICE_SAMPLE_RATE,
        numberOfChannels: 1,
        bitrate: OPUS_BITRATE,
      });
      return {
        encode(pcm: Float32Array, timestampUs: number): void {
          const ad = new g.AudioData({
            format: 'f32-planar',
            sampleRate: VOICE_SAMPLE_RATE,
            numberOfFrames: pcm.length,
            numberOfChannels: 1,
            timestamp: timestampUs,
            data: pcm,
          });
          try {
            if (enc.state === 'configured') enc.encode(ad);
          } finally {
            try {
              ad.close();
            } catch {
              // already closed by the encoder
            }
          }
        },
        async flush(): Promise<void> {
          await enc.flush();
        },
        close(): void {
          try {
            enc.close();
          } catch {
            // already closed
          }
        },
      };
    },

    createDecoder(
      onPcm: (pcm: Float32Array, timestampUs: number) => void,
      onError: (e: unknown) => void
    ): OpusDecoder {
      const dec = new g.AudioDecoder({
        output: (data: AnyAudioData) => {
          try {
            const channel = new Float32Array(data.numberOfFrames);
            try {
              data.copyTo(channel, { planeIndex: 0, format: 'f32-planar' });
            } catch {
              // some implementations only expose 'f32' (interleaved); for mono
              // this gives the same result. fall back without specifying format.
              data.copyTo(channel, { planeIndex: 0 });
            }
            onPcm(channel, data.timestamp);
          } finally {
            try {
              data.close();
            } catch {
              // already closed
            }
          }
        },
        error: (e: unknown) => onError(e),
      });
      dec.configure({
        codec: 'opus',
        sampleRate: VOICE_SAMPLE_RATE,
        numberOfChannels: 1,
      });
      return {
        decode(packet: OpusPacket): void {
          let chunk: AnyEncodedAudioChunk;
          try {
            chunk = new g.EncodedAudioChunk({
              type: packet.type,
              timestamp: packet.timestampUs,
              data: packet.data,
            });
          } catch (e) {
            console.error('voice: failed to construct EncodedAudioChunk', e);
            return;
          }
          try {
            if (dec.state === 'configured') dec.decode(chunk);
          } catch (e) {
            console.error('voice: decode failed', e);
          }
        },
        close(): void {
          try {
            dec.close();
          } catch {
            // already closed
          }
        },
      };
    },
  };
}
