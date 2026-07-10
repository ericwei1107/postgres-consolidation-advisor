import { readFileSync, statSync } from 'node:fs';
import type { DetectorContext } from '../detectors/types.js';
import { scanFiles, toRelPosix } from '../scan.js';

/**
 * Shared file-reading for signal extractors that need their own targeted
 * regex scan over source — the Stage 3.1 harvester's evidence doesn't cover
 * every pattern a threshold needs (e.g. it never captures a `concurrency:`
 * option object or a `$inc` update operator, both of which live on lines the
 * harvester's per-command regex never visits). Same size/binary guards as
 * the harvester, so a hostile or huge repo can't stall a signal extractor.
 */

const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_SOURCE_GLOBS = ['**/*.{js,jsx,mjs,cjs,ts,tsx,py,rb,go}'];

export interface SourceFile {
  file: string;
  raw: string;
}

export async function readSourceFiles(ctx: DetectorContext, globs: string[] = DEFAULT_SOURCE_GLOBS): Promise<SourceFile[]> {
  const paths = await scanFiles(ctx.repoPath, globs, ctx.config);
  const files: SourceFile[] = [];
  for (const path of paths) {
    const rel = toRelPosix(ctx.repoPath, path);
    try {
      if (statSync(path).size > MAX_FILE_BYTES) continue;
      const raw = readFileSync(path, 'utf8');
      if (raw.slice(0, 4096).includes('\0')) continue;
      files.push({ file: rel, raw });
    } catch {
      continue;
    }
  }
  return files;
}

/** Reads one already-known-relative file relative to the repo root, or null if unreadable. */
export function readRepoFile(ctx: DetectorContext, relFile: string): string | null {
  try {
    return readFileSync(`${ctx.repoPath}/${relFile}`, 'utf8');
  } catch {
    return null;
  }
}

/** Crude import/require detection — good enough for signal gating, not the harvester's precision needs. */
export function fileImports(raw: string, library: string): boolean {
  const escaped = library.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dotted = escaped.replaceAll('/', '.');
  return (
    new RegExp(`\\bimport\\b[^;\\n]*["']${escaped}["']`).test(raw) ||
    new RegExp(`\\brequire\\s*\\(\\s*["']${escaped}["']`).test(raw) ||
    new RegExp(`^\\s*from\\s+${dotted}\\s+import\\b`, 'm').test(raw) ||
    new RegExp(`^\\s*import\\s+${dotted}\\b`, 'm').test(raw)
  );
}

/** 1-based line number of a character offset into `raw`. */
export function lineAt(raw: string, index: number): number {
  return raw.slice(0, index).split('\n').length;
}
