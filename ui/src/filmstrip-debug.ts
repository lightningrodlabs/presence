/**
 * Filmstrip flash forensics.
 *
 * A signals-video pane can only paint black from two sources:
 *   (a) the .video-container's black background showing through a
 *       moment where the .strip div isn't painting its bg-image, or
 *   (b) black JPEG content arriving from the sender.
 * This module provides the instrumentation to tell those apart with
 * evidence rather than guesses.
 *
 * 1. Event ring buffer (always on, in-memory, ~zero cost): every event
 *    that can change what the .strip paints is logged with a
 *    performance.now() timestamp (sub-ms, monotonic). From DevTools:
 *
 *      __filmstripDebug.dump()        // last 30 s, console.table + return
 *      __filmstripDebug.dump(120000)  // last 2 min
 *      __filmstripDebug.mark('saw flash')  // or press F9 when flag is on
 *
 *    Workflow: watch a call; the moment a flash is seen press F9; then
 *    dump() and read the events in the ~200 ms before the MARK entry.
 *    The event sequence identifies which code path blanked the strip
 *    (or shows that none did, implicating frame content).
 *
 * 2. Color-coding (off by default; enable with
 *    `localStorage.setItem('filmstripDebug', '1')` and reload):
 *      - .video-container background: magenta instead of black
 *      - .strip: lime background-color while a clip is displayed
 *    A flash then classifies its own cause by color:
 *      magenta = strip element not painting at all (cleared bg-image,
 *                unmount/remount, zero-size layout moment)
 *      lime    = strip painting but its bg-image missing at paint time
 *                (CSS image decode race, revoked blob URL)
 *      black   = the flash is the JPEG content itself — sender-side,
 *                receiver rendering is innocent
 */

export interface FilmstripDebugEvent {
  /** performance.now() ms, sub-ms resolution, monotonic. */
  t: number;
  /** First 8 chars of the peer pubkey ('-' for global events). */
  peer: string;
  event: string;
  detail?: string;
}

const RING_SIZE = 8000;

class FilmstripDebug {
  private buf: FilmstripDebugEvent[] = [];

  /**
   * Whether the color-coded backgrounds (magenta container / lime
   * strip) and the F9 mark hotkey are enabled. Read once at load —
   * requires a reload after toggling the localStorage flag, which is
   * fine for a diagnostic session.
   */
  readonly colorsEnabled: boolean =
    typeof window !== 'undefined' &&
    window.localStorage?.getItem('filmstripDebug') === '1';

  log(peerB64: string, event: string, detail?: string): void {
    this.buf.push({
      t: performance.now(),
      peer: peerB64 === '' ? '-' : peerB64.slice(0, 8),
      event,
      detail,
    });
    if (this.buf.length > RING_SIZE) {
      this.buf.splice(0, this.buf.length - RING_SIZE);
    }
  }

  /** Insert a marker — call (or press F9) the moment a flash is seen. */
  mark(note = 'flash observed'): void {
    this.log('-', 'MARK', note);
    console.log(`[filmstrip-debug] MARK @ ${performance.now().toFixed(1)}ms — ${note}`);
  }

  /**
   * Return (and console.table) events from the last `sinceMs` ms, with
   * a `dt` column showing ms since the previous event for easy gap
   * spotting.
   */
  dump(sinceMs = 30000): Array<FilmstripDebugEvent & { dt: number }> {
    const cutoff = performance.now() - sinceMs;
    const events = this.buf.filter(e => e.t >= cutoff);
    const rows = events.map((e, i) => ({
      ...e,
      t: Math.round(e.t * 10) / 10,
      dt: i === 0 ? 0 : Math.round((e.t - events[i - 1].t) * 10) / 10,
    }));
    console.table(rows);
    return rows;
  }
}

export const filmstripDebug = new FilmstripDebug();

if (typeof window !== 'undefined') {
  (window as any).__filmstripDebug = filmstripDebug;
  if (filmstripDebug.colorsEnabled) {
    window.addEventListener('keydown', e => {
      if (e.key === 'F9') filmstripDebug.mark();
    });
    console.log(
      '[filmstrip-debug] color-coding ON (magenta=container bg, lime=strip bg). ' +
        'F9 marks a flash; __filmstripDebug.dump() shows the event log.'
    );
  }
}
