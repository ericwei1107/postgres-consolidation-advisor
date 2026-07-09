import type { AdvisorConfig } from '../config.js';
import type { DetectedStore } from '../types.js';

/**
 * Detector contract (PLAN.md §2 pipeline). Each detector is isolated: the
 * orchestrator (analyze.ts) catches throws and turns them into warnings so one
 * detector failing never sinks the run.
 */
export interface DetectorContext {
  repoPath: string;
  config: AdvisorConfig;
  /** Record a non-fatal analysis warning (surfaced to stderr / report). */
  addWarning(message: string): void;
}

/**
 * Instance identity (PLAN.md 2.3): detections merge by product + instance,
 * NOT product alone. Identity = compose service name, or URL host:port from
 * env/config, else the per-product default bucket. The merge layer unifies a
 * `hostport` with a `service` when the host equals the service name (compose
 * DNS: a service is reachable at its service name).
 */
export type InstanceIdentity =
  | { kind: 'service'; name: string }
  | { kind: 'hostport'; host: string; port?: string }
  | { kind: 'default' };

/** A detector's raw output: a store plus the instance identity it was seen at. */
export interface Detection {
  store: DetectedStore;
  identity: InstanceIdentity;
}

export interface Detector {
  readonly name: string;
  detect(ctx: DetectorContext): Promise<Detection[]>;
}
