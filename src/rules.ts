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
});

type ProductsFile = z.infer<typeof ProductsFileSchema>;

const CallPatternsFileSchema = z.object({
  products: z.record(
    z.string(),
    z.object({
      libraries: z.array(z.string()).min(1),
      patterns: z.array(z.string()).min(1),
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
}

let cachedFile: ProductsFile | undefined;

function loadProductsFile(): ProductsFile {
  if (cachedFile) return cachedFile;
  const file = join(rulesDir(), 'products.yaml');
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(file, 'utf8'), { maxAliasCount: 100 });
  } catch (e) {
    throw new AdvisorError({
      problem: 'rules/products.yaml is not valid YAML',
      cause: e instanceof Error ? e.message : String(e),
      fix: 'this is a packaging bug — please file an issue',
      docsAnchor: 'troubleshooting',
    });
  }
  const result = ProductsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new AdvisorError({
      problem: `rules/products.yaml is invalid at \`${issue?.path.join('.') ?? '(root)'}\``,
      cause: issue?.message ?? 'schema validation failed',
      fix: 'this is a packaging bug — please file an issue',
      docsAnchor: 'troubleshooting',
    });
  }
  cachedFile = result.data;
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

/** URL scheme → product for env/config values, keyed lowercase (PLAN.md 2.3). */
export function loadUrlSchemes(): Map<string, string> {
  return new Map(
    Object.entries(loadProductsFile().url_schemes).map(([scheme, product]) => [scheme.toLowerCase(), product]),
  );
}

let cachedCallPatterns: CallPatternRule[] | undefined;

/** Product-specific import scopes and command patterns for the usage harvester. */
export function loadCallPatterns(): CallPatternRule[] {
  if (cachedCallPatterns) return cachedCallPatterns;
  const file = join(rulesDir(), 'call-patterns.yaml');
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(file, 'utf8'), { maxAliasCount: 100 });
  } catch (e) {
    throw new AdvisorError({
      problem: 'rules/call-patterns.yaml is not valid YAML',
      cause: e instanceof Error ? e.message : String(e),
      fix: 'this is a packaging bug — please file an issue',
      docsAnchor: 'troubleshooting',
    });
  }
  const result = CallPatternsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new AdvisorError({
      problem: `rules/call-patterns.yaml is invalid at \`${issue?.path.join('.') ?? '(root)'}\``,
      cause: issue?.message ?? 'schema validation failed',
      fix: 'this is a packaging bug — please file an issue',
      docsAnchor: 'troubleshooting',
    });
  }
  cachedCallPatterns = Object.entries(result.data.products).map(([product, def]) => ({
    product,
    libraries: def.libraries.map((library) => library.toLowerCase()),
    patterns: def.patterns.map((pattern) => new RegExp(pattern, 'g')),
  }));
  return cachedCallPatterns;
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
