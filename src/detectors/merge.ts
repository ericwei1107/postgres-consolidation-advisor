import type { DetectedStore, Evidence, StoreCategory } from '../types.js';
import type { Detection, InstanceIdentity } from './types.js';

/**
 * Cross-detector merge by product + instance identity (PLAN.md 2.3).
 *
 * Identity resolution, in order:
 *  1. compose service names anchor instances (two Redis services in one
 *     compose file are TWO stores);
 *  2. env/config host:port identities unify with a service when the host
 *     equals the service name (compose DNS), else they anchor their own
 *     instance;
 *  3. default-bucket evidence (dependencies; env vars without a resolvable
 *     host) folds into the product's single instance when there is exactly
 *     one — otherwise it stays in a default-bucket store and the ambiguity is
 *     recorded as a warning (downstream role confidence capped at medium).
 */

interface Bucket {
  product: string;
  /** Human-readable instance label (service name, host[:port], or 'default'). */
  label: string;
  host?: string;
  port?: string;
  category: StoreCategory[];
  evidence: Evidence[];
}

function addCategories(bucket: Bucket, categories: StoreCategory[]): void {
  for (const c of categories) {
    if (!bucket.category.includes(c)) bucket.category.push(c);
  }
}

function addEvidence(bucket: Bucket, evidence: Evidence[]): void {
  for (const e of evidence) {
    const dup = bucket.evidence.some(
      (x) => x.kind === e.kind && x.file === e.file && x.line === e.line && x.excerpt === e.excerpt,
    );
    if (!dup) bucket.evidence.push(e);
  }
}

/** Hosts match when equal; ports must match only when both sides have one. */
function hostportMatches(bucket: Bucket, host: string, port: string | undefined): boolean {
  if (bucket.host !== host) return false;
  return bucket.port === undefined || port === undefined || bucket.port === port;
}

/**
 * Store ids whose default bucket survived the merge next to 2+ named
 * instances — the ambiguity the merge warning promises caps downstream role
 * confidence at medium. Derivable from the output: a `:default` store only
 * coexists with named siblings in exactly that case (with one named instance
 * the fallback is folded in; alone it IS the only instance).
 */
export function ambiguousDefaultStoreIds(stores: DetectedStore[]): Set<string> {
  const countByProduct = new Map<string, number>();
  for (const s of stores) countByProduct.set(s.product, (countByProduct.get(s.product) ?? 0) + 1);
  const ambiguous = new Set<string>();
  for (const s of stores) {
    if (s.id === `${s.product}:default` && (countByProduct.get(s.product) ?? 0) >= 3) ambiguous.add(s.id);
  }
  return ambiguous;
}

export function mergeDetections(
  detections: Detection[],
  addWarning: (message: string) => void,
): DetectedStore[] {
  const byProduct = new Map<string, Detection[]>();
  for (const d of detections) {
    const list = byProduct.get(d.store.product) ?? [];
    list.push(d);
    byProduct.set(d.store.product, list);
  }

  const stores: DetectedStore[] = [];
  const kindOrder = (identity: InstanceIdentity) =>
    identity.kind === 'service' ? 0 : identity.kind === 'hostport' ? 1 : 2;

  for (const [product, group] of [...byProduct.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const named: Bucket[] = [];
    let fallback: Bucket | undefined;

    // Services anchor instances, then hostports attach or anchor, then defaults.
    const ordered = [...group].sort((a, b) => kindOrder(a.identity) - kindOrder(b.identity));

    for (const { store, identity } of ordered) {
      let bucket: Bucket | undefined;

      if (identity.kind === 'service') {
        bucket = named.find((b) => b.label === identity.name);
        if (!bucket) {
          bucket = { product, label: identity.name, host: identity.name, category: [], evidence: [] };
          named.push(bucket);
        }
        // A service's own port is unknown here; host = service name (compose DNS).
      } else if (identity.kind === 'hostport') {
        bucket = named.find((b) => hostportMatches(b, identity.host, identity.port));
        if (bucket) {
          bucket.port ??= identity.port;
        } else {
          bucket = {
            product,
            label: identity.port ? `${identity.host}:${identity.port}` : identity.host,
            host: identity.host,
            ...(identity.port ? { port: identity.port } : {}),
            category: [],
            evidence: [],
          };
          named.push(bucket);
        }
      } else {
        fallback ??= { product, label: 'default', category: [], evidence: [] };
        bucket = fallback;
      }

      addCategories(bucket, store.category);
      addEvidence(bucket, store.evidence);
    }

    const buckets = [...named];
    if (fallback) {
      if (named.length === 1) {
        // Unambiguous: the product has exactly one instance.
        addCategories(named[0]!, fallback.category);
        addEvidence(named[0]!, fallback.evidence);
      } else {
        if (named.length >= 2) {
          addWarning(
            `${product}: evidence from ${[...new Set(fallback.evidence.map((e) => e.file))].join(', ')} ` +
              `could not be attributed to one of ${named.length} instances ` +
              `(${named.map((b) => b.label).join(', ')}); kept in a default bucket — ` +
              `role confidence for these stores is capped at medium`,
          );
        }
        buckets.push(fallback);
      }
    }

    for (const bucket of buckets.sort((a, b) => (a.label < b.label ? -1 : 1))) {
      stores.push({
        id: `${product}:${bucket.label}`,
        product,
        category: bucket.category,
        evidence: bucket.evidence,
      });
    }
  }

  return stores;
}
