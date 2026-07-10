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
