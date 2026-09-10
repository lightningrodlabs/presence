/**
 * Bundler-proof fallbacks for the two files this package ships as separate
 * script entry points (design spec decision 10). `new URL('./x.js',
 * import.meta.url)` is the default path and works under a bundler that
 * emits the asset; where it doesn't (an inlining bundler, Tauri's asset
 * protocol, a `file://` origin), a host passes these through
 * `FilmstripHost.createWorker` / `VoiceHost.workletModuleUrl` instead.
 *
 * The sources come from `inline-sources.generated.ts`, whose `dist/` copy
 * the build overwrites with the real strings — see that file's header for
 * what a source checkout gets.
 */

import {
  FILMSTRIP_WORKER_SOURCE,
  VOICE_CAPTURE_WORKLET_SOURCE,
} from './inline-sources.generated.js';

const blobUrl = (src: string): string =>
  URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));

/**
 * A filmstrip worker built from the inlined source. The Blob URL is revoked
 * immediately — the Worker holds its own reference to the script once
 * construction has started.
 */
export function createInlineFilmstripWorker(): Worker {
  const u = blobUrl(FILMSTRIP_WORKER_SOURCE);
  try {
    return new Worker(u, { type: 'module' });
  } finally {
    URL.revokeObjectURL(u);
  }
}

/** For `VoiceHost.workletModuleUrl`. Not revoked: addModule may fetch it later. */
export function voiceWorkletModuleUrl(): string {
  return blobUrl(VOICE_CAPTURE_WORKLET_SOURCE);
}
