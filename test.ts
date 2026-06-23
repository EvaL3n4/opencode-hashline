import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import * as path from "path";
import { join } from "path";
import {
  type EditOp, type CompactDiffPreview, type BlockSpan,
  detectLineEnding, normalizeToLF, restoreLineEndings, stripBom, normalizeForStorage,
  normalizeFileText, computeFileHash, SnapshotStore, snapshotStore, canonicalPath,
  parsePatch, applyEdits, lineDiff,
  isStructuralCloserLine, computeDelimiterBalance, balanceDelta, balanceNegate,
  balanceEqual, balanceIsZero, hasNonWhitespace, leadingIndent, isIndentDeeper,
  repairEdits,
  hasAnchorScopedEdit, collectAnchorLines, verifyAnchorContent, findFirstChangedLine,
  applyEditsToSnapshot, replaySessionChainOnCurrent, tryRecover,
  formatAnchoredContext, formatMismatchError, MismatchError,
  parseSeenLinesFromHashlineBody, formatLineRanges, unseenLinesMessage, assertSeenLines,
  hashPatchInput, recordNoopEdit, resetNoopEdit,
  noChangeDiagnostic, noChangeLoopDiagnostic, NOOP_HARD_LIMIT,
  RECOVERY_EXTERNAL_WARNING, RECOVERY_SESSION_REPLAY_WARNING,
  unwrapHashlineHeaderPath, stripWriteContent, stripHashlinePrefixes, stripLeadingHashlinePrefix,
  detectContamination, validateLineBounds, tryParseRecoveryHeader, stripApplyPatchPathNoise,
  trailingPhantomLine, dropTrailingPhantomDeletes, assertUniqueCanonicalPaths,
  buildNumberedDiff, buildCompactDiffPreview, buildSnapshotTable, buildStreamingSectionDiff,
  applyPartialTo,
  EXTENSION_TO_WASM, hasBlockEdit, resolveBlockEdits, resolveBlock, resolveBlockSpan,
  blockUnresolvedMessage, blockSingleLineMessage, BLOCK_RESOLVER_UNAVAILABLE,
  insertAfterBlockCloserLoweredWarning, insertAfterBlockUnresolvedLoweredWarning,
  parseGrepOutput,
  type GrepMatch, type GrepFileMatches, type ParsedGrepOutput,
  Tokenizer, Executor, parsePatchStreaming, splitHashlineLines,
  type Token, type BlockTarget, type ParsedRange, type Anchor,
} from "./src/index.ts";

// ─── Test Helpers ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

function assertEq(actual: unknown, expected: unknown, message: string) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✓ ${message}`);
  } else {
    console.log(`  ✗ ${message}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
  ok ? passed++ : failed++;
}

const tmpDir = join(import.meta.dirname, ".test-tmp");
try { rmSync(tmpDir, { recursive: true }); } catch {}
mkdirSync(tmpDir, { recursive: true });

// ── Test 1: Hash computation ─────────────────────────────────────────────────
console.log("\n─ Hash computation ─");

const text1 = "hello\nworld\n";
const hash1 = computeFileHash(text1);
assert(hash1.length === 4, `hash is 4 chars (got: ${hash1})`);
assert(/^[0-9A-F]{4}$/.test(hash1), `hash is uppercase hex (got: ${hash1})`);

const hash1b = computeFileHash("hello\nworld\n");
assertEq(hash1b, hash1, "same content → same hash");

const hash2 = computeFileHash("hello\nworld\nfoo\n");
assert(hash2 !== hash1, "different content → different hash");

const hashTrailing = computeFileHash("hello \nworld\t\n");
const hashClean = computeFileHash("hello\nworld\n");
assertEq(hashTrailing, hashClean, "trailing whitespace normalized");

const hashCRLF = computeFileHash("hello\r\nworld\r\n");
const hashLF = computeFileHash("hello\nworld\n");
assertEq(hashCRLF, hashLF, "CRLF normalized to LF");

// ── Test 2: BOM stripping ────────────────────────────────────────────────────
console.log("\n─ BOM stripping ─");

const hashBom = computeFileHash("\uFEFFhello\nworld\n");
assertEq(hashBom, hash1, "BOM stripped before hashing");

const bomResult = stripBom("\uFEFFhello");
assertEq(bomResult.bom, "\uFEFF", "stripBom detects BOM");
assertEq(bomResult.text, "hello", "stripBom removes BOM");

const noBomResult = stripBom("hello");
assertEq(noBomResult.bom, "", "stripBom: no BOM → empty bom");
assertEq(noBomResult.text, "hello", "stripBom: no BOM → text unchanged");

// ── Test 3: Lone \r normalization ────────────────────────────────────────────
console.log("\n─ Lone \\r normalization ─");

const hashLoneCR = computeFileHash("hello\rworld\n");
assertEq(hashLoneCR, hashLF, "lone \\r normalized to \\n");

assertEq(normalizeToLF("a\r\nb\r\nc"), "a\nb\nc", "CRLF → LF");
assertEq(normalizeToLF("a\rb\rc"), "a\nb\nc", "lone \\r → LF");
assertEq(normalizeToLF("a\nb\nc"), "a\nb\nc", "LF unchanged");

// ── Test 4: normalizeFileText (trailing whitespace only, not \r) ─────────────
console.log("\n─ normalizeFileText ─");

assertEq(normalizeFileText("hello \n"), "hello\n", "strips trailing space before \\n");
assertEq(normalizeFileText("hello\t\n"), "hello\n", "strips trailing tab before \\n");
assertEq(normalizeFileText("hello "), "hello", "strips trailing space at end of text");
assertEq(normalizeFileText("hello\t"), "hello", "strips trailing tab at end of text");
assertEq(normalizeFileText("hello \r\n"), "hello \r\n", "does NOT touch \\r (handled by normalizeToLF)");

// ── Test 5: Line ending detection + restoration ──────────────────────────────
console.log("\n─ Line ending detection + restoration ─");

assertEq(detectLineEnding("a\r\nb\r\n"), "\r\n", "detects CRLF");
assertEq(detectLineEnding("a\nb\n"), "\n", "detects LF");
assertEq(detectLineEnding("a\r\nb\n"), "\r\n", "CRLF first → CRLF");
assertEq(detectLineEnding("a\nb\r\n"), "\n", "LF first → LF");
assertEq(detectLineEnding(""), "\n", "empty → LF");
assertEq(detectLineEnding("no newlines"), "\n", "no newlines → LF");

assertEq(restoreLineEndings("a\nb\n", "\r\n"), "a\r\nb\r\n", "restores CRLF");
assertEq(restoreLineEndings("a\nb\n", "\n"), "a\nb\n", "LF unchanged");

// ── Test 6: normalizeForStorage ──────────────────────────────────────────────
console.log("\n─ normalizeForStorage ─");

assertEq(normalizeForStorage("\uFEFFa\r\nb\r\n"), "a\nb\n", "strips BOM + normalizes CRLF");
assertEq(normalizeForStorage("a\nb\n"), "a\nb\n", "already normalized → unchanged");

// ── Test 7: Patch parser ─────────────────────────────────────────────────────
console.log("\n─ Patch parser ─");

const patch1 = `[test.py#A1B2]
SWAP 2.=2:
+    greeting = "Hi"
+    msg = f"{greeting}, {name}"

DEL 3`;

const sections1 = parsePatch(patch1);
assert(sections1.length === 1, "one section parsed");
assertEq(sections1[0]?.path, "test.py", "path correct");
assertEq(sections1[0]?.hash, "A1B2", "hash correct (uppercased)");
assert(sections1[0]?.edits.length === 2, "two edits parsed");

const edit0 = sections1[0]?.edits[0];
assert(edit0?.kind === "swap", "first edit is swap");
if (edit0?.kind === "swap") {
  assertEq(edit0.start, 2, "swap start = 2");
  assertEq(edit0.end, 2, "swap end = 2");
  assertEq(edit0.lines.length, 2, "swap has 2 body lines");
  assertEq(edit0.lines[0], '    greeting = "Hi"', "first body line correct");
}

const edit1 = sections1[0]?.edits[1];
assert(edit1?.kind === "delete", "second edit is delete");
if (edit1?.kind === "delete") {
  assertEq(edit1.start, 3, "delete start = 3");
  assertEq(edit1.end, 3, "delete end = 3");
}

// ── Test 8: Parser - all operation types ─────────────────────────────────────
console.log("\n─ Parser: all ops ─");

const patch2 = `[f.txt#0001]
INS.HEAD:
+#header

INS.TAIL:
+#footer

INS.PRE 3:
+before3

INS.POST 1:
+after1

DEL 2

SWAP 4.=5:
+new4
+new5`;

const sections2 = parsePatch(patch2);
assert(sections2.length === 1, "one section");
assert(sections2[0]?.edits.length === 6, "six edits parsed");

const ops = sections2[0]?.edits.map((e) => e.kind);
assert(!!ops?.includes("insert"), "has insert ops");
assert(!!ops?.includes("delete"), "has delete op");
assert(!!ops?.includes("swap"), "has swap op");

const insOps = sections2[0]?.edits.filter((e) => e.kind === "insert") as Extract<EditOp, { kind: "insert" }>[];
assertEq(insOps?.[0]?.position, "head", "first insert is head");
assertEq(insOps?.[1]?.position, "tail", "second insert is tail");
assertEq(insOps?.[2]?.position, "before", "third insert is before");
assertEq(insOps?.[3]?.position, "after", "fourth insert is after");

// ── Test 9: Range separator variants ─────────────────────────────────────────
console.log("\n─ Range separator variants ─");

for (const sep of [".=", "-", "..", "…", "="]) {
  const patch = `[f.txt#0001]\nSWAP 1${sep}3:\n+new`;
  const s = parsePatch(patch);
  const e = s[0]?.edits[0];
  if (e?.kind === "swap") {
    assertEq(e.start, 1, `SWAP 1${sep}3 start=1`);
    assertEq(e.end, 3, `SWAP 1${sep}3 end=3`);
  } else {
    assert(false, `SWAP 1${sep}3 should parse as swap`);
  }
}

// ── Test 10: Edit application ────────────────────────────────────────────────
console.log("\n─ Edit application ─");

const fileContent = "line1\nline2\nline3\nline4\nline5";

const swapResult = applyEdits(fileContent, [
  { kind: "swap", start: 2, end: 2, lines: ["LINE2"] },
]);
assertEq(swapResult, "line1\nLINE2\nline3\nline4\nline5", "SWAP single line");

const swapRange = applyEdits(fileContent, [
  { kind: "swap", start: 2, end: 3, lines: ["REPLACED"] },
]);
assertEq(swapRange, "line1\nREPLACED\nline4\nline5", "SWAP range (2→1 lines)");

const delSingle = applyEdits(fileContent, [
  { kind: "delete", start: 3, end: 3 },
]);
assertEq(delSingle, "line1\nline2\nline4\nline5", "DEL single line");

const delRange = applyEdits(fileContent, [
  { kind: "delete", start: 2, end: 4 },
]);
assertEq(delRange, "line1\nline5", "DEL range");

const insHead = applyEdits(fileContent, [
  { kind: "insert", position: "head", anchor: 0, lines: ["HEADER"] },
]);
assertEq(insHead, "HEADER\nline1\nline2\nline3\nline4\nline5", "INS.HEAD");

const insTail = applyEdits(fileContent, [
  { kind: "insert", position: "tail", anchor: 0, lines: ["FOOTER"] },
]);
assertEq(insTail, "line1\nline2\nline3\nline4\nline5\nFOOTER", "INS.TAIL");

const insPre = applyEdits(fileContent, [
  { kind: "insert", position: "before", anchor: 3, lines: ["BEFORE3"] },
]);
assertEq(insPre, "line1\nline2\nBEFORE3\nline3\nline4\nline5", "INS.PRE 3");

const insPost = applyEdits(fileContent, [
  { kind: "insert", position: "after", anchor: 2, lines: ["AFTER2"] },
]);
assertEq(insPost, "line1\nline2\nAFTER2\nline3\nline4\nline5", "INS.POST 2");

// ── Test 11: Multiple edits (reverse order application) ──────────────────────
console.log("\n─ Multiple edits (reverse order) ─");

const multiResult = applyEdits(fileContent, [
  { kind: "swap", start: 2, end: 2, lines: ["LINE2"] },
  { kind: "delete", start: 4, end: 4 },
  { kind: "insert", position: "after", anchor: 1, lines: ["AFTER1"] },
]);
assertEq(multiResult, "line1\nAFTER1\nLINE2\nline3\nline5", "Multiple edits applied in reverse order");

// ── Test 12: End-to-end ──────────────────────────────────────────────────────
console.log("\n─ End-to-end ─");

const testFile = join(tmpDir, "greet.py");
const originalContent = 'def greet(name):\n    msg = "Hello, " + name\n    print(msg)\ngreet("world")';
writeFileSync(testFile, originalContent);

const fileHash = computeFileHash(originalContent);
console.log(`  File hash: ${fileHash}`);

const patch = `[${testFile}#${fileHash}]
SWAP 2.=2:
+    greeting = "Hi"
+    msg = f"{greeting}, {name}"

DEL 3`;

const sections = parsePatch(patch);
assert(sections.length === 1, "e2e: one section");

const currentContent = readFileSync(testFile, "utf-8");
const currentHash = computeFileHash(currentContent);
assertEq(currentHash, fileHash, "e2e: hash matches (no external change)");

const newContent = applyEdits(currentContent, sections[0]!.edits);
const expectedContent = 'def greet(name):\n    greeting = "Hi"\n    msg = f"{greeting}, {name}"\ngreet("world")';
assertEq(newContent, expectedContent, "e2e: edited content correct");

writeFileSync(testFile, newContent);
const newHash = computeFileHash(newContent);
assert(newHash !== fileHash, "e2e: new hash differs from old");

const currentHash2 = computeFileHash(readFileSync(testFile, "utf-8"));
assert(currentHash2 !== fileHash, "e2e: old hash is stale (edit detected)");

// ── Test 13: Empty body rows ─────────────────────────────────────────────────
console.log("\n─ Empty body rows ─");

const blankPatch = `[f.txt#0001]
INS.POST 1:
+
+nextblank`;

const blankSections = parsePatch(blankPatch);
const blankEdit = blankSections[0]?.edits[0];
if (blankEdit?.kind === "insert") {
  assertEq(blankEdit.lines.length, 2, "two body lines (one blank, one text)");
  assertEq(blankEdit.lines[0], "", "first body line is empty string");
  assertEq(blankEdit.lines[1], "nextblank", "second body line correct");
}

// ── Test 14: Multiple sections ───────────────────────────────────────────────
console.log("\n─ Multiple sections ─");

const multiPatch = `[a.txt#1111]
DEL 1

[b.txt#2222]
INS.HEAD:
+header`;

const multiSections = parsePatch(multiPatch);
assert(multiSections.length === 2, "two sections parsed");
assertEq(multiSections[0]?.path, "a.txt", "first section path");
assertEq(multiSections[1]?.path, "b.txt", "second section path");
assertEq(multiSections[0]?.hash, "1111", "first section hash");
assertEq(multiSections[1]?.hash, "2222", "second section hash");

// ── Test 15: Literal + in body ───────────────────────────────────────────────
console.log("\n─ Literal + in body ─");

const plusPatch = `[f.txt#0001]
INS.HEAD:
++x
+++y`;

const plusSections = parsePatch(plusPatch);
const plusEdit = plusSections[0]?.edits[0];
if (plusEdit?.kind === "insert") {
  assertEq(plusEdit.lines[0], "+x", "++x → +x (literal +)");
  assertEq(plusEdit.lines[1], "++y", "+++y → ++y (literal ++)");
}

// ── Test 16: lineDiff ────────────────────────────────────────────────────────
console.log("\n─ lineDiff ─");

{
  const r = lineDiff("a\nb\nc", "a\nb\nc");
  assertEq(r.additions, 0, "lineDiff: identical → 0 additions");
  assertEq(r.deletions, 0, "lineDiff: identical → 0 deletions");

  const r2 = lineDiff("a\nb\nc", "a\nX\nc");
  assertEq(r2.additions, 1, "lineDiff: swap middle → 1 addition");
  assertEq(r2.deletions, 1, "lineDiff: swap middle → 1 deletion");

  const r3 = lineDiff("a\nb", "a\nb\nc\nd");
  assertEq(r3.additions, 2, "lineDiff: append 2 → 2 additions");
  assertEq(r3.deletions, 0, "lineDiff: append 2 → 0 deletions");

  const r4 = lineDiff("a\nb\nc\nd", "a\nb");
  assertEq(r4.additions, 0, "lineDiff: delete 2 → 0 additions");
  assertEq(r4.deletions, 2, "lineDiff: delete 2 → 2 deletions");

  const r5 = lineDiff("", "new\nfile");
  assertEq(r5.additions, 2, "lineDiff: empty→2 lines → 2 additions");
  assertEq(r5.deletions, 0, "lineDiff: empty→2 lines → 0 deletions");

  const r6 = lineDiff("x\ny\nz", "");
  assertEq(r6.additions, 0, "lineDiff: 3 lines→empty → 0 additions");
  assertEq(r6.deletions, 3, "lineDiff: 3 lines→empty → 3 deletions");
}

// ── Test 17: Delimiter balance ───────────────────────────────────────────────
console.log("\n─ Delimiter balance ─");

{
  const b0 = computeDelimiterBalance(["()"]);
  assertEq(b0.paren, 0, "() → paren balanced");
  assertEq(b0.bracket, 0, "() → bracket balanced");
  assertEq(b0.brace, 0, "() → brace balanced");

  const b1 = computeDelimiterBalance(["("]);
  assertEq(b1.paren, 1, "( → paren +1");

  const b2 = computeDelimiterBalance(["{"]);
  assertEq(b2.brace, 1, "{ → brace +1");

  const b3 = computeDelimiterBalance(["{", "}"]);
  assertEq(b3.brace, 0, "{ } → brace balanced");

  const b4 = computeDelimiterBalance(["[", "]"]);
  assertEq(b4.bracket, 0, "[ ] → bracket balanced");

  const b5 = computeDelimiterBalance(['"("']);
  assertEq(b5.paren, 0, "paren inside string → not counted");

  const b6 = computeDelimiterBalance(["// (comment"]);
  assertEq(b6.paren, 0, "paren in line comment → not counted");

  const b7 = computeDelimiterBalance(["/* ( */"]);
  assertEq(b7.paren, 0, "paren in block comment → not counted");

  const d = balanceDelta({ paren: 1, bracket: 2, brace: 3 }, { paren: 0, bracket: 0, brace: 0 });
  assertEq(d.paren, 1, "balanceDelta: paren");
  assertEq(d.bracket, 2, "balanceDelta: bracket");
  assertEq(d.brace, 3, "balanceDelta: brace");

  const n = balanceNegate({ paren: 1, bracket: 2, brace: 3 });
  assertEq(n.paren, -1, "balanceNegate: paren");
  assertEq(n.bracket, -2, "balanceNegate: bracket");
  assertEq(n.brace, -3, "balanceNegate: brace");

  assert(balanceEqual({ paren: 0, bracket: 0, brace: 0 }, { paren: 0, bracket: 0, brace: 0 }), "balanceEqual: equal");
  assert(!balanceEqual({ paren: 1, bracket: 0, brace: 0 }, { paren: 0, bracket: 0, brace: 0 }), "balanceEqual: not equal");
  assert(balanceIsZero({ paren: 0, bracket: 0, brace: 0 }), "balanceIsZero: zero");
  assert(!balanceIsZero({ paren: 1, bracket: 0, brace: 0 }), "balanceIsZero: not zero");
}

// ── Test 18: Structural closer detection ─────────────────────────────────────
console.log("\n─ Structural closer detection ─");

assert(isStructuralCloserLine("}"), "} is closer");
assert(isStructuralCloserLine("  }"), "  } is closer");
assert(isStructuralCloserLine("});"), "}); is closer");
assert(isStructuralCloserLine("];"), "]; is closer");
assert(isStructuralCloserLine(");"), "); is closer");
assert(isStructuralCloserLine("</Component>"), "</Component> is closer");
assert(isStructuralCloserLine("</>"), "</> is closer");
assert(isStructuralCloserLine("/>"), "/> is closer");
assert(!isStructuralCloserLine("x = 1"), "x = 1 is not closer");
assert(!isStructuralCloserLine("function foo() {"), "function foo() { is not closer");

// ── Test 19: Indentation helpers ─────────────────────────────────────────────
console.log("\n─ Indentation helpers ─");

assert(hasNonWhitespace("hello"), "hasNonWhitespace: hello → true");
assert(!hasNonWhitespace("   "), "hasNonWhitespace: spaces → false");
assert(!hasNonWhitespace(""), "hasNonWhitespace: empty → false");
assert(!hasNonWhitespace("\t\n"), "hasNonWhitespace: tab+newline → false");
assert(!hasNonWhitespace(undefined), "hasNonWhitespace: undefined → false");

assertEq(leadingIndent("    hello"), "    ", "leadingIndent: 4 spaces");
assertEq(leadingIndent("\thello"), "\t", "leadingIndent: tab");
assertEq(leadingIndent("hello"), "", "leadingIndent: no indent");
assertEq(leadingIndent("  \t  hello"), "  \t  ", "leadingIndent: mixed");

assert(isIndentDeeper("    ", ""), "isIndentDeeper: 4sp > 0sp");
assert(isIndentDeeper("    ", "  "), "isIndentDeeper: 4sp > 2sp");
assert(!isIndentDeeper("  ", "    "), "isIndentDeeper: 2sp < 4sp");
assert(!isIndentDeeper("  ", "  "), "isIndentDeeper: equal → false");

// ── Test 20: Boundary repair — two-sided echo ────────────────────────────────
console.log("\n─ Boundary repair: two-sided echo ─");

{
  const fileLines = ["def foo():", "    x = 1", "    y = 2", "    return x + y", "def bar():"];
  const edits: EditOp[] = [
    { kind: "swap", start: 3, end: 3, lines: ["    x = 1", "    y = 99", "    return x + y"] },
  ];
  const { edits: repaired, warnings } = repairEdits(edits, fileLines);
  assertEq(repaired.length, 1, "one edit after repair");
  if (repaired[0]?.kind === "swap") {
    assertEq(repaired[0].lines.length, 1, "echo lines dropped (3 → 1)");
    assertEq(repaired[0].lines[0], "    y = 99", "payload is just the replacement");
  }
  assert(warnings.length > 0, "warning emitted for echo repair");

  const result = applyEdits(fileLines.join("\n"), repaired);
  assertEq(result, "def foo():\n    x = 1\n    y = 99\n    return x + y\ndef bar():", "repaired edit applies correctly");
}

// ── Test 21: Boundary repair — duplicate suffix (balance mismatch) ───────────
console.log("\n─ Boundary repair: duplicate suffix ─");

{
  const fileLines = ["function foo() {", "  x();", "}", "", "function bar() {"];
  const edits: EditOp[] = [
    { kind: "swap", start: 2, end: 2, lines: ["  y();", "}"] },
  ];
  const { edits: repaired, warnings } = repairEdits(edits, fileLines);
  assertEq(repaired.length, 1, "one edit after repair");
  if (repaired[0]?.kind === "swap") {
    assertEq(repaired[0].lines.length, 1, "duplicate suffix dropped (2 → 1)");
    assertEq(repaired[0].lines[0], "  y();", "payload is just the replacement");
  }
  assert(warnings.length > 0, "warning emitted for suffix repair");

  const result = applyEdits(fileLines.join("\n"), repaired);
  assertEq(result, "function foo() {\n  y();\n}\n\nfunction bar() {", "repaired edit applies correctly");
}

// ── Test 22: Boundary repair — duplicate prefix (balance mismatch) ───────────
console.log("\n─ Boundary repair: duplicate prefix ─");

{
  const fileLines = ["{", "  b();", "}"];
  const edits: EditOp[] = [
    { kind: "swap", start: 2, end: 2, lines: ["{", "  b_new();"] },
  ];
  const { edits: repaired, warnings } = repairEdits(edits, fileLines);
  assertEq(repaired.length, 1, "one edit after repair");
  if (repaired[0]?.kind === "swap") {
    assertEq(repaired[0].lines.length, 1, "duplicate prefix dropped (2 → 1)");
    assertEq(repaired[0].lines[0], "  b_new();", "payload is just the replacement");
  }
  assert(warnings.length > 0, "warning emitted for prefix repair");

  const result = applyEdits(fileLines.join("\n"), repaired);
  assertEq(result, "{\n  b_new();\n}", "repaired edit applies correctly");
}

// ── Test 23: Boundary repair — one-sided echo (leading) ──────────────────────
console.log("\n─ Boundary repair: one-sided echo (leading) ─");

{
  const fileLines = ["import foo", "import bar", "import baz", "import qux", "", "const x = 1"];
  const edits: EditOp[] = [
    { kind: "swap", start: 3, end: 4, lines: ["import bar", "import NEW1", "import NEW2"] },
  ];
  const { edits: repaired, warnings } = repairEdits(edits, fileLines);
  assertEq(repaired.length, 1, "one edit after repair");
  if (repaired[0]?.kind === "swap") {
    assertEq(repaired[0].lines.length, 2, "one-sided echo dropped (3 → 2)");
    assertEq(repaired[0].lines[0], "import NEW1", "first line is NEW1");
    assertEq(repaired[0].lines[1], "import NEW2", "second line is NEW2");
  }
  assert(warnings.length > 0, "warning emitted for one-sided echo repair");

  const result = applyEdits(fileLines.join("\n"), repaired);
  assertEq(result, "import foo\nimport bar\nimport NEW1\nimport NEW2\n\nconst x = 1", "repaired edit applies correctly");
}

// ── Test 24: Boundary repair — shifted landing (INS.POST) ────────────────────
console.log("\n─ Boundary repair: shifted landing ─");

{
  const fileLines = ["function foo() {", "  if (x) {", "    y();", "  }", "}"];
  const edits: EditOp[] = [
    { kind: "insert", position: "after", anchor: 3, lines: ["z();"] },
  ];
  const { edits: repaired, warnings } = repairEdits(edits, fileLines);
  assertEq(repaired.length, 1, "one edit after repair");
  if (repaired[0]?.kind === "insert") {
    assertEq(repaired[0].anchor, 5, "landing shifted from line 3 to line 5");
  }
  assert(warnings.length > 0, "warning emitted for shifted landing");

  const result = applyEdits(fileLines.join("\n"), repaired);
  assertEq(result, "function foo() {\n  if (x) {\n    y();\n  }\n}\nz();", "repaired edit applies correctly");
}

// ── Test 25: Boundary repair — no repair needed ──────────────────────────────
console.log("\n─ Boundary repair: no repair needed ─");

{
  const fileLines = ["line1", "line2", "line3"];
  const edits: EditOp[] = [
    { kind: "swap", start: 2, end: 2, lines: ["LINE2"] },
  ];
  const { edits: repaired, warnings } = repairEdits(edits, fileLines);
  assertEq(repaired.length, 1, "edit preserved");
  assertEq(warnings.length, 0, "no warnings");
  if (repaired[0]?.kind === "swap") {
    assertEq(repaired[0].lines[0], "LINE2", "payload unchanged");
  }
}

// ── Test 26: hasAnchorScopedEdit ─────────────────────────────────────────────
console.log("\n─ hasAnchorScopedEdit ─");

assert(!hasAnchorScopedEdit([]), "empty → false");
assert(!hasAnchorScopedEdit([{ kind: "insert", position: "head", anchor: 0, lines: ["x"] }]), "INS.HEAD → false");
assert(!hasAnchorScopedEdit([{ kind: "insert", position: "tail", anchor: 0, lines: ["x"] }]), "INS.TAIL → false");
assert(hasAnchorScopedEdit([{ kind: "insert", position: "before", anchor: 3, lines: ["x"] }]), "INS.PRE → true");
assert(hasAnchorScopedEdit([{ kind: "insert", position: "after", anchor: 3, lines: ["x"] }]), "INS.POST → true");
assert(hasAnchorScopedEdit([{ kind: "delete", start: 3, end: 3 }]), "DEL → true");
assert(hasAnchorScopedEdit([{ kind: "swap", start: 2, end: 2, lines: ["x"] }]), "SWAP → true");
assert(!hasAnchorScopedEdit([
  { kind: "insert", position: "head", anchor: 0, lines: ["x"] },
  { kind: "insert", position: "tail", anchor: 0, lines: ["y"] },
]), "HEAD + TAIL → false");
assert(hasAnchorScopedEdit([
  { kind: "insert", position: "head", anchor: 0, lines: ["x"] },
  { kind: "delete", start: 3, end: 3 },
]), "HEAD + DEL → true");

// ── Test 27: collectAnchorLines + verifyAnchorContent ────────────────────────
console.log("\n─ collectAnchorLines + verifyAnchorContent ─");

{
  const edits: EditOp[] = [
    { kind: "swap", start: 2, end: 3, lines: ["x"] },
    { kind: "delete", start: 5, end: 5 },
    { kind: "insert", position: "before", anchor: 7, lines: ["y"] },
  ];
  const anchors = collectAnchorLines(edits);
  assertEq(anchors.length, 4, "collects 2+1+1=4 anchor lines");
  assert(anchors.includes(2), "includes line 2");
  assert(anchors.includes(3), "includes line 3");
  assert(anchors.includes(5), "includes line 5");
  assert(anchors.includes(7), "includes line 7");

  const prev = "a\nb\nc\nd\ne\nf\ng";
  const curr = "a\nb\nc\nd\ne\nf\ng";
  assert(verifyAnchorContent(prev, curr, edits), "identical texts → anchors match");

  const curr2 = "a\nB\nc\nd\ne\nf\ng";
  assert(!verifyAnchorContent(prev, curr2, edits), "anchor line 2 changed → mismatch");

  const curr4 = "a\nb\nc\nD\ne\nf\ng";
  assert(verifyAnchorContent(prev, curr4, edits), "non-anchor line 4 changed → still match");
}

// ── Test 28: findFirstChangedLine ────────────────────────────────────────────
console.log("\n─ findFirstChangedLine ─");

assertEq(findFirstChangedLine("a\nb\nc", "a\nb\nc"), undefined, "identical → undefined");
assertEq(findFirstChangedLine("a\nb\nc", "a\nB\nc"), 2, "line 2 changed");
assertEq(findFirstChangedLine("a\nb\nc", "A\nb\nc"), 1, "line 1 changed");
assertEq(findFirstChangedLine("a\nb\nc", "a\nb\nC"), 3, "line 3 changed");
assertEq(findFirstChangedLine("a\nb", "a\nb\nc"), 3, "line added at end");

// ── Test 29: 3-way merge recovery ────────────────────────────────────────────
console.log("\n─ 3-way merge recovery ─");

{
  const previousText = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
  const currentText = "LINE1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
  const edits: EditOp[] = [
    { kind: "swap", start: 7, end: 7, lines: ["LINE7"] },
  ];
  const result = applyEditsToSnapshot(previousText, currentText, edits, RECOVERY_EXTERNAL_WARNING);
  assert(result !== null, "3-way merge succeeds (context intact)");
  if (result) {
    assertEq(result.text, "LINE1\nline2\nline3\nline4\nline5\nline6\nLINE7\nline8\nline9\nline10", "merged text correct");
    assertEq(result.firstChangedLine, 7, "first changed line = 7");
    assert(result.warnings.includes(RECOVERY_EXTERNAL_WARNING), "external warning present");
  }
}

// ── Test 30: 3-way merge recovery fails (context changed) ────────────────────
console.log("\n─ 3-way merge recovery: context changed ─");

{
  const previousText = "line1\nline2\nline3\nline4\nline5";
  const currentText = "line1\nLINE2\nLINE3\nline4\nline5";
  const edits: EditOp[] = [
    { kind: "swap", start: 2, end: 2, lines: ["NEW2"] },
  ];
  const result = applyEditsToSnapshot(previousText, currentText, edits, RECOVERY_EXTERNAL_WARNING);
  assert(result === null, "3-way merge fails (context line 3 changed)");
}

// ── Test 31: Session-chain replay ────────────────────────────────────────────
console.log("\n─ Session-chain replay ─");

{
  const previousText = "line1\nline2\nline3\nline4\nline5";
  const currentText = "line1\nline2\nline3\nline4\nLINE5";
  const edits: EditOp[] = [
    { kind: "swap", start: 3, end: 3, lines: ["LINE3"] },
  ];
  const result = replaySessionChainOnCurrent(previousText, currentText, edits);
  assert(result !== null, "session-chain replay succeeds (line counts match, anchor intact)");
  if (result) {
    assertEq(result.text, "line1\nline2\nLINE3\nline4\nLINE5", "replayed text correct");
    assertEq(result.firstChangedLine, 3, "first changed line = 3");
    assert(result.warnings.includes(RECOVERY_SESSION_REPLAY_WARNING), "replay warning present");
  }
}

// ── Test 32: Session-chain replay fails (line count mismatch) ────────────────
console.log("\n─ Session-chain replay: line count mismatch ─");

{
  const previousText = "line1\nline2\nline3";
  const currentText = "line1\nline2";
  const edits: EditOp[] = [
    { kind: "swap", start: 3, end: 3, lines: ["NEW3"] },
  ];
  const result = replaySessionChainOnCurrent(previousText, currentText, edits);
  assert(result === null, "session-chain replay fails (line count mismatch)");
}

// ── Test 33: Session-chain replay fails (anchor content mismatch) ────────────
console.log("\n─ Session-chain replay: anchor content mismatch ─");

{
  const previousText = "line1\nline2\nline3";
  const currentText = "line1\nCHANGED\nline3";
  const edits: EditOp[] = [
    { kind: "swap", start: 2, end: 2, lines: ["NEW2"] },
  ];
  const result = replaySessionChainOnCurrent(previousText, currentText, edits);
  assert(result === null, "session-chain replay fails (anchor line 2 changed)");
}

// ── Test 34: tryRecover (3-way merge path) ───────────────────────────────────
console.log("\n─ tryRecover: 3-way merge path ─");

{
  const store = new SnapshotStore();
  const filePath = "/test/file.txt";
  const hash = store.record(filePath, "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10");
  const currentText = "LINE1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
  const edits: EditOp[] = [
    { kind: "swap", start: 7, end: 7, lines: ["LINE7"] },
  ];
  const result = tryRecover(store, { path: filePath, currentText, fileHash: hash, edits });
  assert(result !== null, "tryRecover succeeds via 3-way merge");
  if (result) {
    assertEq(result.text, "LINE1\nline2\nline3\nline4\nline5\nline6\nLINE7\nline8\nline9\nline10", "recovered text correct");
    assert(result.warnings.includes(RECOVERY_EXTERNAL_WARNING), "external warning (head snapshot)");
  }
}

// ── Test 35: tryRecover (session-chain replay path) ──────────────────────────
console.log("\n─ tryRecover: session-chain replay path ─");

{
  const store = new SnapshotStore();
  const filePath = "/test/file.txt";
  const hash1 = store.record(filePath, "line1\nline2\nline3\nline4\nline5");
  store.record(filePath, "line1\nline2\nline3\nline4\nLINE5");
  const currentText = "line1\nCHANGED\nline3\nline4\nLINE5";
  const edits: EditOp[] = [
    { kind: "swap", start: 3, end: 3, lines: ["LINE3"] },
  ];
  const result = tryRecover(store, { path: filePath, currentText, fileHash: hash1, edits });
  assert(result !== null, "tryRecover succeeds via session-chain replay");
  if (result) {
    assertEq(result.text, "line1\nCHANGED\nLINE3\nline4\nLINE5", "recovered text correct");
    assert(result.warnings.includes(RECOVERY_SESSION_REPLAY_WARNING), "replay warning present");
  }
}

// ── Test 36: tryRecover fails (hash not recognized) ──────────────────────────
console.log("\n─ tryRecover: hash not recognized ─");

{
  const store = new SnapshotStore();
  const filePath = "/test/file.txt";
  store.record(filePath, "line1\nline2\nline3");
  const currentText = "line1\nline2\nline3";
  const edits: EditOp[] = [
    { kind: "swap", start: 2, end: 2, lines: ["NEW2"] },
  ];
  const result = tryRecover(store, { path: filePath, currentText, fileHash: "XXXX", edits });
  assert(result === null, "tryRecover fails (hash not in store)");
}

// ── Test 37: formatAnchoredContext ───────────────────────────────────────────
console.log("\n─ formatAnchoredContext ─");

{
  const fileLines = ["line1", "line2", "line3", "line4", "line5"];
  const ctx = formatAnchoredContext([2], fileLines);
  assertEq(ctx.length, 4, "anchor at line 2 with context=2 → 4 lines (1-4)");
  assertEq(ctx[0], " 1:line1", "line 1 with space marker");
  assertEq(ctx[1], "*2:line2", "line 2 with star marker");
  assertEq(ctx[2], " 3:line3", "line 3 with space marker");
}

// ── Test 38: formatAnchoredContext with gap ──────────────────────────────────
console.log("\n─ formatAnchoredContext: gap ─");

{
  const fileLines = ["line1", "line2", "line3", "line4", "line5", "line6", "line7", "line8", "line9", "line10"];
  const ctx = formatAnchoredContext([2, 9], fileLines);
  assert(ctx.includes("..."), "gap marker present between distant anchors");
  assert(ctx.some(r => r.startsWith("*2:")), "anchor at line 2 marked with *");
  assert(ctx.some(r => r.startsWith("*9:")), "anchor at line 9 marked with *");
}

// ── Test 39: formatMismatchError (recognized hash) ───────────────────────────
console.log("\n─ formatMismatchError: recognized hash ─");

{
  const error = formatMismatchError({
    path: "test.ts",
    expectedHash: "A1B2",
    actualHash: "C3D4",
    fileLines: ["line1", "line2", "line3"],
    anchorLines: [2],
    hashRecognized: true,
  });
  assert(error.includes("file changed between read and edit"), "recognized: mentions file change");
  assert(error.includes("#A1B2"), "recognized: shows expected hash");
  assert(error.includes("#C3D4"), "recognized: shows actual hash");
  assert(error.includes("*2:line2"), "recognized: shows anchored context");
}

// ── Test 40: formatMismatchError (unrecognized hash) ─────────────────────────
console.log("\n─ formatMismatchError: unrecognized hash ─");

{
  const error = formatMismatchError({
    path: "test.ts",
    expectedHash: "XXXX",
    actualHash: "C3D4",
    fileLines: ["line1", "line2", "line3"],
    anchorLines: [2],
    hashRecognized: false,
  });
  assert(error.includes("not from this session"), "unrecognized: mentions not from session");
  assert(error.includes("#XXXX"), "unrecognized: shows expected hash");
  assert(error.includes("#C3D4"), "unrecognized: shows actual hash");
  assert(error.includes("Re-read"), "unrecognized: tells model to re-read");
}

// ── Test 41: SnapshotStore basics ────────────────────────────────────────────
console.log("\n─ SnapshotStore ─");

{
  const store = new SnapshotStore();
  const filePath = "/test/file.txt";

  const hash1 = store.record(filePath, "hello\nworld\n");
  assert(/^[0-9A-F]{4}$/.test(hash1), `record returns 4-hex hash (got: ${hash1})`);

  const snap = store.byHash(filePath, hash1);
  assert(snap !== null, "byHash finds snapshot");
  assertEq(snap?.hash, hash1, "snapshot hash matches");
  assertEq(snap?.text, "hello\nworld\n", "snapshot text matches");

  const head = store.head(filePath);
  assert(head !== null, "head returns snapshot");
  assertEq(head?.hash, hash1, "head hash matches");

  const hash1b = store.record(filePath, "hello\nworld\n");
  assertEq(hash1b, hash1, "same content → same hash (dedup)");

  const hash2 = store.record(filePath, "hello\nworld\nfoo\n");
  assert(hash2 !== hash1, "different content → different hash");

  const head2 = store.head(filePath);
  assertEq(head2?.hash, hash2, "head updated to new hash");

  const snap1 = store.byHash(filePath, hash1);
  assert(snap1 !== null, "byHash still finds old snapshot");

  store.invalidate(filePath);
  assert(store.byHash(filePath, hash1) === null, "invalidate removes old snapshot");
  assert(store.byHash(filePath, hash2) === null, "invalidate removes new snapshot");
  assert(store.head(filePath) === null, "head is null after invalidate");
}

// ── Test 42: SnapshotStore LRU eviction (path limit) ─────────────────────────
console.log("\n─ SnapshotStore: LRU path eviction ─");

{
  const store = new SnapshotStore();
  for (let i = 0; i < 35; i++) {
    store.record(`/test/file${i}.txt`, `content${i}\n`);
  }
  assert(store.byHash("/test/file0.txt", computeFileHash("content0\n")) === null, "file0 evicted");
  assert(store.byHash("/test/file4.txt", computeFileHash("content4\n")) === null, "file4 evicted");
  assert(store.byHash("/test/file5.txt", computeFileHash("content5\n")) !== null, "file5 retained");
  assert(store.byHash("/test/file34.txt", computeFileHash("content34\n")) !== null, "file34 retained");
}

// ── Test 43: SnapshotStore version limit ─────────────────────────────────────
console.log("\n─ SnapshotStore: version limit ─");

{
  const store = new SnapshotStore();
  const filePath = "/test/file.txt";
  const hashes: string[] = [];
  for (let i = 0; i < 6; i++) {
    hashes.push(store.record(filePath, `version${i}\n`));
  }
  assert(store.byHash(filePath, hashes[0]!) === null, "version 0 evicted");
  assert(store.byHash(filePath, hashes[1]!) === null, "version 1 evicted");
  assert(store.byHash(filePath, hashes[2]!) !== null, "version 2 retained");
  assert(store.byHash(filePath, hashes[5]!) !== null, "version 5 retained");
  assertEq(store.head(filePath)?.hash, hashes[5], "head is latest version");
}

// ── Test 44: Write tool utilities ────────────────────────────────────────────
console.log("\n─ Write tool utilities ─");

assertEq(unwrapHashlineHeaderPath("[src/foo.ts#1A2B]"), "src/foo.ts", "unwrapHashlineHeaderPath: [src/foo.ts#1A2B] → src/foo.ts");
assertEq(unwrapHashlineHeaderPath("[foo.ts#ABCD]"), "foo.ts", "unwrapHashlineHeaderPath: [foo.ts#ABCD] → foo.ts");
assertEq(unwrapHashlineHeaderPath("src/foo.ts"), "src/foo.ts", "unwrapHashlineHeaderPath: no brackets → as-is");
assertEq(unwrapHashlineHeaderPath("[]"), "[]", "unwrapHashlineHeaderPath: too short → as-is");
assertEq(unwrapHashlineHeaderPath("[a]"), "a", "unwrapHashlineHeaderPath: no tag → path extracted");
assertEq(unwrapHashlineHeaderPath("[a#1#A1B2]"), "[a#1#A1B2]", "unwrapHashlineHeaderPath: embedded # in path → rejected");
assertEq(unwrapHashlineHeaderPath("[foo.ts#ZZZZ]"), "[foo.ts#ZZZZ]", "unwrapHashlineHeaderPath: non-hex tag → rejected");
assertEq(unwrapHashlineHeaderPath("[foo.ts#1A2B]  "), "foo.ts", "unwrapHashlineHeaderPath: trimEnd handles trailing whitespace");

assertEq(stripLeadingHashlinePrefix("1:hello"), "hello", "stripLeadingHashlinePrefix: 1:hello → hello");
assertEq(stripLeadingHashlinePrefix("42:world"), "world", "stripLeadingHashlinePrefix: 42:world → world");
assertEq(stripLeadingHashlinePrefix("hello"), "hello", "stripLeadingHashlinePrefix: no prefix → as-is");
assertEq(stripLeadingHashlinePrefix(" 3:indented"), "indented", "stripLeadingHashlinePrefix: leading space ok");

{
  const lines1 = ["1:foo", "2:bar"];
  const out1 = stripHashlinePrefixes(lines1);
  assertEq(JSON.stringify(out1), JSON.stringify(["foo", "bar"]), "stripHashlinePrefixes: all prefixed → stripped");

  const lines2 = ["1:foo", "bar"];
  const out2 = stripHashlinePrefixes(lines2);
  assertEq(out2, lines2, "stripHashlinePrefixes: mixed → returned by reference");
  assertEq(JSON.stringify(out2), JSON.stringify(["1:foo", "bar"]), "stripHashlinePrefixes: mixed → content unchanged");

  const lines3 = ["[foo.ts#1A2B]", "1:foo", "2:bar"];
  const out3 = stripHashlinePrefixes(lines3);
  assertEq(JSON.stringify(out3), JSON.stringify(["foo", "bar"]), "stripHashlinePrefixes: header stripped + prefixes stripped");

  const lines4 = ["", "1:foo", ""];
  const out4 = stripHashlinePrefixes(lines4);
  assertEq(JSON.stringify(out4), JSON.stringify(["", "foo", ""]), "stripHashlinePrefixes: empty lines preserved, prefixes stripped");

  const lines5 = ["1:foo", "bar"];
  const out5 = stripHashlinePrefixes(lines5);
  assert(out5 === lines5, "stripHashlinePrefixes: returns reference-equal to input on mismatch");

  const lines6 = ["[Showing lines 1-10 of 20. Use :L1]", "1:foo"];
  const out6 = stripHashlinePrefixes(lines6);
  assertEq(JSON.stringify(out6), JSON.stringify(["foo"]), "stripHashlinePrefixes: truncation notice stripped");
}

assertEq(stripWriteContent("1:hello\n2:world\n"), "hello\nworld\n", "stripWriteContent: prefixes stripped");
assertEq(stripWriteContent("[foo.ts#1A2B]\n1:hello\n2:world"), "hello\nworld", "stripWriteContent: header + prefixes stripped");
assertEq(stripWriteContent("hello\nworld"), "hello\nworld", "stripWriteContent: no prefixes/no header → as-is");
assertEq(stripWriteContent("[foo.ts#1A2B]\nhello\nworld"), "[foo.ts#1A2B]\nhello\nworld", "stripWriteContent: header but body not prefixed → as-is");

// ── Test 45: Parser contamination detection ──────────────────────────────────
console.log("\n─ Parser contamination detection ─");

assert(detectContamination("*** Update File:foo.ts") !== null, "detectContamination: Update File sentinel");
assert(detectContamination("*** Add File:bar.ts") !== null, "detectContamination: Add File sentinel");
assert(detectContamination("*** Delete File:baz.ts") !== null, "detectContamination: Delete File sentinel");
assert(detectContamination("*** Move to:qux.ts") !== null, "detectContamination: Move to sentinel");
assert(detectContamination("@@ -1,3 +1,3 @@") !== null, "detectContamination: unified-diff hunk header");
assert(detectContamination("@@ -1 +1 @@") !== null, "detectContamination: simple @@ hunk header");
assert(detectContamination("@@@") !== null, "detectContamination: starts with @@ fallback");
assertEq(detectContamination(""), null, "detectContamination: empty → null");
assertEq(detectContamination("   "), null, "detectContamination: whitespace only → null");
assertEq(detectContamination("SWAP 1.=3:"), null, "detectContamination: valid hashline op → null");
assertEq(detectContamination("[foo.ts#1A2B]"), null, "detectContamination: valid header → null");

{
  let threw = false;
  try {
    parsePatch("[foo.ts#1A2B]\n*** Update File:foo.ts\nSWAP 1.=1:\n+new");
  } catch {
    threw = true;
  }
  assert(threw, "parsePatch: contamination detected (Update File inside section) → throws");

  const abortSections = parsePatch("[foo.ts#1A2B]\n*** Abort");
  assertEq(abortSections.length, 1, "parsePatch: *** Abort breaks the loop, current section pushed");
  assertEq(abortSections[0]?.path, "foo.ts", "parsePatch: *** Abort path preserved");
  assertEq(abortSections[0]?.hash, "1A2B", "parsePatch: *** Abort hash preserved");
  assertEq(abortSections[0]?.edits.length, 0, "parsePatch: *** Abort edits empty");

  threw = false;
  try {
    parsePatch("[foo.ts#1A2B]\nSWAP 1.=1:\n-new");
  } catch {
    threw = true;
  }
  assert(threw, "parsePatch: `-` body row → throws");

  threw = false;
  try {
    parsePatch("[foo.ts#1A2B]\nSWAP 1.=1:");
  } catch {
    threw = true;
  }
  assert(threw, "parsePatch: empty SWAP body → throws");
}

// ── Test 46: Line bounds validation ──────────────────────────────────────────
console.log("\n─ Line bounds validation ─");

{
  const fileLines = ["a", "b", "c"];

  assertEq(validateLineBounds([{ kind: "swap", start: 1, end: 3, lines: ["x", "y", "z"] }], fileLines), null, "validateLineBounds: valid 1-3 swap");
  assert(validateLineBounds([{ kind: "swap", start: 1, end: 4, lines: ["x"] }], fileLines) !== null, "validateLineBounds: end > lineCount");
  assert(validateLineBounds([{ kind: "swap", start: 0, end: 1, lines: ["x"] }], fileLines) !== null, "validateLineBounds: start < 1");
  assertEq(validateLineBounds([{ kind: "delete", start: 2, end: 2 }], fileLines), null, "validateLineBounds: valid delete 2-2");
  assert(validateLineBounds([{ kind: "delete", start: 5, end: 5 }], fileLines) !== null, "validateLineBounds: delete out of bounds");
  assertEq(validateLineBounds([{ kind: "insert", position: "before", anchor: 2, lines: ["x"] }], fileLines), null, "validateLineBounds: valid INS.PRE 2");
  assertEq(validateLineBounds([{ kind: "insert", position: "after", anchor: 3, lines: ["x"] }], fileLines), null, "validateLineBounds: valid INS.POST 3");
  assert(validateLineBounds([{ kind: "insert", position: "after", anchor: 4, lines: ["x"] }], fileLines) !== null, "validateLineBounds: INS.POST out of bounds");
  assertEq(validateLineBounds([{ kind: "insert", position: "head", anchor: 0, lines: ["x"] }], fileLines), null, "validateLineBounds: INS.HEAD skipped");
  assertEq(validateLineBounds([{ kind: "insert", position: "tail", anchor: 0, lines: ["x"] }], fileLines), null, "validateLineBounds: INS.TAIL skipped");
}

// ── Test 47: Header recovery ─────────────────────────────────────────────────
console.log("\n─ Header recovery ─");

assertEq(stripApplyPatchPathNoise("***Update File:foo.ts"), "foo.ts", "stripApplyPatchPathNoise: ***Update File:");
assertEq(stripApplyPatchPathNoise("Update File:foo.ts"), "foo.ts", "stripApplyPatchPathNoise: Update File:");
assertEq(stripApplyPatchPathNoise("***foo.ts"), "foo.ts", "stripApplyPatchPathNoise: ***foo.ts");
assertEq(stripApplyPatchPathNoise("foo.ts"), "foo.ts", "stripApplyPatchPathNoise: clean path unchanged");

assertEq(JSON.stringify(tryParseRecoveryHeader("[***Update File:foo.ts#CB5A]")), JSON.stringify({ path: "foo.ts", hash: "CB5A" }), "tryParseRecoveryHeader: noise stripped + hash uppercase");
assertEq(JSON.stringify(tryParseRecoveryHeader("[foo.ts#1A2B]")), JSON.stringify({ path: "foo.ts", hash: "1A2B" }), "tryParseRecoveryHeader: normal case works");
assertEq(tryParseRecoveryHeader("[foo#bar#1234]"), null, "tryParseRecoveryHeader: embedded # in body → null");
assertEq(tryParseRecoveryHeader("[]"), null, "tryParseRecoveryHeader: empty body → null");
assertEq(tryParseRecoveryHeader("[foo.ts]"), null, "tryParseRecoveryHeader: no tag → null");
assertEq(tryParseRecoveryHeader("not a header"), null, "tryParseRecoveryHeader: not a bracket line → null");

{
  const r1 = tryParseRecoveryHeader("[***Update File:foo.ts#CB5A]");
  assertEq(r1?.hash, "CB5A", "tryParseRecoveryHeader: hash is uppercase");
}

{
  const recoverySections = parsePatch("[***Update File:foo.ts#1A2B]\nSWAP 1.=1:\n+new");
  assertEq(recoverySections.length, 1, "parsePatch: recovery header parses one section");
  assertEq(recoverySections[0]?.path, "foo.ts", "parsePatch: recovery header path noise stripped");
  assertEq(recoverySections[0]?.hash, "1A2B", "parsePatch: recovery header hash preserved");
}

// ── Test 48: MismatchError class ─────────────────────────────────────────────
console.log("\n─ MismatchError class ─");

{
  const err = new MismatchError({
    path: "foo.ts",
    expectedHash: "1A2B",
    actualHash: "3C4D",
    fileLines: ["a", "b"],
    anchorLines: [1],
    hashRecognized: true,
  });
  assert(err instanceof Error, "MismatchError: instanceof Error");
  assert(err instanceof MismatchError, "MismatchError: instanceof MismatchError");
  assertEq(err.name, "MismatchError", "MismatchError: .name set");
  assertEq(err.path, "foo.ts", "MismatchError: .path set");
  assertEq(err.expectedHash, "1A2B", "MismatchError: .expectedHash set");
  assertEq(err.actualHash, "3C4D", "MismatchError: .actualHash set");
  assertEq(err.hashRecognized, true, "MismatchError: .hashRecognized set");
  assert(err.message.includes("file changed between read and edit"), "MismatchError (recognized): message mentions file change");
  assertEq(err.displayMessage, err.message, "MismatchError: .displayMessage === .message");
}

{
  const errUnrecognized = new MismatchError({
    path: "foo.ts",
    expectedHash: "0000",
    actualHash: "3C4D",
    fileLines: [],
    anchorLines: [],
    hashRecognized: false,
  });
  assert(errUnrecognized.message.includes("not from this session"), "MismatchError (unrecognized): mentions not from session");
}

{
  const header1 = MismatchError.rejectionHeader({
    path: "foo.ts",
    expectedHash: "1A2B",
    actualHash: "3C4D",
    fileLines: [],
    anchorLines: [],
    hashRecognized: true,
  });
  assert(Array.isArray(header1), "rejectionHeader: returns array");
  assertEq(header1.length, 2, "rejectionHeader: 2 strings");
  assert(header1[0]!.includes("file changed between read and edit"), "rejectionHeader (recognized): line 0 mentions file change");

  const header2 = MismatchError.rejectionHeader({
    path: "foo.ts",
    expectedHash: "0000",
    actualHash: "3C4D",
    fileLines: [],
    anchorLines: [],
    hashRecognized: false,
  });
  assert(header2[0]!.includes("not from this session"), "rejectionHeader (unrecognized): line 0 mentions not from session");
}

{
  const details = {
    path: "foo.ts",
    expectedHash: "1A2B",
    actualHash: "3C4D",
    fileLines: ["a", "b"],
    anchorLines: [1] as readonly number[],
    hashRecognized: true,
  };
  const fromFormat = formatMismatchError(details);
  const fromClass = new MismatchError(details).displayMessage;
  assertEq(fromFormat, fromClass, "formatMismatchError produces same output as MismatchError.displayMessage");
}

// ── Test 49: canonicalPath for non-existing files ────────────────────────────
console.log("\n─ canonicalPath for non-existing files ─");

{
  const existingFile = join(tmpDir, "exists.txt");
  writeFileSync(existingFile, "hello\n");
  const realExisting = canonicalPath(existingFile);
  assert(realExisting.includes(tmpDir), "canonicalPath: existing file → realpath contains tmpDir");
  assert(realExisting.endsWith("exists.txt"), "canonicalPath: existing file → realpath ends with basename");

  const nonExistingInDir = join(tmpDir, "nonexistent.txt");
  const realNonExisting = canonicalPath(nonExistingInDir);
  assert(realNonExisting.includes(tmpDir), "canonicalPath: non-existing in existing dir → realpath contains tmpDir");
  assert(realNonExisting.endsWith("nonexistent.txt"), "canonicalPath: non-existing → realpath ends with basename");

  const nonExistingInMissingDir = join(tmpDir, "nonexistent-dir", "file.txt");
  const realMissing = canonicalPath(nonExistingInMissingDir);
  assertEq(realMissing, nonExistingInMissingDir, "canonicalPath: non-existing in non-existing dir → input as-is");
}

// ── Test 50: Trailing phantom line ───────────────────────────────────────────
console.log("\n─ Trailing phantom line ─");

assertEq(trailingPhantomLine(["a", "b", "c"]), 0, "trailingPhantomLine: no phantom");
assertEq(trailingPhantomLine(["a", "b", ""]), 3, "trailingPhantomLine: phantom at line 3");
assertEq(trailingPhantomLine(["a", "b", "c", ""]), 4, "trailingPhantomLine: phantom at line 4");
assertEq(trailingPhantomLine([""]), 0, "trailingPhantomLine: length 1 → 0");
assertEq(trailingPhantomLine([]), 0, "trailingPhantomLine: length 0 → 0");
assertEq(trailingPhantomLine(["", ""]), 2, "trailingPhantomLine: phantom at line 2");

{
  const fileLines = ["a", "b", ""];

  const r1 = dropTrailingPhantomDeletes([{ kind: "delete", start: 3, end: 3 }], fileLines);
  assertEq(r1.length, 0, "dropTrailingPhantomDeletes: single phantom delete dropped");

  const r2 = dropTrailingPhantomDeletes([{ kind: "delete", start: 2, end: 3 }], fileLines);
  assertEq(r2.length, 1, "dropTrailingPhantomDeletes: range clamped to 1 edit");
  if (r2[0]?.kind === "delete") {
    assertEq(r2[0].start, 2, "dropTrailingPhantomDeletes: clamped start");
    assertEq(r2[0].end, 2, "dropTrailingPhantomDeletes: clamped end to phantom-1");
  }

  const r3 = dropTrailingPhantomDeletes([{ kind: "delete", start: 1, end: 1 }], fileLines);
  assertEq(r3.length, 1, "dropTrailingPhantomDeletes: unaffected delete preserved");
  if (r3[0]?.kind === "delete") {
    assertEq(r3[0].start, 1, "dropTrailingPhantomDeletes: unaffected delete start preserved");
  }

  const r4 = dropTrailingPhantomDeletes([{ kind: "swap", start: 1, end: 1, lines: ["x"] }], fileLines);
  assertEq(r4.length, 1, "dropTrailingPhantomDeletes: swap unaffected");

  const r5 = dropTrailingPhantomDeletes([{ kind: "delete", start: 3, end: 3 }], ["a", "b", "c"]);
  assertEq(r5.length, 1, "dropTrailingPhantomDeletes: no phantom → copied");
  if (r5[0]?.kind === "delete") {
    assertEq(r5[0].start, 3, "dropTrailingPhantomDeletes: no phantom → delete preserved");
  }
}

// ── Test 51: Multi-section duplicate path detection ──────────────────────────
console.log("\n─ Multi-section duplicate paths ─");

{
  const ok = assertUniqueCanonicalPaths([
    { path: "foo.ts", hash: "1A2B", edits: [] },
    { path: "bar.ts", hash: "3C4D", edits: [] },
  ]);
  assertEq(ok, null, "assertUniqueCanonicalPaths: different paths → null");

  const dup = assertUniqueCanonicalPaths([
    { path: "foo.ts", hash: "1A2B", edits: [] },
    { path: "foo.ts", hash: "3C4D", edits: [] },
  ]);
  assert(dup !== null, "assertUniqueCanonicalPaths: same path → error");
  if (dup) {
    assert(dup.includes("Multiple sections resolve to the same file"), "assertUniqueCanonicalPaths: error mentions duplicates");
    assert(dup.includes("foo.ts"), "assertUniqueCanonicalPaths: error mentions path");
  }

  const single = assertUniqueCanonicalPaths([
    { path: "foo.ts", hash: "1A2B", edits: [] },
  ]);
  assertEq(single, null, "assertUniqueCanonicalPaths: single section → null");
}

// ── Test 52: Compact diff preview ────────────────────────────────────────────
console.log("\n─ Compact diff preview ─");

{
  const d1 = buildNumberedDiff("a\nb\nc", "a\nx\nc");
  assert(d1.includes(" 1|a"), "buildNumberedDiff: context line 1");
  assert(d1.includes("-2|b"), "buildNumberedDiff: removal at line 2");
  assert(d1.includes("+2|x"), "buildNumberedDiff: addition at line 2");
  assert(d1.includes(" 3|c"), "buildNumberedDiff: context line 3");

  const d2 = buildNumberedDiff("hello", "hello");
  assertEq(d2, "", "buildNumberedDiff: identical → empty");

  const d3 = buildNumberedDiff("a\nb", "a\nb\nc");
  assert(d3.includes("+3|c"), "buildNumberedDiff: appended line at 3");
}

{
  const p1: CompactDiffPreview = buildCompactDiffPreview("");
  assertEq(p1.preview, "", "buildCompactDiffPreview: empty diff → empty preview");
  assertEq(p1.addedLines, 0, "buildCompactDiffPreview: empty diff → 0 added");
  assertEq(p1.removedLines, 0, "buildCompactDiffPreview: empty diff → 0 removed");

  const p2: CompactDiffPreview = buildCompactDiffPreview("+1|new\n+2|line");
  assertEq(p2.preview, "1:new\n2:line", "buildCompactDiffPreview: all-added (no elision)");
  assertEq(p2.addedLines, 2, "buildCompactDiffPreview: all-added → 2 added");
  assertEq(p2.removedLines, 0, "buildCompactDiffPreview: all-added → 0 removed");

  const p3: CompactDiffPreview = buildCompactDiffPreview("-1|old\n-2|gone");
  assertEq(p3.preview, "", "buildCompactDiffPreview: all-removed → empty preview");
  assertEq(p3.addedLines, 0, "buildCompactDiffPreview: all-removed → 0 added");
  assertEq(p3.removedLines, 2, "buildCompactDiffPreview: all-removed → 2 removed");

  const p4: CompactDiffPreview = buildCompactDiffPreview(" 1|ctx\n-2|old\n+2|new\n 3|ctx");
  assert(p4.preview.includes("1:ctx"), "buildCompactDiffPreview: mixed contains ctx line 1");
  assert(p4.preview.includes("2:new"), "buildCompactDiffPreview: mixed contains added line 2");
  assert(p4.preview.includes("3:ctx"), "buildCompactDiffPreview: mixed contains ctx line 3");

  const p5: CompactDiffPreview = buildCompactDiffPreview("+1|a\n+2|b\n+3|c\n+4|d\n+5|e\n+6|f");
  assert(p5.preview.includes("…"), "buildCompactDiffPreview: 6 added → elision marker present");
  assert(p5.preview.split("\n").length < 6, "buildCompactDiffPreview: 6 added → preview has fewer than 6 lines");
  assertEq(p5.addedLines, 6, "buildCompactDiffPreview: 6 added → addedLines=6");
}

// ── Test 53: Seen lines tracking ─────────────────────────────────────────────
console.log("\n─ Seen lines tracking ─");

assertEq(JSON.stringify(parseSeenLinesFromHashlineBody("1:foo\n2:bar\n3:baz")), JSON.stringify([1, 2, 3]), "parseSeenLinesFromHashlineBody: 3 simple rows");
assertEq(JSON.stringify(parseSeenLinesFromHashlineBody("1-5:content")), JSON.stringify([1, 5]), "parseSeenLinesFromHashlineBody: range row");
assertEq(JSON.stringify(parseSeenLinesFromHashlineBody(" 3:indented")), JSON.stringify([3]), "parseSeenLinesFromHashlineBody: single space prefix");
assertEq(JSON.stringify(parseSeenLinesFromHashlineBody("*7:starred")), JSON.stringify([7]), "parseSeenLinesFromHashlineBody: star prefix");
assertEq(JSON.stringify(parseSeenLinesFromHashlineBody("not a line")), JSON.stringify([]), "parseSeenLinesFromHashlineBody: no match");
assertEq(JSON.stringify(parseSeenLinesFromHashlineBody("")), JSON.stringify([]), "parseSeenLinesFromHashlineBody: empty");
assertEq(JSON.stringify(parseSeenLinesFromHashlineBody("1:foo\nbar\n3:baz")), JSON.stringify([1, 3]), "parseSeenLinesFromHashlineBody: non-matching line skipped");

assertEq(formatLineRanges([1, 2, 3, 4]), "1-4", "formatLineRanges: contiguous");
assertEq(formatLineRanges([1, 3, 5]), "1, 3, 5", "formatLineRanges: scattered");
assertEq(formatLineRanges([1, 2, 3, 7, 10, 11, 12]), "1-3, 7, 10-12", "formatLineRanges: mixed");
assertEq(formatLineRanges([]), "", "formatLineRanges: empty");
assertEq(formatLineRanges([5]), "5", "formatLineRanges: single");
assertEq(formatLineRanges([3, 1, 2]), "1-3", "formatLineRanges: sorted + deduped");

{
  const msg = unseenLinesMessage("foo.ts", [5, 6], "1A2B");
  assert(msg.includes("lines 5-6 of foo.ts"), "unseenLinesMessage: contains ranges and path");
  assert(msg.includes("#1A2B"), "unseenLinesMessage: contains tag");
  assert(msg.includes("Re-read"), "unseenLinesMessage: contains Re-read");
}

{
  const seenPath = "/test/seen-lines-test.ts";
  const text = "a\nb\nc\n";
  const hash = snapshotStore.record(seenPath, text, new Set([1, 2, 3]));

  const seen1 = assertSeenLines(
    { path: seenPath, hash, edits: [{ kind: "swap", start: 1, end: 1, lines: ["x"] }] },
    seenPath,
    hash,
  );
  assertEq(seen1, null, "assertSeenLines: line 1 was seen → null");

  const seen2 = assertSeenLines(
    { path: seenPath, hash, edits: [{ kind: "swap", start: 5, end: 5, lines: ["x"] }] },
    seenPath,
    hash,
  );
  assert(seen2 !== null, "assertSeenLines: line 5 was NOT seen → error");

  const seen3 = assertSeenLines(
    { path: seenPath, hash: "0000", edits: [] },
    seenPath,
    "0000",
  );
  assertEq(seen3, null, "assertSeenLines: hash not found → null");
}

{
  const freshStore = new SnapshotStore();
  const p = "/test/record-seen-test.ts";
  const h = freshStore.record(p, "a\nb\nc\n");
  freshStore.recordSeenLines(p, h, [1, 2]);
  const snap = freshStore.byHash(p, h);
  assert(snap !== null, "SnapshotStore.recordSeenLines: snapshot exists");
  assert(snap!.seenLines !== undefined, "SnapshotStore.recordSeenLines: seenLines populated");
  assertEq(snap!.seenLines!.size, 2, "SnapshotStore.recordSeenLines: seenLines has 2 entries");
  assert(snap!.seenLines!.has(1), "SnapshotStore.recordSeenLines: contains 1");
  assert(snap!.seenLines!.has(2), "SnapshotStore.recordSeenLines: contains 2");
}

// ── Test 54: Noop loop guard ─────────────────────────────────────────────────
console.log("\n─ Noop loop guard ─");

{
  const h1 = hashPatchInput("test");
  assert(/^[a-f0-9]{32}$/.test(h1), `hashPatchInput: returns 32-char hex (got: ${h1})`);
  assertEq(hashPatchInput("test"), hashPatchInput("test"), "hashPatchInput: deterministic");
  assert(hashPatchInput("test") !== hashPatchInput("different"), "hashPatchInput: different input → different hash");
}

{
  const sess1 = "test-sess-noop-1";
  const path1 = "/test/file-noop-1.txt";
  resetNoopEdit(sess1, path1);

  const r1 = recordNoopEdit(sess1, path1, "abc");
  assertEq(r1.count, 1, "recordNoopEdit: first call count=1");
  assertEq(r1.escalate, false, "recordNoopEdit: first call no escalate");

  const r2 = recordNoopEdit(sess1, path1, "abc");
  assertEq(r2.count, 2, "recordNoopEdit: second call count=2");
  assertEq(r2.escalate, false, "recordNoopEdit: second call no escalate");

  const r3 = recordNoopEdit(sess1, path1, "abc");
  assertEq(r3.count, 3, "recordNoopEdit: third call count=3");
  assertEq(r3.escalate, true, "recordNoopEdit: third call escalate (NOOP_HARD_LIMIT=3)");

  const r4 = recordNoopEdit(sess1, path1, "xyz");
  assertEq(r4.count, 1, "recordNoopEdit: different input hash → reset count=1");
  assertEq(r4.escalate, false, "recordNoopEdit: reset → no escalate");

  const r5 = recordNoopEdit(sess1, "/test/other.txt", "abc");
  assertEq(r5.count, 1, "recordNoopEdit: different path → separate count=1");
  assertEq(r5.escalate, false, "recordNoopEdit: separate path → no escalate");

  const sess2 = "test-sess-noop-2";
  const r6 = recordNoopEdit(sess2, path1, "abc");
  assertEq(r6.count, 1, "recordNoopEdit: different session → separate count=1");
  assertEq(r6.escalate, false, "recordNoopEdit: separate session → no escalate");

  const sess3 = "test-sess-noop-reset";
  const path3 = "/test/file-noop-reset.txt";
  recordNoopEdit(sess3, path3, "payload");
  recordNoopEdit(sess3, path3, "payload");
  resetNoopEdit(sess3, path3);
  const r7 = recordNoopEdit(sess3, path3, "payload");
  assertEq(r7.count, 1, "recordNoopEdit: reset → fresh count=1");
  assertEq(r7.escalate, false, "recordNoopEdit: reset → no escalate");

  resetNoopEdit("nonexistent-session-noop", "/file.txt");

  const diag1 = noChangeDiagnostic("foo.ts");
  assert(diag1.includes("foo.ts"), "noChangeDiagnostic: contains path");
  assert(diag1.includes("no change") || diag1.includes("byte-identical"), "noChangeDiagnostic: contains no change / byte-identical");
  assert(diag1.includes("re-read"), "noChangeDiagnostic: contains re-read");

  const diag2 = noChangeLoopDiagnostic("foo.ts", 3);
  assert(diag2.includes("foo.ts"), "noChangeLoopDiagnostic: contains path");
  assert(diag2.includes("STOP"), "noChangeLoopDiagnostic: contains STOP");
  assert(diag2.includes("3"), "noChangeLoopDiagnostic: contains count");

  assertEq(NOOP_HARD_LIMIT, 3, "NOOP_HARD_LIMIT: equals 3");
}

// ── Test 55: Block operations (tree-sitter) ─────────────────────────────────
console.log("\n─ Block operations ─");

{
  const swapBlkPatch = `[t.py#A1B2]
SWAP.BLK 1:
+def new():`;

  const swapBlkSections = parsePatch(swapBlkPatch);
  assert(swapBlkSections.length === 1, "parser: SWAP.BLK produces 1 section");
  const swapBlkEdit = swapBlkSections[0]?.edits[0];
  assert(swapBlkEdit?.kind === "block", "parser: SWAP.BLK edit has kind 'block'");
  if (swapBlkEdit?.kind === "block") {
    assertEq(swapBlkEdit.blockOp, "swap", "parser: SWAP.BLK edit has blockOp 'swap'");
    assertEq(swapBlkEdit.anchor, 1, "parser: SWAP.BLK edit anchor = 1");
    assertEq(swapBlkEdit.lines.length, 1, "parser: SWAP.BLK edit has 1 body line");
    assertEq(swapBlkEdit.lines[0], "def new():", "parser: SWAP.BLK edit body line correct");
  }

  const delBlkPatch = `[t.py#A1B2]
DEL.BLK 3`;

  const delBlkSections = parsePatch(delBlkPatch);
  const delBlkEdit = delBlkSections[0]?.edits[0];
  assert(delBlkEdit?.kind === "block", "parser: DEL.BLK edit has kind 'block'");
  if (delBlkEdit?.kind === "block") {
    assertEq(delBlkEdit.blockOp, "delete", "parser: DEL.BLK edit has blockOp 'delete'");
    assertEq(delBlkEdit.anchor, 3, "parser: DEL.BLK edit anchor = 3");
    assertEq(delBlkEdit.lines.length, 0, "parser: DEL.BLK edit has empty body (intentional)");
  }

  const insBlkPostPatch = `[t.py#A1B2]
INS.BLK.POST 1:
+# sibling
+# more`;

  const insBlkPostSections = parsePatch(insBlkPostPatch);
  const insBlkPostEdit = insBlkPostSections[0]?.edits[0];
  assert(insBlkPostEdit?.kind === "block", "parser: INS.BLK.POST edit has kind 'block'");
  if (insBlkPostEdit?.kind === "block") {
    assertEq(insBlkPostEdit.blockOp, "insert_after", "parser: INS.BLK.POST edit has blockOp 'insert_after'");
    assertEq(insBlkPostEdit.anchor, 1, "parser: INS.BLK.POST edit anchor = 1");
    assertEq(insBlkPostEdit.lines.length, 2, "parser: INS.BLK.POST edit has 2 body lines");
  }

  const emptySwapBlkPatch = `[t.py#A1B2]
SWAP.BLK 1:`;

  let emptyThrew = false;
  try { parsePatch(emptySwapBlkPatch); } catch (e) { emptyThrew = true; }
  assert(emptyThrew, "parser: empty SWAP.BLK body throws");

  const okDelBlkPatch = `[t.py#A1B2]
DEL.BLK 5`;
  let delBlkThrew = false;
  try { parsePatch(okDelBlkPatch); } catch (e) { delBlkThrew = true; }
  assert(!delBlkThrew, "parser: DEL.BLK with no body does NOT throw");
}

{
  const noBlock: EditOp[] = [
    { kind: "swap", start: 1, end: 1, lines: ["x"] },
    { kind: "delete", start: 2, end: 3 },
    { kind: "insert", position: "after", anchor: 4, lines: ["y"] },
  ];
  assert(!hasBlockEdit(noBlock), "hasBlockEdit: returns false when no block edits");

  const withBlock: EditOp[] = [
    { kind: "block", anchor: 1, lines: ["x"], blockOp: "swap" },
  ];
  assert(hasBlockEdit(withBlock), "hasBlockEdit: returns true when block edit present");

  const insBlk: EditOp[] = [
    { kind: "block", anchor: 1, lines: ["x"], blockOp: "insert_after" },
  ];
  assert(hasBlockEdit(insBlk), "hasBlockEdit: returns true for insert_after block");
}

{
  const msg = blockUnresolvedMessage(5, "replace");
  assert(msg.includes("SWAP.BLK 5"), "blockUnresolvedMessage: contains SWAP.BLK 5");
  assert(msg.includes("SWAP 5.=M"), "blockUnresolvedMessage: contains fallback SWAP 5.=M");
  assert(msg.includes("could not resolve"), "blockUnresolvedMessage: contains 'could not resolve'");

  const msgDel = blockUnresolvedMessage(7, "delete");
  assert(msgDel.includes("DEL.BLK 7"), "blockUnresolvedMessage: contains DEL.BLK 7");
  assert(msgDel.includes("DEL 7.=M"), "blockUnresolvedMessage: contains fallback DEL 7.=M");

  const singleMsg = blockSingleLineMessage(3, "replace");
  assert(singleMsg.includes("SWAP.BLK 3"), "blockSingleLineMessage: contains SWAP.BLK 3");
  assert(singleMsg.includes("single-line block"), "blockSingleLineMessage: contains 'single-line block'");
  assert(singleMsg.includes("SWAP 3.=3"), "blockSingleLineMessage: contains plain form fallback");

  const singleDel = blockSingleLineMessage(4, "delete");
  assert(singleDel.includes("DEL.BLK 4"), "blockSingleLineMessage: delete contains DEL.BLK 4");
  assert(singleDel.includes("DEL 4"), "blockSingleLineMessage: delete contains plain DEL 4");

  const singleIns = blockSingleLineMessage(5, "insert_after");
  assert(singleIns.includes("INS.BLK.POST 5"), "blockSingleLineMessage: insert_after contains INS.BLK.POST 5");
  assert(singleIns.includes("INS.POST 5"), "blockSingleLineMessage: insert_after contains plain INS.POST 5");

  assert(BLOCK_RESOLVER_UNAVAILABLE.includes("not available"), "BLOCK_RESOLVER_UNAVAILABLE: contains 'not available'");

  const closerWarn = insertAfterBlockCloserLoweredWarning(3);
  assert(closerWarn.includes("INS.BLK.POST 3"), "insertAfterBlockCloserLoweredWarning: contains anchor");
  assert(closerWarn.includes("closing delimiter"), "insertAfterBlockCloserLoweredWarning: contains 'closing delimiter'");

  const unresolvedWarn = insertAfterBlockUnresolvedLoweredWarning(7);
  assert(unresolvedWarn.includes("INS.BLK.POST 7"), "insertAfterBlockUnresolvedLoweredWarning: contains anchor");
  assert(unresolvedWarn.includes("could not resolve"), "insertAfterBlockUnresolvedLoweredWarning: contains 'could not resolve'");
}

{
  assertEq(EXTENSION_TO_WASM[".ts"], "tree-sitter-typescript.wasm", "EXTENSION_TO_WASM: .ts");
  assertEq(EXTENSION_TO_WASM[".tsx"], "tree-sitter-tsx.wasm", "EXTENSION_TO_WASM: .tsx");
  assertEq(EXTENSION_TO_WASM[".js"], "tree-sitter-javascript.wasm", "EXTENSION_TO_WASM: .js");
  assertEq(EXTENSION_TO_WASM[".py"], "tree-sitter-python.wasm", "EXTENSION_TO_WASM: .py");
  assertEq(EXTENSION_TO_WASM[".rs"], "tree-sitter-rust.wasm", "EXTENSION_TO_WASM: .rs");
  assertEq(EXTENSION_TO_WASM[".go"], "tree-sitter-go.wasm", "EXTENSION_TO_WASM: .go");
  assertEq(EXTENSION_TO_WASM[".c"], "tree-sitter-c.wasm", "EXTENSION_TO_WASM: .c");
  assertEq(EXTENSION_TO_WASM[".cpp"], "tree-sitter-cpp.wasm", "EXTENSION_TO_WASM: .cpp");
  assertEq(EXTENSION_TO_WASM[".cs"], "tree-sitter-c_sharp.wasm", "EXTENSION_TO_WASM: .cs");
  assertEq(EXTENSION_TO_WASM[".css"], "tree-sitter-css.wasm", "EXTENSION_TO_WASM: .css");
  assertEq(EXTENSION_TO_WASM[".php"], "tree-sitter-php.wasm", "EXTENSION_TO_WASM: .php");
  assertEq(EXTENSION_TO_WASM[".swift"], "tree-sitter-swift.wasm", "EXTENSION_TO_WASM: .swift");
  assertEq(EXTENSION_TO_WASM[".sol"], "tree-sitter-solidity.wasm", "EXTENSION_TO_WASM: .sol");
  assertEq(EXTENSION_TO_WASM[".vue"], "tree-sitter-vue.wasm", "EXTENSION_TO_WASM: .vue");
  assert(EXTENSION_TO_WASM[".unknown"] === undefined, "EXTENSION_TO_WASM: unknown extension → undefined");
}

await (async () => {
  const unsupportedPath = "/tmp/file.unknown";
  const sampleText = "line 1\nline 2\nline 3\n";

  const insBlk: EditOp[] = [
    { kind: "block", anchor: 1, lines: ["x"], blockOp: "insert_after" },
  ];
  const insResult = await resolveBlockEdits(insBlk, sampleText, unsupportedPath);
  assert(insResult.warnings.length === 1, "resolveBlockEdits: INS.BLK.POST unsupported → 1 warning");
  assert(insResult.warnings[0]!.includes("INS.BLK.POST 1"), "resolveBlockEdits: INS.BLK.POST warning contains anchor");
  assert(insResult.edits.length === 1, "resolveBlockEdits: INS.BLK.POST unresolved → 1 edit");
  const insEdit = insResult.edits[0]!;
  assert(insEdit.kind === "insert", "resolveBlockEdits: INS.BLK.POST lowered to insert");
  if (insEdit.kind === "insert") {
    assertEq(insEdit.position, "after", "resolveBlockEdits: lowered insert position is 'after'");
    assertEq(insEdit.anchor, 1, "resolveBlockEdits: lowered insert anchor preserved");
    assertEq(insEdit.lines[0], "x", "resolveBlockEdits: lowered insert lines preserved");
  }

  const swapBlk: EditOp[] = [
    { kind: "block", anchor: 1, lines: ["y"], blockOp: "swap" },
  ];
  let swapThrew = false;
  try { await resolveBlockEdits(swapBlk, sampleText, unsupportedPath); } catch (e) { swapThrew = true; }
  assert(swapThrew, "resolveBlockEdits: SWAP.BLK unsupported → throws");

  const delBlk: EditOp[] = [
    { kind: "block", anchor: 1, lines: [], blockOp: "delete" },
  ];
  let delThrew = false;
  try { await resolveBlockEdits(delBlk, sampleText, unsupportedPath); } catch (e) { delThrew = true; }
  assert(delThrew, "resolveBlockEdits: DEL.BLK unsupported → throws");

  const passthrough: EditOp[] = [
    { kind: "swap", start: 1, end: 1, lines: ["a"] },
  ];
  const passResult = await resolveBlockEdits(passthrough, sampleText, unsupportedPath);
  assertEq(passResult.warnings.length, 0, "resolveBlockEdits: non-block edits → no warnings");
  assertEq(passResult.edits.length, 1, "resolveBlockEdits: non-block edits → 1 edit");
  assertEq(passResult.edits[0]?.kind, "swap", "resolveBlockEdits: non-block swap preserved");

  const mixed: EditOp[] = [
    { kind: "swap", start: 1, end: 1, lines: ["a"] },
    { kind: "block", anchor: 2, lines: ["b"], blockOp: "insert_after" },
  ];
  const mixedResult = await resolveBlockEdits(mixed, sampleText, unsupportedPath);
  assertEq(mixedResult.edits.length, 2, "resolveBlockEdits: mixed edits → 2 edits");
  assertEq(mixedResult.warnings.length, 1, "resolveBlockEdits: mixed edits → 1 warning (for the block)");

  const pySource = [
    "def greet(name):",
    "    msg = 'Hello, ' + name",
    "    print(msg)",
    "",
  ].join("\n");
  const pyPath = "/tmp/test_block.py";
  writeFileSync(pyPath, pySource);

  const swapBlkPy: EditOp[] = [
    { kind: "block", anchor: 1, lines: ["def new_greet():", "    pass"], blockOp: "swap" },
  ];
  const pyResult = await resolveBlockEdits(swapBlkPy, pySource, pyPath);
  assertEq(pyResult.warnings.length, 0, "resolveBlockEdits: SWAP.BLK on Python function → no warnings");
  assertEq(pyResult.edits.length, 1, "resolveBlockEdits: SWAP.BLK on Python function → 1 edit");
  const pyEdit = pyResult.edits[0]!;
  assertEq(pyEdit.kind, "swap", "resolveBlockEdits: SWAP.BLK resolved to swap");
  if (pyEdit.kind === "swap") {
    assertEq(pyEdit.start, 1, "resolveBlockEdits: SWAP.BLK start=1");
    assertEq(pyEdit.end, 3, "resolveBlockEdits: SWAP.BLK end=3");
    assertEq(pyEdit.lines[0], "def new_greet():", "resolveBlockEdits: SWAP.BLK body preserved");
  }

  const delBlkPy: EditOp[] = [
    { kind: "block", anchor: 1, lines: [], blockOp: "delete" },
  ];
  const delResult = await resolveBlockEdits(delBlkPy, pySource, pyPath);
  assertEq(delResult.warnings.length, 0, "resolveBlockEdits: DEL.BLK on Python function → no warnings");
  assertEq(delResult.edits.length, 1, "resolveBlockEdits: DEL.BLK on Python function → 1 edit");
  const delEdit = delResult.edits[0]!;
  assertEq(delEdit.kind, "delete", "resolveBlockEdits: DEL.BLK resolved to delete");
  if (delEdit.kind === "delete") {
    assertEq(delEdit.start, 1, "resolveBlockEdits: DEL.BLK start=1");
    assertEq(delEdit.end, 3, "resolveBlockEdits: DEL.BLK end=3");
  }

  const insBlkPy: EditOp[] = [
    { kind: "block", anchor: 1, lines: ["# sibling"], blockOp: "insert_after" },
  ];
  const insPyResult = await resolveBlockEdits(insBlkPy, pySource, pyPath);
  assertEq(insPyResult.warnings.length, 0, "resolveBlockEdits: INS.BLK.POST on Python function → no warnings");
  assertEq(insPyResult.edits.length, 1, "resolveBlockEdits: INS.BLK.POST on Python function → 1 edit");
  const insPyEdit = insPyResult.edits[0]!;
  assertEq(insPyEdit.kind, "insert", "resolveBlockEdits: INS.BLK.POST resolved to insert");
  if (insPyEdit.kind === "insert") {
    assertEq(insPyEdit.position, "after", "resolveBlockEdits: INS.BLK.POST position is 'after'");
    assertEq(insPyEdit.anchor, 3, "resolveBlockEdits: INS.BLK.POST anchor=3 (end of function)");
  }

  const directSpan = await resolveBlock(pyPath, pySource, 1);
  assert(directSpan !== null, "resolveBlock: direct call resolves Python function");
  if (directSpan) {
    assertEq(directSpan.start, 1, "resolveBlock: start=1");
    assertEq(directSpan.end, 3, "resolveBlock: end=3");
  }

  const directSpan3 = await resolveBlock(pyPath, pySource, 3);
  assert(directSpan3 !== null, "resolveBlock: direct call resolves inner line");
  if (directSpan3) {
    assertEq(directSpan3.start, 3, `resolveBlock: start=3 (got ${directSpan3.start})`);
  }

  const cachedSpan = await resolveBlock(pyPath, pySource, 1);
  assert(cachedSpan !== null, "resolveBlock: second call returns same result (cached)");
  if (directSpan && cachedSpan) {
    assertEq(cachedSpan.start, directSpan.start, "resolveBlock: cached call preserves start");
    assertEq(cachedSpan.end, directSpan.end, "resolveBlock: cached call preserves end");
  }

  const syncSpan = resolveBlockSpan(pySource, 1);
  assert(syncSpan !== null, "resolveBlockSpan: direct sync call resolves");
  if (syncSpan) {
    assertEq(syncSpan.start, 1, "resolveBlockSpan: start=1");
    assertEq(syncSpan.end, 3, "resolveBlockSpan: end=3");
  }

  // P0 regression: Python source with trailing content after line-1 construct
  // The walk-up loop must NOT include the root node, or SWAP.BLK 1 would
  // resolve to the entire file span and silently destroy trailing code.
  const pySourceTrailing = [
    "def greet(name):",
    "    msg = 'Hello, ' + name",
    "    print(msg)",
    "",
    "x = 1",
  ].join("\n");
  const pyPathTrailing = "/tmp/test_block_trailing.py";
  writeFileSync(pyPathTrailing, pySourceTrailing);

  const trailingSpan = await resolveBlock(pyPathTrailing, pySourceTrailing, 1);
  assert(trailingSpan !== null, "resolveBlock: Python with trailing content → resolves");
  if (trailingSpan) {
    assertEq(trailingSpan.start, 1, "resolveBlock: Python with trailing content → start=1");
    assertEq(trailingSpan.end, 3, "resolveBlock: Python with trailing content → end=3 (NOT 5)");
  }

  // P0 regression: end-to-end SWAP.BLK on Python with trailing content.
  // Pre-fix, this would have swapped the ENTIRE file (silent data loss).
  const trailingSwapResult = await resolveBlockEdits(
    [{ kind: "block", anchor: 1, lines: ["def new_greet():", "    pass"], blockOp: "swap" }],
    pySourceTrailing,
    pyPathTrailing,
  );
  assertEq(trailingSwapResult.warnings.length, 0, "resolveBlockEdits: SWAP.BLK trailing → no warnings");
  assertEq(trailingSwapResult.edits.length, 1, "resolveBlockEdits: SWAP.BLK trailing → 1 edit");
  const trailingSwapEdit = trailingSwapResult.edits[0]!;
  if (trailingSwapEdit.kind === "swap") {
    assertEq(trailingSwapEdit.start, 1, "resolveBlockEdits: SWAP.BLK trailing → start=1");
    assertEq(trailingSwapEdit.end, 3, "resolveBlockEdits: SWAP.BLK trailing → end=3 (function only)");
  }

  // P0 regression: end-to-end DEL.BLK on Python with trailing content.
  // Pre-fix, this would have deleted the ENTIRE file.
  const trailingDelResult = await resolveBlockEdits(
    [{ kind: "block", anchor: 1, lines: [], blockOp: "delete" }],
    pySourceTrailing,
    pyPathTrailing,
  );
  assertEq(trailingDelResult.edits.length, 1, "resolveBlockEdits: DEL.BLK trailing → 1 edit");
  const trailingDelEdit = trailingDelResult.edits[0]!;
  if (trailingDelEdit.kind === "delete") {
    assertEq(trailingDelEdit.start, 1, "resolveBlockEdits: DEL.BLK trailing → start=1");
    assertEq(trailingDelEdit.end, 3, "resolveBlockEdits: DEL.BLK trailing → end=3 (function only)");
  }

  // P0 regression: TypeScript function with trailing content.
  const tsSourceTrailing = [
    "function foo() {",
    "  return 1;",
    "}",
    "",
    "const bar = 2;",
  ].join("\n");
  const tsPathTrailing = "/tmp/test_block_trailing.ts";
  writeFileSync(tsPathTrailing, tsSourceTrailing);

  const tsTrailingSpan = await resolveBlock(tsPathTrailing, tsSourceTrailing, 1);
  assert(tsTrailingSpan !== null, "resolveBlock: TypeScript with trailing content → resolves");
  if (tsTrailingSpan) {
    assertEq(tsTrailingSpan.start, 1, "resolveBlock: TypeScript with trailing content → start=1");
    assertEq(tsTrailingSpan.end, 3, "resolveBlock: TypeScript with trailing content → end=3 (NOT 5)");
  }

  try { rmSync(pyPath); } catch {}
  try { rmSync(pyPathTrailing); } catch {}
  try { rmSync(tsPathTrailing); } catch {}
})();

// ── Test 56: Compaction survival ─────────────────────────────────────────────
console.log("\n─ Compaction survival ─");

{
  const store = new SnapshotStore();
  store.record("/worktree/src/a.ts", "alpha\nbeta\ngamma\n", [1, 2, 3], "session-a");
  store.record("/worktree/src/b.ts", "delta\nepsilon\n", [1], "session-b");

  const aEntries = store.entriesForSession("session-a");
  assertEq(aEntries.length, 1, "entriesForSession: session-a → 1 entry");
  if (aEntries[0]) {
    assertEq(aEntries[0].path, "/worktree/src/a.ts", "entriesForSession: session-a path");
    assertEq(aEntries[0].lineCount, 4, "entriesForSession: session-a lineCount (3 content + trailing empty)");
  }

  const bEntries = store.entriesForSession("session-b");
  assertEq(bEntries.length, 1, "entriesForSession: session-b → 1 entry");
  if (bEntries[0]) {
    assertEq(bEntries[0].path, "/worktree/src/b.ts", "entriesForSession: session-b path");
  }

  const allEntries = store.entriesForSession();
  assertEq(allEntries.length, 2, "entriesForSession: no filter → all entries");

  const taggedTable = buildSnapshotTable(aEntries, "/worktree");
  assert(taggedTable.includes("[src/a.ts#"), `buildSnapshotTable: contains [src/a.ts#... prefix (got: ${taggedTable})`);
  assert(taggedTable.includes(" seen:1-3"), `buildSnapshotTable: contains seen:1-3 (got: ${taggedTable})`);
  assert(!taggedTable.includes("/worktree/"), "buildSnapshotTable: paths relative to worktree");

  const untaggedTable = buildSnapshotTable(allEntries);
  assert(untaggedTable.includes("/worktree/src/a.ts"), "buildSnapshotTable: no worktree → absolute paths");

  const emptyTable = buildSnapshotTable([]);
  assertEq(emptyTable, "", "buildSnapshotTable: empty entries → empty string");

  const noSeenEntry: { path: string; hash: string; seenLines?: Set<number>; lineCount: number } = {
    path: "/worktree/src/c.ts",
    hash: "DEAD",
    lineCount: 2,
  };
  const noSeenTable = buildSnapshotTable([noSeenEntry], "/worktree");
  assert(!noSeenTable.includes(" seen:"), "buildSnapshotTable: no seenLines → no ' seen:' suffix");

  const compat = new SnapshotStore();
  compat.record("/worktree/src/legacy.ts", "line1\nline2\n");
  const legacyEntries = compat.entriesForSession("any-session");
  assertEq(legacyEntries.length, 1, "entriesForSession: backward compat — undefined sessionID still matches");

  const contextStr =
    "Active file snapshots — these [path#tag] anchors remain valid after compaction. " +
    "The model uses them in edit operations. Preserve the tags and file paths in your summary.\n\n" +
    buildSnapshotTable(aEntries, "/worktree");
  assert(contextStr.startsWith("Active file snapshots —"), "compaction context: starts with preamble");
  assert(contextStr.includes("[src/a.ts#"), "compaction context: contains table");
}

// ── Test 57: Grep hashline mode ──────────────────────────────────────────────
console.log("\n─ Grep hashline mode ─");

// 1. parseGrepOutput with typical multi-file output
{
  const grepOutput = [
    "Found 3 matches",
    "",
    "/abs/path/file.ts:",
    "  Line 10: some matched text",
    "  Line 25: another match",
    "",
    "/abs/path/other.ts:",
    "  Line 5: match here",
  ].join("\n");

  const parsed = parseGrepOutput(grepOutput);
  assert(parsed !== null, "parseGrepOutput: typical multi-file → non-null");
  if (parsed) {
    assertEq(parsed.header, "Found 3 matches", "parseGrepOutput: header captured");
    assertEq(parsed.files.length, 2, "parseGrepOutput: 2 files parsed");
    assertEq(parsed.footer, "", "parseGrepOutput: no footer");
    const f0 = parsed.files[0];
    const f1 = parsed.files[1];
    assert(f0 !== undefined, "parseGrepOutput: file 0 present");
    assert(f1 !== undefined, "parseGrepOutput: file 1 present");
    if (f0) {
      assertEq(f0.path, "/abs/path/file.ts", "parseGrepOutput: file 0 path");
      assertEq(f0.matches.length, 2, "parseGrepOutput: file 0 has 2 matches");
      assertEq(f0.matches[0]?.line, 10, "parseGrepOutput: file 0 match 0 line");
      assertEq(f0.matches[0]?.text, "some matched text", "parseGrepOutput: file 0 match 0 text");
      assertEq(f0.matches[1]?.line, 25, "parseGrepOutput: file 0 match 1 line");
      assertEq(f0.matches[1]?.text, "another match", "parseGrepOutput: file 0 match 1 text");
    }
    if (f1) {
      assertEq(f1.path, "/abs/path/other.ts", "parseGrepOutput: file 1 path");
      assertEq(f1.matches.length, 1, "parseGrepOutput: file 1 has 1 match");
    }
  }
}

// 2. parseGrepOutput with 0 matches
{
  const parsed = parseGrepOutput("Found 0 matches\n");
  assert(parsed !== null, "parseGrepOutput: 0 matches → non-null");
  if (parsed) {
    assertEq(parsed.header, "Found 0 matches", "parseGrepOutput: 0 matches header");
    assertEq(parsed.files.length, 0, "parseGrepOutput: 0 matches → empty files");
    assertEq(parsed.footer, "", "parseGrepOutput: 0 matches → no footer");
  }
}

// 3. parseGrepOutput with truncation footer
{
  const grepOutput = [
    "Found 100 matches (more matches available)",
    "",
    "/abs/file.ts:",
    "  Line 1: a",
    "(Results truncated. Use limit=N to see more)",
  ].join("\n");

  const parsed = parseGrepOutput(grepOutput);
  assert(parsed !== null, "parseGrepOutput: truncated → non-null");
  if (parsed) {
    assertEq(parsed.files.length, 1, "parseGrepOutput: truncated → 1 file");
    assert(parsed.footer.startsWith("(Results truncated"), `parseGrepOutput: footer captured (got: ${parsed.footer})`);
  }
}

// 4. parseGrepOutput with non-grep output returns null
{
  assertEq(parseGrepOutput(""), null, "parseGrepOutput: empty string → null");
  assertEq(parseGrepOutput("not grep output\nfoo bar"), null, "parseGrepOutput: random text → null");
  const readResult = parseGrepOutput("[/some/file.ts#1A2B]\n1:hello\n2:world");
  assertEq(readResult, null, "parseGrepOutput: read-tool format → null");
}

// 5. parseGrepOutput with single file, multiple matches
{
  const grepOutput = [
    "Found 4 matches",
    "",
    "/worktree/src/a.ts:",
    "  Line 3: foo",
    "  Line 7: bar",
    "  Line 12: baz",
    "  Line 99: qux",
  ].join("\n");

  const parsed = parseGrepOutput(grepOutput);
  assert(parsed !== null, "parseGrepOutput: single file → non-null");
  if (parsed) {
    assertEq(parsed.files.length, 1, "parseGrepOutput: single file → 1 group");
    const file = parsed.files[0];
    assert(file !== undefined, "parseGrepOutput: single file present");
    if (file) {
      assertEq(file.matches.length, 4, "parseGrepOutput: single file → 4 matches");
      assertEq(file.matches[0]?.line, 3, "parseGrepOutput: match 0 line");
      assertEq(file.matches[3]?.text, "qux", "parseGrepOutput: match 3 text");
    }
  }
}

// 6. End-to-end: build a real grep output, run parser + manual format, verify shape
{
  const grepFilePath = join(tmpDir, "grep-test-6.txt");
  const fileContent = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
  writeFileSync(grepFilePath, fileContent);

  const grepOutput = [
    "Found 2 matches",
    "",
    `${grepFilePath}:`,
    "  Line 2: beta",
    "  Line 4: delta",
  ].join("\n");

  const parsed = parseGrepOutput(grepOutput);
  assert(parsed !== null, "e2e: parseGrepOutput non-null");
  if (parsed) {
    const store = new SnapshotStore();
    const sections: string[] = [];
    sections.push(parsed.header);
    for (const file of parsed.files) {
      const content = readFileSync(file.path, "utf-8");
      const canonical = canonicalPath(file.path);
      const tag = store.record(canonical, content, undefined, "test-session-6");
      const body = file.matches.map((m) => `${m.line}:${m.text}`).join("\n");
      const seenLines = parseSeenLinesFromHashlineBody(body);
      if (seenLines.length > 0) {
        store.recordSeenLines(canonical, tag, seenLines);
      }
      const rel = path.relative("/home/opus/.config/opencode/plugins/opencode-hashline", file.path);
      sections.push(`[${rel}#${tag}]\n${body}`);
    }
    const finalOutput = sections.join("\n\n");

    assert(finalOutput.includes(".test-tmp/grep-test-6.txt#"), `e2e: section header has relative path + tag (got: ${finalOutput})`);
    assert(finalOutput.includes("2:beta"), "e2e: body line 2:beta present");
    assert(finalOutput.includes("4:delta"), "e2e: body line 4:delta present");
    assert(!finalOutput.includes("  Line 2:"), "e2e: original '  Line 2:' format removed");
    assert(finalOutput.startsWith("Found 2 matches"), "e2e: header preserved");
  }
}

// 7. seenLines recording from grep (verify via byHash)
{
  const store = new SnapshotStore();
  const grepFilePath = join(tmpDir, "grep-test-7.txt");
  writeFileSync(grepFilePath, "one\ntwo\nthree\nfour\nfive\n");

  const grepOutput = [
    "Found 3 matches",
    "",
    `${grepFilePath}:`,
    "  Line 1: one",
    "  Line 3: three",
    "  Line 5: five",
  ].join("\n");

  const parsed = parseGrepOutput(grepOutput);
  assert(parsed !== null, "seenLines: parsed non-null");
  if (parsed) {
    const file = parsed.files[0];
    assert(file !== undefined, "seenLines: file present");
    if (file) {
      const content = readFileSync(file.path, "utf-8");
      const canonical = canonicalPath(file.path);
      const tag = store.record(canonical, content, undefined, "test-session-7");
      const body = file.matches.map((m) => `${m.line}:${m.text}`).join("\n");
      const seenLines = parseSeenLinesFromHashlineBody(body);
      assertEq(seenLines.length, 3, "seenLines: 3 seen lines");
      store.recordSeenLines(canonical, tag, seenLines);

      const snapshot = store.byHash(canonical, tag);
      assert(snapshot !== null, "seenLines: snapshot exists by hash");
      if (snapshot) {
        assert(snapshot.seenLines !== undefined, "seenLines: seenLines set attached");
        if (snapshot.seenLines) {
          assertEq(snapshot.seenLines.size, 3, "seenLines: 3 unique lines in set");
          assert(snapshot.seenLines.has(1), "seenLines: line 1 recorded");
          assert(snapshot.seenLines.has(3), "seenLines: line 3 recorded");
          assert(snapshot.seenLines.has(5), "seenLines: line 5 recorded");
        }
      }
    }
  }
}

// 8. Large file skip: file > 4MB falls back to original grep format
{
  const store = new SnapshotStore();
  const bigFile = join(tmpDir, "grep-test-8-big.txt");
  // Build a synthetic content > MAX_GREP_SNAPSHOT_BYTES (4MB) cheaply by sparse string
  const bigContent = "x".repeat(4 * 1024 * 1024 + 100);
  writeFileSync(bigFile, bigContent);

  const grepOutput = [
    "Found 1 matches",
    "",
    `${bigFile}:`,
    "  Line 1: x",
  ].join("\n");

  const parsed = parseGrepOutput(grepOutput);
  assert(parsed !== null, "large-file: parsed non-null");
  if (parsed) {
    // Simulate the hook's skip logic
    let tag: string | null = null;
    try {
      const content = readFileSync(bigFile, "utf-8");
      if (content.length <= 4 * 1024 * 1024) {
        tag = "SHOULD_NOT_BE_MINTED";
      }
    } catch {}
    assertEq(tag, null, "large-file: tag not minted for >4MB file");

    // Fallback: rebuild original grep section
    const file = parsed.files[0];
    assert(file !== undefined, "large-file: file present");
    if (file) {
      const originalLines = [`${file.path}:`];
      for (const m of file.matches) {
        originalLines.push(`  Line ${m.line}: ${m.text}`);
      }
      const fallbackSection = originalLines.join("\n");
      assert(fallbackSection.includes("  Line 1: x"), "large-file: fallback keeps original format");
      assert(!fallbackSection.includes("#"), "large-file: fallback has no tag");
    }
  }
}

// 9. Unreadable file skip: non-existent file falls back to original format
{
  const store = new SnapshotStore();
  const ghostPath = join(tmpDir, "does-not-exist-9.txt");

  const grepOutput = [
    "Found 2 matches",
    "",
    `${ghostPath}:`,
    "  Line 1: foo",
    "  Line 5: bar",
  ].join("\n");

  const parsed = parseGrepOutput(grepOutput);
  assert(parsed !== null, "unreadable: parsed non-null");
  if (parsed) {
    let tag: string | null = "WOULD_BE_MINTED";
    try {
      const content = readFileSync(ghostPath, "utf-8");
      tag = "SHOULD_NOT_REACH";
    } catch {
      tag = null;
    }
    assertEq(tag, null, "unreadable: tag stays null on read error");

    const file = parsed.files[0];
    if (file) {
      const originalLines = [`${file.path}:`];
      for (const m of file.matches) {
        originalLines.push(`  Line ${m.line}: ${m.text}`);
      }
      const fallback = originalLines.join("\n");
      assert(fallback.includes("  Line 1: foo"), "unreadable: fallback has match 1");
      assert(fallback.includes("  Line 5: bar"), "unreadable: fallback has match 2");
      assert(!fallback.includes("#"), "unreadable: fallback has no tag");
    }
  }
}

// ── Test 58: Tokenizer ───────────────────────────────────────────────────────
console.log("\n─ Tokenizer ─");

{
  const lines = splitHashlineLines("alpha\nbeta\ngamma");
  assertEq(lines.length, 3, "splitHashlineLines: basic 3 lines");
  assertEq(lines[0], "alpha", "splitHashlineLines: first line");
  assertEq(lines[2], "gamma", "splitHashlineLines: last line");
}

{
  const lines = splitHashlineLines("alpha\r\nbeta\r\ngamma");
  assertEq(lines.length, 3, "splitHashlineLines: CRLF stripped");
  assertEq(lines[0], "alpha", "splitHashlineLines: CRLF first");
  assertEq(lines[1], "beta", "splitHashlineLines: CRLF second");
}

{
  const lines = splitHashlineLines("alpha\rbeta");
  assertEq(lines.length, 1, "splitHashlineLines: lone CR not a separator");
  assertEq(lines[0], "alpha\rbeta", "splitHashlineLines: lone CR kept in content");
}

{
  const lines = splitHashlineLines("");
  assertEq(lines.length, 1, "splitHashlineLines: empty → single empty");
  assertEq(lines[0], "", "splitHashlineLines: empty is empty string");
}

{
  const lines = splitHashlineLines("alpha\n");
  assertEq(lines.length, 1, "splitHashlineLines: trailing newline → 1 line");
  assertEq(lines[0], "alpha", "splitHashlineLines: trailing newline content");
}

{
  const tk = new Tokenizer();
  const tokens = tk.feed("[foo.ts#1A2B]\nSWAP 1.=3:\n+new");
  assertEq(tokens.length, 2, "Tokenizer.feed: 2 complete lines from 3-line chunk");
  assertEq(tokens[0]?.kind, "header", "Tokenizer.feed: first token is header");
  assertEq(tokens[1]?.kind, "op-block", "Tokenizer.feed: second token is op-block");
  const rest = tk.end();
  assertEq(rest.length, 1, "Tokenizer.end: flushes remaining");
  assertEq(rest[0]?.kind, "payload-literal", "Tokenizer.end: remaining is payload-literal");
}

{
  const tk = new Tokenizer();
  const t1 = tk.feed("[foo.ts#1A2");
  assertEq(t1.length, 0, "Tokenizer.feed: partial header buffered");
  const t2 = tk.feed("B]\nSWAP 1.=1:");
  assertEq(t2.length, 1, "Tokenizer.feed: completes across chunks");
  assertEq(t2[0]?.kind, "header", "Tokenizer.feed: completed header kind");
}

{
  const tk = new Tokenizer();
  tk.feed("alpha\nbeta\n");
  tk.end();
  tk.reset();
  const tokens = tk.feed("[x.ts#ABCD]\n");
  assertEq(tokens.length, 1, "Tokenizer.reset: allows reuse");
  assertEq(tokens[0]?.kind, "header", "Tokenizer.reset: works after reset");
}

{
  const tk = new Tokenizer();
  const tokens = tk.tokenizeAll("[foo.ts#1A2B]\nSWAP 1.=3:\n+new\nDEL 5\nINS.HEAD:\n+head\n*** Begin Patch\n*** End Patch\n*** Abort\n\nnot a header");
  const kinds = tokens.map(t => t.kind);
  assert(kinds.includes("header"), "classifyLine: header token");
  assert(kinds.includes("op-block"), "classifyLine: op-block token");
  assert(kinds.includes("payload-literal"), "classifyLine: payload-literal token");
  assert(kinds.includes("envelope-begin"), "classifyLine: envelope-begin token");
  assert(kinds.includes("envelope-end"), "classifyLine: envelope-end token");
  assert(kinds.includes("abort"), "classifyLine: abort token");
  assert(kinds.includes("blank"), "classifyLine: blank token");
  assert(kinds.includes("raw"), "classifyLine: raw token");
}

{
  const tk = new Tokenizer();
  assert(tk.isOp("SWAP 1.=3:"), "Tokenizer.isOp: SWAP");
  assert(tk.isOp("DEL 5"), "Tokenizer.isOp: DEL");
  assert(tk.isOp("INS.HEAD:"), "Tokenizer.isOp: INS.HEAD");
  assert(!tk.isOp("foo bar"), "Tokenizer.isOp: non-op");
  assert(tk.isHeader("[foo.ts#1A2B]"), "Tokenizer.isHeader: valid header");
  assert(!tk.isHeader("[foo.ts]"), "Tokenizer.isHeader: no hash");
  assert(tk.isEnvelopeMarker("*** Begin Patch"), "Tokenizer.isEnvelopeMarker: begin");
  assert(tk.isEnvelopeMarker("*** End Patch"), "Tokenizer.isEnvelopeMarker: end");
  assert(tk.isEnvelopeMarker("*** Abort"), "Tokenizer.isEnvelopeMarker: abort");
  assert(!tk.isEnvelopeMarker("SWAP 1.=1:"), "Tokenizer.isEnvelopeMarker: non-marker");
}

{
  const sections = parsePatch("[foo.ts#1A2B]\r\nSWAP 1.=1:\r\n+new");
  assertEq(sections.length, 1, "parsePatch: CRLF input parses");
  assertEq(sections[0]?.edits.length, 1, "parsePatch: CRLF one edit");
  assertEq(sections[0]?.edits[0]?.kind, "swap", "parsePatch: CRLF swap kind");
}

{
  const tk = new Tokenizer();
  const tok = tk.tokenize("[foo.ts#1A2B]", 1) as Extract<Token, { kind: "header" }>;
  assertEq(tok.path, "foo.ts", "tryParseHeader: valid path");
  assertEq(tok.fileHash, "1A2B", "tryParseHeader: valid hash");

  const tok2 = tk.tokenize("[foo.ts]", 1);
  assertEq(tok2.kind, "raw", "tryParseHeader: no hash → raw");

  const tok3 = tk.tokenize("[foo#bar#1234]", 1);
  assertEq(tok3.kind, "raw", "tryParseHeader: path with # → raw");

  const tok4 = tk.tokenize("[a#1234]", 1) as Extract<Token, { kind: "header" }>;
  assertEq(tok4.path, "a", "tryParseHeader: short path");
  assertEq(tok4.fileHash, "1234", "tryParseHeader: short path hash");
}

// ── Test 59: Executor ────────────────────────────────────────────────────────
console.log("\n─ Executor ─");

{
  const sections = parsePatch("[foo.ts#1A2B]\nSWAP 1.=3:\n+alpha\n+beta\n+gamma");
  assertEq(sections.length, 1, "Executor: basic section count");
  assertEq(sections[0]?.path, "foo.ts", "Executor: basic path");
  assertEq(sections[0]?.hash, "1A2B", "Executor: basic hash");
  assertEq(sections[0]?.edits.length, 1, "Executor: basic one edit");
  const edit = sections[0]?.edits[0];
  assertEq(edit?.kind, "swap", "Executor: basic swap kind");
  if (edit?.kind === "swap") {
    assertEq(edit.start, 1, "Executor: basic swap start");
    assertEq(edit.end, 3, "Executor: basic swap end");
    assertEq(edit.lines.length, 3, "Executor: basic swap lines");
    assertEq(edit.lines[0], "alpha", "Executor: basic swap line 0");
    assertEq(edit.lines[2], "gamma", "Executor: basic swap line 2");
  }
}

{
  const result = parsePatchStreaming("[foo.ts#1A2B]\nSWAP 1.=1:\n+new");
  assertEq(result.sections.length, 1, "parsePatchStreaming: returns sections");
  assertEq(result.sections[0]?.edits.length, 1, "parsePatchStreaming: one edit");
  assert(Array.isArray(result.warnings), "parsePatchStreaming: returns warnings array");
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nSWAP 1.=1:\nalpha\nbeta");
  assertEq(sections.length, 1, "Executor: bare body auto-piped");
  const edit = sections[0]?.edits[0];
  assertEq(edit?.kind, "swap", "Executor: bare body swap kind");
  if (edit?.kind === "swap") {
    assertEq(edit.lines.length, 2, "Executor: bare body 2 lines");
    assertEq(edit.lines[0], "alpha", "Executor: bare body line 0");
    assertEq(edit.lines[1], "beta", "Executor: bare body line 1");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nINS.HEAD:\n+first\n\n+third");
  assertEq(sections.length, 1, "Executor: deferred blanks interior kept");
  const edit = sections[0]?.edits[0];
  if (edit?.kind === "insert") {
    assertEq(edit.lines.length, 3, "Executor: interior blank kept as empty line");
    assertEq(edit.lines[0], "first", "Executor: interior blank line 0");
    assertEq(edit.lines[1], "", "Executor: interior blank line 1 empty");
    assertEq(edit.lines[2], "third", "Executor: interior blank line 2");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nINS.HEAD:\n+first\n\n\n[bar.ts#3C4D]\nSWAP 1.=1:\n+x");
  assertEq(sections.length, 2, "Executor: trailing blanks discarded");
  const edit0 = sections[0]?.edits[0];
  if (edit0?.kind === "insert") {
    assertEq(edit0.lines.length, 1, "Executor: trailing blanks not in body");
    assertEq(edit0.lines[0], "first", "Executor: trailing blanks only first kept");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\n# this is a comment\nSWAP 1.=1:\n+new");
  assertEq(sections.length, 1, "Executor: skippable comment outside body");
  assertEq(sections[0]?.edits.length, 1, "Executor: comment skipped, edit present");
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nSWAP 1.=3:\n1:alpha\n2:beta\n3:gamma");
  assertEq(sections.length, 1, "Executor: uniform bare prefixes stripped");
  const edit = sections[0]?.edits[0];
  if (edit?.kind === "swap") {
    assertEq(edit.lines[0], "alpha", "Executor: uniform strip line 0");
    assertEq(edit.lines[1], "beta", "Executor: uniform strip line 1");
    assertEq(edit.lines[2], "gamma", "Executor: uniform strip line 2");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nSWAP 1.=2:\n1:alpha\nbeta");
  assertEq(sections.length, 1, "Executor: mixed bare prefixes not stripped");
  const edit = sections[0]?.edits[0];
  if (edit?.kind === "swap") {
    assertEq(edit.lines[0], "1:alpha", "Executor: mixed prefix kept line 0");
    assertEq(edit.lines[1], "beta", "Executor: mixed prefix line 1");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nSWAP 1.=2:\n1: \"one\"\n2: \"two\"");
  assertEq(sections.length, 1, "Executor: YAML literal values not stripped");
  const edit = sections[0]?.edits[0];
  if (edit?.kind === "swap") {
    assertEq(edit.lines[0], "1: \"one\"", "Executor: YAML kept line 0");
    assertEq(edit.lines[1], "2: \"two\"", "Executor: YAML kept line 1");
  }
}

{
  let threw = false;
  try {
    parsePatch("[foo.ts#1A2B]\nDEL 5\nDEL 5");
  } catch {
    threw = true;
  }
  assert(threw, "Executor: overlapping deletes throw");
}

{
  let threw = false;
  try {
    parsePatch("[foo.ts#1A2B]\nDEL 5.=3:");
  } catch {
    threw = true;
  }
  assert(threw, "Executor: DEL with colon throws");
}

{
  let threw = false;
  try {
    parsePatch("[foo.ts#1A2B]\n42");
  } catch {
    threw = true;
  }
  assert(threw, "Executor: bare line number throws");
}

{
  let threw = false;
  try {
    parsePatch("[foo.ts#1A2B]\n1.=3:");
  } catch {
    threw = true;
  }
  assert(threw, "Executor: bare range throws");
}

{
  const sections = parsePatch("*** Begin Patch\n[foo.ts#1A2B]\nSWAP 1.=1:\n+new\n*** End Patch");
  assertEq(sections.length, 1, "Executor: envelope markers handled");
  assertEq(sections[0]?.edits.length, 1, "Executor: envelope one edit");
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nSWAP 1.=1:\n+new\n*** Abort\n[bar.ts#3C4D]\nSWAP 1.=1:\n+ignored");
  assertEq(sections.length, 1, "Executor: abort stops processing");
  assertEq(sections[0]?.path, "foo.ts", "Executor: abort keeps first section");
}

{
  for (const sep of [".=", "-", "..", "…", "="]) {
    const sections = parsePatch(`[foo.ts#1A2B]\nSWAP 1${sep}3:\n+new`);
    const edit = sections[0]?.edits[0];
    if (edit?.kind === "swap") {
      assertEq(edit.start, 1, `Executor: range sep '${sep}' start`);
      assertEq(edit.end, 3, `Executor: range sep '${sep}' end`);
    }
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nDEL 5");
  assertEq(sections.length, 1, "Executor: DEL single line");
  const edit = sections[0]?.edits[0];
  assertEq(edit?.kind, "delete", "Executor: DEL single kind");
  if (edit?.kind === "delete") {
    assertEq(edit.start, 5, "Executor: DEL single start");
    assertEq(edit.end, 5, "Executor: DEL single end");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nDEL 3.=7");
  assertEq(sections.length, 1, "Executor: DEL range");
  const edit = sections[0]?.edits[0];
  if (edit?.kind === "delete") {
    assertEq(edit.start, 3, "Executor: DEL range start");
    assertEq(edit.end, 7, "Executor: DEL range end");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nINS.PRE 5:\n+before");
  const edit = sections[0]?.edits[0];
  assertEq(edit?.kind, "insert", "Executor: INS.PRE kind");
  if (edit?.kind === "insert") {
    assertEq(edit.position, "before", "Executor: INS.PRE position");
    assertEq(edit.anchor, 5, "Executor: INS.PRE anchor");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nINS.POST 5:\n+after");
  const edit = sections[0]?.edits[0];
  if (edit?.kind === "insert") {
    assertEq(edit.position, "after", "Executor: INS.POST position");
    assertEq(edit.anchor, 5, "Executor: INS.POST anchor");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nINS.HEAD:\n+head");
  const edit = sections[0]?.edits[0];
  if (edit?.kind === "insert") {
    assertEq(edit.position, "head", "Executor: INS.HEAD position");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nINS.TAIL:\n+tail");
  const edit = sections[0]?.edits[0];
  if (edit?.kind === "insert") {
    assertEq(edit.position, "tail", "Executor: INS.TAIL position");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nSWAP.BLK 5:\n+block content");
  const edit = sections[0]?.edits[0];
  assertEq(edit?.kind, "block", "Executor: SWAP.BLK kind");
  if (edit?.kind === "block") {
    assertEq(edit.blockOp, "swap", "Executor: SWAP.BLK blockOp");
    assertEq(edit.anchor, 5, "Executor: SWAP.BLK anchor");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nDEL.BLK 5");
  const edit = sections[0]?.edits[0];
  if (edit?.kind === "block") {
    assertEq(edit.blockOp, "delete", "Executor: DEL.BLK blockOp");
    assertEq(edit.anchor, 5, "Executor: DEL.BLK anchor");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nINS.BLK.POST 5:\n+after block");
  const edit = sections[0]?.edits[0];
  if (edit?.kind === "block") {
    assertEq(edit.blockOp, "insert_after", "Executor: INS.BLK.POST blockOp");
    assertEq(edit.anchor, 5, "Executor: INS.BLK.POST anchor");
  }
}

{
  const sections = parsePatch("[a.ts#1111]\nSWAP 1.=1:\n+first\n[b.ts#2222]\nSWAP 1.=1:\n+second");
  assertEq(sections.length, 2, "Executor: multi-section");
  assertEq(sections[0]?.path, "a.ts", "Executor: multi-section path 0");
  assertEq(sections[1]?.path, "b.ts", "Executor: multi-section path 1");
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nSWAP 1.=1:\n++x\n+++y");
  const edit = sections[0]?.edits[0];
  if (edit?.kind === "swap") {
    assertEq(edit.lines[0], "+x", "Executor: literal + prefix line 0");
    assertEq(edit.lines[1], "++y", "Executor: literal + prefix line 1");
  }
}

{
  const sections = parsePatch("[foo.ts#1A2B]\nINS.POST 1:\n+\n+nextblank");
  const edit = sections[0]?.edits[0];
  if (edit?.kind === "insert") {
    assertEq(edit.lines[0], "", "Executor: bare + produces empty string");
    assertEq(edit.lines[1], "nextblank", "Executor: bare + next line");
  }
}

{
  let threw = false;
  try {
    parsePatch("[foo.ts#1A2B]\nSWAP 1.=1:\n+new\n-old");
  } catch {
    threw = true;
  }
  assert(threw, "Executor: minus row in body throws");
}

{
  let threw = false;
  try {
    parsePatch("[foo.ts#1A2B]\nSWAP.BLK 5:");
  } catch {
    threw = true;
  }
  assert(threw, "Executor: empty SWAP.BLK throws");
}

{
  let threw = false;
  try {
    parsePatch("[foo.ts#1A2B]\n*** Update File: bar.ts\nSWAP 1.=1:\n+new");
  } catch {
    threw = true;
  }
  assert(threw, "Executor: apply_patch sentinel in body throws");
}

{
  let threw = false;
  try {
    parsePatch("[foo.ts#1A2B]\nSWAP 1.=1:\n+new\n@@ -1,3 +1,3 @@");
  } catch {
    threw = true;
  }
  assert(threw, "Executor: @@ hunk header in body throws");
}

{
  const sections = parsePatch("[foo.ts#1A2B]\n# trailing comment");
  assertEq(sections.length, 1, "Executor: trailing comment after section doesn't throw");
}

{
  const sections = parsePatch("[foo.ts#1A2B]\n# comment\n[bar.ts#3C4D]\nSWAP 1.=1:\n+x");
  assertEq(sections.length, 2, "Executor: comment between sections doesn't throw");
  assertEq(sections[1]?.path, "bar.ts", "Executor: comment between sections second path");
}

{
  const sections = parsePatch("[***Update File:foo.ts#1A2B]\nSWAP 1.=1:\n+new");
  assertEq(sections[0]?.path, "foo.ts", "Executor: recovery header strips noise via tokenizer");
  assertEq(sections[0]?.hash, "1A2B", "Executor: recovery header hash via tokenizer");
}

// ── Test 60: Streaming diff preview ──────────────────────────────────────────
console.log("\n─ Streaming diff preview ─");

await (async () => {
  // 1. Basic SWAP
  {
    const edits: EditOp[] = [{ kind: "swap", start: 2, end: 3, lines: ["new2", "new3"] }];
    const text = "line1\nline2\nline3\nline4";
    const result = await buildStreamingSectionDiff(edits, text, "/tmp/file.unknown");
    if ("error" in result) {
      assert(false, `buildStreamingSectionDiff: basic SWAP returned error: ${result.error}`);
    } else {
      assertEq(result.diff, "-2|line2\n-3|line3\n+2|new2\n+3|new3", "buildStreamingSectionDiff: basic SWAP diff rows");
      assertEq(result.firstChangedLine, 2, "buildStreamingSectionDiff: basic SWAP firstChangedLine");
    }
  }

  // 2. DEL
  {
    const edits: EditOp[] = [{ kind: "delete", start: 2, end: 2 }];
    const text = "line1\nline2\nline3";
    const result = await buildStreamingSectionDiff(edits, text, "/tmp/file.unknown");
    if ("error" in result) {
      assert(false, `buildStreamingSectionDiff: DEL returned error: ${result.error}`);
    } else {
      assertEq(result.diff, "-2|line2", "buildStreamingSectionDiff: DEL diff rows");
      assertEq(result.firstChangedLine, 2, "buildStreamingSectionDiff: DEL firstChangedLine");
    }
  }

  // 3. INS.POST
  {
    const edits: EditOp[] = [{ kind: "insert", position: "after", anchor: 1, lines: ["inserted"] }];
    const text = "line1\nline2";
    const result = await buildStreamingSectionDiff(edits, text, "/tmp/file.unknown");
    if ("error" in result) {
      assert(false, `buildStreamingSectionDiff: INS.POST returned error: ${result.error}`);
    } else {
      assertEq(result.diff, "+2|inserted", "buildStreamingSectionDiff: INS.POST diff rows");
      assertEq(result.firstChangedLine, 2, "buildStreamingSectionDiff: INS.POST firstChangedLine");
    }
  }

  // 4. INS.HEAD
  {
    const edits: EditOp[] = [{ kind: "insert", position: "head", anchor: 0, lines: ["first"] }];
    const text = "line1";
    const result = await buildStreamingSectionDiff(edits, text, "/tmp/file.unknown");
    if ("error" in result) {
      assert(false, `buildStreamingSectionDiff: INS.HEAD returned error: ${result.error}`);
    } else {
      assertEq(result.diff, "+1|first", "buildStreamingSectionDiff: INS.HEAD diff rows");
      assertEq(result.firstChangedLine, 1, "buildStreamingSectionDiff: INS.HEAD firstChangedLine");
    }
  }

  // 5. INS.TAIL
  {
    const edits: EditOp[] = [{ kind: "insert", position: "tail", anchor: 0, lines: ["last"] }];
    const text = "line1";
    const result = await buildStreamingSectionDiff(edits, text, "/tmp/file.unknown");
    if ("error" in result) {
      assert(false, `buildStreamingSectionDiff: INS.TAIL returned error: ${result.error}`);
    } else {
      assertEq(result.diff, "+2|last", "buildStreamingSectionDiff: INS.TAIL diff rows");
      assertEq(result.firstChangedLine, 2, "buildStreamingSectionDiff: INS.TAIL firstChangedLine");
    }
  }

  // 6. Multiple ops natural order
  {
    const edits: EditOp[] = [
      { kind: "delete", start: 5, end: 5 },
      { kind: "delete", start: 2, end: 2 },
      { kind: "delete", start: 8, end: 8 },
    ];
    const text = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9";
    const result = await buildStreamingSectionDiff(edits, text, "/tmp/file.unknown");
    if ("error" in result) {
      assert(false, `buildStreamingSectionDiff: multi-op returned error: ${result.error}`);
    } else {
      assertEq(result.diff, "-2|l2\n-5|l5\n-8|l8", "buildStreamingSectionDiff: multiple ops natural order (ascending)");
      assertEq(result.firstChangedLine, 2, "buildStreamingSectionDiff: multiple ops firstChangedLine is first anchor");
    }
  }

  // 7. No changes
  {
    const result = await buildStreamingSectionDiff([], "line1", "/tmp/file.unknown");
    if ("error" in result) {
      assertEq(result.error, "No changes would be made.", "buildStreamingSectionDiff: empty edits returns error");
    } else {
      assert(false, `buildStreamingSectionDiff: empty edits should return error, got: ${result.diff}`);
    }
  }

  // 8. Block op dropping (unsupported extension → dropped, not thrown)
  {
    const edits: EditOp[] = [{ kind: "block", anchor: 1, lines: ["x"], blockOp: "swap" }];
    const text = "line1\nline2";
    let threw = false;
    try {
      const result = await buildStreamingSectionDiff(edits, text, "/tmp/file.unknown");
      // Either resolves to a real diff (tree-sitter) or returns the empty-changes error
      // — both are acceptable; the point is it did NOT throw.
      if ("error" in result) {
        assert(result.error === "No changes would be made.", "buildStreamingSectionDiff: dropped block returns no-changes error");
      } else {
        assert(typeof result.diff === "string", "buildStreamingSectionDiff: dropped/resolved block returns string diff");
      }
    } catch {
      threw = true;
    }
    assert(!threw, "buildStreamingSectionDiff: block drop should not throw");
  }

  // resolveBlockEdits default behavior preserved
  {
    const edits: EditOp[] = [{ kind: "block", anchor: 1, lines: ["x"], blockOp: "swap" }];
    let threw = false;
    try { await resolveBlockEdits(edits, "line1", "/tmp/file.unknown"); } catch { threw = true; }
    assert(threw, "resolveBlockEdits: default (no options) still throws for unresolved SWAP.BLK");
  }

  // resolveBlockEdits onUnresolved: "drop" doesn't throw
  {
    const edits: EditOp[] = [{ kind: "block", anchor: 1, lines: ["x"], blockOp: "swap" }];
    const dropResult = await resolveBlockEdits(edits, "line1\nline2", "/tmp/file.unknown", { onUnresolved: "drop" });
    assertEq(dropResult.warnings.length, 1, "resolveBlockEdits: drop mode → 1 warning");
    assert(dropResult.warnings[0]!.includes("SWAP.BLK 1"), "resolveBlockEdits: drop mode warning contains SWAP.BLK 1");
    assert(dropResult.warnings[0]!.includes("Skipped"), "resolveBlockEdits: drop mode warning contains 'Skipped'");
    assertEq(dropResult.edits.length, 0, "resolveBlockEdits: drop mode → 0 edits (block was dropped)");
  }

  // resolveBlockEdits onUnresolved: "drop" for DEL.BLK
  {
    const edits: EditOp[] = [{ kind: "block", anchor: 1, lines: [], blockOp: "delete" }];
    const dropResult = await resolveBlockEdits(edits, "line1", "/tmp/file.unknown", { onUnresolved: "drop" });
    assert(dropResult.warnings[0]!.includes("DEL.BLK 1"), "resolveBlockEdits: drop mode DEL.BLK warning contains anchor");
    assertEq(dropResult.edits.length, 0, "resolveBlockEdits: drop mode DEL.BLK → 0 edits");
  }

  // resolveBlockEdits onUnresolved: "drop" + insert_after keeps lower behavior
  {
    const edits: EditOp[] = [{ kind: "block", anchor: 1, lines: ["y"], blockOp: "insert_after" }];
    const dropResult = await resolveBlockEdits(edits, "line1\nline2", "/tmp/file.unknown", { onUnresolved: "drop" });
    assertEq(dropResult.edits.length, 1, "resolveBlockEdits: drop mode insert_after → 1 edit (lowered)");
    const loweredEdit = dropResult.edits[0]!;
    if (loweredEdit.kind === "insert") {
      assertEq(loweredEdit.position, "after", "resolveBlockEdits: drop mode insert_after lowered position");
      assertEq(loweredEdit.anchor, 1, "resolveBlockEdits: drop mode insert_after lowered anchor");
    } else {
      assert(false, "resolveBlockEdits: drop mode insert_after should lower to insert");
    }
  }

  // applyPartialTo basic apply
  {
    const edits: EditOp[] = [{ kind: "swap", start: 1, end: 1, lines: ["new"] }];
    const result = await applyPartialTo(edits, "old", "/tmp/file.unknown");
    assertEq(result.text, "new", "applyPartialTo: basic swap applies");
    assertEq(result.warnings.length, 0, "applyPartialTo: basic swap → no warnings");
  }

  // applyPartialTo: unresolved block dropped
  {
    const edits: EditOp[] = [{ kind: "block", anchor: 1, lines: [], blockOp: "delete" }];
    const result = await applyPartialTo(edits, "line1\nline2", "/tmp/file.unknown");
    assertEq(result.text, "line1\nline2", "applyPartialTo: dropped block leaves text unchanged");
    assert(result.warnings.length > 0, "applyPartialTo: dropped block produces warning");
    assert(result.warnings[0]!.includes("Skipped"), "applyPartialTo: dropped block warning contains 'Skipped'");
  }

  // applyPartialTo: insert applies through lowered
  {
    const edits: EditOp[] = [{ kind: "insert", position: "after", anchor: 1, lines: ["x"] }];
    const result = await applyPartialTo(edits, "a\nb", "/tmp/file.unknown");
    assertEq(result.text, "a\nx\nb", "applyPartialTo: insert after applies");
    assertEq(result.warnings.length, 0, "applyPartialTo: insert after → no warnings");
  }

  // applyPartialTo: Python SWAP.BLK on resolvable function
  {
    const pySource = ["def greet(name):", "    msg = 'Hello'", "    print(msg)", ""].join("\n");
    const pyPath = "/tmp/test_streaming_diff.py";
    writeFileSync(pyPath, pySource);
    const edits: EditOp[] = [
      { kind: "block", anchor: 1, lines: ["def new_greet():", "    pass"], blockOp: "swap" },
    ];
    const result = await applyPartialTo(edits, pySource, pyPath);
    assert(result.text.startsWith("def new_greet():"), "applyPartialTo: SWAP.BLK on Python function applies");
    assert(!result.text.includes("def greet(name):"), "applyPartialTo: SWAP.BLK replaced original function");
    assertEq(result.warnings.length, 0, "applyPartialTo: SWAP.BLK on Python function → no warnings");
    try { rmSync(pyPath); } catch {}
  }

  // buildStreamingSectionDiff on Python SWAP.BLK
  {
    const pySource = ["def greet(name):", "    msg = 'Hello'", "    print(msg)", ""].join("\n");
    const pyPath = "/tmp/test_streaming_diff2.py";
    writeFileSync(pyPath, pySource);
    const edits: EditOp[] = [
      { kind: "block", anchor: 1, lines: ["def new_greet():", "    pass"], blockOp: "swap" },
    ];
    const result = await buildStreamingSectionDiff(edits, pySource, pyPath);
    if ("error" in result) {
      assert(false, `buildStreamingSectionDiff: Python SWAP.BLK should not error, got: ${result.error}`);
    } else {
      assert(result.diff.includes("-1|def greet(name):"), "buildStreamingSectionDiff: Python SWAP.BLK shows deletion row");
      assert(result.diff.includes("+1|def new_greet():"), "buildStreamingSectionDiff: Python SWAP.BLK shows insertion row");
      assertEq(result.firstChangedLine, 1, "buildStreamingSectionDiff: Python SWAP.BLK firstChangedLine");
    }
    try { rmSync(pyPath); } catch {}
  }
})();

// ─── Cleanup ─────────────────────────────────────────────────────────────────

try { rmSync(tmpDir, { recursive: true }); } catch {}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
