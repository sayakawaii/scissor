/**
 * OaK-inspired experience layer (doc: docs/agent-design/oak-inspired-agent-design.md).
 *
 * Observe-only, UI-agnostic: normalized `(state, option, outcome)` events plus
 * deterministic offline aggregation into option utility. Nothing here influences
 * agent decisions in this slice (doc §8: trace normalization + offline report).
 */
export * from "./types.js";
export * from "./features.js";
export * from "./model.js";
export * from "./report.js";
export * from "./advisor.js";
export * from "./router.js";
export * from "./curator.js";
export * from "./estimator.js";
