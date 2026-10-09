// @vitest-environment jsdom
/**
 * renderSharedPanel mounts every registered `shareOverlayElement` into
 * every share tile (spec "Two new module aspects"). Same style as
 * intent-diff-surfaces.test.ts: a constructed, never-mounted room-view
 * with a fake store, rendering the template method into a detached host.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../room/logs-graph', () => ({}));

import { render } from 'lit';
import { writable } from '@holochain-open-dev/stores';
import '../room/room-view';

const myPubKey = new Uint8Array(39).fill(1);
const PEER = 'uhCAkpeer';

function makeRoomView(mine: Record<string, unknown>, peers: Record<string, Record<string, unknown>>): any {
  const el = document.createElement('room-view') as any;
  el.streamsStore = {
    _myModuleStates: writable(mine),
    _peerModuleStates: writable(peers),
    _screenShareConnectionsIncoming: writable({}),
    clock: { now: () => 0 },
    phantomAgents: () => [],
    disconnect: vi.fn(),
  };
  el.roomStore = { client: { client: { myPubKey } } };
  el._myModuleStates = { value: mine };
  el._peerModuleStates = { value: peers };
  el._presentPeers = { value: [] };
  el._showConnectionDetails = false;
  return el;
}

const env = (moduleId: string, payload: object) => ({ moduleId, active: true, payload: JSON.stringify(payload), updatedAt: 1 });

describe('renderSharedPanel share overlays', () => {
  it('mounts the annotations overlay into an own screen-share tile and a peer wal tile', () => {
    const el = makeRoomView(
      { 'screen-share': env('screen-share', { annotationsEpoch: 1 }) },
      { [PEER]: { wal: env('wal', { weaveUrl: 'weave://x', annotationsEpoch: 1 }) } },
    );
    const host = document.createElement('div');
    render(el.renderSharedPanel(), host);
    const frames = Array.from(host.querySelectorAll('.shared-panel-frame'));
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      const overlay = frame.querySelector('module-annotations-share-overlay') as any;
      expect(overlay).not.toBeNull();
      // Under the maximize icon in document order, so the icon paints on top.
      const icon = frame.querySelector('.maximize-icon')!;
      expect(overlay.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const own = frames[0].querySelector('module-annotations-share-overlay') as any;
    expect(own.shareModuleId).toBe('screen-share');
    expect(own.context.isMe).toBe(true);
    const theirs = frames[1].querySelector('module-annotations-share-overlay') as any;
    expect(theirs.shareModuleId).toBe('wal');
    expect(theirs.sharerPubKeyB64).toBe(PEER);
    expect(theirs.context.isMe).toBe(false);
  });

  it('negative control: with no share active nothing is mounted', () => {
    const el = makeRoomView({}, {});
    const host = document.createElement('div');
    render(el.renderSharedPanel(), host);
    expect(host.querySelector('module-annotations-share-overlay')).toBeNull();
  });
});
