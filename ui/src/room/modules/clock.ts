import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { PropertyValues } from 'lit';
import { mdiClockOutline } from '@mdi/js';
import { registerModule } from './registry';
import type { ModuleDefinition, ModuleStateEnvelope } from './types';

interface ClockPayload {
  timezone: string;
}

@customElement('module-clock-replace')
export class ModuleClockReplace extends LitElement {
  @property({ attribute: false }) moduleState: ModuleStateEnvelope | null = null;

  @state() private _time = '';
  private _timezone = '';
  private _timer?: number;

  connectedCallback() {
    super.connectedCallback();
    this._parseTimezone();
    this._tick();
    this._timer = window.setInterval(() => this._tick(), 1000);
  }

  disconnectedCallback() {
    if (this._timer !== undefined) clearInterval(this._timer);
    super.disconnectedCallback();
  }

  willUpdate(changed: PropertyValues) {
    if (changed.has('moduleState')) {
      this._parseTimezone();
      this._tick();
    }
  }

  private _parseTimezone() {
    try {
      const data: ClockPayload = JSON.parse(this.moduleState?.payload || '{}');
      this._timezone = data.timezone || '';
    } catch {
      this._timezone = '';
    }
  }

  private _tick() {
    try {
      this._time = this._timezone
        ? new Date().toLocaleTimeString(undefined, { timeZone: this._timezone })
        : new Date().toLocaleTimeString();
    } catch {
      this._time = new Date().toLocaleTimeString();
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
    }
    .time {
      font-size: 12cqi;
      font-family: monospace;
      white-space: nowrap;
    }
    .timezone {
      font-size: 5cqi;
      opacity: 0.6;
      margin-top: 4px;
    }
  `;

  render() {
    return html`
      <span class="time">${this._time}</span>
      ${this._timezone ? html`<span class="timezone">${this._timezone}</span>` : html``}
    `;
  }
}

const clockModule: ModuleDefinition = {
  id: 'clock',
  type: 'agent',
  label: 'Clock',
  icon: mdiClockOutline,
  activationControl: 'receiver',

  replaceElement: 'module-clock-replace',

  defaultState() {
    return JSON.stringify({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    } satisfies ClockPayload);
  },
};

registerModule(clockModule);
