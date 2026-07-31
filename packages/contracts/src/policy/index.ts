// contracts/policy — module public index (ACBP-P6-001a; CDR-066). Cross-module imports go through this index
// (spec rule 10).
export {
  POLICY_DECISIONS,
  MOST_RESTRICTIVE_POLICY_DECISION,
  isPolicyDecision,
  policyRank,
  resolvePolicyDecision,
  combinePolicyDecisions,
  combinePolicyVerdicts,
} from './decision.js';
export type { PolicyDecision, PolicyVerdict } from './decision.js';
export { POLICY_DIMENSIONS, TRUST_CRITICAL_DIMENSIONS, FACT_PROVENANCES, POLICY_CONDITIONS, DEFAULT_NEW_COMPANY_POLICY, evaluatePolicy } from './evaluate.js';
export type { PolicyDimension, FactProvenance, PolicyCondition, ProvenancedFact, PolicyObservations, PolicyRule, PolicyRuleSet, PolicyEvaluation } from './evaluate.js';
export {
  AUTONOMY_LEVELS,
  MVP_AUTONOMY_LEVELS,
  MOST_RESTRICTIVE_AUTONOMY_LEVEL,
  DEFAULT_NEW_COMPANY_AUTONOMY_LEVEL,
  AUTONOMY_LEVEL_CONSEQUENCES,
  isAutonomyLevel,
  isMvpAutonomyLevel,
  resolveAutonomyLevel,
  autonomyLevelRules,
} from './autonomy.js';
export type { AutonomyLevel, MvpAutonomyLevel } from './autonomy.js';
