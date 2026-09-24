/**
 * Main-thread half of the portable voice capture path (design spec decision
 * 5): mic track → `MediaStreamAudioSourceNode` → the AudioWorkletProcessor in
 * `voice-capture-worklet.ts` → 960-sample (20 ms @ 48 kHz) Float32 blocks.
 * This REPLACES Presence's `MediaStreamTrackProcessor` pump (`voice.ts`'s
 * `buildTrackReader`/`pumpEncoder`), which WebKitGTK does not implement.
 *
 * Constrains: src/voice-carrier.ts (its only caller in this package).
 */

/** The one sample rate this carrier speaks; Opus is configured to match. */
export const VOICE_SAMPLE_RATE = 48000;

/** Samples per Opus frame: 20 ms at `VOICE_SAMPLE_RATE`. */
export const VOICE_FRAME_SAMPLES = 960;

export class VoiceCapture {
  private src: MediaStreamAudioSourceNode | null = null;

  private node: AudioWorkletNode | null = null;

  private sink: GainNode | null = null;

  /** Monotonic frame counter — the encoder timestamp base (µs). */
  private frames = 0;

  /** `addModule` is idempotent per context but not free; load it once. */
  private moduleLoaded = new WeakSet<AudioContext>();

  async start(
    ctx: AudioContext,
    track: MediaStreamTrack,
    onFrame: (pcm: Float32Array, timestampUs: number) => void,
    moduleUrl: string
  ): Promise<boolean> {
    if (ctx.sampleRate !== VOICE_SAMPLE_RATE) {
      console.error(
        `voice: AudioContext must run at ${VOICE_SAMPLE_RATE} Hz, got ${ctx.sampleRate}`
      );
      return false;
    }
    try {
      if (!this.moduleLoaded.has(ctx)) {
        await ctx.audioWorklet.addModule(moduleUrl);
        this.moduleLoaded.add(ctx);
      }
    } catch (e) {
      console.error('voice: addModule failed', e);
      return false;
    }
    this.stop();
    // Graph construction throws on a closed/closing context, an ended track,
    // or an unregistered processor name. Contain it here — as Presence's
    // `buildTrackReader` contained the MediaStreamTrackProcessor
    // construction — so `start` RESOLVES false instead of rejecting: the
    // caller's failure arm (`VoiceCarrier.startCapture`) is what releases the
    // mic handle and closes the encoder, and a rejection would skip it and
    // strand the device.
    try {
      this.src = ctx.createMediaStreamSource(new MediaStream([track]));
      this.node = new AudioWorkletNode(ctx, 'signals-media-voice-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      // A zero-gain sink keeps the graph pulled on engines that only process
      // connected nodes (WebKit).
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.src.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(ctx.destination);
    } catch (e) {
      console.error('voice: failed to build the capture graph', e);
      this.stop();
      return false;
    }
    this.frames = 0;
    this.node.port.onmessage = e => {
      const pcm = e.data as Float32Array;
      onFrame(pcm, this.frames++ * 20_000);
    };
    return true;
  }

  /**
   * Device change: rebind the source to the new track. The worklet node and
   * the frame counter survive, so encoder timestamps stay continuous (the
   * property Presence's `onMicTrackChanged` preserved by keeping the
   * encoder across the processor rebuild).
   */
  replaceTrack(ctx: AudioContext, track: MediaStreamTrack): void {
    if (!this.node) return;
    this.src?.disconnect();
    this.src = ctx.createMediaStreamSource(new MediaStream([track]));
    this.src.connect(this.node);
  }

  stop(): void {
    try {
      this.src?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {
      // disconnect on an already-torn-down graph is not an error here.
    }
    if (this.node) this.node.port.onmessage = null;
    this.src = null;
    this.node = null;
    this.sink = null;
  }
}
