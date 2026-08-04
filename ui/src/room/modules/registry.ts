import type { ModuleDefinition } from './types';

const moduleRegistry = new Map<string, ModuleDefinition>();

export function registerModule(def: ModuleDefinition): void {
  if (moduleRegistry.has(def.id)) {
    console.warn(`Module '${def.id}' already registered, overwriting.`);
  }
  moduleRegistry.set(def.id, def);
}

export function getModule(id: string): ModuleDefinition | undefined {
  return moduleRegistry.get(id);
}

export function getAllModules(): ModuleDefinition[] {
  return Array.from(moduleRegistry.values());
}

export function getAgentModules(): ModuleDefinition[] {
  return getAllModules().filter(m => m.type === 'agent');
}

export function getShareModules(): ModuleDefinition[] {
  return getAllModules().filter(m => m.type === 'share');
}

/**
 * The ONE constructor for a share tile's maximize/layout key (Round 3
 * item 4a). `_maximizedVideo` in room-view is a string with several key
 * families (peer pubkeys, 'my-own-stream', share keys); the share-key
 * encoding used to be written out in four places — the tile `repeat()`
 * key, the tile's own `shareKey`, and two store-event arms — and a fifth
 * site compared against a `<video>` element id (`'my-own-screen'`) that
 * no tile is ever keyed by, so stopping your own maximized screen share
 * left `_maximizedVideo` pointing at a key nothing renders and the room
 * blanked until a double-click. Every share-key construction and
 * comparison goes through this function.
 *
 * Constrains `room-view.ts:renderSharedPanel` and the
 * `my-screen-share-off` / `peer-screen-share-disconnected` arms of
 * `room-view.ts:_onStoreEvent`.
 */
export function shareMaximizeKey(moduleId: string, agentPubKeyB64: string): string {
  return `share-${moduleId}-${agentPubKeyB64}`;
}
