import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import {
  type EditOp,
  detectLineEnding, normalizeToLF, restoreLineEndings, stripBom, normalizeForStorage,
  normalizeFileText, computeFileHash, SnapshotStore,
  parsePatch, applyEdits, lineDiff,
  isStructuralCloserLine, computeDelimiterBalance, balanceDelta, balanceNegate,
  balanceEqual, balanceIsZero, hasNonWhitespace, leadingIndent, isIndentDeeper,
  repairEdits,
  hasAnchorScopedEdit, collectAnchorLines, verifyAnchorContent, findFirstChangedLine,
  applyEditsToSnapshot, replaySessionChainOnCurrent, tryRecover,
  formatAnchoredContext, formatMismatchError,
  RECOVERY_EXTERNAL_WARNING, RECOVERY_SESSION_REPLAY_WARNING,
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

// ─── Cleanup ─────────────────────────────────────────────────────────────────

try { rmSync(tmpDir, { recursive: true }); } catch {}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
