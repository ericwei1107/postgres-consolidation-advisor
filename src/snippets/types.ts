/**
 * Per-template render contexts (PLAN.md 6.1). Every field is required —
 * Handlebars templates are compiled `strict: true` (src/snippets/templates.ts),
 * so a missing context field throws at render time instead of silently
 * rendering an empty string.
 */

export interface CacheUnloggedTableContext {
  tableName: string;
  ttlSeconds: number;
}

export interface QueueContext {
  queueName: string;
}

export interface QueueTsContext extends QueueContext {
  /** PascalCase suffix for generated function names, e.g. "orders" -> "Orders". */
  pascalName: string;
}

export interface MongoJsonbContext {
  tableName: string;
  /** Hot fields promoted to real columns (frequent field-level mutators, PLAN.md §1.4). */
  hotColumns: { name: string; sqlType: string }[];
  /** The remaining fields, kept in the JSONB blob. */
  coldColumn: string;
  ginIndexName: string;
}

export interface SearchTsvectorContext {
  tableName: string;
  textColumns: string[];
  tsvectorColumn: string;
  indexName: string;
}

export interface SearchParadeDbContext {
  tableName: string;
  textColumns: string[];
  indexName: string;
}

export interface VectorContext {
  tableName: string;
  dims: number;
  indexName: string;
}

export interface TimeseriesContext {
  tableName: string;
  timeColumn: string;
}

export interface GraphRecursiveCteContext {
  tableName: string;
  cteName: string;
  maxDepth: number;
}
