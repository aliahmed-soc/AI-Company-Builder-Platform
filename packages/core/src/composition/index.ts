// @acbp/core/composition — module public index. The composition layer wires concrete provider adapters
// + database + use cases (ACBP-P1-002 Slice 3). Imported by application composition roots (apps/web).
export * from './clerk-identity.js';
export {
  createModelGateway,
  type ModelGatewayCompositionConfig,
  type CallModelOptions,
  type BoundModelGateway,
} from './model-gateway.js';
export { interviewOutputValidator } from './interview-gateway.js';
export { understandingOutputValidator } from './understanding-gateway.js';
export { strategyOutputValidator, strategyRecommendationValidator } from './strategy-gateway.js';
