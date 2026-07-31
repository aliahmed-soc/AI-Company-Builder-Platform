// core/policy — module public index (ACBP-P6-001c; CDR-066 §6). Cross-module imports go through this index
// (spec rule 10).
export {
  evaluateCompanyPolicy,
  initializeCompanyPolicy,
  toPolicyGateAnswer,
  EVALUATION_POINTS,
  NO_USABLE_POLICY_REASONS,
  // ACBP-P6-006. Listed here because this index enumerates rather than re-exporting `*`: a use case missing from it
  // compiles, tests fine in place, and is reachable by nobody — which is exactly how P6-003 shipped an approval
  // service with no consumers.
  setCompanyAutonomyLevel,
  readCompanyAutonomy,
  AUTONOMY_REFUSAL_REASONS,
} from './policy-service.js';
export type {
  EvaluationPoint,
  NoUsablePolicyReason,
  PolicyServiceOptions,
  EvaluateCompanyPolicyParams,
  EvaluateCompanyPolicyResult,
  InitializeCompanyPolicyParams,
  InitializeCompanyPolicyResult,
  AutonomyRefusalReason,
  SetCompanyAutonomyLevelParams,
  SetCompanyAutonomyLevelResult,
  AutonomyLevelOption,
  ReadCompanyAutonomyResult,
} from './policy-service.js';
