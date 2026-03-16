/**
 * n8n-a2e - Agent-to-n8n Workflow Composer
 *
 * Public API exports for library usage.
 */

// Types
export * from './types/index.js';

// Storage
export { Store } from './storage/index.js';
export type { StoreConfig } from './storage/index.js';

// Extractor
export { extractFromInstance, extractCredentials, rawToNodeDefinition } from './extractor/index.js';

// Search
export { SearchEngine } from './search/index.js';
export type { SearchResult } from './search/index.js';

// Composer
export { composeWorkflow, validateWorkflow, matchCredentials, fetchCredentials } from './composer/index.js';
export type { ComposerNode, ComposerConnection, ComposeOptions, ValidationResult, ValidationError, CredentialBinding, CredentialMatchResult } from './composer/index.js';

// Client
export { N8nClient } from './client/index.js';
export type { N8nClientConfig } from './client/index.js';

// Agent
export { Orchestrator } from './agent/index.js';
export type { AgentConfig, RecallResult, WorkflowPlan, WorkflowStep, StepConnection, DeployResult } from './agent/index.js';

// LLM
export { ClaudeProvider, OpenAiProvider, OllamaProvider, createProvider, WorkflowAgent } from './llm/index.js';
export type { LlmProvider, LlmMessage, LlmResponse, LlmOptions, ProviderType, AgentSession, AgentResponse } from './llm/index.js';

// Seeds
export { seedPatterns } from './seeds/index.js';

// MCP
export { McpServer, startMcpServer } from './mcp/index.js';

// Eval
export { ModelEvaluator } from './eval/index.js';
export type { EvalGoal, EvalModelConfig, EvalRunResult, EvalSummary, EvalReport } from './eval/index.js';

// Autonomous
export { AutonomousAgent, CircuitBreaker } from './autonomous/index.js';
export type { AutonomousConfig, AutonomousResult, AgentEvent } from './autonomous/index.js';
export { sanitizeSecrets, resolveSecrets, sanitizeParameters } from './autonomous/index.js';
export { normalizeResponse, extractBestJson } from './autonomous/index.js';
export type { NormalizeResult } from './autonomous/index.js';
export { saveWorkflowSkill, saveWorkflowError, recallWorkflowSkills, markPatternSuccess, markPatternFailure } from './autonomous/index.js';
