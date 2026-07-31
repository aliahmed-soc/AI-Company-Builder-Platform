// contracts/approvals — module public index (ACBP-P6-003a; CDR-068). Cross-module imports go through this index
// (spec rule 10).
export {
  APPROVAL_SCOPES,
  MVP_APPROVAL_SCOPES,
  REVERSIBILITIES,
  APPROVAL_REQUEST_CONTENT_FIELDS,
  APPROVAL_REQUEST_REQUIRED_INPUTS,
  DERIVED_APPROVAL_REQUEST_FIELDS,
  isApprovalScope,
  isMvpApprovalScope,
  reversibilityOf,
  buildApprovalRequest,
} from './request.js';
export type { ApprovalScope, Reversibility, ApprovalRequestContentField, ApprovalRequestInput, ApprovalRequestContent, BuildApprovalRequestResult } from './request.js';
export { APPROVAL_DECISION_PATHS, APPROVAL_DECIDER_TYPES, isApprovalDecisionPath, isApprovalDeciderType, parseApprovalDecision, authorizesExecution } from './decision.js';
export type { ApprovalDecisionPath, ApprovalDeciderType, ApprovalDecider, ApprovalDecisionInput, ApprovalDecision, ParseApprovalDecisionResult } from './decision.js';
// Binding, expiry and usability (ACBP-P6-004; CDR-069). Exported from the index at the same moment they are
// written — P6-003's service was invisible outside its own package for a whole ticket because this step was
// missed, and every guard in it survived mutation as a result.
export { BINDING_NORMALIZATION_VERSION, bindingMaterial, bindingMatches, isExpired, approvalUsability } from './binding.js';
export type { ApprovalBindingInput, PayloadBinding, ApprovalUsabilityState, ApprovalUnusableReason, ApprovalUsability } from './binding.js';
