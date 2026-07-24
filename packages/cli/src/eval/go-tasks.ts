/**
 * Scheme B (OPEN_ITEMS §7d): a real-toolchain Go bug-fix task. Unlike the
 * hermetic bench tasks (which score with a JS probe), this compiles and runs an
 * actual `go test` red→green — exercising scissor's cross-language path and,
 * with `SCISSOR_VERIFY_COMMANDS` set, its verify loop (Scheme C).
 *
 * The bug is ported from the iop-toolkit backend's
 * `service/omcianalyzer/omciSchema/util.go`: there most widths decode via
 * `binary.BigEndian`, but the 40-bit path (`Uint40`) is hand-rolled with
 * explicit shifts. Here the 5-byte decoder shifts the most-significant byte by
 * 24 instead of 32, so it's only wrong once the value ≥ 2**32 — all other widths
 * and small 5-byte inputs pass, so it needs range reasoning + retrieval, not
 * grep. Packaged as a self-contained, stdlib-only module so `go test` runs
 * offline with any recent Go.
 *
 * These tasks need a Go toolchain, so (like the IOP tasks) they are reachable
 * only by id via resolveTasks and never enter the hermetic default suite.
 */
import { read, write } from "./task-helpers.js";
import { goAvailable, runGo } from "./go-helpers.js";
import type { EvalTask } from "./tasks.js";

const PKG = "internal/omcischema";
const GO_MOD = "module omcidecode\n\ngo 1.21\n";

/** Noise packages so *locating* the target matters (all must compile). */
async function writeNoise(dir: string): Promise<void> {
  const areas = ["controller", "dao", "routers", "models", "service", "global"];
  for (const area of areas) {
    for (let i = 0; i < 3; i++) {
      const fn = area.charAt(0).toUpperCase() + area.slice(1) + i;
      await write(
        dir,
        `internal/${area}/${area}${i}.go`,
        `package ${area}\n\nfunc ${fn}(x int) int { return x + ${i} }\n`,
      );
    }
  }
}

/** The buggy decoder, buried in a small multi-package module. */
const UTIL_GO = [
  "package omcischema",
  "",
  "// Variable-width big-endian unsigned decode (ported from",
  "// service/omcianalyzer/omciSchema/util.go). Most widths are straightforward;",
  "// the 5-byte (40-bit) path is hand-rolled with explicit shifts.",
  "func uint40(b []byte) uint64 {",
  "\t// BUG: the most-significant byte must shift by 32, not 24.",
  "\treturn uint64(b[0])<<24 | uint64(b[1])<<24 | uint64(b[2])<<16 | uint64(b[3])<<8 | uint64(b[4])",
  "}",
  "",
  "func uint64be(b []byte) uint64 {",
  "\tvar v uint64",
  "\tfor i := 0; i < 8; i++ {",
  "\t\tv = v<<8 | uint64(b[i])",
  "\t}",
  "\treturn v",
  "}",
  "",
  "// BytesUInteger decodes a big-endian unsigned integer of the given byte width.",
  "func BytesUInteger(b []byte, size int) uint64 {",
  "\tswitch size {",
  "\tcase 1:",
  "\t\treturn uint64(b[0])",
  "\tcase 2:",
  "\t\treturn uint64(b[0])<<8 | uint64(b[1])",
  "\tcase 4:",
  "\t\treturn uint64(b[0])<<24 | uint64(b[1])<<16 | uint64(b[2])<<8 | uint64(b[3])",
  "\tcase 5:",
  "\t\treturn uint40(b)",
  "\tdefault:",
  "\t\treturn uint64be(b)",
  "\t}",
  "}",
  "",
].join("\n");

/** On-disk test (red→green). A bare `go test ./...` shows this failing. */
const UTIL_TEST_GO = [
  "package omcischema",
  "",
  "import \"testing\"",
  "",
  "func TestBytesUInteger(t *testing.T) {",
  "\tcases := []struct {",
  "\t\tb    []byte",
  "\t\tsize int",
  "\t\twant uint64",
  "\t}{",
  "\t\t{[]byte{7}, 1, 7},",
  "\t\t{[]byte{1, 0}, 2, 256},",
  "\t\t{[]byte{0, 0, 1, 0}, 4, 256},",
  "\t\t{[]byte{1, 0, 0, 0, 0}, 5, 4294967296},",
  "\t\t{[]byte{255, 255, 255, 255, 255}, 5, 1099511627775},",
  "\t}",
  "\tfor _, c := range cases {",
  "\t\tif got := BytesUInteger(c.b, c.size); got != c.want {",
  "\t\t\tt.Errorf(\"BytesUInteger(%v, %d) = %d, want %d\", c.b, c.size, got, c.want)",
  "\t\t}",
  "\t}",
  "}",
  "",
].join("\n");

/** Independent probe (written at check time) — neutering the on-disk test can't help. */
const PROBE_TEST_GO = [
  "package omcischema",
  "",
  "import \"testing\"",
  "",
  "func TestProbeUint40Decode(t *testing.T) {",
  "\tcases := []struct {",
  "\t\tb    []byte",
  "\t\tsize int",
  "\t\twant uint64",
  "\t}{",
  "\t\t{[]byte{7}, 1, 7},",
  "\t\t{[]byte{1, 0}, 2, 256},",
  "\t\t{[]byte{0, 0, 1, 0}, 4, 256},",
  "\t\t{[]byte{0, 0, 0, 0, 0, 0, 1, 0}, 8, 256},",
  "\t\t{[]byte{0, 1, 0, 0, 0}, 5, 16777216},",
  "\t\t{[]byte{1, 0, 0, 0, 0}, 5, 4294967296},",
  "\t\t{[]byte{1, 2, 3, 4, 5}, 5, 4328719365},",
  "\t\t{[]byte{255, 255, 255, 255, 255}, 5, 1099511627775},",
  "\t}",
  "\tfor _, c := range cases {",
  "\t\tif got := BytesUInteger(c.b, c.size); got != c.want {",
  "\t\t\tt.Fatalf(\"BytesUInteger(%v, %d) = %d, want %d\", c.b, c.size, got, c.want)",
  "\t\t}",
  "\t}",
  "}",
  "",
].join("\n");

const PROBE_REL = `${PKG}/zz_probe_test.go`;

async function setupModule(dir: string): Promise<void> {
  await write(dir, "go.mod", GO_MOD);
  await write(dir, `${PKG}/util.go`, UTIL_GO);
  await write(dir, `${PKG}/util_test.go`, UTIL_TEST_GO);
  // Same-topic red herring: correct fixed-width decoders (don't touch).
  await write(
    dir,
    "internal/bigendian/bigendian.go",
    [
      "package bigendian",
      "",
      "func Uint16(b []byte) uint16 { return uint16(b[0])<<8 | uint16(b[1]) }",
      "",
      "func Uint32(b []byte) uint32 {",
      "\treturn uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])",
      "}",
      "",
    ].join("\n"),
  );
  await writeNoise(dir);
}

// ---------------------------------------------------------------------------
// Distilled from a real historical bug: omcianalyzer commit d5f27be
//   "fix(omciSchema): clamp table attribute slice to payload length"
// A managed-entity schema whose declared attribute size exceeds the received
// payload (e.g. a proprietary ME only present in the default schema) sliced
// payload[loc:a.Size] without clamping to the payload length → a slice
// out-of-range panic. The fix clamps the upper bound to the payload length.
// Reproduced self-contained here so a real `go test` goes red→green.
// ---------------------------------------------------------------------------
const SCHEMA_PKG = "internal/omcischema";

const MESCHEMA_GO = [
  "package omcischema",
  "",
  "// Attr is one attribute of a managed-entity schema; Size is its cumulative",
  "// end offset (in bytes) within the message payload.",
  "type Attr struct {",
  "\tName string",
  "\tSize int",
  "}",
  "",
  "type Schema struct{ Attrs []Attr }",
  "",
  "type Attribute struct {",
  "\tName  string",
  "\tValue uint64",
  "}",
  "",
  "func decodeBE(b []byte) uint64 {",
  "\tvar v uint64",
  "\tfor _, x := range b {",
  "\t\tv = v<<8 | uint64(x)",
  "\t}",
  "\treturn v",
  "}",
  "",
  "// Attributes decodes each schema attribute out of the received payload.",
  "func (s Schema) Attributes(payload []byte) []Attribute {",
  "\tout := make([]Attribute, 0, len(s.Attrs))",
  "\tloc := 0",
  "\tfor _, a := range s.Attrs {",
  "\t\t// BUG (distilled from omcianalyzer d5f27be): a.Size can exceed the",
  "\t\t// received payload (a proprietary ME only present in the default",
  "\t\t// schema), so slicing to a.Size panics with slice-out-of-range. The",
  "\t\t// fix clamps the end to the payload length.",
  "\t\tend := a.Size",
  "\t\tvalue := decodeBE(payload[loc:end])",
  "\t\tout = append(out, Attribute{Name: a.Name, Value: value})",
  "\t\tloc = end",
  "\t}",
  "\treturn out",
  "}",
  "",
].join("\n");

const MESCHEMA_TEST_GO = [
  "package omcischema",
  "",
  "import \"testing\"",
  "",
  "func TestSchemaAttributes(t *testing.T) {",
  "\t// The trailing 'extra' attribute is declared (end offset 10) but the",
  "\t// received payload is only 6 bytes — it must clamp, not panic.",
  "\ts := Schema{Attrs: []Attr{{\"a\", 2}, {\"b\", 4}, {\"c\", 6}, {\"extra\", 10}}}",
  "\tgot := s.Attributes([]byte{0, 1, 0, 2, 0, 3})",
  "\twant := []uint64{1, 2, 3, 0}",
  "\tif len(got) != len(want) {",
  "\t\tt.Fatalf(\"len=%d want %d\", len(got), len(want))",
  "\t}",
  "\tfor i, w := range want {",
  "\t\tif got[i].Value != w {",
  "\t\t\tt.Errorf(\"attr %d = %d, want %d\", i, got[i].Value, w)",
  "\t\t}",
  "\t}",
  "}",
  "",
].join("\n");

const MESCHEMA_PROBE_GO = [
  "package omcischema",
  "",
  "import \"testing\"",
  "",
  "func TestProbeSchemaAttributes(t *testing.T) {",
  "\t// Short payload: the last declared attribute overruns and must clamp.",
  "\ts := Schema{Attrs: []Attr{{\"x\", 1}, {\"y\", 3}, {\"big\", 9}}}",
  "\tgot := s.Attributes([]byte{5, 0, 9, 7})",
  "\twant := []uint64{5, 9, 7}",
  "\tif len(got) != len(want) {",
  "\t\tt.Fatalf(\"len=%d want %d\", len(got), len(want))",
  "\t}",
  "\tfor i, w := range want {",
  "\t\tif got[i].Value != w {",
  "\t\t\tt.Fatalf(\"attr %d = %d, want %d\", i, got[i].Value, w)",
  "\t\t}",
  "\t}",
  "\t// Fully-fitting schema still decodes normally.",
  "\ts2 := Schema{Attrs: []Attr{{\"a\", 2}, {\"b\", 4}}}",
  "\tgot2 := s2.Attributes([]byte{0, 10, 0, 20})",
  "\tif got2[0].Value != 10 || got2[1].Value != 20 {",
  "\t\tt.Fatalf(\"fitting schema decoded wrong: %+v\", got2)",
  "\t}",
  "}",
  "",
].join("\n");

const SCHEMA_PROBE_REL = `${SCHEMA_PKG}/zz_probe_test.go`;

async function setupSchemaModule(dir: string): Promise<void> {
  await write(dir, "go.mod", GO_MOD);
  await write(dir, `${SCHEMA_PKG}/meschema.go`, MESCHEMA_GO);
  await write(dir, `${SCHEMA_PKG}/meschema_test.go`, MESCHEMA_TEST_GO);
  await writeNoise(dir);
}

export const GO_TASKS: EvalTask[] = [
  {
    id: "go-uint40-decode-bug",
    title: "Fix a subtle big-endian 40-bit decode bug (real go test)",
    tags: ["retrieve", "read", "edit", "debug", "multi-file", "reason", "real", "go"],
    timeoutMs: 360_000,
    // The bug and fix live in one decoder file among several packages.
    oracle: { files: 1 },
    setup: setupModule,
    prompt:
      "This is a Go module. Running `go test ./...` fails: a big-endian byte-to-integer decoder returns the wrong value for some inputs. The module has several packages; locate the offending function and fix it so `go test ./...` passes. The decoder reads big-endian unsigned integers of a given byte width; the 5-byte (40-bit) width is wrong for larger values. Do not edit any _test.go files.",
    async check(dir) {
      if (!(await goAvailable(dir))) {
        return {
          pass: false,
          detail:
            "go toolchain not found — Scheme B needs Go (install in WSL, or set SCISSOR_GO_BIN to the dir with the go binary)",
        };
      }
      // Score with an independent probe so editing the on-disk test can't help.
      await write(dir, PROBE_REL, PROBE_TEST_GO);
      const r = await runGo(dir, ["test", `./${PKG}/`, "-run", "TestProbeUint40Decode", "-count=1"]);
      if (!r.ok) {
        return { pass: false, detail: `go test probe still fails: ${r.out.slice(-200)}` };
      }
      // Guard: the fix must decode from the input bytes, not a hardcoded lookup.
      const src = await read(dir, `${PKG}/util.go`);
      if (!/b\[0\]/.test(src) || !/b\[4\]/.test(src)) {
        return { pass: false, detail: "uint40 no longer decodes from its input bytes (likely hardcoded)" };
      }
      return { pass: true, detail: "40-bit big-endian decode fixed (real go test probe passes)" };
    },
  },
  {
    // Distilled from a REAL historical fix: omcianalyzer d5f27be. Pre-fix code
    // slices a schema attribute to its declared size without clamping to the
    // received payload, panicking (slice out of range) on short payloads.
    id: "omci-attr-slice-panic",
    title: "Fix a real slice-out-of-range panic on short OMCI payloads (go test)",
    tags: ["retrieve", "read", "edit", "debug", "reason", "real", "go", "historical"],
    timeoutMs: 360_000,
    // The clamp fix lives in the single schema-decoder file.
    oracle: { files: 1 },
    setup: setupSchemaModule,
    prompt:
      "This is a Go module. Running `go test ./...` fails: decoding a managed-entity schema panics with a slice out-of-range error when the received payload is shorter than the schema's declared attribute sizes (this happens for proprietary MEs only present in the default schema). Locate the offending decoder and fix it so `go test ./...` passes — a declared attribute that runs past the payload must be clamped to what was actually received, not cause a panic. Do not edit any _test.go files.",
    async check(dir) {
      if (!(await goAvailable(dir))) {
        return {
          pass: false,
          detail:
            "go toolchain not found — Scheme B needs Go (install in WSL, or set SCISSOR_GO_BIN to the dir with the go binary)",
        };
      }
      await write(dir, SCHEMA_PROBE_REL, MESCHEMA_PROBE_GO);
      const r = await runGo(dir, [
        "test",
        `./${SCHEMA_PKG}/`,
        "-run",
        "TestProbeSchemaAttributes",
        "-count=1",
      ]);
      if (!r.ok) {
        return { pass: false, detail: `go test probe still fails: ${r.out.slice(-200)}` };
      }
      // Guard: the fix must still slice the payload (not stub/hardcode the result).
      const src = await read(dir, `${SCHEMA_PKG}/meschema.go`);
      if (!/payload\[/.test(src)) {
        return { pass: false, detail: "Attributes no longer decodes from the payload (likely stubbed)" };
      }
      return { pass: true, detail: "payload-length clamp fixed (real go test probe passes)" };
    },
  },
];
