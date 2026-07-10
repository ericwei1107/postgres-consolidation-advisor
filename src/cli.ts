#!/usr/bin/env node
/**
 * postgres-advisor CLI (PLAN.md 1.1).
 *
 * Exit codes: 0 = ok, 1 = --fail-on condition hit, 2 = error.
 * Stdout contract: when stdout is not a TTY, stdout carries ONLY the report
 * artifact; progress and warnings go to stderr (PLAN.md 1.1 / 7.0).
 */

// Node engine guard — a friendly sentence, not an ESM stack trace. Keep this
// before anything that could pull in newer-runtime features.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) {
  console.error(`postgres-advisor requires Node >= 20 (you have ${process.versions.node})`);
  process.exit(2);
}

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import { analyze } from './analyze.js';
import { loadConfig } from './config.js';
import { AdvisorError, EXIT_ERROR, EXIT_FAIL_ON, EXIT_OK } from './errors.js';
import type { AnalysisResult } from './types.js';

const VERSION = '0.1.0';
const LOCKFILE = 'postgres-advisor.lock.json';

type FailOnCondition = 'keep' | 'borderline' | 'new-store';
const FAIL_ON_VALUES: readonly FailOnCondition[] = ['keep', 'borderline', 'new-store'];

function parseFailOn(value: string): FailOnCondition[] {
  if (value === 'none' || value.trim() === '') return [];
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    if (!(FAIL_ON_VALUES as readonly string[]).includes(p)) {
      throw new AdvisorError({
        problem: `invalid --fail-on condition \`${p}\``,
        cause: '--fail-on takes a comma-separated list of exact conditions',
        fix: `use any of: ${FAIL_ON_VALUES.join(', ')} (or omit the flag)`,
        docsAnchor: 'exit-codes',
      });
    }
  }
  return parts as FailOnCondition[];
}

function parseMaxFiles(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new AdvisorError({
      problem: `invalid --max-files value \`${value}\``,
      cause: '--max-files must be a non-negative integer',
      fix: 'use a value such as --max-files 10000 (or omit the flag)',
      docsAnchor: 'configuration',
    });
  }
  return Number(value);
}

/** Minimal Stage-1 renderers; the real reporters land in Stage 7. */
function renderJson(result: AnalysisResult): string {
  return JSON.stringify(result, null, 2) + '\n';
}

function renderMarkdown(result: AnalysisResult): string {
  if (result.stores.length === 0) {
    return [
      `# postgres-advisor v${VERSION}`,
      '',
      'Nothing to consolidate — this repo is already Postgres-only.',
      '',
      '0 data stores detected.',
      '',
    ].join('\n');
  }
  return `# postgres-advisor v${VERSION}\n\n${result.stores.length} data stores detected.\n`;
}

function progress(msg: string): void {
  // Progress lines never contaminate a piped artifact stream.
  if (process.stderr.isTTY) process.stderr.write(msg + '\n');
}

async function runAnalyze(
  pathArg: string,
  opts: { format?: string; out?: string; noAi?: boolean; failOn: string; maxFiles?: number; verbose?: boolean },
): Promise<never> {
  const repoPath = resolve(pathArg);
  if (!existsSync(repoPath)) {
    throw new AdvisorError({
      problem: `path does not exist: ${repoPath}`,
      fix: 'pass a repository directory: postgres-advisor analyze <path>',
      docsAnchor: 'quickstart',
    });
  }

  const failOn = parseFailOn(opts.failOn);

  // --fail-on new-store needs a lockfile to diff against (PLAN.md 1.1).
  if (failOn.includes('new-store') && !existsSync(join(repoPath, LOCKFILE))) {
    throw new AdvisorError({
      problem: `--fail-on new-store requires a committed ${LOCKFILE}`,
      cause: 'there is no baseline to diff detected stores against',
      fix: 'run `postgres-advisor analyze --write-lock` and commit the lockfile first',
      docsAnchor: 'ci-gate',
    });
  }

  const config = loadConfig(repoPath);

  progress('Scanning…');
  const result = await analyze({ repoPath, config, noAi: opts.noAi === true, maxFiles: opts.maxFiles });
  progress(`${result.stores.length} stores detected`);
  if (opts.verbose) {
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
  }

  // Render the artifact.
  const format = opts.format ?? 'terminal';
  let artifact: string;
  switch (format) {
    case 'json':
      artifact = renderJson(result);
      break;
    case 'md':
      artifact = renderMarkdown(result);
      break;
    case 'html':
      throw new AdvisorError({
        problem: '--format html is not implemented yet',
        cause: 'the HTML reporter ships in a later stage (PLAN.md 7.2)',
        fix: 'use --format md or --format json for now',
        docsAnchor: 'reports',
      });
    default: {
      // Default terminal surface (full contract lands in Stage 7.0).
      const lines: string[] = [];
      if (result.stores.length === 0) {
        lines.push('0 data stores detected — nothing to consolidate. This repo is already Postgres-only.');
      } else {
        lines.push(`${result.stores.length} data stores detected.`);
      }
      artifact = lines.join('\n') + '\n';
    }
  }

  if (opts.out) {
    writeFileSync(opts.out, artifact);
    progress(`Report written to ${opts.out}`);
  } else {
    process.stdout.write(artifact);
  }

  // Evaluate --fail-on against verdicts (exact-match list).
  const hit = failOn.find((cond) =>
    cond === 'new-store'
      ? false // new-store diffing arrives with the lockfile logic (Stage 9.1)
      : result.verdicts.some((v) => v.decision === cond),
  );
  if (hit) {
    process.stderr.write(`fail-on condition hit: ${hit}\n`);
    process.exit(EXIT_FAIL_ON);
  }
  process.exit(EXIT_OK);
}

const program = new Command();

program
  .name('postgres-advisor')
  .description(
    'Inventory a repo’s non-Postgres data stores and get consolidate/keep verdicts with cited thresholds.',
  )
  .version(VERSION);

program
  .command('analyze [path]', { isDefault: true })
  .description('analyze a repository (default: current directory)')
  .addOption(new Option('--format <format>', 'report format').choices(['md', 'json', 'html']))
  .option('--out <file>', 'write the report to a file instead of stdout')
  .option('--max-files <count>', 'limit source files scanned for call sites', parseMaxFiles)
  .option('--verbose', 'print analysis warnings and skipped-file counts to stderr')
  .option('--no-ai', 'skip Gemini calls; use deterministic fallbacks everywhere')
  .option(
    '--fail-on <conditions>',
    `comma-separated exact-match list: ${FAIL_ON_VALUES.join(', ')} (exit 1 on hit)`,
    'none',
  )
  .action(async (pathArg: string | undefined, opts: { format?: string; out?: string; noAi?: boolean; failOn: string; maxFiles?: number; verbose?: boolean }) => {
    await runAnalyze(pathArg ?? '.', opts);
  });

program
  .command('explain [threshold-id]')
  .description('show a threshold: value, comparison, source + grade, assumption status')
  .option('--list', 'list all threshold ids by category')
  .action(() => {
    // Stub until rules/thresholds.yaml lands (PLAN.md 4.2).
    const err = new AdvisorError({
      problem: '`explain` is not available in this build',
      cause: 'threshold rules ship in Stage 4.2',
      fix: 'see PLAN.md §1 for the full threshold methodology in the meantime',
      docsAnchor: 'methodology',
    });
    console.error(err.format());
    process.exit(EXIT_ERROR);
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  if (e instanceof AdvisorError) {
    console.error(e.format());
  } else {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(EXIT_ERROR);
});
