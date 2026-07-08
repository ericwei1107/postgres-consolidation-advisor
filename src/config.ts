import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { AdvisorError } from './errors.js';

/**
 * `.postgres-advisor.yaml` — PLAN.md 1.1.
 * Invalid config is a hard fail (exit 2), same policy as rules files: it
 * gates CI semantics. The error names the field AND shows the valid shape.
 *
 * Precedence rule: `suppress` shapes LOCAL analyze output only — it does NOT
 * satisfy the CI gate (9.1); the lockfile justification is the only
 * gate-silencing mechanism.
 */

export const CONFIG_FILENAME = '.postgres-advisor.yaml';

export const AdvisorConfigSchema = z
  .object({
    /** Store ids or product names; suppressed stores stay in the inventory annotated "suppressed", get no verdict. */
    suppress: z.array(z.string()).default([]),
    /** Glob patterns excluded from scanning (in addition to built-in node_modules/vendor/.git/dist/build). */
    ignore: z.array(z.string()).default([]),
    /** If non-empty, scanning is restricted to these glob patterns. */
    paths: z.array(z.string()).default([]),
    /** threshold-id → value. Overridden thresholds render "(user-overridden; cited source no longer applies)". fitScore weights are NOT overridable in v1. */
    threshold_overrides: z.record(z.string(), z.number()).default({}),
  })
  .strict();

export type AdvisorConfig = z.infer<typeof AdvisorConfigSchema>;

export const DEFAULT_CONFIG: AdvisorConfig = {
  suppress: [],
  ignore: [],
  paths: [],
  threshold_overrides: {},
};

const SHAPE_EXAMPLE = `  suppress: [redis-cache]          # store ids or products; local reports only
  ignore: ["examples/**"]          # extra scan exclusions
  paths: ["services/api/**"]       # restrict scanning (optional)
  threshold_overrides:
    queue.est-peak-msgs-sec: 2000  # overrides render "(user-overridden)"`;

export function loadConfig(repoPath: string): AdvisorConfig {
  const file = join(repoPath, CONFIG_FILENAME);
  if (!existsSync(file)) return DEFAULT_CONFIG;

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'), { maxAliasCount: 100 });
  } catch (e) {
    throw new AdvisorError({
      problem: `${CONFIG_FILENAME} is not valid YAML`,
      cause: e instanceof Error ? e.message : String(e),
      fix: `Fix the YAML syntax. Valid shape:\n${SHAPE_EXAMPLE}`,
      docsAnchor: 'configuration',
    });
  }

  if (raw === null || raw === undefined) return DEFAULT_CONFIG;

  const result = AdvisorConfigSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)';
    throw new AdvisorError({
      problem: `${CONFIG_FILENAME} is invalid at \`${field}\``,
      cause: issue?.message ?? 'schema validation failed',
      fix: `Valid shape:\n${SHAPE_EXAMPLE}`,
      docsAnchor: 'configuration',
    });
  }
  return result.data;
}
