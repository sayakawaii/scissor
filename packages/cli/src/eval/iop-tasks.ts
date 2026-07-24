/**
 * Scheme A (OPEN_ITEMS §7d, option D): retrieval QA on a real, large codebase —
 * the `iop-toolkit` backend (Go, ~190 files across nested service/ packages).
 * Each task asks a question whose answer is a precise token that lives in one
 * non-obvious file, so answering rewards repo-map/retrieve; a near-naked harness
 * must blind-read/grep the tree. Read-only (no toolchain needed), scored by
 * matching the answer text against known tokens.
 *
 * These tasks depend on an external source tree, so they are NOT part of the
 * hermetic default eval/bench suite (the pre-push gate). They are reachable only
 * by id (via resolveTasks), e.g. `scissor ab --candidate bare -t iop-... `.
 * The source is a cached copy; point SCISSOR_IOP_BACKEND at it (default:
 * ~/.scissor/iop-cache/backend).
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvalTask } from "./tasks.js";

/** Resolve the cached backend source tree used by the IOP retrieval tasks. */
export function iopBackendDir(): string {
  return (
    process.env.SCISSOR_IOP_BACKEND ?? path.join(os.homedir(), ".scissor", "iop-cache", "backend")
  );
}

async function copyBackendInto(dir: string): Promise<void> {
  const src = iopBackendDir();
  try {
    await fs.access(src);
  } catch {
    throw new Error(
      `IOP backend source not found at ${src}. Set SCISSOR_IOP_BACKEND to a cached checkout ` +
        `(see OPEN_ITEMS §7d, scheme A).`,
    );
  }
  await fs.cp(src, dir, { recursive: true });
}

/**
 * Case-insensitive containment: passes only when the answer contains EVERY
 * needle. Pure/deterministic, so it is unit-testable without the source tree.
 */
export function answerContains(
  text: string,
  needles: string[],
): { pass: boolean; missing: string[] } {
  const hay = (text ?? "").toLowerCase();
  const missing = needles.filter((n) => !hay.includes(n.toLowerCase()));
  return { pass: missing.length === 0, missing };
}

function qa(id: string, prompt: string, needles: string[], detail: string): EvalTask {
  return {
    id,
    title: prompt.length > 64 ? prompt.slice(0, 61) + "..." : prompt,
    tags: ["retrieve", "qa", "real", "iop"],
    timeoutMs: 180_000,
    // Each answer lives in exactly one file; a lean policy inspects ~1 file.
    oracle: { files: 1 },
    setup: copyBackendInto,
    prompt,
    async check(_dir, finalText) {
      const { pass, missing } = answerContains(finalText, needles);
      return pass
        ? { pass: true, detail }
        : {
            pass: false,
            detail: `missing ${JSON.stringify(missing)} in answer: ${finalText.slice(0, 100)}`,
          };
    },
  };
}

/**
 * Retrieval-QA tasks over the real backend tree. Answers are exact tokens found
 * in the source; the harder ones require locating the right file among ~190.
 */
export const IOP_TASKS: EvalTask[] = [
  qa(
    "iop-module-name",
    "This repository is a Go backend service. What is the module name declared in its go.mod? Answer with just the module path.",
    ["omciAnalyzer"],
    "module name omciAnalyzer (go.mod)",
  ),
  qa(
    "iop-kafka-client",
    "Which third-party Go library does this backend use as its Kafka client? Answer with the import path.",
    ["github.com/IBM/sarama"],
    "Kafka client github.com/IBM/sarama (go.mod)",
  ),
  qa(
    "iop-web-framework",
    "Which HTTP web framework does this backend build its REST API on? Answer with the library import path.",
    ["gin-gonic/gin"],
    "web framework gin-gonic/gin (go.mod)",
  ),
  qa(
    "iop-library-search-handler",
    "Which Go controller/handler function is registered for the HTTP route POST /api/library/search? Answer with the function name.",
    ["LibrarySearch"],
    "handler LibrarySearch (routers/libraryRouter.go)",
  ),
  qa(
    "iop-omcianalyzer-request-handler",
    "Which Go controller/handler function is registered for the HTTP route POST /api/omcianalyzer/request? Answer with the function name.",
    ["OmciAnalyzerRequest"],
    "handler OmciAnalyzerRequest (routers/omcianalyzerRouter.go)",
  ),
  qa(
    "iop-sequencetracer-prefix",
    "What is the route group prefix (base path) for the sequence-tracer API endpoints? Answer with the path.",
    ["/api/sequencetracer"],
    "route group /api/sequencetracer (routers/sequenceTracerRouter.go)",
  ),
  qa(
    "iop-kafka-topic-keys",
    "The backend config defines two Kafka topic settings for talking to the collector. What are the two YAML config keys (as declared in the config struct tags)? List both.",
    ["topicCollectorRequest", "topicCollectorResponse"],
    "both topic keys (global/conf.go)",
  ),
  qa(
    "iop-evtocd-deshape-file",
    "Which Go source file implements EVTOCD deshaping? Answer with the file name.",
    ["evtocdDeshape.go"],
    "evtocdDeshape.go (service/omciDeshape)",
  ),
];
