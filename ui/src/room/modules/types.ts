import { TemplateResult } from 'lit';
import type { StreamsStore } from '../../streams-store';
import type { ModuleStateEnvelope } from '../../types';

export type { ModuleStateEnvelope };

export type ModuleType = 'agent' | 'share';
export type ModuleActivationControl = 'sender' | 'receiver';

/**
 * A multi-state icon rendered in the standardized icon strip on a pane.
 * The current state is an index into the states array, or undefined to hide.
 */
export interface ModuleIconDefinition {
  states: Array<{
    icon: string;       // SVG path (e.g. mdi icon)
    tooltip?: string;
    color?: string;
  }>;
  /** Index into states array. undefined = icon is hidden. */
  currentState: number | undefined;
  /** Called when the icon is clicked, receiving the current state index. */
  onSelect?: (currentStateIndex: number) => void;
}

/**
 * Context passed to module render methods.
 */
export interface ModuleRenderContext {
  isMe: boolean;
  connected: boolean;
  circleView: boolean;
  streamsStore: StreamsStore;
  /** The local agent's public key (base64) */
  myPubKeyB64: string;
  /** Module-specific extra data passed by the pane renderer (e.g., OpenConnectionInfo for video) */
  extra?: Record<string, unknown>;
}

/**
 * Context passed to module lifecycle hooks.
 */
export interface ModuleLifecycleContext {
  streamsStore: StreamsStore;
  myPubKeyB64: string;
}

/**
 * A module definition. Modules are bundles of optional aspects:
 * - Display: renderOverlay and/or renderReplace
 * - State icons: getStateIcons for standardized icon strip
 * - State data: defaultState, produceState for reconcilable snapshots
 * - Stream: onData for ephemeral data chunks
 */
export interface ModuleDefinition {
  id: string;
  type: ModuleType;
  label: string;
  icon: string;                            // SVG path
  activationControl: ModuleActivationControl;

  // --- Display aspects ---

  /** Content rendered on top of the pane, always visible when module is active. */
  renderOverlay?(
    agentPubKeyB64: string,
    state: ModuleStateEnvelope | null,
    context: ModuleRenderContext,
  ): TemplateResult;

  /** Content that fills the pane when viewer switches to this module's view. */
  renderReplace?(
    agentPubKeyB64: string,
    state: ModuleStateEnvelope | null,
    context: ModuleRenderContext,
  ): TemplateResult;

  // --- State icon aspect ---

  /** Return icons for the standardized icon strip on the pane. */
  getStateIcons?(
    agentPubKeyB64: string,
    state: ModuleStateEnvelope | null,
    context: ModuleRenderContext,
  ): ModuleIconDefinition[];

  // --- State data aspect ---

  /** Initial JSON payload when module is activated. */
  defaultState?(): string;
  /** Periodic state producer. Return updated payload JSON, or null if no change. */
  produceState?(): string | null;
  /** Interval in ms between produceState calls. */
  stateInterval?: number;

  // --- Stream aspect ---

  /** Called when an ephemeral data chunk arrives from a peer. */
  onData?(agentPubKeyB64: string, chunk: string): void;

  // --- Lifecycle ---

  onActivate?(context: ModuleLifecycleContext): void;
  onDeactivate?(): void;

  // --- Toolbar ---

  /** Render a button for the bottom control bar (activation toggle). */
  renderToolbarButton?(
    myState: ModuleStateEnvelope | null,
    toggle: () => void,
  ): TemplateResult;
}
