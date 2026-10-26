// @vitest-environment jsdom
/**
 * The audio output rows of the mic menu and the sink application on the
 * view's media elements. room-view has no full jsdom mount harness (see
 * view-teardown-symmetry.test.ts's standing rationale), so these pins
 * drive the template method and the apply method directly on a constructed
 * element with a fake store — the intent-diff-surfaces style.
 */
import { describe, it, expect, vi } from 'vitest';

// logs-graph pulls plotly.js, which does not survive jsdom import; see
// view-teardown-symmetry.test.ts for the standing rationale.
vi.mock('../room/logs-graph', () => ({}));

import { render } from 'lit';
import '../room/room-view';

const DEVICES = [
  { kind: 'audiooutput', deviceId: 'default', label: 'Default - Speakers' },
  { kind: 'audiooutput', deviceId: 'spk-2', label: 'Headset' },
];

function makeRoomView(overrides?: { devices?: unknown[]; outputId?: string }): any {
  const el = document.createElement('room-view') as any;
  el.streamsStore = { changeAudioOutput: vi.fn() };
  // The StoreSubscriber fields read only `.value`; overwrite them with
  // plain value holders (never mounted, so they never subscribed).
  el._audioOutputDevices = { value: overrides?.devices ?? DEVICES };
  el._audioOutputId = { value: overrides?.outputId };
  return el;
}

function renderRows(overrides?: Parameters<typeof makeRoomView>[0]) {
  const el = makeRoomView(overrides);
  const host = document.createElement('div');
  render(el._renderAudioOutputRows(), host);
  const rows = Array.from(host.querySelectorAll('.audio-output')) as HTMLElement[];
  const checked = rows.filter(
    r => !(r.querySelector('.row > div') as HTMLElement).style.color
  );
  return { el, host, rows, checked };
}

describe('the mic menu offers the audio output devices', () => {
  it('one row per audiooutput device under an "Audio Output" title', () => {
    const { host, rows } = renderRows();
    expect(host.textContent).toContain('Audio Output');
    expect(rows.map(r => r.textContent?.trim().replace(/\s+/g, ' '))).toEqual([
      '✓ Default - Speakers',
      '✓ Headset',
    ]);
  });

  it('no selection checks the "default" device; a selection checks that device', () => {
    expect(renderRows().checked.map(r => r.textContent?.includes('Default'))).toEqual([true]);
    const { checked } = renderRows({ outputId: 'spk-2' });
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toContain('Headset');
  });

  it('a click is the one gesture onto StreamsStore.changeAudioOutput', () => {
    const { el, rows } = renderRows();
    rows[1].click();
    expect(el.streamsStore.changeAudioOutput).toHaveBeenCalledWith('spk-2');
  });

  it('no enumerated outputs (WebKitGTK, Firefox) → no section at all', () => {
    const { host } = renderRows({ devices: [] });
    expect(host.textContent?.trim()).toBe('');
  });
});

describe('_applyAudioOutput routes the chimes through the chosen sink', () => {
  function sinkTarget() {
    const t = { sinkId: '', calls: [] as string[], setSinkId: async (id: string) => void t.calls.push(id) };
    return t;
  }

  it('both chime elements get the selected sink; unchanged ones are skipped on the next pass', () => {
    const el = makeRoomView({ outputId: 'spk-2' });
    el._joinAudio = sinkTarget();
    el._leaveAudio = sinkTarget();
    el._applyAudioOutput();
    expect(el._joinAudio.calls).toEqual(['spk-2']);
    expect(el._leaveAudio.calls).toEqual(['spk-2']);
    el._joinAudio.sinkId = 'spk-2';
    el._leaveAudio.sinkId = 'spk-2';
    el._applyAudioOutput();
    expect(el._joinAudio.calls).toEqual(['spk-2']);
  });

  it('with no selection the chimes stay on the default sink (negative control)', () => {
    const el = makeRoomView();
    el._joinAudio = sinkTarget();
    el._leaveAudio = sinkTarget();
    el._applyAudioOutput();
    expect(el._joinAudio.calls).toEqual([]);
  });
});
