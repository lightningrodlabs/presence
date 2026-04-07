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
