// Autonomous Workflow Agent
export { AutonomousAgent } from './autonomous-agent.js';
export type { AutonomousConfig, AutonomousResult, AgentEvent } from './autonomous-agent.js';

// Circuit Breaker
export { CircuitBreaker } from './circuit-breaker.js';
export type { CircuitBreakerResult } from './circuit-breaker.js';

// Workflow Skills (learning layer)
export {
  saveWorkflowSkill,
  saveWorkflowError,
  recallWorkflowSkills,
  markPatternSuccess,
  markPatternFailure,
  saveExecutionFix,
} from './workflow-skills.js';

// Plan Normalization
export { normalizePlan } from './normalize-plan.js';
export type { NormalizePlanResult } from './normalize-plan.js';

// Response Normalization
export { normalizeResponse, extractBestJson } from './normalize.js';
export type { NormalizeResult } from './normalize.js';

// Secret Sanitization
export {
  sanitizeSecrets,
  resolveSecrets,
  isSensitiveParam,
  sanitizeParameters,
} from './sanitize.js';
