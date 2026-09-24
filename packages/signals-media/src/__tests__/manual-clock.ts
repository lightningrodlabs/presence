/** Test clock satisfying `MediaClock`; time only moves when a test moves it. */
export class ManualClock {
  constructor(private _now = 0) {}
  now(): number {
    return this._now;
  }
  advance(ms: number): void {
    this._now += ms;
  }
  set(ms: number): void {
    this._now = ms;
  }
}
