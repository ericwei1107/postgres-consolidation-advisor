import { z } from 'zod';

/**
 * Core types — PLAN.md §2. Frozen as of 2026-07-08 (post final-gate).
 * Every interface has a matching zod schema; the `satisfies z.ZodType<...>`
 * bindings make schema/interface drift a compile error.
 */

export type StoreCategory =
  | 'cache'
  | 'queue'
  | 'search'
  | 'document'
  | 'vector'
  | 'timeseries'
  | 'olap'
  | 'graph'
  | 'geospatial'
  | 'relational'
  | 'unknown';

export const StoreCategorySchema = z.enum([
  'cache',
  'queue',
  'search',
  'document',
  'vector',
  'timeseries',
  'olap',
  'graph',
  'geospatial',
  'relational',
  'unknown',
]) satisfies z.ZodType<StoreCategory>;

export type EvidenceKind =
  | 'compose'
  | 'env'
  | 'dependency'
  | 'orm-schema'
  | 'call-site'
  | 'live-stats';

export const EvidenceKindSchema = z.enum([
  'compose',
  'env',
  'dependency',
  'orm-schema',
  'call-site',
  'live-stats',
]) satisfies z.ZodType<EvidenceKind>;

export interface Evidence {
  kind: EvidenceKind;
  file: string;
  line?: number;
  /**
   * Excerpts from env/config files carry variable NAMES with redacted values
   * (credentials always stripped) — see PLAN.md 2.3 secret-redaction rule.
   */
  excerpt: string;
}

export const EvidenceSchema = z.object({
  kind: EvidenceKindSchema,
  file: z.string(),
  line: z.number().int().positive().optional(),
  excerpt: z.string(),
}) satisfies z.ZodType<Evidence>;

export interface DetectedStore {
  /** Stable content hash of (product + normalized instance identity) — PLAN.md 9.1. */
  id: string;
  product: string;
  category: StoreCategory[];
  evidence: Evidence[];
}

export const DetectedStoreSchema = z.object({
  id: z.string(),
  product: z.string(),
  category: z.array(StoreCategorySchema),
  evidence: z.array(EvidenceSchema),
}) satisfies z.ZodType<DetectedStore>;

export type Confidence = 'high' | 'medium' | 'low';

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']) satisfies z.ZodType<Confidence>;

export interface StoreRole {
  storeId: string;
  role: StoreCategory;
  confidence: Confidence;
  classifiedBy: 'rule' | 'gemini';
  evidence: Evidence[];
}

export const StoreRoleSchema = z.object({
  storeId: z.string(),
  role: StoreCategorySchema,
  confidence: ConfidenceSchema,
  classifiedBy: z.enum(['rule', 'gemini']),
  evidence: z.array(EvidenceSchema),
}) satisfies z.ZodType<StoreRole>;

export interface ThresholdComparison {
  variable: string;
  observed: string;
  threshold: string;
  source: string;
  passed: boolean;
}

export const ThresholdComparisonSchema = z.object({
  variable: z.string(),
  observed: z.string(),
  threshold: z.string(),
  source: z.string(),
  passed: z.boolean(),
}) satisfies z.ZodType<ThresholdComparison>;

/** Populated for every `consolidate` verdict — the cost side of the decision. */
export interface MigrationEffort {
  callSites: number;
  filesTouched: number;
  dataMigration: 'copy' | 'dual-write' | 'none';
  rollbackNote: string;
}

export const MigrationEffortSchema = z.object({
  callSites: z.number().int().nonnegative(),
  filesTouched: z.number().int().nonnegative(),
  dataMigration: z.enum(['copy', 'dual-write', 'none']),
  rollbackNote: z.string(),
}) satisfies z.ZodType<MigrationEffort>;

export interface Verdict {
  storeId: string;
  role: StoreCategory;
  decision: 'consolidate' | 'keep' | 'borderline';
  /** 0–100. JSON-only: never rendered in human surfaces (PLAN.md 7.0). */
  fitScore: number;
  confidence: Confidence;
  thresholdComparisons: ThresholdComparison[];
  rationale: string;
  postgresEquivalent: string;
  snippetId?: string;
  migrationEffort?: MigrationEffort;
}

export const VerdictSchema = z.object({
  storeId: z.string(),
  role: StoreCategorySchema,
  decision: z.enum(['consolidate', 'keep', 'borderline']),
  fitScore: z.number().min(0).max(100),
  confidence: ConfidenceSchema,
  thresholdComparisons: z.array(ThresholdComparisonSchema),
  rationale: z.string(),
  postgresEquivalent: z.string(),
  snippetId: z.string().optional(),
  migrationEffort: MigrationEffortSchema.optional(),
}) satisfies z.ZodType<Verdict>;

/** Structured ORM field summary (PLAN.md §2 review addition) — typed data for 4.3/6.2. */
export interface FieldSummary {
  model: string;
  fields: { name: string; type: string; nested: boolean }[];
  estimatedDocBytes?: number;
}

export const FieldSummarySchema = z.object({
  model: z.string(),
  fields: z.array(z.object({ name: z.string(), type: z.string(), nested: z.boolean() })),
  estimatedDocBytes: z.number().positive().optional(),
}) satisfies z.ZodType<FieldSummary>;

/** Full analysis result — the `--format json` artifact shape (schemaVersion 1). */
export interface AnalysisResult {
  schemaVersion: 1;
  stores: DetectedStore[];
  roles: StoreRole[];
  verdicts: Verdict[];
  warnings: string[];
}

export const AnalysisResultSchema = z.object({
  schemaVersion: z.literal(1),
  stores: z.array(DetectedStoreSchema),
  roles: z.array(StoreRoleSchema),
  verdicts: z.array(VerdictSchema),
  warnings: z.array(z.string()),
}) satisfies z.ZodType<AnalysisResult>;
