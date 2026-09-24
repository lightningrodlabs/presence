/**
 * Placeholder for the generated inline sources. CHECKED IN so `tsc` and a
 * source checkout resolve this import; `npm run build`
 * (`scripts/gen-inline-sources.mjs`, after tsc) OVERWRITES the compiled
 * `dist/inline-sources.generated.js` with the real worker and worklet
 * sources. The emitted `.d.ts` is generated from THIS file and is left
 * alone — the declared type is `string` either way.
 *
 * Consequence, documented for the README: in a source checkout (running out
 * of `src/`, not `dist/`) `createInlineFilmstripWorker()` and
 * `voiceWorkletModuleUrl()` build empty-source Blob URLs. Use the
 * `dist/`-relative default (`new URL('./filmstrip-worker.js', …)`) or a
 * `FilmstripHost.createWorker` / `VoiceHost.workletModuleUrl` override
 * there.
 *
 * The explicit `: string` annotations matter: without them tsc infers the
 * literal type `""` and bakes it into the `.d.ts`, which the build's
 * overwrite would then contradict.
 */

export const FILMSTRIP_WORKER_SOURCE: string = '';
export const VOICE_CAPTURE_WORKLET_SOURCE: string = '';
