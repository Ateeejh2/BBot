import { instanceKey } from '../core/types.js';

export interface PitMapCacheView {
  fingerprint: string;
  firstSeenAt: number;
  lastSeenAt: number;
  graphBuiltAt?: number;
  refreshDue: boolean;
  invalidated: boolean;
  instances: string[];
}

interface Generation<T> {
  fingerprint: string;
  firstSeenAt: number;
  lastSeenAt: number;
  graph?: T;
  graphBuiltAt?: number;
  invalidated: boolean;
  instances: Set<string>;
}

/**
 * Shared Pit map cache keyed by terrain fingerprint, not by "the current map".
 *
 * During weekly rotation Hypixel instances may temporarily serve different maps.
 * Multiple generations therefore coexist and each instance is independently bound
 * to the fingerprint it actually observes.
 */
export class PitMapCache<T> {
  private readonly generations = new Map<string, Generation<T>>();
  private readonly instanceBindings = new Map<string, string>();

  constructor(
    readonly refreshAfterMs = 7 * 24 * 60 * 60 * 1000,
    private readonly maxGenerations = 6
  ) {
    if (!Number.isSafeInteger(refreshAfterMs) || refreshAfterMs < 1) throw new Error('Invalid map cache refresh interval');
    if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 2) throw new Error('Invalid map cache generation limit');
  }

  bind(instanceId: string, fingerprint: string, now: number): PitMapCacheView {
    const instance = instanceKey(instanceId);
    const key = normalizeFingerprint(fingerprint);
    const previous = this.instanceBindings.get(instance);
    if (previous && previous !== key) this.generations.get(previous)?.instances.delete(instance);

    let generation = this.generations.get(key);
    if (!generation) {
      generation = {
        fingerprint: key,
        firstSeenAt: now,
        lastSeenAt: now,
        invalidated: false,
        instances: new Set()
      };
      this.generations.set(key, generation);
    }

    generation.lastSeenAt = now;
    generation.instances.add(instance);
    this.instanceBindings.set(instance, key);
    this.prune();
    return this.view(generation, now);
  }

  unbind(instanceId: string): void {
    const instance = instanceKey(instanceId);
    const fingerprint = this.instanceBindings.get(instance);
    if (!fingerprint) return;
    this.instanceBindings.delete(instance);
    this.generations.get(fingerprint)?.instances.delete(instance);
  }

  fingerprintForInstance(instanceId: string): string | undefined {
    return this.instanceBindings.get(instanceKey(instanceId));
  }

  setGraph(fingerprint: string, graph: T, now: number): PitMapCacheView {
    const key = normalizeFingerprint(fingerprint);
    let generation = this.generations.get(key);
    if (!generation) {
      generation = {
        fingerprint: key,
        firstSeenAt: now,
        lastSeenAt: now,
        invalidated: false,
        instances: new Set()
      };
      this.generations.set(key, generation);
    }
    generation.graph = graph;
    generation.graphBuiltAt = now;
    generation.lastSeenAt = now;
    generation.invalidated = false;
    this.prune();
    return this.view(generation, now);
  }

  graphForInstance(instanceId: string): T | undefined {
    const fingerprint = this.fingerprintForInstance(instanceId);
    if (!fingerprint) return;
    const generation = this.generations.get(fingerprint);
    if (!generation || generation.invalidated) return;
    return generation.graph;
  }

  refreshDue(instanceId: string, now: number): boolean {
    const fingerprint = this.fingerprintForInstance(instanceId);
    if (!fingerprint) return true;
    const generation = this.generations.get(fingerprint);
    if (!generation || generation.invalidated || generation.graphBuiltAt === undefined) return true;
    return now - generation.graphBuiltAt >= this.refreshAfterMs;
  }

  invalidateInstance(instanceId: string): void {
    const fingerprint = this.fingerprintForInstance(instanceId);
    if (!fingerprint) return;
    const generation = this.generations.get(fingerprint);
    if (generation) generation.invalidated = true;
  }

  invalidateFingerprint(fingerprint: string): void {
    const generation = this.generations.get(normalizeFingerprint(fingerprint));
    if (generation) generation.invalidated = true;
  }

  snapshot(now: number): PitMapCacheView[] {
    return [...this.generations.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.fingerprint.localeCompare(b.fingerprint))
      .map(generation => this.view(generation, now));
  }

  private view(generation: Generation<T>, now: number): PitMapCacheView {
    return {
      fingerprint: generation.fingerprint,
      firstSeenAt: generation.firstSeenAt,
      lastSeenAt: generation.lastSeenAt,
      graphBuiltAt: generation.graphBuiltAt,
      refreshDue: generation.invalidated || generation.graphBuiltAt === undefined ||
        now - generation.graphBuiltAt >= this.refreshAfterMs,
      invalidated: generation.invalidated,
      instances: [...generation.instances].sort()
    };
  }

  private prune(): void {
    if (this.generations.size <= this.maxGenerations) return;
    const removable = [...this.generations.values()]
      .filter(generation => generation.instances.size === 0)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    while (this.generations.size > this.maxGenerations && removable.length) {
      this.generations.delete(removable.shift()!.fingerprint);
    }
  }
}

function normalizeFingerprint(value: string): string {
  const fingerprint = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/.test(fingerprint)) throw new Error('Invalid map fingerprint');
  return fingerprint;
}
