/**
 * RTCPeer — Thin wrapper around RTCPeerConnection.
 *
 * Replaces SimplePeer. Keeps RTCPeerConnection accessible and the FSM in control.
 * Implements the Perfect Negotiation pattern (W3C recommended).
 *
 * Does NOT provide:
 * - State management (FSM's job)
 * - Retry logic (ReconnectPolicy's job)
 * - Signal transport (injected as callback)
 */

import type {
  ConnectionConfig,
  RTCPeerEvent,
  RTCPeerEventHandler,
  TransportSnapshot,
  Unsubscribe,
} from './types';

export type RTCPeerOptions = {
  /** If true, this peer has lower pubkey and yields on offer collision (polite) */
  polite: boolean;
  /** WebRTC configuration */
  config: ConnectionConfig;
  /** Callback to send signaling data to remote peer */
  onSignal: (data: RTCSessionDescriptionInit | RTCIceCandidateInit) => void;
  /** Optional: factory for RTCPeerConnection (for testing) */
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
};

export class RTCPeer {
  readonly pc: RTCPeerConnection;
  private _polite: boolean;
  private _onSignal: (data: RTCSessionDescriptionInit | RTCIceCandidateInit) => void;
  private _handlers: Map<string, RTCPeerEventHandler[]> = new Map();
  private _dataChannel: RTCDataChannel | null = null;
  private _destroyed = false;
  private _destroying = false;

  // Perfect Negotiation state
  private _makingOffer = false;
  private _ignoreOffer = false;
  private _isSettingRemoteAnswerPending = false;

  // ICE candidate queue (for candidates arriving before remote description)
  private _pendingCandidates: RTCIceCandidateInit[] = [];

  // Negotiation task queue — serializes ALL signaling operations (incoming signals
  // AND outgoing offers from negotiationneeded) to prevent concurrent
  // setLocalDescription/setRemoteDescription from corrupting signaling state.
  private _taskQueue: Array<() => Promise<void>> = [];
  private _processingTasks = false;

  constructor(options: RTCPeerOptions) {
    this._polite = options.polite;
    this._onSignal = options.onSignal;

    const rtcConfig: RTCConfiguration = {
      iceServers: options.config.iceServers,
    };

    const factory = options.createPeerConnection ?? ((cfg: RTCConfiguration) => new RTCPeerConnection(cfg));
    this.pc = factory(rtcConfig);

    this._setupEventListeners();
    this._createDataChannel();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Current transport state snapshot */
  get transportSnapshot(): TransportSnapshot {
    return {
      ice: (this.pc.iceConnectionState as any) ?? 'new',
      dtls: this._getDtlsState() as any,
      signaling: this.pc.signalingState ?? 'stable',
      gathering: this.pc.iceGatheringState ?? 'new',
      dataChannel: this._dataChannel?.readyState ?? null,
    };
  }

  /** Whether the peer has been destroyed */
  get destroyed(): boolean {
    return this._destroyed;
  }

  /**
   * Handle a remote signal (offer, answer, or ICE candidate).
   * Implements the Perfect Negotiation pattern.
   * Signals are queued and processed serially to prevent concurrent
   * setLocalDescription/setRemoteDescription from corrupting signaling state.
   */
  async handleSignal(signal: RTCSessionDescriptionInit | RTCIceCandidateInit): Promise<void> {
    if (this._destroyed) return;

    await this._enqueueTask(async () => {
      if ('candidate' in signal && signal.candidate !== undefined) {
        await this._handleRemoteCandidate(signal);
      } else {
        await this._handleRemoteDescription(signal as RTCSessionDescriptionInit);
      }
    });
  }

  /** Queue an outgoing offer from negotiationneeded */
  private _enqueueNegotiation(): void {
    this._enqueueTask(async () => {
      if (this._destroyed) return;
      try {
        this._makingOffer = true;
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) {
          this._onSignal(this.pc.localDescription);
        }
      } catch (e) {
        this._emit({ type: 'error', data: e });
      } finally {
        this._makingOffer = false;
      }
    });
  }

  /** Enqueue a task and drain the queue serially */
  private async _enqueueTask(task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      this._taskQueue.push(async () => {
        await task();
        resolve();
      });
      if (!this._processingTasks) {
        this._drainTaskQueue();
      }
    });
  }

  private async _drainTaskQueue(): Promise<void> {
    if (this._processingTasks) return;
    this._processingTasks = true;
    try {
      while (this._taskQueue.length > 0) {
        if (this._destroyed) break;
        const next = this._taskQueue.shift()!;
        try {
          await next();
        } catch (e) {
          console.error('RTCPeer task queue error:', e);
        }
      }
    } finally {
      this._processingTasks = false;
    }
  }

  /** Add a local media track */
  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    if (this._destroyed) throw new Error('RTCPeer is destroyed');
    return this.pc.addTrack(track, stream);
  }

  /** Remove a local media track */
  removeTrack(sender: RTCRtpSender): void {
    if (this._destroyed) return;
    this.pc.removeTrack(sender);
  }

  /** Replace a track on an existing sender (no renegotiation needed) */
  async replaceTrack(sender: RTCRtpSender, newTrack: MediaStreamTrack | null): Promise<void> {
    if (this._destroyed) return;
    await sender.replaceTrack(newTrack);
  }

  /** Get all senders */
  getSenders(): RTCRtpSender[] {
    return this.pc.getSenders();
  }

  /** Get connection stats */
  async getStats(): Promise<RTCStatsReport> {
    return this.pc.getStats();
  }

  /** Trigger ICE restart */
  restartIce(): void {
    if (this._destroyed) return;
    this.pc.restartIce();
  }

  /** Send data via data channel */
  send(data: string): void {
    if (this._destroyed) return;
    if (this._dataChannel?.readyState === 'open') {
      this._dataChannel.send(data);
    }
  }

  /** Subscribe to events */
  on(type: string, handler: RTCPeerEventHandler): Unsubscribe {
    if (!this._handlers.has(type)) {
      this._handlers.set(type, []);
    }
    this._handlers.get(type)!.push(handler);
    return () => {
      const handlers = this._handlers.get(type);
      if (handlers) {
        this._handlers.set(type, handlers.filter(h => h !== handler));
      }
    };
  }

  /** Destroy the peer connection and clean up */
  destroy(): void {
    if (this._destroyed || this._destroying) return;
    this._destroying = true;

    // Clear handlers BEFORE closing to prevent stale event delivery during teardown
    this._handlers.clear();
    this._destroyed = true;
    this._destroying = false;
    this._pendingCandidates = [];
    this._taskQueue = [];

    try {
      if (this._dataChannel) {
        this._dataChannel.close();
        this._dataChannel = null;
      }
      this.pc.close();
    } catch (e) {
      // Ignore errors during teardown
    }
  }

  // ---------------------------------------------------------------------------
  // Perfect Negotiation — handling remote descriptions
  // ---------------------------------------------------------------------------

  private async _handleRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {

    const readyForOffer = !this._makingOffer &&
      (this.pc.signalingState === 'stable' || this._isSettingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;

    this._ignoreOffer = !this._polite && offerCollision;

    if (this._ignoreOffer) {
      this._emit({ type: 'signal', data: { ignored: true, sdpType: description.type } });
      return;
    }

    if (offerCollision) {
      // Polite peer: accept the incoming offer (implicit rollback)
      // Discard any queued candidates from the rolled-back session
      this._pendingCandidates = [];
      this._emit({ type: 'signal', data: { collision: true, yielding: true } });
    }

    this._isSettingRemoteAnswerPending = description.type === 'answer';
    try {
      await this.pc.setRemoteDescription(description);
    } catch (e: any) {
      // A stale/duplicate answer arriving in stable state is harmless — the
      // exchange already completed. This can happen when Holochain delivers
      // the same signal twice or when both peers call ensureConnection and
      // signals cross. Log and continue rather than propagating the error,
      // which would break the connection.
      if (description.type === 'answer' && this.pc.signalingState === 'stable') {
        // Silently ignore — the connection is already established
      } else {
        throw e;
      }
    } finally {
      this._isSettingRemoteAnswerPending = false;
    }

    // Flush any ICE candidates that arrived before the remote description.
    // After a collision rollback, the queue was cleared — only candidates
    // arriving AFTER the new remote description belong to the correct session.
    await this._flushPendingCandidates();

    if (description.type === 'offer') {
      await this.pc.setLocalDescription();
      if (this.pc.localDescription) {
        this._onSignal(this.pc.localDescription);
      }
    }
  }

  private async _handleRemoteCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    // If we're currently ignoring a colliding offer, also ignore its candidates
    if (this._ignoreOffer) return;

    if (!this.pc.remoteDescription) {
      // Queue until remote description is set
      this._pendingCandidates.push(candidate);
      return;
    }

    try {
      await this.pc.addIceCandidate(candidate);
    } catch (e) {
      // Silently ignore candidate errors — they're typically from stale sessions
    }
  }

  private async _flushPendingCandidates(): Promise<void> {
    const candidates = [...this._pendingCandidates];
    this._pendingCandidates = [];
    for (const candidate of candidates) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (e) {
        // Ignore errors for stale candidates
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event setup
  // ---------------------------------------------------------------------------

  private _setupEventListeners(): void {
    // Perfect Negotiation: handle negotiationneeded
    // Serialized through the same queue as incoming signals to prevent
    // interleaving setLocalDescription with setRemoteDescription.
    this.pc.addEventListener('negotiationneeded', () => {
      if (this._destroyed) return;
      this._emit({ type: 'negotiation-needed' });
      this._enqueueNegotiation();
    });

    // ICE candidates
    this.pc.addEventListener('icecandidate', (event: any) => {
      if (this._destroyed) return;
      if (event.candidate) {
        this._onSignal(event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
      }
    });

    // ICE connection state
    this.pc.addEventListener('iceconnectionstatechange', () => {
      if (this._destroyed) return;
      this._emit({ type: 'ice-state-change', data: this.pc.iceConnectionState });
    });

    // Aggregate connection state
    this.pc.addEventListener('connectionstatechange', () => {
      if (this._destroyed) return;
      const state = this.pc.connectionState;
      if (state === 'connected') {
        this._emit({ type: 'connect' });
      } else if (state === 'failed' || state === 'closed') {
        this._emit({ type: 'close', data: state });
      }
    });

    // Signaling state
    this.pc.addEventListener('signalingstatechange', () => {
      if (this._destroyed) return;
      this._emit({ type: 'signaling-state-change', data: this.pc.signalingState });
    });

    // ICE gathering state
    this.pc.addEventListener('icegatheringstatechange', () => {
      if (this._destroyed) return;
      this._emit({ type: 'gathering-state-change', data: this.pc.iceGatheringState });
    });

    // Remote tracks
    this.pc.addEventListener('track', (event: any) => {
      if (this._destroyed) return;
      this._emit({ type: 'track', data: { track: event.track, streams: event.streams } });
      if (event.streams && event.streams.length > 0) {
        this._emit({ type: 'stream', data: event.streams[0] });
      }
    });
  }

  private _createDataChannel(): void {
    this._dataChannel = this.pc.createDataChannel('data', { ordered: true });

    this._dataChannel.addEventListener('open', () => {
      if (this._destroyed) return;
      this._emit({ type: 'data-channel-state-change', data: 'open' });
    });

    this._dataChannel.addEventListener('close', () => {
      if (this._destroyed) return;
      this._emit({ type: 'data-channel-state-change', data: 'closed' });
    });

    this._dataChannel.addEventListener('message', (event: any) => {
      if (this._destroyed) return;
      this._emit({ type: 'data', data: event.data });
    });

    this._dataChannel.addEventListener('error', (event: any) => {
      if (this._destroyed) return;
      this._emit({ type: 'error', data: event.error || event });
    });

    // Also listen for incoming data channels from remote
    this.pc.addEventListener('datachannel', (event: any) => {
      if (this._destroyed) return;
      const channel = event.channel;
      channel.addEventListener('message', (msgEvent: any) => {
        if (this._destroyed) return;
        this._emit({ type: 'data', data: msgEvent.data });
      });
    });
  }

  private _getDtlsState(): string {
    // Access DTLS state via SCTP transport if available
    try {
      const sctp = (this.pc as any).sctp;
      if (sctp?.transport?.state) return sctp.transport.state;
    } catch (e) {
      // Not available in all browsers/mocks
    }

    // Fallback: derive from connection state
    const connState = this.pc.connectionState;
    if (connState === 'connected') return 'connected';
    if (connState === 'connecting') return 'connecting';
    if (connState === 'failed') return 'failed';
    if (connState === 'closed') return 'closed';
    return 'new';
  }

  // ---------------------------------------------------------------------------
  // Event emission
  // ---------------------------------------------------------------------------

  private _emit(event: RTCPeerEvent): void {
    const handlers = this._handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (e) {
          console.error('RTCPeer event handler error:', e);
        }
      }
    }
  }
}
