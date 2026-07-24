/**
 * Deterministic test for Scheme A (OPEN_ITEMS §7d): the IOP retrieval-QA task
 * set. Verifies the pure scoring helper (answerContains — case-insensitive,
 * all-of semantics, missing report) and that each task's check() accepts a
 * correct answer and rejects a wrong one. check() never touches the filesystem,
 * so this runs without the external source tree. resolveTasks must surface IOP
 * tasks only when named by id, never in the default suite.
 *
 * Run: node --import tsx scripts/test-iop.mts
 */
import assert from "node:assert/strict";
import { answerContains, IOP_TASKS } from "../packages/cli/src/eval/iop-tasks.js";
import { resolveTasks } from "../packages/cli/src/eval/bench-tasks.js";

// --- answerContains: case-insensitive, all-of, reports what's missing ---
assert.deepEqual(answerContains("the module is omciAnalyzer", ["omciAnalyzer"]), {
  pass: true,
  missing: [],
});
assert.deepEqual(answerContains("MODULE = OMCIANALYZER", ["omciAnalyzer"]), {
  pass: true,
  missing: [],
}, "case-insensitive match");
assert.deepEqual(
  answerContains("only one key: topicCollectorRequest", [
    "topicCollectorRequest",
    "topicCollectorResponse",
  ]),
  { pass: false, missing: ["topicCollectorResponse"] },
  "all-of: reports the missing needle",
);
assert.deepEqual(answerContains("", ["x"]), { pass: false, missing: ["x"] }, "empty text");
assert.deepEqual(answerContains(undefined as unknown as string, ["x"]), {
  pass: false,
  missing: ["x"],
}, "nullish text is safe");

// --- every task has a real check that accepts truth and rejects noise ---
assert.ok(IOP_TASKS.length >= 8, "at least 8 IOP tasks");
const expected: Record<string, string> = {
  "iop-module-name": "the module is omciAnalyzer",
  "iop-kafka-client": "it uses github.com/IBM/sarama",
  "iop-web-framework": "built on github.com/gin-gonic/gin",
  "iop-library-search-handler": "the handler is LibrarySearch",
  "iop-omcianalyzer-request-handler": "OmciAnalyzerRequest handles it",
  "iop-sequencetracer-prefix": "the prefix is /api/sequencetracer",
  "iop-kafka-topic-keys": "topicCollectorRequest and topicCollectorResponse",
  "iop-evtocd-deshape-file": "see evtocdDeshape.go",
};
for (const t of IOP_TASKS) {
  assert.ok(typeof t.setup === "function", `${t.id} has setup`);
  assert.ok(t.prompt.length > 0, `${t.id} has a prompt`);
  const good = expected[t.id];
  assert.ok(good, `test has an expected answer for ${t.id}`);
  const okRes = await t.check("/nonexistent", good);
  assert.equal(okRes.pass, true, `${t.id} accepts the correct answer`);
  const badRes = await t.check("/nonexistent", "I could not find that in the code.");
  assert.equal(badRes.pass, false, `${t.id} rejects a non-answer`);
}

// --- resolveTasks: IOP tasks are reachable by id but excluded by default ---
const def = resolveTasks();
assert.ok(!def.some((t) => t.id.startsWith("iop-")), "IOP tasks are not in the default suite");
const byId = resolveTasks(["iop-module-name", "iop-kafka-topic-keys"]);
assert.deepEqual(
  byId.map((t) => t.id).sort(),
  ["iop-kafka-topic-keys", "iop-module-name"],
  "IOP tasks resolve when named",
);

process.stdout.write("test-iop: ALL PASS\n");
