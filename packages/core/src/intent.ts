/**
 * Lightweight, deterministic heuristic to decide whether a user request is
 * "clearly vague" — i.e. underspecified enough that leading with a clarifying
 * question is likely to save wasted work. This is intentionally conservative
 * (biased toward "not vague") so specific requests are never gated: a false
 * negative just means we behave as before, while a false positive costs the
 * user an unnecessary question. No LLM call, no state.
 */

/** Signals that the request names a concrete target → treat it as specific. */
function hasConcreteTarget(t: string): boolean {
  return (
    /\.[a-z]{1,6}\b/i.test(t) || // file extension / path (e.g. auth.ts, README.md)
    /`[^`]+`/.test(t) || // backticked token
    /```/.test(t) || // code fence
    /https?:\/\//i.test(t) || // URL
    /[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*/.test(t) || // camelCase identifier
    /\b[a-z0-9]+_[a-z0-9]+\b/i.test(t) || // snake_case identifier
    /\//.test(t) // a path separator
  );
}

/** English "vague verb + vague object" phrasings (e.g. "improve it", "fix this"). */
const VAGUE_EN =
  /\b(fix|improve|optimi[sz]e|enhance|refactor|clean\s*up|tidy|tweak|polish|redo|rework|sort|update|change)\b[^.?!]*\b(it|this|that|these|those|things?|stuff|everything|code|app|project|program|repo)\b/i;

/** Whole-prompt generic asks with no object at all. */
const GENERIC_EN =
  /^(help(\s+me)?|do\s+something|make\s+it\s+(better|work|nicer|faster|cleaner)|any\s+ideas?|what('?s|\s+is)\s+next|improve(\s+(this|it))?|optimi[sz]e(\s+(this|it))?|fix(\s+(it|this))?|clean\s*up|refactor)\s*[.!?]*$/i;

/** Chinese vague verbs, usually paired with 一下/这个/代码 etc. */
const VAGUE_ZH =
  /(优化|改进|完善|重构|整理|润色|美化|重写|修一?下|改一?下|搞一?下|弄一?下|处理一?下|看一?下|看看|帮我(弄|搞|改|优化|处理|完善|重构))/;

/**
 * Return true when a request is clearly vague/underspecified. Requires BOTH a
 * vague marker AND the absence of any concrete target, and only fires on short
 * requests (long prompts usually carry enough detail to act on).
 */
export function isVagueRequest(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length === 0) return false;
  if (hasConcreteTarget(t)) return false;

  const cjkCount = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  const isShort = cjkCount > 0 ? t.length <= 24 : wordCount <= 10;
  if (!isShort) return false;

  if (GENERIC_EN.test(t)) return true;
  if (VAGUE_EN.test(t)) return true;
  if (cjkCount > 0 && VAGUE_ZH.test(t)) return true;
  return false;
}
