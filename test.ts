import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
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
  buildNumberedDiff, buildCompactDiffPreview,
  EXTENSION_TO_WASM, hasBlockEdit, resolveBlockEdits, resolveBlock, resolveBlockSpan,
  blockUnresolvedMessage, blockSingleLineMessage, BLOCK_RESOLVER_UNAVAILABLE,
  insertAfterBlockCloserLoweredWarning, insertAfterBlockUnresolvedLoweredWarning,
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

// ─── Cleanup ─────────────────────────────────────────────────────────────────

try { rmSync(tmpDir, { recursive: true }); } catch {}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
