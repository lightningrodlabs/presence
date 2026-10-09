// ui/src/room/modules/annotations.ts
/**
 * Share annotations: the `annotations` module and its share-tile overlay.
 * Spec: docs/superpowers/specs/2026-10-09-screen-share-annotations-design.md.
 *
 * The module is agent-type, activated at join (room-view.ts, beside
 * `reactions`), with no toolbar button and no agent-tile overlay. Its
 * state is the author's own boards (annotation-policy.ts,
 * AnnotationsPayload). The overlay element below is mounted into EVERY
 * share tile by room-view's renderSharedPanel through the
 * `shareOverlayElement` aspect (modules/types.ts), aggregates every
 * author's board for that tile, and draws them as SVG over the tile's
 * declared surface (`annotationSurface`, annotation-geometry.ts).
 *
 * No ambient time: the stroke id reads the store's injected clock.
 */
import { LitElement, css, html, nothing, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { mdiDeleteSweep, mdiEraser, mdiPencil, mdiUndo } from '@mdi/js';
import { getModule, getShareModules, registerModule } from './registry';
import type { ModuleDefinition, ModuleRenderContext, ModuleStateEnvelope } from './types';
import type { AgentPubKeyB64 } from '@holochain/client';
import { surfaceBox, toGrid } from '../annotation-geometry';
import type { SurfaceBox } from '../annotation-geometry';
import {
  ANNOTATION_PALETTE,
  ANNOTATIONS_MODULE_ID,
  activeShareEpochs,
  applyStroke,
  clearMyBoard,
  defaultColorFor,
  emptyAnnotations,
  parseAnnotationsPayload,
  pruneBoards,
  readShareAnnotationsEpoch,
  thinPoints,
  undoLastStroke,
  visibleStrokes,
} from '../annotation-policy';
import type { AnnotationsPayload, AnnotationStroke, VisibleStroke } from '../annotation-policy';

const icon = (path: string) => html`<svg viewBox="0 0 24 24" width="18" height="18"><path d=${path} fill="currentColor"></path></svg>`;

const pairs = (pts: number[]): string => {
  const out: string[] = [];
  for (let i = 0; i < pts.length; i += 2) out.push(`${pts[i]},${pts[i + 1]}`);
  return out.join(' ');
};

@customElement('module-annotations-share-overlay')
export class ModuleAnnotationsShareOverlay extends LitElement {
  @property({ attribute: false }) sharerPubKeyB64: AgentPubKeyB64 = '';
  @property({ attribute: false }) shareModuleId = '';
  @property({ attribute: false }) context!: ModuleRenderContext;

  /** Pen armed. Reflected so the stylesheet can gate pointer capture. */
  @property({ type: Boolean, reflect: true }) pen = false;

  @state() private _color: number | null = null;
  @state() private _surface: SurfaceBox | null = null;
  @state() private _drawing: number[] | null = null;

  private _counter = 0;
  private _video: HTMLVideoElement | null = null;
  private _resizeObserver: ResizeObserver | null = null;

  // Own subscriptions, not StoreSubscriber: that controller never
  // resubscribes after a DOM move (repeat() moves share frames), leaving
  // a frozen snapshot whose writes would clobber newer state.
  @state() _mineStates: Record<string, ModuleStateEnvelope> = {};
  @state() _peerStates: Record<AgentPubKeyB64, Record<string, ModuleStateEnvelope>> = {};
  private _unsubs: Array<() => void> = [];

  static styles = css`
    :host {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 2;
      pointer-events: none;
    }
    .canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    :host([pen]) .canvas {
      pointer-events: auto;
      touch-action: none;
      cursor: crosshair;
    }
    svg.board {
      position: absolute;
      overflow: visible;
    }
    polyline.stroke {
      fill: none;
      stroke-width: 3;
      stroke-linecap: round;
      stroke-linejoin: round;
      vector-effect: non-scaling-stroke;
    }
    /* left is 55px, not 10px: room-view's .maximize-icon (room-view.ts)
       is absolute at bottom 5px / left 5px, 40x40, z-index 3 above this
       host, so it covers x 5-45px; the strip starts 10px clear of it or
       the pen toggle cannot be clicked. */
    .strip {
      position: absolute;
      bottom: 10px;
      left: 55px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.55);
      pointer-events: auto;
    }
    .tool {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #fff;
      cursor: pointer;
    }
    .tool.on {
      background: rgba(255, 255, 255, 0.25);
    }
    .tool:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .swatch {
      width: 18px;
      height: 18px;
      border: 2px solid transparent;
      border-radius: 50%;
      cursor: pointer;
      padding: 0;
    }
    .swatch.on {
      border-color: #fff;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    const store = this.context.streamsStore;
    this._unsubs.push(
      store._myModuleStates.subscribe(v => {
        this._mineStates = v;
      }),
      store._peerModuleStates.subscribe(v => {
        this._peerStates = v;
      }),
    );
    // The share tile holds at most one <video> (screen-share.ts,
    // renderShare); the asset tile holds none and uses the tile surface.
    this._video = this.parentElement?.querySelector('video') ?? null;
    this._video?.addEventListener('loadedmetadata', this._measure);
    this._video?.addEventListener('resize', this._measure);
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this._measure);
      this._resizeObserver.observe(this);
    }
    this._measure();
  }

  disconnectedCallback() {
    for (const u of this._unsubs.splice(0)) u();
    this._video?.removeEventListener('loadedmetadata', this._measure);
    this._video?.removeEventListener('resize', this._measure);
    this._video = null;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._drawing = null;
    super.disconnectedCallback();
  }

  private _measure = () => {
    const kind = getModule(this.shareModuleId)?.annotationSurface ?? 'tile';
    const rect = this.getBoundingClientRect();
    this._surface = surfaceBox(kind, rect.width, rect.height, this._video?.videoWidth, this._video?.videoHeight);
  };

  // --- reads ---------------------------------------------------------------

  private _myPayload(): AnnotationsPayload {
    return parseAnnotationsPayload(this._mineStates?.[ANNOTATIONS_MODULE_ID]?.payload);
  }

  private _shareEnvelope(): ModuleStateEnvelope | null {
    return this.context.isMe
      ? (this._mineStates?.[this.shareModuleId] ?? null)
      : (this._peerStates?.[this.sharerPubKeyB64]?.[this.shareModuleId] ?? null);
  }

  private _epoch(): number {
    return readShareAnnotationsEpoch(this._shareEnvelope());
  }

  private _visible(): VisibleStroke[] {
    const authors = [{ author: this.context.myPubKeyB64, payload: this._myPayload() }];
    for (const [peer, modules] of Object.entries(this._peerStates)) {
      authors.push({ author: peer, payload: parseAnnotationsPayload(modules[ANNOTATIONS_MODULE_ID]?.payload) });
    }
    return visibleStrokes(authors, this.sharerPubKeyB64, this.shareModuleId, this._epoch());
  }

  private _colorIndex(): number {
    return this._color ?? defaultColorFor(this.context.myPubKeyB64);
  }

  // --- writes --------------------------------------------------------------

  private _write(next: AnnotationsPayload): void {
    const active = activeShareEpochs(
      this._mineStates,
      this.context.myPubKeyB64,
      this._peerStates,
      getShareModules().map(m => m.id),
    );
    void this.context.streamsStore.updateModuleState(
      ANNOTATIONS_MODULE_ID,
      JSON.stringify(pruneBoards(next, active)),
    );
  }

  private _toGrid(e: MouseEvent): [number, number] {
    const rect = this.getBoundingClientRect();
    return toGrid(this._surface!, e.clientX - rect.left, e.clientY - rect.top);
  }

  private _onPointerDown(e: PointerEvent) {
    if (!this.pen || !this._surface) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    this._drawing = [...this._toGrid(e)];
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._drawing || !this._surface) return;
    this._drawing = [...this._drawing, ...this._toGrid(e)];
  }

  private _onPointerUp(e: PointerEvent) {
    const raw = this._drawing;
    this._drawing = null;
    if (!raw || !this._surface) return;
    const pts = thinPoints([...raw, ...this._toGrid(e)]);
    // A press and release on one spot has no extent: nothing to draw.
    if (pts.length < 4 || pts.every((v, i) => v === pts[i % 2])) return;
    const stroke: AnnotationStroke = {
      id: `${this.context.streamsStore.clock.now()}-${++this._counter}`,
      epoch: this._epoch(),
      color: this._colorIndex(),
      pts,
    };
    this._write(applyStroke(this._myPayload(), this.sharerPubKeyB64, this.shareModuleId, stroke));
  }

  private _onPointerCancel() {
    this._drawing = null;
  }

  private _onDblClick(e: Event) {
    if (this.pen) e.stopPropagation();
  }

  // --- render --------------------------------------------------------------

  private _renderStrip() {
    const canDraw = !!this._surface;
    return html`
      <div class="strip">
        <button
          class="tool pen ${this.pen ? 'on' : ''}"
          title=${this.pen ? 'Pen off' : 'Pen on'}
          ?disabled=${!canDraw}
          @click=${() => (this.pen = !this.pen)}
        >${icon(mdiPencil)}</button>
        ${this.pen
          ? ANNOTATION_PALETTE.map(
              (hex, i) => html`<button
                class="swatch ${i === this._colorIndex() ? 'on' : ''}"
                style="background: ${hex}"
                title="Color"
                @click=${() => (this._color = i)}
              ></button>`,
            )
          : nothing}
        <button
          class="tool undo"
          title="Undo my last stroke"
          @click=${() => this._write(undoLastStroke(this._myPayload(), this.sharerPubKeyB64, this.shareModuleId))}
        >${icon(mdiUndo)}</button>
        <button
          class="tool clear-mine"
          title="Clear mine"
          @click=${() => this._write(clearMyBoard(this._myPayload(), this.sharerPubKeyB64, this.shareModuleId))}
        >${icon(mdiEraser)}</button>
        ${this.context?.isMe
          ? html`<button
              class="tool clear-all"
              title="Clear all"
              @click=${() => void this.context.streamsStore.clearShareAnnotations(this.shareModuleId)}
            >${icon(mdiDeleteSweep)}</button>`
          : nothing}
      </div>
    `;
  }

  render() {
    const s = this._surface;
    const strokes = s ? this._visible() : [];
    return html`
      <div
        class="canvas"
        @pointerdown=${this._onPointerDown}
        @pointermove=${this._onPointerMove}
        @pointerup=${this._onPointerUp}
        @pointercancel=${this._onPointerCancel}
        @dblclick=${this._onDblClick}
      >
        ${s
          ? html`<svg
              class="board"
              viewBox="0 0 10000 10000"
              preserveAspectRatio="none"
              style="left: ${s.left}px; top: ${s.top}px; width: ${s.width}px; height: ${s.height}px;"
            >
              ${strokes.map(
                v => svg`<polyline
                  class="stroke"
                  data-author=${v.author}
                  points=${pairs(v.stroke.pts)}
                  stroke=${ANNOTATION_PALETTE[v.stroke.color]}
                ></polyline>`,
              )}
              ${this._drawing && this._drawing.length >= 4
                ? svg`<polyline
                    class="stroke drawing"
                    points=${pairs(this._drawing)}
                    stroke=${ANNOTATION_PALETTE[this._colorIndex()]}
                  ></polyline>`
                : nothing}
            </svg>`
          : nothing}
      </div>
      ${this._renderStrip()}
    `;
  }
}

const annotationsModule: ModuleDefinition = {
  id: ANNOTATIONS_MODULE_ID,
  type: 'agent',
  label: 'Annotations',
  icon: mdiPencil,
  activationControl: 'sender',

  shareOverlayElement: 'module-annotations-share-overlay',

  defaultState() {
    return JSON.stringify(emptyAnnotations());
  },
};

registerModule(annotationsModule);
