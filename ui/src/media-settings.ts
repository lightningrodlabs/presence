/**
 * MediaSettings — owner of device enumeration/selection and the
 * storage-backed ICE/TURN configuration (store-decomposition round two;
 * docs/superpowers/specs/2026-09-03-owner-extraction-design.md). Storage
 * reads stay LIVE (per-call), matching the Phase 6 live-closure pin in
 * the wiring suite.
 */
import { derived, writable, type Readable, type Writable } from '@holochain-open-dev/stores';
import type { AgentPubKeyB64 } from '@holochain/client';
import type { StreamsStoreDeps } from './store-deps';
import { DEFAULT_ICE_SERVERS } from './transport';
import type { SimpleEvent } from './logging';

export type MediaSettingsBindings = {
  /** deps.storage.local — live handle. */
  storage: StreamsStoreDeps['storage']['local'];
  /** deps.mediaDevices — enumerateDevices source. */
  mediaDevices: StreamsStoreDeps['mediaDevices'];
  /** micSource.changeDevice / cameraSource.changeDevice, late-bound. */
  changeMicDevice: (deviceId: string) => Promise<void>;
  changeCameraDevice: (deviceId: string) => Promise<void>;
  /** StreamsStore._broadcastRtcAction, late-bound. */
  broadcastRtcAction: (action: 'change-audio-input' | 'change-video-input') => void;
  logAgentEvent: (e: SimpleEvent) => void;
  now: () => number;
  myPubKeyB64: () => AgentPubKeyB64;
};

export class MediaSettings {
  mediaDevices: Writable<MediaDeviceInfo[]> = writable([]);
  _audioInputId: Writable<string | undefined> = writable(undefined); // if undefined, the default audio input source is used
  _audioOutputId: Writable<string | undefined> = writable(undefined); // if undefined, the default audio output is used
  _videoInputId: Writable<string | undefined> = writable(undefined); // if undefined, the default video input source is used

  constructor(private readonly bindings: MediaSettingsBindings) {}

  // ICE/TURN settings live in storage.local (window.localStorage in
  // production) and are edited from the Settings panel. Read them live (not
  // snapshotted at construction) so edits take effect on the next connection
  // without a reload. iceConfig / the transport trickle getters consult
  // these on every ensureConnection.
  get trickleICE(): boolean {
    // Stored as 'true'/'false'; default ON when unset.
    return this.bindings.storage.getItem('trickleICE') !== 'false';
  }

  get turnUrl(): string {
    return this.bindings.storage.getItem('turnUrl') || '';
  }

  get turnUsername(): string {
    return this.bindings.storage.getItem('turnUsername') || '';
  }

  get turnCredential(): string {
    return this.bindings.storage.getItem('turnCredential') || '';
  }

  // Cloudflare-provisioned TURN. Stored under separate keys from the manual
  // TURN server so both can be offered as ICE candidates simultaneously (the
  // ICE agent gathers relay candidates from every configured server). Written
  // by the Settings panel's auto-provisioning; read live here.
  get cfTurnUrl(): string {
    return this.bindings.storage.getItem('cfTurnUrl') || '';
  }

  get cfTurnUsername(): string {
    return this.bindings.storage.getItem('cfTurnUsername') || '';
  }

  get cfTurnCredential(): string {
    return this.bindings.storage.getItem('cfTurnCredential') || '';
  }

  enableTrickleICE() {
    this.bindings.storage.setItem('trickleICE', 'true');
  }

  disableTrickleICE() {
    this.bindings.storage.setItem('trickleICE', 'false');
  }

  get iceConfig(): RTCIceServer[] {
    const servers: RTCIceServer[] = [...DEFAULT_ICE_SERVERS];
    // A TURN field may carry more than one URL (comma- or whitespace-separated)
    // so a single credential covers multiple transports — typically the UDP
    // relay `turn:host:3478` plus the TLS-over-TCP relay
    // `turns:host:443?transport=tcp`. The latter survives lossy-UDP paths and
    // firewalls that only permit 443 (§6.3). One m-line per distinct URL is
    // fine; the agent picks the best.
    const pushTurn = (url: string, username: string, credential: string) => {
      const urls = url
        .split(/[\s,]+/)
        .map(u => u.trim())
        .filter(Boolean);
      if (urls.length > 0) {
        servers.push({
          urls: urls.length === 1 ? urls[0] : urls,
          username,
          credential,
        });
      }
    };
    // Manual and Cloudflare TURN are independent entries — both are offered as
    // candidates when present (WebRTC supports multiple TURN servers).
    pushTurn(this.turnUrl, this.turnUsername, this.turnCredential);
    pushTurn(this.cfTurnUrl, this.cfTurnUsername, this.cfTurnCredential);
    return servers;
  }

  async changeVideoInput(deviceId: string) {
    this.bindings.logAgentEvent({
      agent: this.bindings.myPubKeyB64(),
      timestamp: this.bindings.now(),
      event: 'ChangeMyVideoInput',
    });
    // CameraSource owns the device-switch path: it stores the new id,
    // opens a new track if a consumer holds the camera, and fires
    // _onCameraTrackChange's device-change branch to replaceTrack on
    // mainStream and on every transport. Mirrors changeAudioInput.
    await this.bindings.changeCameraDevice(deviceId);
    this.bindings.broadcastRtcAction('change-video-input');
  }

  async changeAudioInput(deviceId: string) {
    this.bindings.logAgentEvent({
      agent: this.bindings.myPubKeyB64(),
      timestamp: this.bindings.now(),
      event: 'ChangeMyAudioInput',
    });
    console.log('Changing audio input to: ', deviceId);
    // MicSource owns the device-switch path: it stores the new id, opens a
    // new track, replaces the active track, and fires _onMicTrackChange,
    // which is what updates mainStream and replaceTracks on all peers.
    // If no consumer currently holds the mic (WebRTC off + voice off), the
    // id is stored and the next acquire picks it up.
    await this.bindings.changeMicDevice(deviceId);
    this.bindings.broadcastRtcAction('change-audio-input');
  }

  async updateMediaDevices() {
    const mediaDevices = await this.bindings.mediaDevices.enumerateDevices();
    this.mediaDevices.set(mediaDevices);
  }

  audioInputDevices(): Readable<MediaDeviceInfo[]> {
    return derived(this.mediaDevices, devices =>
      devices.filter(device => device.kind === 'audioinput')
    );
  }

  videoInputDevices(): Readable<MediaDeviceInfo[]> {
    return derived(this.mediaDevices, devices =>
      devices.filter(device => device.kind === 'videoinput')
    );
  }

  audioOutputDevices(): Readable<MediaDeviceInfo[]> {
    return derived(this.mediaDevices, devices =>
      devices.filter(device => device.kind === 'audiooutput')
    );
  }

  audioInputId(): Readable<string | undefined> {
    return derived(this._audioInputId, id => id);
  }

  audioOutputId(): Readable<string | undefined> {
    return derived(this._audioOutputId, id => id);
  }

  videoInputId(): Readable<string | undefined> {
    return derived(this._videoInputId, id => id);
  }
}
