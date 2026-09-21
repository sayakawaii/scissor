/**
 * Parse a JSON string into a plain object, tolerating the loose output models
 * sometimes emit for tool-call arguments. Returns {} for empty input, invalid
 * JSON, or any non-object (including arrays), so callers always get a safe
 * Record. Shared by the Anthropic and OpenAI-compatible providers.
 */
export function safeParseJsonObject(raw: string): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
