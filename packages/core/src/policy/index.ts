// core/policy — module public index (ACBP-P6-001c; CDR-066 §6). Cross-module imports go through this index
// (spec rule 10).
export { evaluateCompanyPolicy, initializeCompanyPolicy, toPolicyGateKind, EVALUATION_POINTS, NO_USABLE_POLICY_REASONS } from './policy-service.js';
export type {
  EvaluationPoint,
  NoUsablePolicyReason,
  PolicyServiceOptions,
  EvaluateCompanyPolicyParams,
  EvaluateCompanyPolicyResult,
  InitializeCompanyPolicyParams,
  InitializeCompanyPolicyResult,
} from './policy-service.js';