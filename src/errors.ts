/**
 * Error convention (PLAN.md 1.1): every user-facing error carries
 * problem + cause + fix + stable docs anchor. Exit codes: 0 ok,
 * 1 --fail-on condition hit, 2 analysis/config error.
 */

export const DOCS_BASE = 'https://github.com/ericwei1107/postgres-consolidation-advisor#';

export class AdvisorError extends Error {
  readonly problem: string;
  readonly cause2: string | undefined;
  readonly fix: string | undefined;
  readonly docsAnchor: string | undefined;

  constructor(opts: { problem: string; cause?: string; fix?: string; docsAnchor?: string }) {
    super(opts.problem);
    this.name = 'AdvisorError';
    this.problem = opts.problem;
    this.cause2 = opts.cause;
    this.fix = opts.fix;
    this.docsAnchor = opts.docsAnchor;
  }

  format(): string {
    const lines = [`error: ${this.problem}`];
    if (this.cause2) lines.push(`cause: ${this.cause2}`);
    if (this.fix) lines.push(`fix:   ${this.fix}`);
    if (this.docsAnchor) lines.push(`docs:  ${DOCS_BASE}${this.docsAnchor}`);
    return lines.join('\n');
  }
}

export const EXIT_OK = 0;
export const EXIT_FAIL_ON = 1;
export const EXIT_ERROR = 2;
