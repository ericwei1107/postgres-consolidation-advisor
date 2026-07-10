export * from './types.js';
export { analyze, type AnalyzeOptions } from './analyze.js';
export { loadConfig, AdvisorConfigSchema, type AdvisorConfig, CONFIG_FILENAME } from './config.js';
export { AdvisorError, EXIT_OK, EXIT_FAIL_ON, EXIT_ERROR } from './errors.js';
export { loadMappings, mappingsFor, MAPPED_CATEGORIES, type MappingOption } from './rules.js';
export {
  loadThresholds,
  thresholdById,
  thresholdByCategoryVariable,
  thresholdsByCategory,
  loadScoringConfig,
  loadConstants,
  type ThresholdRule,
  type ThresholdBand,
  type ThresholdSource,
  type ScoringConfig,
  type ConstantEntry,
} from './rules.js';
export { explainThreshold, listThresholds } from './explain.js';
export {
  queueThroughput,
  cacheCommandMix,
  cacheFanOut,
  docSizeEstimate,
  docUpdateShape,
  vectorScale,
  searchFeatures,
  traversalShape,
  olapPresenceSignals,
  isSignalRange,
  type Signal,
  type SignalRange,
  type Observability,
} from './signals/index.js';
export { computeVerdict, computeVerdicts, buildVerdictRules, collectSignals, type VerdictRules } from './scoring/index.js';
export { renderRationale, type RationaleContext } from './scoring/rationale.js';
export { renderTemplate, renderTemplateFile, templatesDir, TEMPLATE_FILES, type TemplateId } from './snippets/templates.js';
export { validateSql } from './snippets/validateSql.js';
export { astShapeEqual } from './snippets/astShape.js';
export { tailorSnippet, type TailorOptions, type TailorResult } from './snippets/tailor.js';
export type {
  CacheUnloggedTableContext,
  QueueContext,
  QueueTsContext,
  MongoJsonbContext,
  SearchTsvectorContext,
  SearchParadeDbContext,
  VectorContext,
  TimeseriesContext,
  GraphRecursiveCteContext,
} from './snippets/types.js';
