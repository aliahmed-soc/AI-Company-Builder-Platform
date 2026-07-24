// core/model — model gateway public index (ACBP-P2-003; ADR-011; CDR-026). Cross-module imports go through here.
export {
  callModel,
  type ModelGatewayDeps,
  type ResolvedProvider,
  type GatewayConfig,
  type CostInput,
  type PolicyDecision,
  type OutputValidation,
  type OutputValidationOk,
  type OutputValidationErr,
} from './model-gateway.js';
