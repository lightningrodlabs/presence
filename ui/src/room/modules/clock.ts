import { html } from 'lit';
import { mdiClockOutline } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { registerModule } from './registry';
import type { ModuleDefinition, ModuleRenderContext, ModuleStateEnvelope } from './types';

interface ClockPayload {
  timezone: string;
}

function formatTimeInTimezone(timezone: string): string {
  try {
    return new Date().toLocaleTimeString(undefined, { timeZone: timezone });
  } catch {
    return new Date().toLocaleTimeString();
  }
}

const clockModule: ModuleDefinition = {
  id: 'clock',
  type: 'agent',
  label: 'Clock',
  icon: mdiClockOutline,
  activationControl: 'receiver',

  defaultState() {
    return JSON.stringify({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    } satisfies ClockPayload);
  },

  renderReplace(
    _agentPubKeyB64: string,
    state: ModuleStateEnvelope | null,
    _context: ModuleRenderContext,
  ) {
    let timezone = '';
    try {
      const data: ClockPayload = JSON.parse(state?.payload || '{}');
      timezone = data.timezone || '';
    } catch { /* empty */ }

    // Render the current time in the sender's timezone, computed locally
    const time = timezone ? formatTimeInTimezone(timezone) : new Date().toLocaleTimeString();

    return html`
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center;
                  width: 100%; height: 100%; background: #1a1a2e; color: #e0e0e0; overflow: hidden;">
        <span style="font-size: 12cqi; font-family: monospace; white-space: nowrap;">${time}</span>
        ${timezone ? html`<span style="font-size: 5cqi; opacity: 0.6; margin-top: 4px;">${timezone}</span>` : html``}
      </div>
    `;
  },
};

registerModule(clockModule);
