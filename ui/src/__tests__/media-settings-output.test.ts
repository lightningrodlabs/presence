/**
 * MediaSettings.changeAudioOutput — the ONE writer of `_audioOutputId`.
 * Local-only: it logs, stores, and hands the sink to the AudioContext
 * owner; it broadcasts no RTC action (peers do not care which speaker we
 * play them on).
 */
import { describe, it, expect, vi } from 'vitest';
import { get } from '@holochain-open-dev/stores';
import { MediaSettings, type MediaSettingsBindings } from '../media-settings';

function rig() {
  const events: string[] = [];
  const sinks: Array<string | undefined> = [];
  const broadcasts: string[] = [];
  const bindings: MediaSettingsBindings = {
    storage: { getItem: () => null, setItem: () => {} } as unknown as MediaSettingsBindings['storage'],
    mediaDevices: { enumerateDevices: async () => [] } as unknown as MediaSettingsBindings['mediaDevices'],
    changeMicDevice: vi.fn(async () => {}),
    changeCameraDevice: vi.fn(async () => {}),
    setPlayoutSink: id => void sinks.push(id),
    broadcastRtcAction: a => void broadcasts.push(a),
    logAgentEvent: e => void events.push(e.event),
    now: () => 0,
    myPubKeyB64: () => 'me',
  };
  return { ms: new MediaSettings(bindings), events, sinks, broadcasts, bindings };
}

describe('MediaSettings.changeAudioOutput', () => {
  it('stores the id, hands the sink to the playout owner, logs, and broadcasts nothing', () => {
    const r = rig();
    expect(get(r.ms.audioOutputId())).toBeUndefined();
    r.ms.changeAudioOutput('spk-2');
    expect(get(r.ms.audioOutputId())).toBe('spk-2');
    expect(r.sinks).toEqual(['spk-2']);
    expect(r.events).toEqual(['ChangeMyAudioOutput']);
    expect(r.broadcasts).toEqual([]);
  });

  it('undefined selects the default output', () => {
    const r = rig();
    r.ms.changeAudioOutput('spk-2');
    r.ms.changeAudioOutput(undefined);
    expect(get(r.ms.audioOutputId())).toBeUndefined();
    expect(r.sinks).toEqual(['spk-2', undefined]);
  });

  it('negative control: an input change touches neither the output id nor the sink', async () => {
    const r = rig();
    await r.ms.changeAudioInput('mic-2');
    expect(get(r.ms.audioOutputId())).toBeUndefined();
    expect(r.sinks).toEqual([]);
    expect(r.broadcasts).toEqual(['change-audio-input']);
  });

  it('audioOutputDevices is the audiooutput filter of the enumeration', async () => {
    const r = rig();
    (r.bindings.mediaDevices as any).enumerateDevices = async () => [
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Mic' },
      { kind: 'audiooutput', deviceId: 'default', label: 'Default' },
      { kind: 'audiooutput', deviceId: 'spk-2', label: 'Headset' },
      { kind: 'videoinput', deviceId: 'cam-1', label: 'Cam' },
    ];
    await r.ms.updateMediaDevices();
    expect(get(r.ms.audioOutputDevices()).map(d => d.deviceId)).toEqual(['default', 'spk-2']);
  });
});
