/**
 * Test helpers for WebRTC connection state machine tests.
 *
 * Provides MockRTCPeerConnection, FakeSignalingChannel, and utilities.
 */

import { vi } from 'vitest';
import type {
  SignalingAdapter,
  SignalMessage,
  Unsubscribe,
} from '../types';

// ---------------------------------------------------------------------------
// MockRTCPeerConnection
// ---------------------------------------------------------------------------

type MockEventHandler = (...args: any[]) => void;

/**
 * Minimal mock of RTCPeerConnection for unit testing.
 * Allows tests to trigger state changes and verify behavior.
 */
export class MockRTCPeerConnection {
  // Public state — tests read these
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  signalingState: RTCSignalingState = 'stable';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  connectionState: RTCPeerConnectionState = 'new';

  // Configuration
  readonly configuration: RTCConfiguration;

  // Internal event handlers
  private _handlers: Map<string, MockEventHandler[]> = new Map();

  // Track management
  private _senders: MockRTCSender[] = [];
  private _receivers: MockRTCReceiver[] = [];
  private _localStreams: MediaStream[] = [];
  private _remoteStreams: MediaStream[] = [];
  private _dataChannels: MockRTCDataChannel[] = [];
  private _pendingCandidates: RTCIceCandidateInit[] = [];

  // Spies for verification
  createOffer = vi.fn(async (_options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> => {
    return { type: 'offer', sdp: `mock-offer-sdp-${Date.now()}` };
  });

  createAnswer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => {
    return { type: 'answer', sdp: `mock-answer-sdp-${Date.now()}` };
  });

  setLocalDescription = vi.fn(async (desc?: RTCSessionDescriptionInit) => {
    if (!desc) {
      // Implicit creation — browser auto-generates offer or answer
      if (this.signalingState === 'stable' || this.signalingState === 'have-local-offer') {
        desc = await this.createOffer();
      } else {
        desc = await this.createAnswer();
      }
    }
    this.localDescription = desc as RTCSessionDescription;
    if (desc.type === 'offer') {
      this._setSignalingState('have-local-offer');
    } else if (desc.type === 'answer') {
      this._setSignalingState('stable');
    }
  });

  setRemoteDescription = vi.fn(async (desc: RTCSessionDescriptionInit) => {
    this.remoteDescription = desc as RTCSessionDescription;
    if (desc.type === 'offer') {
      this._setSignalingState('have-remote-offer');
    } else if (desc.type === 'answer') {
      this._setSignalingState('stable');
    }
    // Apply any pending ICE candidates
    for (const candidate of this._pendingCandidates) {
      // In real impl, these would be applied
    }
    this._pendingCandidates = [];
  });

  addIceCandidate = vi.fn(async (candidate?: RTCIceCandidateInit) => {
    if (!this.remoteDescription) {
      if (candidate) this._pendingCandidates.push(candidate);
      return;
    }
    // In real impl, candidate would be applied to ICE agent
  });

  addTrack = vi.fn((track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender => {
    const sender = new MockRTCSender(track);
    this._senders.push(sender);
    this._fireEvent('negotiationneeded');
    return sender as unknown as RTCRtpSender;
  });

  removeTrack = vi.fn((sender: RTCRtpSender) => {
    this._senders = this._senders.filter(s => (s as unknown) !== sender);
    this._fireEvent('negotiationneeded');
  });

  getSenders = vi.fn((): RTCRtpSender[] => {
    return this._senders as unknown as RTCRtpSender[];
  });

  getReceivers = vi.fn((): RTCRtpReceiver[] => {
    return this._receivers as unknown as RTCRtpReceiver[];
  });

  getStats = vi.fn(async (): Promise<RTCStatsReport> => {
    return new Map() as unknown as RTCStatsReport;
  });

  createDataChannel = vi.fn((label: string, options?: RTCDataChannelInit): RTCDataChannel => {
    const dc = new MockRTCDataChannel(label);
    this._dataChannels.push(dc);
    // In real browsers, creating a data channel triggers negotiationneeded
    // Use queueMicrotask to fire it asynchronously like a real browser
    queueMicrotask(() => this._fireEvent('negotiationneeded'));
    return dc as unknown as RTCDataChannel;
  });

  restartIce = vi.fn(() => {
    this._fireEvent('negotiationneeded');
  });

  close = vi.fn(() => {
    this._setSignalingState('closed');
    this._setConnectionState('closed');
    this._setIceConnectionState('closed');
  });

  getTransceivers = vi.fn((): RTCRtpTransceiver[] => []);

  // Event listener interface
  addEventListener(event: string, handler: MockEventHandler) {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, []);
    }
    this._handlers.get(event)!.push(handler);
  }

  removeEventListener(event: string, handler: MockEventHandler) {
    const handlers = this._handlers.get(event);
    if (handlers) {
      this._handlers.set(event, handlers.filter(h => h !== handler));
    }
  }

  // Also support on* property handlers
  set oniceconnectionstatechange(handler: MockEventHandler | null) {
    this._setPropertyHandler('iceconnectionstatechange', handler);
  }
  set onconnectionstatechange(handler: MockEventHandler | null) {
    this._setPropertyHandler('connectionstatechange', handler);
  }
  set onsignalingstatechange(handler: MockEventHandler | null) {
    this._setPropertyHandler('signalingstatechange', handler);
  }
  set onicegatheringstatechange(handler: MockEventHandler | null) {
    this._setPropertyHandler('icegatheringstatechange', handler);
  }
  set onicecandidate(handler: MockEventHandler | null) {
    this._setPropertyHandler('icecandidate', handler);
  }
  set ontrack(handler: MockEventHandler | null) {
    this._setPropertyHandler('track', handler);
  }
  set ondatachannel(handler: MockEventHandler | null) {
    this._setPropertyHandler('datachannel', handler);
  }
  set onnegotiationneeded(handler: MockEventHandler | null) {
    this._setPropertyHandler('negotiationneeded', handler);
  }

  private _propertyHandlers: Map<string, MockEventHandler | null> = new Map();

  private _setPropertyHandler(event: string, handler: MockEventHandler | null) {
    this._propertyHandlers.set(event, handler);
  }

  constructor(configuration?: RTCConfiguration) {
    this.configuration = configuration || {};
  }

  // --- Test control methods ---

  /** Simulate ICE connection state change */
  simulateIceConnectionState(state: RTCIceConnectionState) {
    this._setIceConnectionState(state);
  }

  /** Simulate connection state change (aggregate) */
  simulateConnectionState(state: RTCPeerConnectionState) {
    this._setConnectionState(state);
  }

  /** Simulate ICE gathering state change */
  simulateIceGatheringState(state: RTCIceGatheringState) {
    this.iceGatheringState = state;
    this._fireEvent('icegatheringstatechange');
  }

  /** Simulate receiving an ICE candidate */
  simulateIceCandidate(candidate: RTCIceCandidateInit | null) {
    this._fireEvent('icecandidate', { candidate });
  }

  /** Simulate receiving a remote track */
  simulateTrack(track: MediaStreamTrack, streams: MediaStream[] = []) {
    const receiver = new MockRTCReceiver(track);
    this._receivers.push(receiver);
    this._fireEvent('track', {
      track,
      streams,
      receiver,
      transceiver: { receiver, sender: new MockRTCSender(track) },
    });
  }

  /** Simulate remote data channel */
  simulateDataChannel(label: string): MockRTCDataChannel {
    const dc = new MockRTCDataChannel(label);
    this._dataChannels.push(dc);
    this._fireEvent('datachannel', { channel: dc });
    return dc;
  }

  /** Simulate full successful connection sequence */
  async simulateSuccessfulConnection() {
    this._setIceConnectionState('checking');
    this._setConnectionState('connecting');
    this._setIceConnectionState('connected');
    this._setConnectionState('connected');
  }

  // --- Private helpers ---

  private _setSignalingState(state: RTCSignalingState) {
    this.signalingState = state;
    this._fireEvent('signalingstatechange');
  }

  private _setIceConnectionState(state: RTCIceConnectionState) {
    this.iceConnectionState = state;
    this._fireEvent('iceconnectionstatechange');
  }

  private _setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this._fireEvent('connectionstatechange');
  }

  private _fireEvent(event: string, detail?: any) {
    const eventObj = detail ? { ...detail, type: event } : { type: event };

    // Property handler
    const propHandler = this._propertyHandlers.get(event);
    if (propHandler) propHandler(eventObj);

    // addEventListener handlers
    const handlers = this._handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(eventObj);
      }
    }
  }
}

class MockRTCSender {
  track: MediaStreamTrack | null;
  constructor(track: MediaStreamTrack | null) {
    this.track = track;
  }
  replaceTrack = vi.fn(async (track: MediaStreamTrack | null) => {
    this.track = track;
  });
  getStats = vi.fn(async () => new Map());
}

class MockRTCReceiver {
  track: MediaStreamTrack;
  constructor(track: MediaStreamTrack) {
    this.track = track;
  }
  getStats = vi.fn(async () => new Map());
}

/**
 * Mock RTCDataChannel for testing.
 */
export class MockRTCDataChannel {
  readonly label: string;
  readyState: RTCDataChannelState = 'connecting';
  private _handlers: Map<string, MockEventHandler[]> = new Map();
  private _propHandlers: Map<string, MockEventHandler | null> = new Map();

  // Spy on send
  send = vi.fn((_data: string | ArrayBuffer | Blob | ArrayBufferView) => {});

  close = vi.fn(() => {
    this.readyState = 'closed';
    this._fireEvent('close');
  });

  constructor(label: string) {
    this.label = label;
  }

  addEventListener(event: string, handler: MockEventHandler) {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, []);
    }
    this._handlers.get(event)!.push(handler);
  }

  removeEventListener(event: string, handler: MockEventHandler) {
    const handlers = this._handlers.get(event);
    if (handlers) {
      this._handlers.set(event, handlers.filter(h => h !== handler));
    }
  }

  set onopen(handler: MockEventHandler | null) { this._propHandlers.set('open', handler); }
  set onclose(handler: MockEventHandler | null) { this._propHandlers.set('close', handler); }
  set onmessage(handler: MockEventHandler | null) { this._propHandlers.set('message', handler); }
  set onerror(handler: MockEventHandler | null) { this._propHandlers.set('error', handler); }

  /** Test helper: simulate channel opening */
  simulateOpen() {
    this.readyState = 'open';
    this._fireEvent('open');
  }

  /** Test helper: simulate incoming message */
  simulateMessage(data: string) {
    this._fireEvent('message', { data });
  }

  private _fireEvent(event: string, detail?: any) {
    const eventObj = detail ? { ...detail, type: event } : { type: event };
    const propHandler = this._propHandlers.get(event);
    if (propHandler) propHandler(eventObj);
    const handlers = this._handlers.get(event);
    if (handlers) {
      for (const handler of handlers) handler(eventObj);
    }
  }
}

// ---------------------------------------------------------------------------
// Mock MediaStream / MediaStreamTrack
// ---------------------------------------------------------------------------

let trackIdCounter = 0;

export function createMockTrack(kind: 'audio' | 'video'): MediaStreamTrack {
  const id = `mock-${kind}-${++trackIdCounter}`;
  return {
    id,
    kind,
    enabled: true,
    muted: false,
    readyState: 'live',
    label: id,
    stop: vi.fn(),
    clone: vi.fn(function(this: any) { return { ...this, id: `${this.id}-clone` }; }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    getCapabilities: vi.fn(() => ({})),
    getConstraints: vi.fn(() => ({})),
    getSettings: vi.fn(() => ({})),
    applyConstraints: vi.fn(async () => {}),
    onended: null,
    onmute: null,
    onunmute: null,
    contentHint: '',
  } as unknown as MediaStreamTrack;
}

export function createMockStream(audio = true, video = true): MediaStream {
  const tracks: MediaStreamTrack[] = [];
  if (audio) tracks.push(createMockTrack('audio'));
  if (video) tracks.push(createMockTrack('video'));

  return {
    id: `mock-stream-${Date.now()}`,
    active: true,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
    addTrack: vi.fn((track: MediaStreamTrack) => tracks.push(track)),
    removeTrack: vi.fn((track: MediaStreamTrack) => {
      const idx = tracks.indexOf(track);
      if (idx >= 0) tracks.splice(idx, 1);
    }),
    clone: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    onaddtrack: null,
    onremovetrack: null,
  } as unknown as MediaStream;
}

// ---------------------------------------------------------------------------
// FakeSignalingChannel
// ---------------------------------------------------------------------------

export type FakeSignalingConfig = {
  /** Simulated one-way latency in ms (0 = synchronous delivery) */
  latencyMs?: number;
  /** Random jitter added to latency (0-jitterMs) */
  jitterMs?: number;
  /** Probability of dropping a message (0.0 to 1.0) */
  dropRate?: number;
  /** If true, messages can be reordered */
  reorder?: boolean;
};

type SignalEntry = {
  from: string;
  to: string;
  message: SignalMessage;
  deliverAt: number;
};

/**
 * In-memory signaling channel connecting two or more peers for testing.
 * Implements SignalingAdapter for each peer.
 */
export class FakeSignalingChannel {
  private _handlers: Map<string, ((from: string, message: SignalMessage) => void)[]> = new Map();
  private _config: Required<FakeSignalingConfig>;
  private _queue: SignalEntry[] = [];
  private _log: SignalEntry[] = [];

  constructor(config: FakeSignalingConfig = {}) {
    this._config = {
      latencyMs: config.latencyMs ?? 0,
      jitterMs: config.jitterMs ?? 0,
      dropRate: config.dropRate ?? 0,
      reorder: config.reorder ?? false,
    };
  }

  /** Create a SignalingAdapter for a specific peer identity */
  createAdapter(myId: string): SignalingAdapter {
    return {
      sendSignal: (to: string, message: SignalMessage) => {
        this._send(myId, to, message);
      },
      onSignal: (handler: (from: string, message: SignalMessage) => void): Unsubscribe => {
        if (!this._handlers.has(myId)) {
          this._handlers.set(myId, []);
        }
        this._handlers.get(myId)!.push(handler);
        return () => {
          const handlers = this._handlers.get(myId);
          if (handlers) {
            this._handlers.set(myId, handlers.filter(h => h !== handler));
          }
        };
      },
    };
  }

  /** Get all messages sent through this channel (for assertions) */
  get messageLog(): ReadonlyArray<SignalEntry> {
    return this._log;
  }

  /** Deliver all queued messages (use with fake timers) */
  flush() {
    const now = Date.now();
    const ready = this._queue.filter(e => e.deliverAt <= now);
    this._queue = this._queue.filter(e => e.deliverAt > now);

    if (this._config.reorder) {
      // Shuffle ready messages
      for (let i = ready.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ready[i], ready[j]] = [ready[j], ready[i]];
      }
    }

    for (const entry of ready) {
      this._deliver(entry);
    }
  }

  /** Deliver all messages regardless of timing */
  flushAll() {
    const entries = [...this._queue];
    this._queue = [];
    for (const entry of entries) {
      this._deliver(entry);
    }
  }

  private _send(from: string, to: string, message: SignalMessage) {
    // Simulate drop
    if (this._config.dropRate > 0 && Math.random() < this._config.dropRate) {
      return;
    }

    const delay = this._config.latencyMs + Math.random() * this._config.jitterMs;
    const entry: SignalEntry = {
      from,
      to,
      message: structuredClone(message),
      deliverAt: Date.now() + delay,
    };

    this._log.push(entry);

    if (delay === 0) {
      this._deliver(entry);
    } else {
      this._queue.push(entry);
    }
  }

  private _deliver(entry: SignalEntry) {
    const handlers = this._handlers.get(entry.to);
    if (handlers) {
      for (const handler of handlers) {
        handler(entry.from, entry.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Test Utilities
// ---------------------------------------------------------------------------

/**
 * Wait for a condition to become true, checking every `intervalMs`.
 * Rejects after `timeoutMs`.
 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
