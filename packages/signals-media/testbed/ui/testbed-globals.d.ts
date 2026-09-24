/**
 * One authority for the testbed's automation surface and its two ambient
 * globals. `ui/testbed.js` writes `window.__testbed`; `testbed.spec.ts` reads
 * it. Before this file each side described that shape for itself, which is the
 * parallel-copy-that-drifts pattern — and only the reader's copy was checked
 * by anything.
 *
 * Constrains: ui/testbed.js (the writer), testbed.spec.ts (the reader).
 */
import type { FilmstripCarrier, VoiceCarrier } from '@lightningrodlabs/signals-media';

/** One `report(step, ok, detail)` line. */
export interface TestbedResult {
  ok: boolean;
  detail: string;
}

export type TestbedResults = Record<string, TestbedResult>;

/** Exactly what `ui/testbed.js`'s `stats()` returns. */
export interface TestbedStats {
  me: string;
  mode: string;
  started: boolean;
  /** ms since `startCapture` was called; 0 before then. */
  uptimeMs: number;
  voiceSent: number;
  clipsSent: number;
  voiceRecvPeers: string[];
  voiceSentPeers: string[];
  /** peer -> host-clock ms of the last voice frame received from it. */
  recvMs: Record<string, number>;
  sentMs: Record<string, number>;
  audioLevel: Record<string, number>;
  framesPainted: Record<string, number>;
  /** Whole-run painted rate. The >= 5 fps assertions read this. */
  fpsIn: Record<string, number>;
  /** Trailing-5 s painted rate. Display only. */
  fpsRecent: Record<string, number>;
  bufferDepth: Record<string, number>;
  voiceRx: Record<string, { jitterMs: number | null; lossPercent: number | null }>;
  videoRx: Record<
    string,
    {
      fpsActual: number | null;
      kbps: number | null;
      lossPercent: number | null;
      transitMs: number | null;
    }
  >;
  /** Count of strictly-newer voice session epochs seen, across all peers. */
  epochAdopts: number;
  epochs: Record<string, number>;
  restartCostMs: number | null;
  targets: string[];
  consoleErrors: string[];
}

export interface TestbedApi {
  me: string;
  mode: string;
  results: TestbedResults;
  done: boolean;
  stats(): TestbedStats;
  logLines(): string[];
  consoleErrors(): string[];
  start(): Promise<void>;
  /** Returns the measured cost in ms, or null if no frame was sent in time. */
  restartVoice(): Promise<number | null>;
  setTargets(list: string[] | null): string[];
  carriers: { voice: VoiceCarrier; filmstrip: FilmstripCarrier };
}

/** The slice of Tauri's `withGlobalTauri` surface the page uses. */
export interface TauriGlobal {
  core?: {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  };
}

declare global {
  interface Window {
    __testbed: TestbedApi;
  }
  // `var` (not just a Window member) so `globalThis.__TAURI__` resolves:
  // both are read off `globalThis` in ui/testbed.js, and the Tauri shell
  // injects `__TESTBED_QUERY` through an initialization script.
  // eslint-disable-next-line no-var
  var __TAURI__: TauriGlobal | undefined;
  // eslint-disable-next-line no-var
  var __TESTBED_QUERY: string | undefined;
}
