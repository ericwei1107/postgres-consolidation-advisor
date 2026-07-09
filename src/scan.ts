import { relative, sep } from 'node:path';
import fg from 'fast-glob';
import type { AdvisorConfig } from './config.js';

/**
 * File walking for detectors (PLAN.md 2.1 parse-error/walk policy).
 * - Never follows symlinks (avoids escaping the repo and cycle hangs).
 * - Always ignores vendored/build/VCS trees.
 * - Honors `.postgres-advisor.yaml` `ignore:` (extra excludes) and `paths:`
 *   (when set, results are restricted to files also matched by these globs).
 */

export const BUILTIN_IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
];

/** Convert an absolute path to a repo-relative POSIX path (stable in evidence). */
export function toRelPosix(repoPath: string, absPath: string): string {
  return relative(repoPath, absPath).split(sep).join('/');
}

export async function scanFiles(
  repoPath: string,
  patterns: string[],
  config: AdvisorConfig,
  extraIgnore: string[] = [],
): Promise<string[]> {
  const ignore = [...BUILTIN_IGNORE_GLOBS, ...config.ignore, ...extraIgnore];
  const common = {
    cwd: repoPath,
    absolute: true,
    dot: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    onlyFiles: true,
  } as const;

  let entries = await fg(patterns, { ...common, ignore });

  if (config.paths.length > 0) {
    const scoped = new Set(await fg(config.paths, { ...common, ignore }));
    entries = entries.filter((e) => scoped.has(e));
  }

  return [...new Set(entries)].sort();
}
