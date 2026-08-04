// @vitest-environment jsdom
/**
 * Round 3 item 4b(1) — logs-graph's missing super.disconnectedCallback,
 * the retro's leak #3 verbatim, in a component with four @consume
 * controllers. It escaped the view-teardown suite because that suite
 * mocks the whole module away (`vi.mock('../room/logs-graph')` — plotly
 * does not survive jsdom import). This file mocks PLOTLY instead and
 * loads the real element, so the pin cannot be hidden by the module
 * mock: dropping the super call fails the controller-spy test below.
 */
import { describe, it, expect, vi } from 'vitest';

// Plotly is only touched at render/firstUpdated time; an empty default
// export satisfies the value import (type imports are erased).
vi.mock('plotly.js-dist-min', () => ({ default: {} }));

import '../room/logs-graph';

describe('LogsGraph.disconnectedCallback', () => {
  it('reaches super.disconnectedCallback so the @consume controllers get hostDisconnected', () => {
    const el = document.createElement('logs-graph') as any;
    const hostDisconnected = vi.fn();
    el.addController({ hostDisconnected });
    el.disconnectedCallback();
    expect(hostDisconnected).toHaveBeenCalledTimes(1);
  });

  it('still runs its own unsubscribers', () => {
    const el = document.createElement('logs-graph') as any;
    const unsub = vi.fn();
    el.eventUnsubscribers = [unsub];
    el.disconnectedCallback();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
