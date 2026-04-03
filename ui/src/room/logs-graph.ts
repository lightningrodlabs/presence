import { LitElement, css, html } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import {
  AgentPubKeyB64,
  AppClient,
  decodeHashFromBase64,
  encodeHashToBase64,
} from '@holochain/client';
import { localized, msg } from '@lit/localize';
import { consume } from '@lit/context';
import { WeaveClient } from '@theweave/api';
import Plotly, {
  Dash,
  Data,
  Datum,
  Layout,
  PlotData,
  Shape,
} from 'plotly.js-dist-min';
import { Unsubscriber } from '@holochain-open-dev/stores';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import './room-view';

import { RoomStore } from './room-store';
import {
  clientContext,
  roomStoreContext,
  streamsStoreContext,
} from '../contexts';
import { plotlyStyles, sharedStyles } from '../sharedStyles';
import { weaveClientContext } from '../types';
import { StreamsStore } from '../streams-store';
import { SimpleEventType, StreamInfoLog } from '../logging';
import './elements/avatar-with-nickname';

// ---------------------------------------------------------------------------
// FSM phase → numeric level mapping for the state timeline
// ---------------------------------------------------------------------------
const FSM_PHASE_LEVEL: Record<string, number> = {
  idle: 0,
  signaling: 1,
  connecting: 2,
  connected: 3,
  reconnecting: 1.5,
  disconnected: -0.5,
  failed: -1,
  closed: 0,
};

const FSM_PHASE_COLOR: Record<string, string> = {
  idle: '#999999',
  signaling: '#5bc0eb',
  connecting: '#fde74c',
  connected: '#48e708',
  reconnecting: '#e8900c',
  disconnected: '#e84040',
  failed: '#8b0000',
  closed: '#333333',
};

@localized()
@customElement('logs-graph')
export class LogsGraph extends LitElement {
  @consume({ context: roomStoreContext })
  roomStore!: RoomStore;

  @consume({ context: streamsStoreContext })
  @property({ type: Object })
  streamsStore!: StreamsStore;

  @consume({ context: clientContext })
  @state()
  client!: AppClient;

  @consume({ context: weaveClientContext })
  @state()
  weaveClient!: WeaveClient;

  @property()
  agent!: AgentPubKeyB64;

  @state()
  loading = true;

  @query('#graph')
  graph!: HTMLElement;

  @state()
  autoFollow = true;

  shapes: Partial<Shape>[] = [];

  eventUnsubscribers: Unsubscriber[] = [];

  async firstUpdated() {
    const data: Data[] = [];

    /**
     * Subplot layout:
     *
     * Row 1 (y3): FSM connection state timeline — colored step chart
     * Row 2 (y):  Stream/track state — our own stream + how peer perceives it
     * Row 3 (y2): Events — connection events, media signals, custom logs
     */

    // Row 2: Stream and track traces (indices 0-5)
    const myStreamData = this.myStreamTraces();
    data.push(...myStreamData);

    const agentStreamData = this.agentStreamTraces();
    data.push(...agentStreamData);

    // Row 1: FSM state timeline (index 6)
    const fsmTrace = this.fsmStateTrace();
    data.push(fsmTrace);

    // Shapes for events (Row 3)
    const shapes = this.eventShapes();
    this.shapes = shapes;

    const now = Date.now();
    const layout: Partial<Layout> = {
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.15,
        font: { size: 10 },
      },
      shapes,
      hovermode: 'closest',
      hoverlabel: {
        namelength: -1,
      },
      // Main subplot layout with shared x-axis
      grid: {
        rows: 3,
        columns: 1,
        subplots: [['xy3'], ['xy'], ['xy2']] as any,
        roworder: 'top to bottom' as any,
      },
      xaxis: {
        type: 'date',
        rangeslider: { visible: true, thickness: 0.08 },
        range: [now - 60_000, now + 5_000],
      },
      // Row 2: Stream state
      yaxis: {
        title: { text: 'Stream State' } as any,
        range: [-2.5, 2.5],
        fixedrange: true,
        tickvals: [-2, -1, 0, 1, 2],
        ticktext: ['muted (peer)', 'on (peer)', 'off', 'on', 'muted'],
      },
      // Row 3: Events
      yaxis2: {
        title: { text: 'Events' } as any,
        range: [-2, 2],
        fixedrange: true,
        showticklabels: false,
      },
      // Row 1: FSM state
      yaxis3: {
        title: { text: 'Connection' } as any,
        range: [-1.5, 4],
        fixedrange: true,
        tickvals: [-1, -0.5, 0, 1, 1.5, 2, 3],
        ticktext: ['failed', 'disconnected', 'idle', 'signaling', 'reconnecting', 'connecting', 'connected'],
      },
      height: 550,
      margin: { t: 30, b: 60, l: 80, r: 20 },
      // Plotly config for better zoom
      dragmode: 'zoom',
    };

    const config = {
      responsive: true,
      scrollZoom: true,
      displayModeBar: true,
      modeBarButtonsToAdd: ['toggleSpikelines'] as any[],
    };

    Plotly.newPlot(this.graph, data, layout, config);

    // Register handlers for live updates
    this.registerEventHandlers();
  }

  disconnectedCallback(): void {
    this.eventUnsubscribers.forEach(unsubscribe => unsubscribe());
  }

  // ---------------------------------------------------------------------------
  // FSM State Timeline (Row 1)
  // ---------------------------------------------------------------------------

  fsmStateTrace(): Data {
    const agentEvents = this.streamsStore.logger.agentEvents[this.agent] || [];

    // Extract FSM state transitions
    const fsmEvents = agentEvents
      .filter(e => e.event.startsWith('ConnectionState_'))
      .sort((a, b) => a.timestamp - b.timestamp);

    const x: Datum[] = [];
    const y: Datum[] = [];
    const text: string[] = [];
    const colors: string[] = [];

    for (const event of fsmEvents) {
      const phase = event.event.replace('ConnectionState_', '');
      const level = FSM_PHASE_LEVEL[phase] ?? 0;
      const color = FSM_PHASE_COLOR[phase] ?? '#999';

      x.push(event.timestamp);
      y.push(level);
      text.push(phase);
      colors.push(color);
    }

    return {
      x,
      y,
      text,
      type: 'scatter',
      mode: 'lines+markers',
      name: 'FSM State',
      yaxis: 'y3',
      line: {
        shape: 'hv', // step chart
        width: 3,
        color: '#5bc0eb',
      },
      marker: {
        size: 8,
        color: colors,
        symbol: 'circle',
      },
      hovertemplate: '%{text}<br>%{x}<extra>FSM State</extra>',
    } as Data;
  }

  // ---------------------------------------------------------------------------
  // Stream/Track traces (Row 2)
  // ---------------------------------------------------------------------------

  myStreamTraces(): Data[] {
    const myLogInfos = this.streamsStore.logger.myStreamStatusLog;
    return loadStreamAndTrackInfo(myLogInfos, 'actual', false);
  }

  agentStreamTraces(): Data[] {
    const agentPongMetadataLogs =
      this.streamsStore.logger.agentPongMetadataLogs[this.agent] || [];

    const streamLogs: StreamInfoLog[] = agentPongMetadataLogs.map(log => ({
      t_first: log.t_first,
      t_last: log.t_last,
      info: log.metaData.streamInfo
        ? log.metaData.streamInfo
        : {
            stream: null,
            tracks: [],
          },
    }));

    return loadStreamAndTrackInfo(streamLogs, `perceived`, true);
  }

  // ---------------------------------------------------------------------------
  // Event shapes (Row 3)
  // ---------------------------------------------------------------------------

  eventShapes(): Partial<Shape>[] {
    const shapes: Partial<Shape>[] = [];

    const customEvents = this.streamsStore.logger.customLogs;
    const allAgentEvents = this.streamsStore.logger.agentEvents;
    const myEvents =
      allAgentEvents[encodeHashToBase64(this.client.myPubKey)] || [];
    const agentEvents = allAgentEvents[this.agent] || [];
    const pongEvents = agentEvents.filter(event => event.event === 'Pong');

    // Create rectangles for Pongs (batched)
    let tempRect: (Partial<Shape> & { x1: number }) | undefined;
    pongEvents
      .sort((a, b) => a.timestamp - b.timestamp)
      .forEach(event => {
        if (tempRect && event.timestamp - tempRect.x1 < 3_500) {
          tempRect.x1 = event.timestamp;
        } else if (!tempRect) {
          tempRect = {
            type: 'rect',
            name: 'Pong',
            x0: event.timestamp,
            x1: event.timestamp,
            y0: -0.5,
            y1: 0.5,
            yref: 'y2',
            line: { color: 'f2da0080' },
            fillcolor: 'f2da0080',
          };
        } else {
          shapes.push(tempRect);
          tempRect = undefined;
        }
      });
    if (tempRect) shapes.push(tempRect);

    // Non-pong events as vertical lines in the events subplot
    [
      ...myEvents,
      ...agentEvents.filter(event => event.event !== 'Pong'),
    ]
      .filter(event => !event.event.startsWith('ConnectionState_')) // FSM events shown in Row 1
      .forEach(payload => {
        const [color, dash] = simpleEventTypeToColor(payload.event);
        const [y0, y1] = yEventType(payload.event);
        shapes.push({
          type: 'line',
          x0: payload.timestamp,
          y0,
          x1: payload.timestamp,
          y1,
          yref: 'y2',
          line: { color, dash, width: 1.5 },
          name: payload.event,
        });
      });

    // Custom logs as labeled vertical lines spanning the events subplot
    customEvents.forEach(event => {
      // Skip FSM transition logs — they're shown in Row 1
      if (event.log.startsWith('FSM [') || event.log.startsWith('ScreenFSM [')) return;

      shapes.push({
        type: 'line',
        x0: event.timestamp,
        y0: -1.5,
        x1: event.timestamp,
        y1: 1.5,
        yref: 'y2',
        line: {
          color: '#e07f00',
          width: 1.5,
        },
        name: event.log,
        label: {
          text: event.log.length > 60 ? event.log.slice(0, 57) + '...' : event.log,
          xanchor: 'left',
          textangle: -45,
          textposition: 'top right',
          font: { size: 9 },
        },
      });
    });

    return shapes;
  }

  // ---------------------------------------------------------------------------
  // Live update handlers
  // ---------------------------------------------------------------------------

  registerEventHandlers() {
    const unsubscriber1 = this.streamsStore.logger.on(
      'simple-event',
      payload => {
        if (
          payload.event in
          [
            'MyAudioOn',
            'MyAudioOff',
            'MyVideoOn',
            'MyVideoOff',
            'ChangeMyAudioInput',
          ]
        ) {
          if (payload.agent !== encodeHashToBase64(this.client.myPubKey))
            return;
        } else if (payload.agent !== this.agent) return;

        // FSM state events → update Row 1 trace
        if (payload.event.startsWith('ConnectionState_')) {
          const phase = payload.event.replace('ConnectionState_', '');
          const level = FSM_PHASE_LEVEL[phase] ?? 0;
          Plotly.extendTraces(
            this.graph,
            {
              x: [[payload.timestamp]],
              y: [[level]],
              text: [[phase]] as any,
            },
            [6] // FSM trace index
          );
        }

        // Pong events → batch into rectangles
        if (payload.event === 'Pong') {
          const matchingRectIdx = this.shapes.findIndex(
            shape =>
              shape.type === 'rect' &&
              shape.name === 'Pong' &&
              typeof shape.x1 === 'number' &&
              payload.timestamp - shape.x1 < 3_500
          );
          if (matchingRectIdx !== -1) {
            const matchingRect = this.shapes[matchingRectIdx];
            matchingRect.x1 = payload.timestamp;
            this.shapes[matchingRectIdx] = matchingRect;
          } else {
            this.shapes.push({
              type: 'rect',
              name: 'Pong',
              x0: payload.timestamp,
              x1: payload.timestamp,
              y0: -0.5,
              y1: 0.5,
              yref: 'y2',
              line: { color: 'f2da0080' },
              fillcolor: 'f2da0080',
            });
          }
        } else if (!payload.event.startsWith('ConnectionState_')) {
          // Non-FSM, non-pong events → vertical line in events subplot
          const [color, dash] = simpleEventTypeToColor(payload.event);
          const [y0, y1] = yEventType(payload.event);
          this.shapes.push({
            type: 'line',
            x0: payload.timestamp,
            y0,
            x1: payload.timestamp,
            y1,
            yref: 'y2',
            line: { color, dash, width: 1.5 },
            name: payload.event,
          });
        }

        Plotly.relayout(this.graph, {
          shapes: this.shapes,
          xaxis: this.autoFollow
            ? {
                range: [
                  payload.timestamp - 120_000,
                  payload.timestamp + 120_000,
                ],
              }
            : undefined,
        });
      }
    );

    const unsubscriber2 = this.streamsStore.logger.on(
      'my-stream-info',
      payload => {
        const streamState = payload.info.stream ? 1 : 0;
        const videoTrack = payload.info.tracks.find(
          track => track.kind === 'video'
        );
        const videoTrackState = videoTrack ? (videoTrack.muted ? 2 : 1) : 0;
        const audioTrack = payload.info.tracks.find(
          track => track.kind === 'audio'
        );
        const audioTrackState = audioTrack ? (audioTrack.muted ? 2 : 1) : 0;

        Plotly.extendTraces(
          this.graph,
          {
            x: [[payload.t_last], [payload.t_last], [payload.t_last]],
            y: [[streamState], [videoTrackState], [audioTrackState]],
          },
          [0, 1, 2]
        );
      }
    );

    const unsubscriber3 = this.streamsStore.logger.on(
      'agent-pong-metadata',
      payload => {
        if (payload.agent !== this.agent) return;
        const streamState = payload.info.metaData.streamInfo?.stream ? 1 : 0;
        const videoTrack = payload.info.metaData.streamInfo?.tracks.find(
          track => track.kind === 'video'
        );
        const videoTrackState = videoTrack ? (videoTrack.muted ? 2 : 1) : 0;
        const audioTrack = payload.info.metaData.streamInfo?.tracks.find(
          track => track.kind === 'audio'
        );
        const audioTrackState = audioTrack ? (audioTrack.muted ? 2 : 1) : 0;

        Plotly.extendTraces(
          this.graph,
          {
            x: [
              [payload.info.t_last],
              [payload.info.t_last],
              [payload.info.t_last],
            ],
            y: [
              [streamState * -1],
              [videoTrackState * -1],
              [audioTrackState * -1],
            ],
          },
          [3, 4, 5]
        );
      }
    );

    const unsubscriber4 = this.streamsStore.logger.on('custom-log', event => {
      // Skip FSM transition logs
      if (event.log.startsWith('FSM [') || event.log.startsWith('ScreenFSM [')) return;

      this.shapes.push({
        type: 'line',
        x0: event.timestamp,
        y0: -1.5,
        x1: event.timestamp,
        y1: 1.5,
        yref: 'y2',
        line: {
          color: '#e07f00',
          width: 1.5,
        },
        name: event.log,
        label: {
          text: event.log.length > 60 ? event.log.slice(0, 57) + '...' : event.log,
          xanchor: 'left',
          textangle: -45,
          textposition: 'top right',
          font: { size: 9 },
        },
      });
    });

    this.eventUnsubscribers.push(
      unsubscriber1,
      unsubscriber2,
      unsubscriber3,
      unsubscriber4
    );
  }

  render() {
    return html`
      <!-- NOTE: This requires plotly styles applied explicitly since this is shadow DOM -->
      <div class="column secondary-font">
        <div
          class="column items-center"
          style="background: white; padding-top: 5px;"
        >
          <div class="row items-center">
            <span style="margin-right: 10px; font-size: 18px;"
              >${msg('Connection Logs with')}</span
            >
            <avatar-with-nickname
              .agentPubKey=${decodeHashFromBase64(this.agent)}
            ></avatar-with-nickname>
          </div>
        </div>
        <div class="tweaks column items-center" style="padding-top: 5px;">
          <div class="row" style="padding: 0 5px; gap: 15px;">
            <label class="row" style="align-items: center; gap: 4px;">
              <input
                @change=${(e: Event) => {
                  const checkbox = e.target as HTMLInputElement;
                  this.autoFollow = checkbox.checked;
                }}
                type="checkbox"
                checked
              />
              <span>${msg('auto-follow')}</span>
            </label>
            <button
              @click=${() => this._zoomToLast(30_000)}
              style="font-size: 12px; padding: 2px 8px; cursor: pointer;"
            >30s</button>
            <button
              @click=${() => this._zoomToLast(60_000)}
              style="font-size: 12px; padding: 2px 8px; cursor: pointer;"
            >1m</button>
            <button
              @click=${() => this._zoomToLast(300_000)}
              style="font-size: 12px; padding: 2px 8px; cursor: pointer;"
            >5m</button>
            <button
              @click=${() => this._zoomToAll()}
              style="font-size: 12px; padding: 2px 8px; cursor: pointer;"
            >All</button>
          </div>
        </div>
        <div id="graph"></div>
      </div>
    `;
  }

  private _zoomToLast(ms: number) {
    const now = Date.now();
    Plotly.relayout(this.graph, {
      'xaxis.range': [now - ms, now + 2_000],
    });
    this.autoFollow = false;
  }

  private _zoomToAll() {
    Plotly.relayout(this.graph, {
      'xaxis.autorange': true,
    });
    this.autoFollow = false;
  }

  static styles = [
    sharedStyles,
    plotlyStyles,
    css`
      .tweaks {
        min-width: 1000px;
        background: white;
        font-size: 14px;
        color: black;
      }
    `,
  ];
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function loadStreamAndTrackInfo(
  infoLog: StreamInfoLog[],
  name: string,
  inverse: boolean
): Data[] {
  const streamData: Partial<PlotData> = {
    x: [],
    y: [],
    type: 'scatter',
    name: `Stream (${name})`,
    line: {
      dash: 'dash',
      color: 'black',
    },
  };

  infoLog.forEach(info => {
    let streamState = info.info.stream ? 1 : 0;
    if (inverse) streamState *= -1;
    (streamData.x as Datum[]).push(info.t_first);
    (streamData.y as Datum[]).push(streamState);
    (streamData.x as Datum[]).push(info.t_last);
    (streamData.y as Datum[]).push(streamState);
  });

  const videoTrackData: Partial<PlotData> = {
    x: [],
    y: [],
    type: 'scatter',
    name: `Video (${name})`,
    line: {
      color: 'darkblue',
    },
  };
  infoLog.forEach(info => {
    const videoTrack = info.info.tracks.find(track => track.kind === 'video');
    let videoTrackState = videoTrack ? (videoTrack.muted ? 2 : 1) : 0;
    if (inverse) videoTrackState *= -1;
    (videoTrackData.x as Datum[]).push(info.t_first);
    (videoTrackData.y as Datum[]).push(videoTrackState);
    (videoTrackData.x as Datum[]).push(info.t_last);
    (videoTrackData.y as Datum[]).push(videoTrackState);
  });

  const audioTrackData: Partial<PlotData> = {
    x: [],
    y: [],
    type: 'scatter',
    name: `Audio (${name})`,
    line: {
      color: 'darkred',
    },
  };
  infoLog.forEach(info => {
    const audioTrack = info.info.tracks.find(track => track.kind === 'audio');
    let audioTrackState = audioTrack ? (audioTrack.muted ? 2 : 1) : 0;
    if (inverse) audioTrackState *= -1;
    (audioTrackData.x as Datum[]).push(info.t_first);
    (audioTrackData.y as Datum[]).push(audioTrackState);
    (audioTrackData.x as Datum[]).push(info.t_last);
    (audioTrackData.y as Datum[]).push(audioTrackState);
  });

  return [streamData, videoTrackData, audioTrackData];
}

function simpleEventTypeToColor(
  event: SimpleEventType
): [string, Dash | undefined] {
  switch (event) {
    case 'Pong':
      return ['#f2da0080', undefined];

    // WebRTC Connection Events (legacy)
    case 'Connected':
      return ['green', undefined];
    case 'InitAccept':
      return ['lightblue', undefined];
    case 'InitRequest':
      return ['lightblue', undefined];
    case 'SdpData':
      return ['gray', undefined];
    // Media events
    case 'PeerAudioOnSignal':
      return ['darkred', undefined];
    case 'PeerAudioOffSignal':
      return ['darkred', 'dash'];
    case 'PeerVideoOnSignal':
      return ['darkblue', undefined];
    case 'PeerVideoOffSignal':
      return ['darkblue', 'dash'];
    case 'PeerChangeAudioInput':
      return ['darkred', 'dot'];
    case 'PeerChangeVideoInput':
      return ['darkblue', 'dot'];
    case 'MyAudioOn':
      return ['darkred', undefined];
    case 'MyAudioOff':
      return ['darkred', 'dash'];
    case 'MyVideoOn':
      return ['darkblue', undefined];
    case 'MyVideoOff':
      return ['darkblue', 'dash'];
    case 'ChangeMyAudioInput':
      return ['darkred', 'dot'];
    case 'ChangeMyVideoInput':
      return ['darkblue', 'dot'];

    // Track events
    case 'RemoteTrack':
      return ['#0886e7', undefined];
    case 'StreamReceived':
      return ['#0886e7', 'dash'];
    case 'TrackArrivedMuted':
      return ['orange', 'dash'];
    case 'TrackUnmuted':
      return ['green', 'dot'];
    case 'TrackUnmuteTimeout':
      return ['red', 'dash'];

    // Reconcile
    case 'ReconcileAudio':
      return ['darkred', undefined];
    case 'ReconcileStream':
      return ['black', undefined];
    case 'ReconcileVideo':
      return ['darkblue', undefined];

    // Peer lifecycle
    case 'PeerLeave':
      return ['#333', undefined];

    default:
      return ['pink', undefined];
  }
}

function yEventType(event: SimpleEventType): [number, number] {
  switch (event) {
    case 'Pong':
      return [-0.5, 0.5];

    // Connection lifecycle
    case 'Connected':
    case 'InitAccept':
    case 'InitRequest':
    case 'SdpData':
    case 'PeerLeave':
      return [0, 1.5];

    // Peer media signals
    case 'PeerAudioOnSignal':
    case 'PeerAudioOffSignal':
    case 'PeerVideoOnSignal':
    case 'PeerVideoOffSignal':
    case 'PeerChangeAudioInput':
    case 'PeerChangeVideoInput':
      return [0, -0.75];

    // My media events
    case 'MyAudioOn':
    case 'MyAudioOff':
    case 'MyVideoOn':
    case 'MyVideoOff':
    case 'ChangeMyAudioInput':
    case 'ChangeMyVideoInput':
      return [0, 0.75];

    // Track events
    case 'RemoteTrack':
    case 'StreamReceived':
    case 'TrackArrivedMuted':
    case 'TrackUnmuted':
    case 'TrackUnmuteTimeout':
    case 'ReconcileStream':
    case 'ReconcileAudio':
    case 'ReconcileVideo':
      return [-1.2, 1.2];

    default:
      return [0, 0.5];
  }
}
