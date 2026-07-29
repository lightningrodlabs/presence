import { describe, it, expect } from 'vitest';
import { decideScreenSignalRoute } from '../screen-signal-policy';

describe('decideScreenSignalRoute — dir routing, pinned', () => {
  it("the peer's sharer side routes to OUR incoming-share transport", () => {
    expect(decideScreenSignalRoute('sharer')).toEqual({
      route: 'incoming-share',
      reason: 'peer-is-sharer',
    });
  });

  it("the peer's viewer side routes to OUR outgoing-share transport", () => {
    expect(decideScreenSignalRoute('viewer')).toEqual({
      route: 'outgoing-share',
      reason: 'peer-is-viewer',
    });
  });

  it('anything else drops rather than guesses', () => {
    for (const dir of [undefined, null, '', 'SHARER', 'both', 42, {}, []]) {
      expect(decideScreenSignalRoute(dir)).toEqual({
        route: 'drop',
        reason: 'missing-or-unknown-dir',
      });
    }
  });
});
