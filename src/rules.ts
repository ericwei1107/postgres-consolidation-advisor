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

const ProductsFileSchema = z.object({
  products: z.record(
    z.string(),
    z.object({
      category: z.array(StoreCategorySchema).min(1),
      image_patterns: z.array(z.string()).default([]),
    }),
  ),
});

export interface ProductRule {
  product: string;
  category: StoreCategory[];
  imagePatterns: RegExp[];
}

let cachedProducts: ProductRule[] | undefined;

export function loadProducts(): ProductRule[] {
  if (cachedProducts) return cachedProducts;
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
  cachedProducts = Object.entries(result.data.products).map(([product, def]) => ({
    product,
    category: def.category,
    imagePatterns: def.image_patterns.map((p) => new RegExp(p, 'i')),
  }));
  return cachedProducts;
}

/** Match a container image reference to a product, or null. */
export function matchImage(image: string): ProductRule | null {
  for (const rule of loadProducts()) {
    if (rule.imagePatterns.some((re) => re.test(image))) return rule;
  }
  return null;
}
