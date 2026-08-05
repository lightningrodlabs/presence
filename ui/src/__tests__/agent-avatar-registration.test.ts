// @vitest-environment jsdom
/**
 * View-layer round (§8 view-misc row): <agent-avatar> collision pin.
 *
 * Two facts this file mechanizes:
 *
 * 1. The tag `agent-avatar` is registered by OUR lobby/agent-avatar.ts.
 *    The @holochain-open-dev/profiles library ships an element with the
 *    SAME tag name (dist/elements/agent-avatar.js); if any import chain
 *    ever pulls the library registration in alongside ours, the second
 *    customElements.define throws and module evaluation dies at load —
 *    in the field that is a blank app, not a test failure. The identity
 *    assertion below fails first: the constructor registered for the tag
 *    must be the local class.
 *
 * 2. room-view registers the tag it renders. Before this round room-view
 *    used <agent-avatar> in its template but imported no registration —
 *    the tag resolved only because presence-app transitively loaded
 *    lobby/list-online-agents → lobby/agent-avatar. Any refactor of that
 *    unrelated import chain would have silently turned the logs-graph
 *    avatar into an unknown element (Lit renders unknown tags inert, no
 *    error). Importing ONLY room-view must now be enough to register it.
 *
 * Imports are dynamic and ordered: a static `import '../lobby/agent-avatar'`
 * here would register the tag itself and make fact 2 vacuously green — the
 * constructor is captured after loading room-view but before this file
 * touches the lobby module.
 */
import { describe, it, expect, vi } from 'vitest';

// Same jsdom-import caveat as view-teardown-symmetry.test.ts: logs-graph
// pulls plotly.js, which does not survive jsdom import.
vi.mock('../room/logs-graph', () => ({}));

describe('agent-avatar tag registration', () => {
  it('room-view alone registers the tag it renders, and the constructor is the local lobby class', async () => {
    await import('../room/room-view');
    // Captured BEFORE this file imports the lobby module — if room-view
    // dropped its registration import, this is undefined, not repaired
    // by the identity lookup below.
    const registered = customElements.get('agent-avatar');
    expect(registered).toBeDefined();

    const { AgentAvatar } = await import('../lobby/agent-avatar');
    expect(registered).toBe(AgentAvatar);
  });
});
