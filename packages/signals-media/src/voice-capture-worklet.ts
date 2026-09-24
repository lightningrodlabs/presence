// AudioWorkletProcessor: accumulates 128-frame render quanta into 960-sample
// (20 ms @ 48 kHz) mono blocks and posts each block (transferred) to the main
// thread, where `VoiceCapture` hands it to the Opus encoder. This file has NO
// imports — it is loaded by `AudioWorklet.addModule` into a scope with no
// module graph — and it is the ONE 128 → 960 accumulator (no pure duplicate;
// `src/__tests__/voice-capture.test.ts` drives this class directly).
//
// The two globals below exist only in the AudioWorklet scope; they are
// declared rather than typed from a lib because `@types/audioworklet`
// conflicts with the DOM lib this package compiles against.
declare const AudioWorkletProcessor: any;
declare function registerProcessor(n: string, c: any): void;

// Must equal `VOICE_FRAME_SAMPLES` in voice-capture.ts (960 samples = 20 ms
// at VOICE_SAMPLE_RATE), and with it the `20_000` µs timestamp step that
// file advances per block: the encoder's frame duration and this buffer's
// length are the same number seen from two sides. A worklet module is
// evaluated in the AudioWorklet global scope and cannot import, so this
// comment is the only link between the two constants — change one, change
// both.
const FRAME = 960;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(FRAME);

  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(FRAME - this.n, ch.length - i);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === FRAME) {
        const out = this.buf;
        (this as any).port.postMessage(out, [out.buffer]);
        this.buf = new Float32Array(FRAME);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('signals-media-voice-capture', VoiceCaptureProcessor);

export {};
