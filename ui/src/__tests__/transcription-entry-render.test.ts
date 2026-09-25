// @vitest-environment jsdom
/**
 * The room header's transcription entry on hosts with and without the
 * local-model seam (plan Review Focus 1; Task 4 fix round 1). Same style
 * as the system-audio row pins in intent-diff-surfaces.test.ts: a
 * constructed, never-mounted room-view with a fake store, rendering the
 * template method into a detached container. `streamsStore.localModels`
 * is the one authority for the seam (review M5).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../room/logs-graph', () => ({}));

import { render } from 'lit';
import '../room/room-view';

function makeRoomView(localModels: unknown, asrAvailable: boolean | undefined): any {
  const el = document.createElement('room-view') as any;
  el.streamsStore = { localModels, disconnect: vi.fn() };
  el._asrAvailable = asrAvailable;
  el._myModuleStates = { value: {} };
  el._transcriptionCapturing = { value: false };
  el._transcriptionStarting = { value: false };
  return el;
}

function renderEntry(el: any): HTMLElement | null {
  const host = document.createElement('div');
  render(el._renderTranscriptionToolbarButton(), host);
  return host.querySelector('.toggle-btn');
}

const asrHost = (available: boolean) => ({
  capabilities: async () => ({ asr: { available } }),
  asr: {},
});

describe('the transcription header entry', () => {
  it('a host without localModels renders no entry (and so no "Services → Transcription" pointer)', () => {
    const el = makeRoomView(undefined, false);
    expect(renderEntry(el)).toBeNull();
  });

  it('negative control: a host with localModels and ASR available renders the entry', () => {
    const el = makeRoomView(asrHost(true), true);
    expect(renderEntry(el)).not.toBeNull();
  });

  it('a host with localModels but ASR off still renders the entry (its Moss has the settings page)', () => {
    const el = makeRoomView(asrHost(false), false);
    expect(renderEntry(el)).not.toBeNull();
  });

  it('the ASR probe reads the store seam, not the weave client', async () => {
    const el = makeRoomView(asrHost(true), undefined);
    // A weave client that disagrees: the probe must not consult it.
    Object.defineProperty(el, '_weaveClient', { value: { localModels: undefined }, configurable: true });
    await el._probeAsrAvailability();
    expect(el._asrAvailable).toBe(true);
  });
});
