export interface ToolActivationRuntime {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface ToolActivationUpdate {
  add?: Iterable<string>;
  remove?: Iterable<string>;
}

/**
 * Updates the active tool set without disturbing tools owned by other extensions.
 * Removal wins when a name appears in both add and remove.
 */
export function updateActiveTools(runtime: ToolActivationRuntime, update: ToolActivationUpdate): boolean {
  const active = runtime.getActiveTools();
  const removals = new Set(update.remove ?? []);
  const additions = [...new Set(update.add ?? [])].filter((name) => !removals.has(name));
  const next: string[] = [];
  const seen = new Set<string>();

  for (const name of active) {
    if (!removals.has(name) && !seen.has(name)) {
      next.push(name);
      seen.add(name);
    }
  }
  for (const name of additions) {
    if (!seen.has(name)) {
      next.push(name);
      seen.add(name);
    }
  }

  if (active.length === next.length && active.every((name, index) => name === next[index])) return false;
  runtime.setActiveTools(next);
  return true;
}

export interface LazyToolActivation {
  setEnabled(enabled: boolean): void;
  isRegistered(): boolean;
}

export function createLazyToolActivation(
  runtime: ToolActivationRuntime,
  toolName: string,
  register: () => void,
): LazyToolActivation {
  let registered = false;

  return {
    setEnabled(enabled) {
      if (enabled && !registered) {
        register();
        registered = true;
      }
      if (!registered) return;
      updateActiveTools(runtime, enabled ? { add: [toolName] } : { remove: [toolName] });
    },
    isRegistered: () => registered,
  };
}
