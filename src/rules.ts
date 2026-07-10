import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { AdvisorError } from './errors.js';
import { StoreCategorySchema, type StoreCategory } from './types.js';

/**
 * Loads declarative rule files that ship with the package (PLAN.md §0: rules are
 * data, not code). `rules/` lives at the package root and is listed in
 * package.json `files`, so it is present both in dev (source tree) and when
 * installed (next to `dist/`). We resolve it by walking up from this module.
 */

let cachedRulesDir: string | undefined;

export function rulesDir(): string {
  if (cachedRulesDir) return cachedRulesDir;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'rules'),
    join(here, '..', 'rules'),
    join(here, '..', '..', 'rules'),
    join(here, '..', '..', '..', 'rules'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'products.yaml'))) {
      cachedRulesDir = dir;
      return dir;
    }
  }
  throw new AdvisorError({
    problem: 'could not locate the bundled rules/ directory',
    cause: `looked in: ${candidates.join(', ')}`,
    fix: 'reinstall postgres-advisor; rules/ ships with the package',
    docsAnchor: 'troubleshooting',
  });
}

/**
 * Parse + zod-validate one bundled rules file. Rules files are packaged
 * artifacts, so any failure here is a packaging bug and hard-fails (exit 2),
 * per the PLAN.md 1.1 rules-file policy.
 */
function loadRulesFile<Schema extends z.ZodType>(filename: string, schema: Schema): z.infer<Schema> {
  const file = join(rulesDir(), filename);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(file, 'utf8'), { maxAliasCount: 100 });
  } catch (e) {
    throw new AdvisorError({
      problem: `rules/${filename} is not valid YAML`,
      cause: e instanceof Error ? e.message : String(e),
      fix: 'this is a packaging bug — please file an issue',
      docsAnchor: 'troubleshooting',
    });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new AdvisorError({
      problem: `rules/${filename} is invalid at \`${issue?.path.join('.') ?? '(root)'}\``,
      cause: issue?.message ?? 'schema validation failed',
      fix: 'this is a packaging bug — please file an issue',
      docsAnchor: 'troubleshooting',
    });
  }
  return result.data;
}

const ClientLibrarySchema = z
  .object({
    product: z.string().optional(),
    category: z.array(StoreCategorySchema).min(1).optional(),
    broker_from_config: z.boolean().optional(),
  })
  .refine((v) => v.product !== undefined || v.broker_from_config === true, {
    message: 'a client library needs either `product` or `broker_from_config: true`',
  });

const ProductsFileSchema = z.object({
  products: z.record(
    z.string(),
    z.object({
      category: z.array(StoreCategorySchema).min(1),
      image_patterns: z.array(z.string()).default([]),
    }),
  ),
  client_libraries: z.record(z.string(), ClientLibrarySchema).default({}),
  broker_schemes: z.record(z.string(), z.string()).default({}),
  env_vars: z.record(z.string(), z.string()).default({}),
  url_schemes: z.record(z.string(), z.string()).default({}),
  embedding_dims: z.record(z.string(), z.number().int().positive()).default({}),
});

type ProductsFile = z.infer<typeof ProductsFileSchema>;

const CallPatternsFileSchema = z.object({
  products: z.record(
    z.string(),
    z.object({
      libraries: z.array(z.string()).min(1),
      patterns: z.array(z.string()).min(1),
      /** Imported constructor symbols that count as call sites on their own (e.g. BullMQ `Queue`/`Worker`). */
      constructors: z.array(z.string()).default([]),
    }),
  ),
});

const SourceGradeSchema = z.enum(['vendor', 'independent', 'reproduced']);

const ThresholdSourceSchema = z.object({
  url: z.string(),
  grade: SourceGradeSchema,
  note: z.string().optional(),
});

const ThresholdBandSchema = z.object({
  decision: z.enum(['consolidate', 'keep', 'borderline']),
  min: z.number().optional(),
  max: z.number().optional(),
  mapping_option: z.string().optional(),
});

const ObservabilitySchema = z.enum(['static', 'estimated', 'live-only']);
const LiveSourceSchema = z.enum(['pg-stats', 'incumbent-only', 'none']);

const ThresholdCommonSchema = {
  id: z.string(),
  category: StoreCategorySchema,
  variable: z.string(),
  description: z.string(),
  observability: ObservabilitySchema,
  live_source: LiveSourceSchema,
  live_source_note: z.string().optional(),
  unit: z.string().optional(),
  weight: z.number().positive().optional(),
  sources: z.array(ThresholdSourceSchema).default([]),
  assumption_id: z.string().regex(/^A\d+$/).optional(),
  failure_mode: z.string().optional(),
  note: z.string().optional(),
};

const ThresholdBandsSchema = z.object({
  ...ThresholdCommonSchema,
  comparison: z.literal('bands'),
  bands: z.array(ThresholdBandSchema).min(1),
});

const ThresholdGateSchema = z.object({
  ...ThresholdCommonSchema,
  comparison: z.literal('gate'),
  gate_decision: z.enum(['consolidate', 'keep']),
  gate_signals: z.array(z.string()).min(1),
  mapping_option: z.string().optional(),
});

const ThresholdReferenceSchema = z.object({
  ...ThresholdCommonSchema,
  comparison: z.literal('reference'),
  value: z.number(),
});

const ThresholdEntrySchema = z.discriminatedUnion('comparison', [
  ThresholdBandsSchema,
  ThresholdGateSchema,
  ThresholdReferenceSchema,
]);

const ScoringConfigSchema = z.object({
  base_score: z.number(),
  qualitative_gate_max_fit_score: z.number(),
  default_weight: z.number(),
});

const ConstantEntrySchema = z.object({
  description: z.string(),
  observability: ObservabilitySchema,
  value: z.union([z.number(), z.object({ min: z.number(), max: z.number() })]),
  unit: z.string(),
  assumption_id: z.string().regex(/^A\d+$/).optional(),
  sources: z.array(ThresholdSourceSchema).default([]),
});

const ThresholdsFileSchema = z.object({
  scoring: ScoringConfigSchema,
  constants: z.record(z.string(), ConstantEntrySchema),
  thresholds: z.array(ThresholdEntrySchema).min(1),
});

const MappingOptionSchema = z.object({
  name: z.string(),
  label: z.string(),
  extension_required: z.object({
    required: z.boolean(),
    name: z.string().nullable(),
  }),
  maturity: z.string(),
  operational_cost: z.string(),
  data_migration: z.enum(['copy', 'dual-write', 'none']),
  rollback: z.string(),
});

const MappingsFileSchema = z.object({
  mappings: z.record(z.string(), z.array(MappingOptionSchema).min(1)),
});

const RolesFileSchema = z.object({
  products: z.record(
    z.string(),
    z.object({
      fixed_role: StoreCategorySchema.optional(),
      cache: z
        .object({
          commands: z.array(z.string()).min(1),
          min_share: z.number().min(0).max(1),
          mixed_confidence: z.enum(['high', 'medium', 'low']),
        })
        .optional(),
      queue: z
        .object({
          libraries: z.array(z.string()).min(1),
          commands: z.array(z.string()).min(1),
        })
        .optional(),
      command_mix: z
        .object({
          plain_kv: z.array(z.string()),
          native_structure: z.array(z.string()),
        })
        .optional(),
    }),
  ),
});

export interface ProductRule {
  product: string;
  category: StoreCategory[];
  imagePatterns: RegExp[];
}

export interface ClientLibraryRule {
  library: string;
  /** Absent only when brokerFromConfig (the backing store is named in app config). */
  product?: string;
  /** Overrides the product's base category seed (e.g. bullmq → redis as queue). */
  category?: StoreCategory[];
  brokerFromConfig: boolean;
}

export interface CallPatternRule {
  product: string;
  libraries: string[];
  patterns: RegExp[];
  /** Lowercased constructor symbols that are call sites when imported from this product's libraries. */
  constructors: Set<string>;
}

export interface RoleRule {
  product: string;
  fixedRole?: StoreCategory;
  cache?: { commands: string[]; minShare: number; mixedConfidence: 'high' | 'medium' | 'low' };
  queue?: { libraries: string[]; commands: string[] };
  /** Partition for the cacheCommandMix signal: plain KV vs Redis-native structures (PLAN.md §1.2). */
  commandMix?: { plainKv: Set<string>; nativeStructure: Set<string> };
}

/** A Postgres-native option for consolidating one StoreCategory — PLAN.md 4.1. */
export interface MappingOption {
  name: string;
  label: string;
  extensionRequired: { required: boolean; name: string | null };
  maturity: string;
  operationalCost: string;
  dataMigration: 'copy' | 'dual-write' | 'none';
  rollback: string;
}

/** Every StoreCategory that gets a Postgres-consolidation mapping (all but relational/unknown). */
export const MAPPED_CATEGORIES: StoreCategory[] = [
  'cache',
  'queue',
  'search',
  'document',
  'vector',
  'timeseries',
  'olap',
  'graph',
  'geospatial',
];

let cachedFile: ProductsFile | undefined;

function loadProductsFile(): ProductsFile {
  cachedFile ??= loadRulesFile('products.yaml', ProductsFileSchema);
  return cachedFile;
}

let cachedProducts: ProductRule[] | undefined;

export function loadProducts(): ProductRule[] {
  if (cachedProducts) return cachedProducts;
  cachedProducts = Object.entries(loadProductsFile().products).map(([product, def]) => ({
    product,
    category: def.category,
    imagePatterns: def.image_patterns.map((p) => new RegExp(p, 'i')),
  }));
  return cachedProducts;
}

let cachedLibraries: Map<string, ClientLibraryRule> | undefined;

/** Dependency-name → rule, keyed lowercase (PyPI normalization happens at lookup). */
export function loadClientLibraries(): Map<string, ClientLibraryRule> {
  if (cachedLibraries) return cachedLibraries;
  cachedLibraries = new Map(
    Object.entries(loadProductsFile().client_libraries).map(([library, def]) => [
      library.toLowerCase(),
      {
        library,
        ...(def.product !== undefined ? { product: def.product } : {}),
        ...(def.category !== undefined ? { category: def.category } : {}),
        brokerFromConfig: def.broker_from_config === true,
      },
    ]),
  );
  return cachedLibraries;
}

/** Literal broker-URL scheme → product (Celery rule, PLAN.md 2.2). */
export function loadBrokerSchemes(): Record<string, string> {
  return loadProductsFile().broker_schemes;
}

let cachedEnvVars: Map<string, string> | undefined;

/** Well-known env variable NAME → product, keyed uppercase (PLAN.md 2.3). */
export function loadEnvVars(): Map<string, string> {
  if (cachedEnvVars) return cachedEnvVars;
  cachedEnvVars = new Map(
    Object.entries(loadProductsFile().env_vars).map(([name, product]) => [name.toUpperCase(), product]),
  );
  return cachedEnvVars;
}

let cachedUrlSchemes: Map<string, string> | undefined;

/** URL scheme → product for env/config values, keyed lowercase (PLAN.md 2.3). */
export function loadUrlSchemes(): Map<string, string> {
  // Cached like the other loaders — the env detector consults this per LINE.
  cachedUrlSchemes ??= new Map(
    Object.entries(loadProductsFile().url_schemes).map(([scheme, product]) => [scheme.toLowerCase(), product]),
  );
  return cachedUrlSchemes;
}

let cachedEmbeddingDims: Map<string, number> | undefined;

/** Embedding-model name → dimensionality, for the vectorScale signal (PLAN.md 4.3). */
export function loadEmbeddingDims(): Map<string, number> {
  cachedEmbeddingDims ??= new Map(Object.entries(loadProductsFile().embedding_dims));
  return cachedEmbeddingDims;
}

let cachedCallPatterns: CallPatternRule[] | undefined;

/** Product-specific import scopes and command patterns for the usage harvester. */
export function loadCallPatterns(): CallPatternRule[] {
  if (cachedCallPatterns) return cachedCallPatterns;
  const file = loadRulesFile('call-patterns.yaml', CallPatternsFileSchema);
  cachedCallPatterns = Object.entries(file.products).map(([product, def]) => ({
    product,
    libraries: def.libraries.map((library) => library.toLowerCase()),
    patterns: def.patterns.map((pattern) => new RegExp(pattern, 'g')),
    constructors: new Set(def.constructors.map((c) => c.toLowerCase())),
  }));
  return cachedCallPatterns;
}

let cachedRoles: Map<string, RoleRule> | undefined;

/** Deterministic product and command-mix rules for the Stage 3 role classifier. */
export function loadRoleRules(): Map<string, RoleRule> {
  if (cachedRoles) return cachedRoles;
  const file = loadRulesFile('roles.yaml', RolesFileSchema);
  cachedRoles = new Map(
    Object.entries(file.products).map(([product, rule]) => [
      product,
      {
        product,
        ...(rule.fixed_role ? { fixedRole: rule.fixed_role } : {}),
        ...(rule.cache
          ? {
              cache: {
                commands: rule.cache.commands.map((command) => command.toLowerCase()),
                minShare: rule.cache.min_share,
                mixedConfidence: rule.cache.mixed_confidence,
              },
            }
          : {}),
        ...(rule.queue
          ? {
              queue: {
                libraries: rule.queue.libraries.map((library) => library.toLowerCase()),
                commands: rule.queue.commands.map((command) => command.toLowerCase()),
              },
            }
          : {}),
        ...(rule.command_mix
          ? {
              commandMix: {
                plainKv: new Set(rule.command_mix.plain_kv.map((c) => c.toLowerCase())),
                nativeStructure: new Set(rule.command_mix.native_structure.map((c) => c.toLowerCase())),
              },
            }
          : {}),
      } satisfies RoleRule,
    ],
  ));
  return cachedRoles;
}

let cachedMappings: Map<StoreCategory, MappingOption[]> | undefined;

/** Ordered Postgres-native migration options per StoreCategory — PLAN.md 4.1. */
export function loadMappings(): Map<StoreCategory, MappingOption[]> {
  if (cachedMappings) return cachedMappings;
  const file = loadRulesFile('mappings.yaml', MappingsFileSchema);
  const map = new Map<StoreCategory, MappingOption[]>();
  for (const [category, options] of Object.entries(file.mappings)) {
    const categoryResult = StoreCategorySchema.safeParse(category);
    if (!categoryResult.success) {
      throw new AdvisorError({
        problem: `rules/mappings.yaml has an unknown category \`${category}\``,
        cause: 'every top-level key under `mappings:` must be a valid StoreCategory',
        fix: 'this is a packaging bug — please file an issue',
        docsAnchor: 'troubleshooting',
      });
    }
    map.set(
      categoryResult.data,
      options.map((o) => ({
        name: o.name,
        label: o.label,
        extensionRequired: { required: o.extension_required.required, name: o.extension_required.name },
        maturity: o.maturity,
        operationalCost: o.operational_cost,
        dataMigration: o.data_migration,
        rollback: o.rollback,
      })),
    );
  }
  cachedMappings = map;
  return cachedMappings;
}

/** Postgres-native options for one StoreCategory, in recommendation order. */
export function mappingsFor(category: StoreCategory): MappingOption[] {
  return loadMappings().get(category) ?? [];
}

export interface ThresholdSource {
  url: string;
  grade: 'vendor' | 'independent' | 'reproduced';
  note?: string;
}

export interface ThresholdBand {
  decision: 'consolidate' | 'keep' | 'borderline';
  min?: number;
  max?: number;
  mappingOption?: string;
}

interface ThresholdCommon {
  id: string;
  category: StoreCategory;
  variable: string;
  description: string;
  observability: 'static' | 'estimated' | 'live-only';
  liveSource: 'pg-stats' | 'incumbent-only' | 'none';
  liveSourceNote?: string;
  unit?: string;
  weight?: number;
  sources: ThresholdSource[];
  assumptionId?: string;
  failureMode?: string;
  note?: string;
  /** Set by applyThresholdOverride — the cited source no longer applies. */
  overridden?: boolean;
}

/** One threshold from PLAN.md §1, encoded as data — PLAN.md 4.2. */
export type ThresholdRule =
  | (ThresholdCommon & { comparison: 'bands'; bands: ThresholdBand[] })
  | (ThresholdCommon & {
      comparison: 'gate';
      gateDecision: 'consolidate' | 'keep';
      gateSignals: string[];
      mappingOption?: string;
    })
  | (ThresholdCommon & { comparison: 'reference'; value: number });

export interface ScoringConfig {
  baseScore: number;
  qualitativeGateMaxFitScore: number;
  defaultWeight: number;
}

/** A general-estimation-model input (PLAN.md 4.2) — not itself a decision boundary. */
export interface ConstantEntry {
  description: string;
  observability: 'static' | 'estimated' | 'live-only';
  value: number | { min: number; max: number };
  unit: string;
  assumptionId?: string;
  sources: ThresholdSource[];
}

function toThresholdSources(sources: z.infer<typeof ThresholdSourceSchema>[]): ThresholdSource[] {
  return sources.map((s) => ({ url: s.url, grade: s.grade, ...(s.note !== undefined ? { note: s.note } : {}) }));
}

let cachedThresholdsFile: z.infer<typeof ThresholdsFileSchema> | undefined;

function loadThresholdsFile(): z.infer<typeof ThresholdsFileSchema> {
  cachedThresholdsFile ??= loadRulesFile('thresholds.yaml', ThresholdsFileSchema);
  return cachedThresholdsFile;
}

let cachedThresholds: Map<string, ThresholdRule> | undefined;

/**
 * Every threshold from PLAN.md §1, keyed by id. Ids are `<category>.<variable>`
 * by construction (validated at load), so this map serves both the
 * by-id and the (category, variable) lookup PLAN.md 4.2 requires.
 */
export function loadThresholds(): Map<string, ThresholdRule> {
  if (cachedThresholds) return cachedThresholds;
  const file = loadThresholdsFile();
  const map = new Map<string, ThresholdRule>();
  for (const raw of file.thresholds) {
    const expectedId = `${raw.category}.${raw.variable}`;
    if (raw.id !== expectedId) {
      throw new AdvisorError({
        problem: `rules/thresholds.yaml entry \`${raw.id}\` doesn't match its category+variable (\`${expectedId}\`)`,
        cause: 'threshold ids must be exactly `<category>.<variable-slug>` so id and (category, variable) lookups agree',
        fix: 'this is a packaging bug — please file an issue',
        docsAnchor: 'troubleshooting',
      });
    }
    if (map.has(raw.id)) {
      throw new AdvisorError({
        problem: `rules/thresholds.yaml has a duplicate threshold id \`${raw.id}\``,
        fix: 'this is a packaging bug — please file an issue',
        docsAnchor: 'troubleshooting',
      });
    }

    const common: ThresholdCommon = {
      id: raw.id,
      category: raw.category,
      variable: raw.variable,
      description: raw.description,
      observability: raw.observability,
      liveSource: raw.live_source,
      ...(raw.live_source_note !== undefined ? { liveSourceNote: raw.live_source_note } : {}),
      ...(raw.unit !== undefined ? { unit: raw.unit } : {}),
      ...(raw.weight !== undefined ? { weight: raw.weight } : {}),
      sources: toThresholdSources(raw.sources),
      ...(raw.assumption_id !== undefined ? { assumptionId: raw.assumption_id } : {}),
      ...(raw.failure_mode !== undefined ? { failureMode: raw.failure_mode } : {}),
      ...(raw.note !== undefined ? { note: raw.note } : {}),
    };

    let rule: ThresholdRule;
    if (raw.comparison === 'bands') {
      rule = {
        ...common,
        comparison: 'bands',
        bands: raw.bands.map((b) => ({
          decision: b.decision,
          ...(b.min !== undefined ? { min: b.min } : {}),
          ...(b.max !== undefined ? { max: b.max } : {}),
          ...(b.mapping_option !== undefined ? { mappingOption: b.mapping_option } : {}),
        })),
      };
    } else if (raw.comparison === 'gate') {
      rule = {
        ...common,
        comparison: 'gate',
        gateDecision: raw.gate_decision,
        gateSignals: raw.gate_signals,
        ...(raw.mapping_option !== undefined ? { mappingOption: raw.mapping_option } : {}),
      };
    } else {
      rule = { ...common, comparison: 'reference', value: raw.value };
    }
    map.set(raw.id, rule);
  }
  cachedThresholds = map;
  return cachedThresholds;
}

export interface ThresholdOverrideOutcome {
  rule: ThresholdRule;
  applied: boolean;
  unsupported: boolean;
}

/**
 * Applies a `.postgres-advisor.yaml` `threshold_overrides` entry. The single
 * override number replaces the threshold's headline numeric value: for a
 * `bands` comparison that's the first band's boundary (the number PLAN.md §1
 * states in prose, e.g. queue's "< 1,000 msgs/sec"); for `reference` it's the
 * cited figure itself. `gate` thresholds have no numeric value to override.
 */
export function applyThresholdOverride(
  rule: ThresholdRule,
  overrideValue: number | undefined,
): ThresholdOverrideOutcome {
  if (overrideValue === undefined) return { rule, applied: false, unsupported: false };
  if (rule.comparison === 'reference') {
    return { rule: { ...rule, value: overrideValue, overridden: true }, applied: true, unsupported: false };
  }
  if (rule.comparison === 'bands' && rule.bands.length > 0) {
    const [first, ...rest] = rule.bands as [ThresholdBand, ...ThresholdBand[]];
    if (first.max !== undefined) {
      // Moving the first band's upper boundary must drag any band that was
      // contiguous with it (min === old max) along, or the bands overlap and
      // the report renders contradictory ranges.
      const oldMax = first.max;
      const shifted = rest.map((b) => (b.min === oldMax ? { ...b, min: overrideValue } : b));
      return {
        rule: { ...rule, bands: [{ ...first, max: overrideValue }, ...shifted], overridden: true },
        applied: true,
        unsupported: false,
      };
    }
    if (first.min !== undefined) {
      return {
        rule: { ...rule, bands: [{ ...first, min: overrideValue }, ...rest], overridden: true },
        applied: true,
        unsupported: false,
      };
    }
    return { rule: { ...rule, overridden: true }, applied: true, unsupported: false };
  }
  return { rule, applied: false, unsupported: true };
}

/** Lookup by stable id (e.g. `queue.est-peak-msgs-sec`), or undefined if unknown. */
export function thresholdById(id: string): ThresholdRule | undefined {
  return loadThresholds().get(id);
}

/** Lookup by (category, variable) — always equivalent to `thresholdById(\`${category}.${variable}\`)`. */
export function thresholdByCategoryVariable(category: StoreCategory, variable: string): ThresholdRule | undefined {
  return loadThresholds().get(`${category}.${variable}`);
}

/** All thresholds for one StoreCategory, in file order. */
export function thresholdsByCategory(category: StoreCategory): ThresholdRule[] {
  return [...loadThresholds().values()].filter((t) => t.category === category);
}

/** Verdict-engine constants (fitScore base/gate/weights) — PLAN.md 5.1's no-literals source. */
export function loadScoringConfig(): ScoringConfig {
  const file = loadThresholdsFile();
  return {
    baseScore: file.scoring.base_score,
    qualitativeGateMaxFitScore: file.scoring.qualitative_gate_max_fit_score,
    defaultWeight: file.scoring.default_weight,
  };
}

let cachedConstants: Map<string, ConstantEntry> | undefined;

/** General-estimation-model inputs (e.g. `general.est-peak-jobs-per-worker-slot`, [A1]). */
export function loadConstants(): Map<string, ConstantEntry> {
  if (cachedConstants) return cachedConstants;
  const file = loadThresholdsFile();
  cachedConstants = new Map(
    Object.entries(file.constants).map(([id, c]) => [
      id,
      {
        description: c.description,
        observability: c.observability,
        value: c.value,
        unit: c.unit,
        ...(c.assumption_id !== undefined ? { assumptionId: c.assumption_id } : {}),
        sources: toThresholdSources(c.sources),
      } satisfies ConstantEntry,
    ]),
  );
  return cachedConstants;
}

/** Category seed for a product from the products table, or ['unknown']. */
export function productCategories(product: string): StoreCategory[] {
  const def = loadProductsFile().products[product];
  return def ? [...def.category] : ['unknown'];
}

/** Match a container image reference to a product, or null. */
export function matchImage(image: string): ProductRule | null {
  for (const rule of loadProducts()) {
    if (rule.imagePatterns.some((re) => re.test(image))) return rule;
  }
  return null;
}
