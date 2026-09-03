/**
 * PeerAudioLevels — owner of the per-peer WebRTC AnalyserNode surface
 * (store-decomposition round two;
 * docs/superpowers/specs/2026-09-03-owner-extraction-design.md).
 * State lives on PeerRecord.analyser; this object owns the behavior.
 */
import type { AgentPubKeyB64 } from '@holochain/client';
import type { PeerRecord } from './peer-record';

export type PeerAudioLevelsBindings = {
  /** micSource.ensureAudioContext, late-bound. */
  ensureAudioContext: () => AudioContext | null;
  peerRecord: (k: AgentPubKeyB64) => PeerRecord | undefined;
  ensurePeerRecord: (k: AgentPubKeyB64) => PeerRecord;
};

export class PeerAudioLevels {
  constructor(private readonly b: PeerAudioLevelsBindings) {}

  /**
   * Set up an AnalyserNode for a peer's incoming WebRTC audio stream.
   * Connected as: MediaStreamSource → AnalyserNode (no destination —
   * the <video> element handles playback). Called from the peer-stream
   * event handler.
   */
  setupPeerAudioAnalyser(pubKeyB64: string, stream: MediaStream): void {
    // Clean up any existing analyser for this peer
    { const r = this.b.peerRecord(pubKeyB64); if (r) r.analyser = undefined; }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    const ctx = this.b.ensureAudioContext();
    if (!ctx) return;

    // Resume if still suspended (Electron/Wayland sometimes leaves the
    // context suspended past creation; a suspended context means the audio
    // graph doesn't run and the analyser reads back zeros, even though the
    // <video> element plays audio fine).
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      // Do NOT connect analyser to destination — <video> handles playback
      this.b.ensurePeerRecord(pubKeyB64).analyser = { node: analyser, buffer: new Uint8Array(analyser.fftSize) };
    } catch (e) {
      console.warn('Failed to create audio analyser for peer:', e);
    }
  }

  /**
   * Read the current peak audio level for a peer from the WebRTC
   * AnalyserNode. Returns 0.0–1.0, or 0 if no analyser exists.
   * Called by the audio-level-meter element at 10fps.
   */
  getWebrtcAudioLevel(pubKeyB64: string): number {
    const a = this.b.peerRecord(pubKeyB64)?.analyser;
    if (!a) return 0;

    a.node.getByteTimeDomainData(a.buffer);
    let peak = 0;
    for (let i = 0; i < a.buffer.length; i += 4) {
      // Byte domain data is 0–255 centered at 128
      const v = Math.abs(a.buffer[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }
}
