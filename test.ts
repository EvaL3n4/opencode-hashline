import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const HASH_MASK = 0xffff;
const HASH_LENGTH = 4;

function normalizeFileText(text: string): string {
  return text.replace(/[ \t\r]+(?=\n|$)/g, "");
}

function computeFileHash(text: string): string {
  const normalized = normalizeFileText(text);
  const hash = createHash("md5").update(normalized).digest();
  const low16 = hash.readUInt16LE(0) & HASH_MASK;
  return low16.toString(16).padStart(HASH_LENGTH, "0").toUpperCase();
}

type EditOp =
  | { kind: "swap"; start: number; end: number; lines: string[] }
  | { kind: "delete"; start: number; end: number }
  | { kind: "insert"; position: "before" | "after" | "head" | "tail"; anchor: number; lines: string[] };

interface PatchSection {
  path: string;
  hash: string;
  edits: EditOp[];
}

function parsePatch(input: string): PatchSection[] {
  const sections: PatchSection[] = [];
  const lines = input.split("\n");

  let currentSection: PatchSection | null = null;
  let bodyTarget: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) continue;

    const headerMatch = line.match(/^\[([^\]]+)#([0-9A-Fa-f]{4})\]\s*$/);
    if (headerMatch) {
      bodyTarget = null;
      if (currentSection) sections.push(currentSection);
      currentSection = {
        path: headerMatch[1]!,
        hash: headerMatch[2]!.toUpperCase(),
        edits: [],
      };
      continue;
    }

    if (!currentSection) continue;

    if (bodyTarget !== null && line.startsWith("+")) {
      bodyTarget.push(line.slice(1));
      continue;
    }

    bodyTarget = null;

    const swapMatch = line.match(/^SWAP\s+(\d+)\s*[-.=…]+\s*(\d+):\s*$/);
    const delMatch = line.match(/^DEL\s+(\d+)\s*(?:[-.=…]+\s*(\d+))?\s*$/);
    const insPreMatch = line.match(/^INS\.PRE\s+(\d+):\s*$/);
    const insPostMatch = line.match(/^INS\.POST\s+(\d+):\s*$/);
    const insHeadMatch = line.match(/^INS\.HEAD:\s*$/);
    const insTailMatch = line.match(/^INS\.TAIL:\s*$/);

    if (swapMatch) {
      const edit: Extract<EditOp, { kind: "swap" }> = {
        kind: "swap",
        start: parseInt(swapMatch[1]!, 10),
        end: parseInt(swapMatch[2]!, 10),
        lines: [],
      };
      currentSection.edits.push(edit);
      bodyTarget = edit.lines;
    } else if (delMatch) {
      const start = parseInt(delMatch[1]!, 10);
      const end = delMatch[2] ? parseInt(delMatch[2]!, 10) : start;
      currentSection.edits.push({ kind: "delete", start, end });
    } else if (insPreMatch) {
      const edit: Extract<EditOp, { kind: "insert" }> = {
        kind: "insert",
        position: "before",
        anchor: parseInt(insPreMatch[1]!, 10),
        lines: [],
      };
      currentSection.edits.push(edit);
      bodyTarget = edit.lines;
    } else if (insPostMatch) {
      const edit: Extract<EditOp, { kind: "insert" }> = {
        kind: "insert",
        position: "after",
        anchor: parseInt(insPostMatch[1]!, 10),
        lines: [],
      };
      currentSection.edits.push(edit);
      bodyTarget = edit.lines;
    } else if (insHeadMatch) {
      const edit: Extract<EditOp, { kind: "insert" }> = {
        kind: "insert",
        position: "head",
        anchor: 0,
        lines: [],
      };
      currentSection.edits.push(edit);
      bodyTarget = edit.lines;
    } else if (insTailMatch) {
      const edit: Extract<EditOp, { kind: "insert" }> = {
        kind: "insert",
        position: "tail",
        anchor: 0,
        lines: [],
      };
      currentSection.edits.push(edit);
      bodyTarget = edit.lines;
    }
  }

  if (currentSection) sections.push(currentSection);
  return sections;
}

function applyEdits(text: string, edits: EditOp[]): string {
  let fileLines = text.split("\n");

  const sorted = [...edits].sort((a, b) => {
    const aLine = getAnchorLine(a);
    const bLine = getAnchorLine(b);
    return bLine - aLine;
  });

  for (const edit of sorted) {
    fileLines = applySingleEdit(fileLines, edit);
  }

  return fileLines.join("\n");
}

function getAnchorLine(edit: EditOp): number {
  switch (edit.kind) {
    case "swap":
    case "delete":
      return edit.start;
    case "insert":
      return edit.anchor;
  }
}

function applySingleEdit(lines: string[], edit: EditOp): string[] {
  switch (edit.kind) {
    case "swap": {
      const before = lines.slice(0, edit.start - 1);
      const after = lines.slice(edit.end);
      return [...before, ...edit.lines, ...after];
    }
    case "delete": {
      const before = lines.slice(0, edit.start - 1);
      const after = lines.slice(edit.end);
      return [...before, ...after];
    }
    case "insert": {
      switch (edit.position) {
        case "head":
          return [...edit.lines, ...lines];
        case "tail":
          return [...lines, ...edit.lines];
        case "before": {
          const before = lines.slice(0, edit.anchor - 1);
          const after = lines.slice(edit.anchor - 1);
          return [...before, ...edit.lines, ...after];
        }
        case "after": {
          const before = lines.slice(0, edit.anchor);
          const after = lines.slice(edit.anchor);
          return [...before, ...edit.lines, ...after];
        }
      }
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

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

const tmpDir = join(import.meta.dir, ".test-tmp");
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
assertEq(hashCRLF, hashLF, "CRLF normalized to LF (trailing \\r stripped before \\n)");

// ── Test 2: Patch parser ─────────────────────────────────────────────────────
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

// ── Test 3: Parser - all operation types ─────────────────────────────────────
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
assert(ops?.includes("insert"), "has insert ops");
assert(ops?.includes("delete"), "has delete op");
assert(ops?.includes("swap"), "has swap op");

const insOps = sections2[0]?.edits.filter((e) => e.kind === "insert") as Extract<EditOp, { kind: "insert" }>[];
assertEq(insOps?.[0]?.position, "head", "first insert is head");
assertEq(insOps?.[1]?.position, "tail", "second insert is tail");
assertEq(insOps?.[2]?.position, "before", "third insert is before");
assertEq(insOps?.[3]?.position, "after", "fourth insert is after");

// ── Test 4: Range separator variants ─────────────────────────────────────────
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

// ── Test 5: Edit application ─────────────────────────────────────────────────
console.log("\n─ Edit application ─");

const fileContent = "line1\nline2\nline3\nline4\nline5";

// SWAP single line
const swapResult = applyEdits(fileContent, [
  { kind: "swap", start: 2, end: 2, lines: ["LINE2"] },
]);
assertEq(swapResult, "line1\nLINE2\nline3\nline4\nline5", "SWAP single line");

// SWAP range with different length
const swapRange = applyEdits(fileContent, [
  { kind: "swap", start: 2, end: 3, lines: ["REPLACED"] },
]);
assertEq(swapRange, "line1\nREPLACED\nline4\nline5", "SWAP range (2→1 lines)");

// DEL single
const delSingle = applyEdits(fileContent, [
  { kind: "delete", start: 3, end: 3 },
]);
assertEq(delSingle, "line1\nline2\nline4\nline5", "DEL single line");

// DEL range
const delRange = applyEdits(fileContent, [
  { kind: "delete", start: 2, end: 4 },
]);
assertEq(delRange, "line1\nline5", "DEL range");

// INS.HEAD
const insHead = applyEdits(fileContent, [
  { kind: "insert", position: "head", anchor: 0, lines: ["HEADER"] },
]);
assertEq(insHead, "HEADER\nline1\nline2\nline3\nline4\nline5", "INS.HEAD");

// INS.TAIL
const insTail = applyEdits(fileContent, [
  { kind: "insert", position: "tail", anchor: 0, lines: ["FOOTER"] },
]);
assertEq(insTail, "line1\nline2\nline3\nline4\nline5\nFOOTER", "INS.TAIL");

// INS.PRE
const insPre = applyEdits(fileContent, [
  { kind: "insert", position: "before", anchor: 3, lines: ["BEFORE3"] },
]);
assertEq(insPre, "line1\nline2\nBEFORE3\nline3\nline4\nline5", "INS.PRE 3");

// INS.POST
const insPost = applyEdits(fileContent, [
  { kind: "insert", position: "after", anchor: 2, lines: ["AFTER2"] },
]);
assertEq(insPost, "line1\nline2\nAFTER2\nline3\nline4\nline5", "INS.POST 2");

// ── Test 6: Multiple edits in one patch (reverse order application) ───────────
console.log("\n─ Multiple edits (reverse order) ─");

const multiResult = applyEdits(fileContent, [
  { kind: "swap", start: 2, end: 2, lines: ["LINE2"] },
  { kind: "delete", start: 4, end: 4 },
  { kind: "insert", position: "after", anchor: 1, lines: ["AFTER1"] },
]);
// Applied in reverse: del line 4, swap line 2, insert after line 1
// Start:  line1 line2 line3 line4 line5
// Del 4:  line1 line2 line3 line5
// Swap 2: line1 LINE2 line3 line5
// Ins 1:  line1 AFTER1 LINE2 line3 line5
assertEq(multiResult, "line1\nAFTER1\nLINE2\nline3\nline5", "Multiple edits applied in reverse order");

// ── Test 7: End-to-end (file write + hash + edit) ────────────────────────────
console.log("\n─ End-to-end ─");

const testFile = join(tmpDir, "greet.py");
const originalContent = 'def greet(name):\n    msg = "Hello, " + name\n    print(msg)\ngreet("world")';
writeFileSync(testFile, originalContent);

const fileHash = computeFileHash(originalContent);
console.log(`  File hash: ${fileHash}`);

// Simulate an edit
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

// Write and verify new hash
writeFileSync(testFile, newContent);
const newHash = computeFileHash(newContent);
assert(newHash !== fileHash, "e2e: new hash differs from old");

// Verify stale hash rejection
const currentHash2 = computeFileHash(readFileSync(testFile, "utf-8"));
assert(currentHash2 !== fileHash, "e2e: old hash is stale (edit detected)");

// ── Test 8: Empty body (insert blank line) ───────────────────────────────────
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

// ── Test 9: Multiple sections ────────────────────────────────────────────────
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

// ── Test 10: Body lines with + prefix ────────────────────────────────────────
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

// ─── Cleanup ─────────────────────────────────────────────────────────────────

try { rmSync(tmpDir, { recursive: true }); } catch {}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
