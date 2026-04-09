import { LitElement, css, html, PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { decodeHashFromBase64 } from '@holochain/client';
import { mdiTimerOutline } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { registerModule } from './registry';
import type { ModuleDefinition, ModuleRenderContext, ModuleStateEnvelope } from './types';

interface TimerPayload {
  endTimestamp: number; // ms since epoch
  durationMs: number;   // original duration for display
}

function parseTimer(state: ModuleStateEnvelope | null): TimerPayload | null {
  if (!state?.payload) return null;
  try {
    return JSON.parse(state.payload) as TimerPayload;
  } catch {
    return null;
  }
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/** Play a short chime tone via WebAudio (no asset file required). */
function playChime() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const now = ctx.currentTime;

    // Three short notes, ascending: C5, E5, G5
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.18;
      const stop = start + 0.35;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.3, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, stop);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(stop + 0.05);
    });

    // Close context after the sound finishes
    setTimeout(() => ctx.close().catch(() => {}), 1500);
  } catch (e) {
    console.warn('Failed to play chime:', e);
  }
}

@customElement('module-timer-share')
export class ModuleTimerShare extends LitElement {
  @property({ attribute: false }) agentPubKeyB64 = '';
  @property({ attribute: false }) moduleState: ModuleStateEnvelope | null = null;
  @property({ attribute: false }) context!: ModuleRenderContext;

  @state() private _remaining = 0;
  private _timer?: number;
  private _chimePlayed = false;
  private _lastEndTimestamp = 0;

  connectedCallback() {
    super.connectedCallback();
    this._tick();
    this._timer = window.setInterval(() => this._tick(), 250);
  }

  disconnectedCallback() {
    if (this._timer !== undefined) clearInterval(this._timer);
    super.disconnectedCallback();
  }

  willUpdate(changed: PropertyValues) {
    if (changed.has('moduleState')) {
      const t = parseTimer(this.moduleState);
      if (t && t.endTimestamp !== this._lastEndTimestamp) {
        this._lastEndTimestamp = t.endTimestamp;
        this._chimePlayed = false;
      }
      this._tick();
    }
  }

  private _tick() {
    const t = parseTimer(this.moduleState);
    if (!t) {
      this._remaining = 0;
      return;
    }
    this._remaining = Math.max(0, t.endTimestamp - Date.now());
    if (this._remaining === 0 && !this._chimePlayed) {
      this._chimePlayed = true;
      playChime();
    }
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      background: #1a1a2e;
      color: #e0e0e0;
      overflow: hidden;
      container-type: inline-size;
      position: relative;
    }
    .time {
      font-size: 22cqi;
      font-family: monospace;
      font-weight: bold;
      letter-spacing: 0.05em;
    }
    .label {
      font-size: 5cqi;
      opacity: 0.6;
      margin-top: 8px;
    }
    .done {
      color: #ffd700;
      animation: pulse 1s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .footer {
      position: absolute;
      bottom: 8px;
      left: 50%;
      transform: translateX(-50%);
    }
  `;

  render() {
    const t = parseTimer(this.moduleState);
    if (!t) return html``;
    const isDone = this._remaining === 0;

    return html`
      <span class="time ${isDone ? 'done' : ''}">${formatRemaining(this._remaining)}</span>
      <span class="label">${isDone ? 'time\u2019s up' : 'remaining'}</span>
      <div class="footer">
        <avatar-with-nickname
          .size=${36}
          .agentPubKey=${decodeHashFromBase64(this.agentPubKeyB64)}
          style="height: 36px;"
        ></avatar-with-nickname>
      </div>
    `;
  }
}

const timerModule: ModuleDefinition = {
  id: 'timer',
  type: 'share',
  label: 'Timer',
  icon: mdiTimerOutline,
  activationControl: 'sender',
  shareWrapperClass: 'shared-wal-container',

  shareElement: 'module-timer-share',

  renderToolbarButton(myState, toggle, streamsStore) {
    const active = !!myState;

    if (active) {
      // Active: button stops the timer
      return html`
        <sl-tooltip content="Stop Timer" hoist>
          <div
            class="toggle-btn"
            tabindex="0"
            @click=${toggle}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') toggle();
            }}
          >
            <sl-icon
              class="toggle-btn-icon"
              .src=${wrapPathInSvg(mdiTimerOutline)}
            ></sl-icon>
          </div>
        </sl-tooltip>
      `;
    }

    // Inactive: dropdown of preset durations
    const startTimer = async (minutes: number) => {
      const durationMs = Math.round(minutes * 60 * 1000);
      const payload: TimerPayload = {
        endTimestamp: Date.now() + durationMs,
        durationMs,
      };
      await streamsStore.activateModule('timer', JSON.stringify(payload));
    };

    const presets: Array<{ label: string; minutes: number }> = [
      { label: '1 min', minutes: 1 },
      { label: '2 min', minutes: 2 },
      { label: '5 min', minutes: 5 },
      { label: '10 min', minutes: 10 },
      { label: '15 min', minutes: 15 },
      { label: '20 min', minutes: 20 },
      { label: '30 min', minutes: 30 },
    ];

    return html`
      <sl-dropdown placement="top" distance="4" hoist>
        <div
          slot="trigger"
          class="toggle-btn btn-off"
          tabindex="0"
          title="Start Timer"
        >
          <sl-icon
            class="toggle-btn-icon btn-icon-off"
            .src=${wrapPathInSvg(mdiTimerOutline)}
          ></sl-icon>
        </div>
        <sl-menu class="reconnect-menu secondary-font">
          ${presets.map(p => html`
            <sl-menu-item
              class="reconnect-menu-item"
              @click=${() => startTimer(p.minutes)}
            >${p.label}</sl-menu-item>
          `)}
        </sl-menu>
      </sl-dropdown>
    `;
  },
};

registerModule(timerModule);
