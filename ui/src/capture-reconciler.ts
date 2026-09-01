import type { LocalIntent } from './intent';
import type { MicSource, MicAcquireResult } from './mic-source';
import type { CameraSource, CameraAcquireResult } from './camera-source';
import {
  decideCaptureAction,
  CAPTURE_REOPEN_MAX_ATTEMPTS,
} from './capture-reconcile-policy';
import type { CaptureReconcileInput } from './capture-reconcile-policy';

/**
 * CaptureReconciler — the impure owner that executes
 * `decideCaptureAction` for mic and camera on every presence tick and
 * every media gesture (Task 3). It holds what would otherwise be new
 * store fields: the WebRTC acquire handles for mic and camera (moved out
 * of `StreamsStore`), plus each device's `lastAttemptAt` /
 * `attemptsSinceGesture` retry state.
 *
 * The whole point of the owner-object shape is that acquisition and
 * device recovery have ONE home, and it is not the store — the store
 * keeps only the field, the tick-subscription call, the `noteGesture`
 * calls, and `releaseAll()` in `disconnect()`. `MicSource` /
 * `RoomOwnership` are the bindings-pattern precedents.
 *
 * Fanout note: the reconciler triggers reopen/acquire, it does NOT own
 * peer fanout. Reopen swaps the dead track on peers through the source's
 * `onTrackChange` device-change branch; the camera's keepalive-aware
 * peer attach on a fresh open stays in `videoOn`/`videoOff` (store
 * fanout), because it is tied to the WebRTC handle, not the device close.
 */
export type CaptureReconcilerBindings = {
  clock: { now(): number };
  getIntent: () => LocalIntent;
  mic: MicSource;
  camera: CameraSource;
  /** store error-event emitter, for the report-failure arm */
  onError: (message: string) => void;
  log: (message: string) => void;
};

type DeviceState = {
  lastAttemptAt: number | undefined;
  attemptsSinceGesture: number;
  /** true while an acquire/reopen await is outstanding — reopen does not
   *  pass through the `acquiring` lifecycle, so the lifecycle alone cannot
   *  guard against a concurrent tick double-opening. */
  inFlight: boolean;
};

const CONSUMER_ID = 'webrtc';

export class CaptureReconciler {
  private bindings: CaptureReconcilerBindings;

  private micHandle: MicAcquireResult | null = null;

  private cameraHandle: CameraAcquireResult | null = null;

  private micState: DeviceState = {
    lastAttemptAt: undefined,
    attemptsSinceGesture: 0,
    inFlight: false,
  };

  private cameraState: DeviceState = {
    lastAttemptAt: undefined,
    attemptsSinceGesture: 0,
    inFlight: false,
  };

  constructor(bindings: CaptureReconcilerBindings) {
    this.bindings = bindings;
  }

  get micAttemptState(): { attemptsSinceGesture: number } {
    return { attemptsSinceGesture: this.micState.attemptsSinceGesture };
  }

  get cameraAttemptState(): { attemptsSinceGesture: number } {
    return { attemptsSinceGesture: this.cameraState.attemptsSinceGesture };
  }

  /** Whether the reconciler currently holds the WebRTC camera handle —
   *  the gate `videoOn`/`videoOff` use to decide whether to run the
   *  keepalive-aware peer attach / swap (replaces the store's old
   *  `if (!this._webrtcCameraHandle)` reads). */
  get cameraHandleHeld(): boolean {
    return this.cameraHandle !== null;
  }

  /** Record a user gesture touching a device: reset the retry count and
   *  clear the pacing stamp so the next tick reopens immediately. The
   *  store calls this then `tick()` from each media gesture method. */
  noteGesture(device: 'mic' | 'camera'): void {
    const state = device === 'mic' ? this.micState : this.cameraState;
    state.attemptsSinceGesture = 0;
    state.lastAttemptAt = undefined;
  }

  async tick(): Promise<void> {
    await Promise.all([this._reconcileMic(), this._reconcileCamera()]);
  }

  /** Disconnect cleanup: release both handles unconditionally. Distinct
   *  from the `close` arm — `disconnect()` tears everything down, so this
   *  does not run the decision table. */
  releaseAll(): void {
    if (this.micHandle) {
      try { this.micHandle.release(); } catch {}
      this.micHandle = null;
    }
    if (this.cameraHandle) {
      try { this.cameraHandle.release(); } catch {}
      this.cameraHandle = null;
    }
  }

  private _input(
    wanted: boolean,
    lifecycleState: CaptureReconcileInput['lifecycle'],
    state: DeviceState,
  ): CaptureReconcileInput {
    return {
      wanted,
      lifecycle: lifecycleState,
      lastAttemptAt: state.lastAttemptAt,
      attemptsSinceGesture: state.attemptsSinceGesture,
      now: this.bindings.clock.now(),
    };
  }

  private async _reconcileMic(): Promise<void> {
    const state = this.micState;
    if (state.inFlight) return;
    const intent = this.bindings.getIntent();
    const decision = decideCaptureAction(
      this._input(intent.mic.wanted, this.bindings.mic.lifecycle, state),
    );

    switch (decision.action) {
      case 'open': {
        state.inFlight = true;
        state.lastAttemptAt = this.bindings.clock.now();
        state.attemptsSinceGesture += 1;
        try {
          if (this.micHandle) {
            await this.bindings.mic.reopen();
          } else {
            const handle = await this.bindings.mic.acquire({ id: CONSUMER_ID });
            if (handle) this.micHandle = handle;
          }
          // Apply the current mute on every (re)open — a reopened device
          // comes back enabled otherwise.
          this.bindings.mic.setMuted(this.bindings.getIntent().mic.muted);
        } finally {
          state.inFlight = false;
        }
        return;
      }
      case 'close':
        if (this.micHandle) {
          try { this.micHandle.release(); } catch {}
          this.micHandle = null;
        }
        return;
      case 'report-failure':
        // Bump past the ceiling so the next tick reads `already-reported`
        // — this is what makes the report fire exactly once.
        state.attemptsSinceGesture = CAPTURE_REOPEN_MAX_ATTEMPTS + 1;
        this.bindings.onError('Microphone unavailable');
        this.bindings.log('CaptureReconcile: mic attempts exhausted, reported once');
        return;
      case 'hold':
      case 'none':
        return;
      default: {
        const exhaustive: never = decision;
        void exhaustive;
      }
    }
  }

  private async _reconcileCamera(): Promise<void> {
    const state = this.cameraState;
    if (state.inFlight) return;
    const intent = this.bindings.getIntent();
    const decision = decideCaptureAction(
      this._input(intent.camera.wanted, this.bindings.camera.lifecycle, state),
    );

    switch (decision.action) {
      case 'open': {
        state.inFlight = true;
        state.lastAttemptAt = this.bindings.clock.now();
        state.attemptsSinceGesture += 1;
        try {
          if (this.cameraHandle) {
            // Dead-but-held: reopen swaps the corpse on peers via the
            // source's device-change fanout. A fresh open (no handle) is
            // acquired here; its keepalive-aware peer attach is `videoOn`'s
            // job (tied to the WebRTC handle, not the device).
            await this.bindings.camera.reopen();
          } else {
            const handle = await this.bindings.camera.acquire({ id: CONSUMER_ID });
            if (handle) this.cameraHandle = handle;
          }
        } finally {
          state.inFlight = false;
        }
        return;
      }
      case 'close':
        if (this.cameraHandle) {
          try { this.cameraHandle.release(); } catch {}
          this.cameraHandle = null;
        }
        return;
      case 'report-failure':
        state.attemptsSinceGesture = CAPTURE_REOPEN_MAX_ATTEMPTS + 1;
        this.bindings.onError('Camera unavailable');
        this.bindings.log('CaptureReconcile: camera attempts exhausted, reported once');
        return;
      case 'hold':
      case 'none':
        return;
      default: {
        const exhaustive: never = decision;
        void exhaustive;
      }
    }
  }
}
