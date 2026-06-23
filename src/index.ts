import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { readFileSync, realpathSync, writeFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import * as path from "path";
import { createTwoFilesPatch, structuredPatch, applyPatch } from "diff";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Snapshot {
  path: string;
  text: string;
  hash: string;
  recordedAt: number;
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

interface FileDiffMetadata {
  file: string;
  before: string;
  after: string;
  patch: string;
  additions: number;
  deletions: number;
}

type EditContext = {
  worktree: string;
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void;
};

type ToolResult = { output: string; metadata?: { [key: string]: any }; title?: string };
// ─── Normalization (BOM + Line Endings) ──────────────────────────────────────

type LineEnding = "\r\n" | "\n";

function detectLineEnding(content: string): LineEnding {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function restoreLineEndings(text: string, ending: LineEnding): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function normalizeForStorage(text: string): string {
  const { text: noBom } = stripBom(text);
  return normalizeToLF(noBom);
}

// ─── Hash Computation ────────────────────────────────────────────────────────

const HASH_MASK = 0xffff;
const HASH_LENGTH = 4;

function normalizeFileText(text: string): string {
  return text.replace(/[ \t]+(?=\n|$)/g, "");
}

function computeFileHash(text: string): string {
  const { text: noBom } = stripBom(text);
  const lf = normalizeToLF(noBom);
  const normalized = normalizeFileText(lf);
  const hash = createHash("md5").update(normalized).digest();
  const low16 = hash.readUInt16LE(0) & HASH_MASK;
  return low16.toString(16).padStart(HASH_LENGTH, "0").toUpperCase();
}

// ─── Snapshot Store ──────────────────────────────────────────────────────────

const MAX_PATHS = 30;
const MAX_VERSIONS_PER_PATH = 4;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

class SnapshotStore {
  private store = new Map<string, Snapshot[]>();
  private totalBytes = 0;

  record(path: string, text: string): string {
    const normalized = normalizeForStorage(text);
    const hash = computeFileHash(normalized);
    const snapshot: Snapshot = { path, text: normalized, hash, recordedAt: Date.now() };

    let versions = this.store.get(path);
    if (!versions) {
      versions = [];
      this.store.set(path, versions);
    }

    const existing = versions.find((s) => s.hash === hash);
    if (existing) {
      existing.recordedAt = Date.now();
      return hash;
    }

    versions.push(snapshot);
    this.totalBytes += text.length;

    while (versions.length > MAX_VERSIONS_PER_PATH) {
      const removed = versions.shift();
      if (removed) this.totalBytes -= removed.text.length;
    }

    this.evictIfNeeded();
    return hash;
  }

  byHash(path: string, hash: string): Snapshot | null {
    const versions = this.store.get(path);
    if (!versions) return null;
    return versions.find((s) => s.hash === hash) ?? null;
  }

  head(path: string): Snapshot | null {
    const versions = this.store.get(path);
    if (!versions || versions.length === 0) return null;
    return versions[versions.length - 1]!;
  }

  invalidate(path: string): void {
    const versions = this.store.get(path);
    if (versions) {
      for (const v of versions) this.totalBytes -= v.text.length;
      this.store.delete(path);
    }
  }

  clear(): void {
    this.store.clear();
    this.totalBytes = 0;
  }

  private evictIfNeeded(): void {
    while (this.store.size > MAX_PATHS || this.totalBytes > MAX_TOTAL_BYTES) {
      const oldest = this.findOldestPath();
      if (!oldest) break;
      this.invalidate(oldest);
    }
  }

  private findOldestPath(): string | null {
    let oldestPath: string | null = null;
    let oldestTime = Infinity;
    for (const [path, versions] of this.store) {
      const first = versions[0];
      if (first && first.recordedAt < oldestTime) {
        oldestTime = first.recordedAt;
        oldestPath = path;
      }
    }
    return oldestPath;
  }
}

// ─── Snapshot Store Singleton ────────────────────────────────────────────────

const snapshotStore = new SnapshotStore();

function canonicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function relativePath(from: string, to: string): string {
  const rel = path.relative(from, to);
  return rel || to;
}

const HL_PREFIX_RE = /^\s*(?:>>>|>>)?\s*(?:[+*-]\s*)?\d+:/;
const HL_HEADER_RE = /^\s*\[[^#\r\n]+#[0-9a-fA-F]{4}\]\s*$/;
const READ_TRUNCATION_NOTICE_RE = /^\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines? in (?:file|\S+))\b.*\bUse :L?\d+/;

function stripLeadingHashlinePrefix(line: string): string {
  return line.replace(HL_PREFIX_RE, "");
}

function stripHashlinePrefixes(lines: string[]): string[] {
  let nonEmpty = 0, headerCount = 0, hashPrefixCount = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (READ_TRUNCATION_NOTICE_RE.test(line)) continue;
    if (HL_HEADER_RE.test(line)) { nonEmpty++; headerCount++; continue; }
    nonEmpty++;
    if (HL_PREFIX_RE.test(line)) hashPrefixCount++;
  }
  if (nonEmpty === 0) return lines;
  const contentLineCount = nonEmpty - headerCount;
  if (contentLineCount === 0 || hashPrefixCount !== contentLineCount) return lines;
  return lines
    .filter(line => !READ_TRUNCATION_NOTICE_RE.test(line) && !HL_HEADER_RE.test(line))
    .map(line => stripLeadingHashlinePrefix(line));
}

function stripWriteContent(content: string): string {
  const lines = content.split("\n");
  const cleaned = stripHashlinePrefixes(lines);
  if (cleaned !== lines) return cleaned.join("\n");
  const headerIndex = lines.findIndex(line => line.trim().length > 0);
  if (headerIndex === -1) return content;
  const headerLine = lines[headerIndex]!;
  if (!HL_HEADER_RE.test(headerLine)) return content;
  const withoutHeader = lines.slice(0, headerIndex).concat(lines.slice(headerIndex + 1));
  const cleanedWithoutHeader = stripHashlinePrefixes(withoutHeader);
  if (cleanedWithoutHeader === withoutHeader) return content;
  return cleanedWithoutHeader.join("\n");
}

function unwrapHashlineHeaderPath(targetPath: string): string {
  const trimmed = targetPath.trimEnd();
  if (trimmed.length < 3 || trimmed[0] !== "[" || trimmed[trimmed.length - 1] !== "]") {
    return targetPath;
  }
  const inner = trimmed.slice(1, -1);
  const tagMatch = /#[0-9a-fA-F]{4}$/.exec(inner);
  const pathPart = tagMatch ? inner.slice(0, tagMatch.index) : inner;
  if (pathPart.length === 0 || pathPart.includes("#")) return targetPath;
  return pathPart;
}

// ─── Call Tracking (tool.execute.before → after bridge) ──────────────────────

interface CallInfo {
  filePath?: string;
  rawContent?: string;
  writeContent?: string;
}

const pendingCalls = new Map<string, CallInfo>();

// ─── Patch Parser ────────────────────────────────────────────────────────────

function detectContamination(text: string): string | null {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return null;
  if (
    trimmed.startsWith("*** Update File:") ||
    trimmed.startsWith("*** Add File:") ||
    trimmed.startsWith("*** Delete File:") ||
    trimmed.startsWith("*** Move to:")
  ) {
    const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
    return `apply_patch sentinel ${JSON.stringify(preview)} is not valid in hashline. File sections start with \`[path#HASH]\` (no \`Update File:\` / \`Add File:\` keyword). Use \`SWAP N.=M:\`, \`DEL N.=M\`, or \`INS.PRE|POST|HEAD|TAIL:\` ops.`;
  }
  if (/^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/.test(trimmed)) {
    return "unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. Use `SWAP N.=M:`, `DEL N.=M`, or `INS.PRE|POST|HEAD|TAIL:` ops.";
  }
  if (trimmed.startsWith("@@")) {
    const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
    return `\`@@\`-bracketed hunk header ${JSON.stringify(preview)} is not valid in hashline. Drop the \`@@ ... @@\` brackets and write a verb header such as \`SWAP N.=M:\`.`;
  }
  return null;
}

function parsePatch(input: string): PatchSection[] {
  const sections: PatchSection[] = [];
  const lines = input.split("\n");

  let currentSection: PatchSection | null = null;
  let bodyTarget: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) continue;
    if (line.startsWith("*** Abort")) break;

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

    if (bodyTarget !== null && line.startsWith("-")) {
      throw new Error("`-` rows are not valid; the range already names the lines being changed. For a literal `-` line, write `+-…`.");
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
    } else {
      const contamination = detectContamination(line);
      if (contamination) {
        throw new Error(contamination);
      }
    }
  }

  if (currentSection) sections.push(currentSection);

  for (const section of sections) {
    for (const edit of section.edits) {
      if (edit.kind === "swap" && edit.lines.length === 0) {
        throw new Error("`SWAP N.=M:` needs at least one `+TEXT` body row. To delete lines, use `DEL N.=M`.");
      }
    }
  }

  return sections;
}

// ─── Edit Application ────────────────────────────────────────────────────────

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

function validateLineBounds(edits: readonly EditOp[], fileLines: readonly string[]): string | null {
  const lineCount = fileLines.length;
  for (const edit of edits) {
    switch (edit.kind) {
      case "swap":
      case "delete":
        if (edit.start < 1 || edit.start > lineCount) {
          return `Line ${edit.start} does not exist (file has ${lineCount} lines).`;
        }
        if (edit.end < edit.start || edit.end > lineCount) {
          return `Line ${edit.end} does not exist (file has ${lineCount} lines).`;
        }
        break;
      case "insert":
        if (edit.position === "head" || edit.position === "tail") break;
        if (edit.anchor < 1 || edit.anchor > lineCount) {
          return `Line ${edit.anchor} does not exist (file has ${lineCount} lines).`;
        }
        break;
    }
  }
  return null;
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

// ─── Line Diff (for TUI metadata) ────────────────────────────────────────────

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const m = a.length;
  const n = b.length;

  let prefix = 0;
  while (prefix < m && prefix < n && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < m - prefix && suffix < n - prefix && a[m - 1 - suffix] === b[n - 1 - suffix]) suffix++;

  const aMid = a.slice(prefix, m - suffix);
  const bMid = b.slice(prefix, n - suffix);

  if (aMid.length === 0) return { additions: bMid.length, deletions: 0 };
  if (bMid.length === 0) return { additions: 0, deletions: aMid.length };

  const dp: number[][] = Array.from({ length: aMid.length + 1 }, () => new Array(bMid.length + 1).fill(0));
  for (let i = 1; i <= aMid.length; i++) {
    for (let j = 1; j <= bMid.length; j++) {
      dp[i]![j] = aMid[i - 1] === bMid[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  let additions = 0;
  let deletions = 0;
  let i = aMid.length;
  let j = bMid.length;
  while (i > 0 && j > 0) {
    if (aMid[i - 1] === bMid[j - 1]) {
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      deletions++;
      i--;
    } else {
      additions++;
      j--;
    }
  }
  while (i > 0) { deletions++; i--; }
  while (j > 0) { additions++; j--; }

  return { additions, deletions };
}

// ─── Boundary Repair ─────────────────────────────────────────────────────────

const STRUCTURAL_CLOSER_RE = /^\s*[)\]}]+[;,]?\s*$/;
const JSX_CLOSER_RE = /^\s*(?:<\/>|<\/[A-Za-z][\w.:-]*>|\/>)\s*[;,]?\s*$/;

function isStructuralCloserLine(text: string): boolean {
  return STRUCTURAL_CLOSER_RE.test(text) || JSX_CLOSER_RE.test(text);
}

interface DelimiterBalance { paren: number; bracket: number; brace: number; }

function computeDelimiterBalance(lines: readonly string[]): DelimiterBalance {
  const balance: DelimiterBalance = { paren: 0, bracket: 0, brace: 0 };
  let inBlockComment = false;
  let quote = "";
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inBlockComment) {
        if (ch === "*" && line[i + 1] === "/") { inBlockComment = false; i++; }
        continue;
      }
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "/" && line[i + 1] === "/") break;
      if (ch === "/" && line[i + 1] === "*") { inBlockComment = true; i++; continue; }
      switch (ch) {
        case "(": balance.paren++; break;
        case ")": balance.paren--; break;
        case "[": balance.bracket++; break;
        case "]": balance.bracket--; break;
        case "{": balance.brace++; break;
        case "}": balance.brace--; break;
      }
    }
    if (quote === '"' || quote === "'") quote = "";
  }
  return balance;
}

function balanceDelta(a: DelimiterBalance, b: DelimiterBalance): DelimiterBalance {
  return { paren: a.paren - b.paren, bracket: a.bracket - b.bracket, brace: a.brace - b.brace };
}
function balanceNegate(a: DelimiterBalance): DelimiterBalance {
  return { paren: -a.paren, bracket: -a.bracket, brace: -a.brace };
}
function balanceEqual(a: DelimiterBalance, b: DelimiterBalance): boolean {
  return a.paren === b.paren && a.bracket === b.bracket && a.brace === b.brace;
}
function balanceIsZero(a: DelimiterBalance): boolean {
  return a.paren === 0 && a.bracket === 0 && a.brace === 0;
}

function hasNonWhitespace(text: string | undefined): boolean {
  if (!text) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 9 && code !== 10 && code !== 11 && code !== 12 && code !== 13 && code !== 32) return true;
  }
  return false;
}

function leadingIndent(line: string): string {
  let end = 0;
  while (end < line.length) {
    const code = line.charCodeAt(end);
    if (code !== 9 && code !== 32) break;
    end++;
  }
  return line.slice(0, end);
}

function isIndentDeeper(deeper: string, shallower: string): boolean {
  return deeper.length > shallower.length && deeper.startsWith(shallower);
}

function countDuplicateLeadingBoundaryLines(payload: readonly string[], startLine: number, fileLines: readonly string[]): number {
  const max = Math.min(payload.length, startLine - 1);
  for (let count = max; count >= 1; count--) {
    let matches = true;
    let hasContent = false;
    for (let offset = 0; offset < count; offset++) {
      const line = payload[offset];
      if (line !== fileLines[startLine - 1 - count + offset]) { matches = false; break; }
      hasContent ||= hasNonWhitespace(line);
    }
    if (matches && hasContent) return count;
  }
  return 0;
}

function countDuplicateTrailingBoundaryLines(payload: readonly string[], endLine: number, fileLines: readonly string[]): number {
  const max = Math.min(payload.length, fileLines.length - endLine);
  for (let count = max; count >= 1; count--) {
    let matches = true;
    let hasContent = false;
    for (let offset = 0; offset < count; offset++) {
      const line = payload[payload.length - count + offset];
      if (line !== fileLines[endLine + offset]) { matches = false; break; }
      hasContent ||= hasNonWhitespace(line);
    }
    if (matches && hasContent) return count;
  }
  return 0;
}

interface BoundaryEcho { leading: number; trailing: number; }

function findBoundaryEcho(payload: readonly string[], startLine: number, endLine: number, fileLines: readonly string[]): BoundaryEcho | undefined {
  const leadingMax = countDuplicateLeadingBoundaryLines(payload, startLine, fileLines);
  if (leadingMax === 0) return undefined;
  const trailingMax = countDuplicateTrailingBoundaryLines(payload, endLine, fileLines);
  if (trailingMax === 0) return undefined;
  if (leadingMax + trailingMax >= payload.length) return undefined;
  const leadingBalance = computeDelimiterBalance(payload.slice(0, leadingMax));
  const trailingBalance = computeDelimiterBalance(payload.slice(payload.length - trailingMax));
  const droppedBalance = balanceDelta(leadingBalance, balanceNegate(trailingBalance));
  if (!balanceIsZero(droppedBalance)) {
    const delta = balanceDelta(
      computeDelimiterBalance(payload),
      computeDelimiterBalance(fileLines.slice(startLine - 1, endLine)),
    );
    if (!balanceEqual(droppedBalance, delta)) return undefined;
  }
  return { leading: leadingMax, trailing: trailingMax };
}

function findDuplicateSuffix(payload: readonly string[], endLine: number, fileLines: readonly string[], delta: DelimiterBalance): number {
  if (balanceIsZero(delta)) return 0;
  const maxK = Math.min(payload.length, fileLines.length - endLine);
  for (let k = maxK; k >= 1; k--) {
    let matches = true;
    for (let t = 0; t < k; t++) {
      if (payload[payload.length - k + t] !== fileLines[endLine + t]) { matches = false; break; }
    }
    if (!matches) continue;
    if (balanceEqual(computeDelimiterBalance(payload.slice(payload.length - k)), delta)) return k;
  }
  return 0;
}

function findDuplicatePrefix(payload: readonly string[], startLine: number, fileLines: readonly string[], delta: DelimiterBalance): number {
  if (balanceIsZero(delta)) return 0;
  const maxJ = Math.min(payload.length, startLine - 1);
  for (let j = maxJ; j >= 1; j--) {
    let matches = true;
    for (let t = 0; t < j; t++) {
      if (payload[t] !== fileLines[startLine - 1 - j + t]) { matches = false; break; }
    }
    if (!matches) continue;
    if (balanceEqual(computeDelimiterBalance(payload.slice(0, j)), delta)) return j;
  }
  return 0;
}

function findOneSidedBoundaryEcho(payload: readonly string[], startLine: number, endLine: number, fileLines: readonly string[]): { side: "leading" | "trailing"; count: number } | undefined {
  const leading = countDuplicateLeadingBoundaryLines(payload, startLine, fileLines);
  const trailing = countDuplicateTrailingBoundaryLines(payload, endLine, fileLines);
  if (leading > 0 === trailing > 0) return undefined;
  const side = leading > 0 ? "leading" : "trailing";
  const count = leading > 0 ? leading : trailing;
  if (count >= payload.length) return undefined;
  const echoLines = side === "leading" ? payload.slice(0, count) : payload.slice(payload.length - count);
  if (!balanceIsZero(computeDelimiterBalance(echoLines))) return undefined;
  if (endLine === startLine) {
    if (side !== "trailing" || !echoLines.every(isStructuralCloserLine)) return undefined;
  }
  return { side, count };
}

function bodyTargetIndent(rows: readonly string[]): string | undefined {
  const nonBlank = rows.filter(hasNonWhitespace);
  if (nonBlank.length === 0) return undefined;
  if (nonBlank.every(row => STRUCTURAL_CLOSER_RE.test(row))) return undefined;
  let target = leadingIndent(nonBlank[0] ?? "");
  for (const row of nonBlank) {
    const indent = leadingIndent(row);
    if (indent.startsWith(target)) continue;
    if (target.startsWith(indent)) target = indent;
    else return undefined;
  }
  return target;
}

function resolveShiftedLanding(
  anchor: number,
  target: string,
  fileLines: readonly string[],
  targetedLines: ReadonlySet<number>,
): { line: number; crossed: number } | undefined {
  const anchorText = fileLines[anchor - 1];
  if (anchorText === undefined || !hasNonWhitespace(anchorText)) return undefined;
  if (!isIndentDeeper(leadingIndent(anchorText), target)) return undefined;
  let landing = anchor;
  let crossed = 0;
  for (let line = anchor + 1; line <= fileLines.length; line++) {
    const text = fileLines[line - 1] ?? "";
    if (!hasNonWhitespace(text)) continue;
    if (!STRUCTURAL_CLOSER_RE.test(text)) break;
    const indent = leadingIndent(text);
    if (!indent.startsWith(target)) break;
    if (targetedLines.has(line)) return undefined;
    landing = line;
    crossed++;
    if (indent.length === target.length) break;
  }
  return landing === anchor ? undefined : { line: landing, crossed };
}

function repairEdits(edits: readonly EditOp[], fileLines: readonly string[]): { edits: EditOp[]; warnings: string[] } {
  const warnings: string[] = [];
  const repaired: EditOp[] = [];

  const targetedLines = new Set<number>();
  for (const edit of edits) {
    if (edit.kind === "delete") {
      for (let l = edit.start; l <= edit.end; l++) targetedLines.add(l);
    } else if (edit.kind === "swap") {
      for (let l = edit.start; l <= edit.end; l++) targetedLines.add(l);
    } else if (edit.position === "before" || edit.position === "after") {
      targetedLines.add(edit.anchor);
    }
  }

  for (const edit of edits) {
    if (edit.kind === "swap") {
      const { lines: payload, start, end } = edit;

      const echo = findBoundaryEcho(payload, start, end, fileLines);
      if (echo) {
        warnings.push(
          `Auto-repaired a replacement boundary echo at line ${start}: dropped ${echo.leading} leading and ${echo.trailing} trailing payload line(s) already present outside the range. Issue the payload as the final desired content for the selected range only — never restate unchanged lines bordering the range.`,
        );
        repaired.push({ ...edit, lines: payload.slice(echo.leading, payload.length - echo.trailing) });
        continue;
      }

      const delta = balanceDelta(
        computeDelimiterBalance(payload),
        computeDelimiterBalance(fileLines.slice(start - 1, end)),
      );

      if (!balanceIsZero(delta)) {
        const dupSuffix = findDuplicateSuffix(payload, end, fileLines, delta);
        if (dupSuffix > 0) {
          warnings.push(
            `Auto-repaired a delimiter-balance mismatch in the replacement at line ${start}: dropped ${dupSuffix} duplicated trailing payload line(s) already present below the range. Issue the payload as the final desired content only — never restate or omit a closing bracket bordering the range.`,
          );
          repaired.push({ ...edit, lines: payload.slice(0, payload.length - dupSuffix) });
          continue;
        }
        const dupPrefix = findDuplicatePrefix(payload, start, fileLines, delta);
        if (dupPrefix > 0) {
          warnings.push(
            `Auto-repaired a delimiter-balance mismatch in the replacement at line ${start}: dropped ${dupPrefix} duplicated leading payload line(s) already present above the range. Issue the payload as the final desired content only — never restate or omit a closing bracket bordering the range.`,
          );
          repaired.push({ ...edit, lines: payload.slice(dupPrefix) });
          continue;
        }
      } else {
        const oneSided = findOneSidedBoundaryEcho(payload, start, end, fileLines);
        if (oneSided) {
          const newPayload = oneSided.side === "leading"
            ? payload.slice(oneSided.count)
            : payload.slice(0, payload.length - oneSided.count);
          const where = oneSided.side === "leading" ? "above" : "below";
          warnings.push(
            `Auto-repaired a replacement boundary echo at line ${start}: dropped ${oneSided.count} ${oneSided.side} payload line(s) identical to the surviving line(s) just ${where} the range. The range was one line short of the content you retyped — issue the payload as the final content for the selected range only, and widen the range to consume any keeper you restate.`,
          );
          repaired.push({ ...edit, lines: newPayload });
          continue;
        }
      }

      repaired.push(edit);
      continue;
    }

    if (edit.kind === "insert" && edit.position === "after") {
      const target = bodyTargetIndent(edit.lines);
      if (target !== undefined) {
        const shifted = resolveShiftedLanding(edit.anchor, target, fileLines, targetedLines);
        if (shifted !== undefined) {
          warnings.push(
            `INS.POST ${edit.anchor}: body indented shallower than the anchor, so the landing moved past ${shifted.crossed} closing line${shifted.crossed === 1 ? "" : "s"} to after line ${shifted.line}. For the deeper position inside the block, re-issue with the body indented to match.`,
          );
          repaired.push({ ...edit, anchor: shifted.line });
          continue;
        }
      }
      repaired.push(edit);
      continue;
    }

    repaired.push(edit);
  }

  return { edits: repaired, warnings };
}

// ─── Recovery (3-way merge + session-chain replay) ──────────────────────────

const RECOVERY_FUZZ_FACTOR = 0;

const RECOVERY_EXTERNAL_WARNING =
  "Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";

const RECOVERY_SESSION_CHAIN_WARNING =
  "Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash).";

const RECOVERY_SESSION_REPLAY_WARNING =
  "Recovered by replaying your edits onto the current file content (a prior in-session edit changed the lines you re-targeted with a stale hash). Verify the diff matches your intent.";

const HEADTAIL_DRIFT_WARNING =
  "Applied the INS.HEAD:/INS.TAIL: edit despite a stale snapshot tag (file changed since your read) — head/tail position is content-independent. Re-read if the drift was unexpected.";

interface RecoveryResult {
  text: string;
  firstChangedLine?: number;
  warnings: string[];
}

function hasAnchorScopedEdit(edits: readonly EditOp[]): boolean {
  return edits.some(edit => {
    if (edit.kind === "delete") return true;
    if (edit.kind === "swap") return true;
    return edit.position === "before" || edit.position === "after";
  });
}

function collectAnchorLines(edits: readonly EditOp[]): number[] {
  const lines: number[] = [];
  for (const edit of edits) {
    if (edit.kind === "delete") {
      for (let l = edit.start; l <= edit.end; l++) lines.push(l);
    } else if (edit.kind === "swap") {
      for (let l = edit.start; l <= edit.end; l++) lines.push(l);
    } else if (edit.position === "before" || edit.position === "after") {
      lines.push(edit.anchor);
    }
  }
  return lines;
}

function verifyAnchorContent(previousText: string, currentText: string, edits: readonly EditOp[]): boolean {
  const lines = collectAnchorLines(edits);
  if (lines.length === 0) return true;
  const prev = previousText.split("\n");
  const curr = currentText.split("\n");
  for (const line of lines) {
    const idx = line - 1;
    if (idx < 0 || idx >= prev.length || idx >= curr.length) return false;
    if (prev[idx] !== curr[idx]) return false;
  }
  return true;
}

function findFirstChangedLine(a: string, b: string): number | undefined {
  if (a === b) return undefined;
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) return i + 1;
  }
  return undefined;
}

function applyEditsToSnapshot(
  previousText: string,
  currentText: string,
  edits: readonly EditOp[],
  recoveryWarning: string,
): RecoveryResult | null {
  const fileLines = previousText.split("\n");
  const { edits: repairedEdits, warnings: repairWarnings } = repairEdits(edits, fileLines);
  let applied: string;
  try {
    applied = applyEdits(previousText, [...repairedEdits]);
  } catch {
    return null;
  }
  if (applied === previousText) return null;

  const patch = structuredPatch("file", "file", previousText, applied, "", "", { context: 3 });
  const merged = applyPatch(currentText, patch, { fuzzFactor: RECOVERY_FUZZ_FACTOR });
  if (typeof merged !== "string" || merged === currentText) return null;

  const firstChangedLine = findFirstChangedLine(currentText, merged);
  const warnings = [...repairWarnings];
  if (firstChangedLine !== undefined) warnings.unshift(recoveryWarning);

  return { text: merged, firstChangedLine, warnings };
}

function replaySessionChainOnCurrent(
  previousText: string,
  currentText: string,
  edits: readonly EditOp[],
): RecoveryResult | null {
  if (previousText.split("\n").length !== currentText.split("\n").length) return null;
  if (!verifyAnchorContent(previousText, currentText, edits)) return null;
  const fileLines = currentText.split("\n");
  const { edits: repairedEdits, warnings: repairWarnings } = repairEdits(edits, fileLines);
  let applied: string;
  try {
    applied = applyEdits(currentText, [...repairedEdits]);
  } catch {
    return null;
  }
  if (applied === currentText) return null;
  return {
    text: applied,
    firstChangedLine: findFirstChangedLine(currentText, applied),
    warnings: [RECOVERY_SESSION_REPLAY_WARNING, ...repairWarnings],
  };
}

function tryRecover(
  store: SnapshotStore,
  args: { path: string; currentText: string; fileHash: string; edits: readonly EditOp[] },
): RecoveryResult | null {
  const { path, currentText, fileHash, edits } = args;
  const snapshot = store.byHash(path, fileHash);
  if (!snapshot) return null;
  const head = store.head(path);
  const isHead = head === snapshot;
  const recoveryWarning = isHead ? RECOVERY_EXTERNAL_WARNING : RECOVERY_SESSION_CHAIN_WARNING;
  const merged = applyEditsToSnapshot(snapshot.text, currentText, edits, recoveryWarning);
  if (merged !== null) return merged;
  if (!isHead) return replaySessionChainOnCurrent(snapshot.text, currentText, edits);
  return null;
}

// ─── Mismatch Error with Anchored Context ───────────────────────────────────

const MISMATCH_CONTEXT = 2;

function formatAnchoredContext(anchorLines: readonly number[], fileLines: readonly string[]): string[] {
  const displayLines = new Set<number>();
  for (const line of anchorLines) {
    if (line < 1 || line > fileLines.length) continue;
    const lo = Math.max(1, line - MISMATCH_CONTEXT);
    const hi = Math.min(fileLines.length, line + MISMATCH_CONTEXT);
    for (let lineNum = lo; lineNum <= hi; lineNum++) displayLines.add(lineNum);
  }
  const anchorSet = new Set(anchorLines);
  const rows: string[] = [];
  let previous = -1;
  for (const lineNum of [...displayLines].sort((a, b) => a - b)) {
    if (previous !== -1 && lineNum > previous + 1) rows.push("...");
    previous = lineNum;
    const marker = anchorSet.has(lineNum) ? "*" : " ";
    rows.push(`${marker}${lineNum}:${fileLines[lineNum - 1] ?? ""}`);
  }
  return rows;
}

interface MismatchDetails {
  path: string;
  expectedHash: string;
  actualHash: string;
  fileLines: string[];
  anchorLines: readonly number[];
  hashRecognized: boolean;
}

function formatMismatchError(details: MismatchDetails): string {
  const pathText = ` for ${details.path}`;
  const header: string[] = details.hashRecognized
    ? [
        `Edit rejected${pathText}: file changed between read and edit.`,
        `Section is bound to #${details.expectedHash}, but the current file hashes to #${details.actualHash}. If a prior edit in this session modified this file, copy the [${details.path}#newhash] header from that edit's response; otherwise re-read the file with \`read\` to refresh the tag before retrying.`,
      ]
    : [
        `Edit rejected${pathText}: hash #${details.expectedHash} is not from this session.`,
        `The current file hashes to #${details.actualHash}. Re-read the file with \`read\` to copy a current [${details.path}#${details.actualHash}] header — never invent the tag and never reuse one from a prior session.`,
      ];
  const context = formatAnchoredContext(details.anchorLines, details.fileLines);
  if (context.length === 0) return header.join("\n");
  return [...header, "", ...context].join("\n");
}

// ─── Edit Tool ───────────────────────────────────────────────────────────────

async function executeHashlineEdit(args: { input: string }, context: EditContext): Promise<ToolResult> {
  let sections: PatchSection[];
  try {
    sections = parsePatch(args.input);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}` };
  }
  if (sections.length === 0) {
    return { output: "Error: no valid patch sections found. Expected [PATH#TAG] header followed by operations." };
  }

  const prepared: { path: string; newText: string; oldText: string; bom: string; lineEnding: LineEnding; warnings: string[] }[] = [];

  for (const section of sections) {
    const canonical = canonicalPath(section.path);

    if (!existsSync(section.path)) {
      return { output: `Error: file not found: ${section.path}` };
    }

    const rawContent = readFileSync(section.path, "utf-8");
    const { bom } = stripBom(rawContent);
    const lineEnding = detectLineEnding(rawContent);
    const normalized = normalizeForStorage(rawContent);
    const currentHash = computeFileHash(normalized);

    if (currentHash !== section.hash) {
      const snapshot = snapshotStore.byHash(canonical, section.hash);

      if (!hasAnchorScopedEdit(section.edits)) {
        const fileLines = normalized.split("\n");
        const boundsError = validateLineBounds(section.edits, fileLines);
        if (boundsError) {
          return { output: `Error: ${boundsError}` };
        }
        const { edits: repairedEdits, warnings: repairWarnings } = repairEdits(section.edits, fileLines);
        const newText = applyEdits(normalized, repairedEdits);
        prepared.push({ path: section.path, newText, oldText: normalized, bom, lineEnding, warnings: [HEADTAIL_DRIFT_WARNING, ...repairWarnings] });
        continue;
      }

      if (snapshot) {
        const recovered = tryRecover(snapshotStore, {
          path: canonical,
          currentText: normalized,
          fileHash: section.hash,
          edits: section.edits,
        });
        if (recovered) {
          prepared.push({ path: section.path, newText: recovered.text, oldText: normalized, bom, lineEnding, warnings: recovered.warnings });
          continue;
        }
        const fileLines = normalized.split("\n");
        const anchorLines = collectAnchorLines(section.edits);
        return { output: formatMismatchError({ path: section.path, expectedHash: section.hash, actualHash: currentHash, fileLines, anchorLines, hashRecognized: true }) };
      } else {
        const fileLines = normalized.split("\n");
        const anchorLines = collectAnchorLines(section.edits);
        return { output: formatMismatchError({ path: section.path, expectedHash: section.hash, actualHash: currentHash, fileLines, anchorLines, hashRecognized: false }) };
      }
    }

    const fileLines = normalized.split("\n");
    const boundsError = validateLineBounds(section.edits, fileLines);
    if (boundsError) {
      return { output: `Error: ${boundsError}` };
    }
    const { edits: repairedEdits, warnings: repairWarnings } = repairEdits(section.edits, fileLines);
    const newText = applyEdits(normalized, repairedEdits);
    prepared.push({ path: section.path, newText, oldText: normalized, bom, lineEnding, warnings: repairWarnings });
  }

  const results: string[] = [];
  const filediffs: FileDiffMetadata[] = [];

  for (const entry of prepared) {
    const restored = entry.bom + restoreLineEndings(entry.newText, entry.lineEnding);
    writeFileSync(entry.path, restored);
    const canonical = canonicalPath(entry.path);
    const newHash = snapshotStore.record(canonical, entry.newText);

    const { additions, deletions } = lineDiff(entry.oldText, entry.newText);
    const diffString = createTwoFilesPatch(entry.path, entry.path, entry.oldText, entry.newText);
    filediffs.push({
      file: entry.path,
      before: entry.oldText,
      after: entry.newText,
      patch: diffString,
      additions,
      deletions,
    });

    const changedLines = entry.newText.split("\n");
    const linePreview = changedLines.slice(0, 50).map((line, i) => `${i + 1}:${line}`).join("\n");
    const warningPrefix = entry.warnings.length > 0 ? entry.warnings.map(w => `⚠ ${w}`).join("\n") + "\n" : "";
    results.push(`${warningPrefix}Edited [${entry.path}#${newHash}]\n${linePreview}`);
  }

  if (filediffs.length > 0) {
    const first = filediffs[0]!;
    const title = context.worktree ? relativePath(context.worktree, first.file) : first.file;
    context.metadata({ metadata: { diff: first.patch, filediff: first, diagnostics: {} } });
    return { output: results.join("\n\n"), metadata: { diff: first.patch, filediff: first, diagnostics: {} }, title };
  }
  return { output: results.join("\n\n") };
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const HASHLINE_PROMPT = `
<hashline>
Your edit tool uses hash-anchored patches. When you \`read\` a file, the output starts with \`[PATH#TAG]\` where TAG is a 4-hex content hash. Each line is prefixed with its line number: \`N:content\`.

To edit, call the \`edit\` tool with a patch. Every file section starts with \`[PATH#TAG]\` — the tag from your latest \`read\`. The tag is REQUIRED on every section.

<ops>
\`SWAP N.=M:\` — replace lines N through M (inclusive) with body rows below. Single line: \`SWAP N.=N:\`.
\`DEL N\` — delete line N. Range: \`DEL N.=M\` — delete lines N through M.
\`INS.PRE N:\` — insert body rows immediately before line N.
\`INS.POST N:\` — insert body rows immediately after line N.
\`INS.HEAD:\` — insert body rows at the very start of the file.
\`INS.TAIL:\` — insert body rows at the very end of the file.
</ops>

<body-rows>
Body rows appear only under a \`:\` header. Every body row is \`+TEXT\` — add a literal line TEXT, verbatim (leading whitespace kept). \`+\` alone adds a blank line. NEVER write \`-old\` or bare/context lines. To keep a line, leave it out of every range.
</body-rows>

<rules>
- Line numbers + \`[PATH#TAG]\` header come from your latest \`read\` (\`LINE:TEXT\` rows).
- Numbers refer to the ORIGINAL file; never shift as hunks apply.
- Every applied edit mints a fresh \`#TAG\` — anchor the next edit on the edit response or a fresh \`read\`.
- Ranges cover ONLY lines whose content changes. Never widen over unchanged lines.
- Indent body rows exactly for the depth they should live at.
- On a stale-tag rejection: STOP and re-\`read\` before further edits.
- One hunk per range; body = final content, never an old/new pair.
- NEVER format/restyle code with this tool; run the project formatter instead.
</rules>

<example>
Original (from \`read\`):
\`\`\`
[greet.py#A1B2]
1:def greet(name):
2:    msg = "Hello, " + name
3:    print(msg)
4:greet("world")
\`\`\`

Insert a guard after line 1:
\`\`\`
[greet.py#A1B2]
INS.POST 1:
+    if not name: name = "stranger"
\`\`\`

Replace line 2 with two lines:
\`\`\`
[greet.py#A1B2]
SWAP 2.=2:
+    greeting = "Hi"
+    msg = f"{greeting}, {name}"
\`\`\`

Delete line 3:
\`\`\`
[greet.py#A1B2]
DEL 3
\`\`\`
</example>
</hashline>
`.trim();

// ─── Internal Agent Detection ────────────────────────────────────────────────

const INTERNAL_AGENT_SIGNATURES = [
  "You are a title generator",
  "You are a helpful AI assistant tasked with summarizing conversations",
  "Summarize what was done in this conversation",
];

function isInternalAgent(system: string[]): boolean {
  const text = system.join("\n");
  return INTERNAL_AGENT_SIGNATURES.some((sig) => text.includes(sig));
}

// ─── Plugin Entry Point ──────────────────────────────────────────────────────

const HashlinePlugin: Plugin = async ({ client, $, directory, worktree }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "read") {
        const filePath = output.args?.filePath;
        if (filePath) {
          const callInfo: CallInfo = { filePath };
          try {
            callInfo.rawContent = readFileSync(filePath, "utf-8");
          } catch {}
          pendingCalls.set(input.callID, callInfo);
        }
      }

      if (input.tool === "write") {
        const rawFilePath = output.args?.filePath;
        if (rawFilePath) {
          const filePath = unwrapHashlineHeaderPath(rawFilePath);
          const writeContent = stripWriteContent(output.args?.content ?? "");
          const callInfo: CallInfo = {
            filePath,
            writeContent,
          };
          pendingCalls.set(input.callID, callInfo);
          output.args.filePath = filePath;
          output.args.content = writeContent;
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      const callInfo = pendingCalls.get(input.callID);

      if (input.tool === "read" && callInfo?.filePath) {
        pendingCalls.delete(input.callID);
        const canonical = canonicalPath(callInfo.filePath);
        const rawContent = callInfo.rawContent ?? "";
        const hash = snapshotStore.record(canonical, rawContent);
        output.output = `[${callInfo.filePath}#${hash}]\n${output.output}`;
      }

      if (input.tool === "write" && callInfo?.filePath) {
        pendingCalls.delete(input.callID);
        const canonical = canonicalPath(callInfo.filePath);
        const content = callInfo.writeContent ?? "";
        const hash = snapshotStore.record(canonical, content);
        if (output.output) {
          output.output = `[${callInfo.filePath}#${hash}]\n${output.output}`;
        } else {
          output.output = `[${callInfo.filePath}#${hash}]`;
        }
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (isInternalAgent(output.system)) return;

      if (output.system.length > 0) {
        output.system[output.system.length - 1] += "\n\n" + HASHLINE_PROMPT;
      } else {
        output.system.push(HASHLINE_PROMPT);
      }
    },

    tool: {
      edit: tool({
        description: "Edit files using hash-anchored patches. Read a file first to get its [PATH#TAG] header, then call this tool with a patch. Each section starts with [PATH#TAG] (tag from your latest read). Operations: SWAP N.=M: (replace lines), DEL N (delete line), INS.PRE N: / INS.POST N: / INS.HEAD: / INS.TAIL: (insert). Body rows are +TEXT lines.",
        args: {
          input: tool.schema.string().describe("Hashline patch content. Each section: [PATH#TAG] header, then operations with +body rows."),
        },
        async execute(args, context) {
          return executeHashlineEdit(args, context);
        },
      }),
    },
  };
};

// ─── Test Exports ───────────────────────────────────────────────────────────
export {
  type Snapshot, type EditOp, type PatchSection, type LineEnding,
  type DelimiterBalance, type BoundaryEcho, type RecoveryResult, type MismatchDetails,
  detectLineEnding, normalizeToLF, restoreLineEndings, stripBom, normalizeForStorage,
  normalizeFileText, computeFileHash, SnapshotStore, canonicalPath,
  parsePatch, applyEdits, getAnchorLine, applySingleEdit, lineDiff,
  isStructuralCloserLine, computeDelimiterBalance, balanceDelta, balanceNegate,
  balanceEqual, balanceIsZero, hasNonWhitespace, leadingIndent, isIndentDeeper,
  countDuplicateLeadingBoundaryLines, countDuplicateTrailingBoundaryLines,
  findBoundaryEcho, findDuplicateSuffix, findDuplicatePrefix,
  findOneSidedBoundaryEcho, bodyTargetIndent, resolveShiftedLanding, repairEdits,
  hasAnchorScopedEdit, collectAnchorLines, verifyAnchorContent, findFirstChangedLine,
  applyEditsToSnapshot, replaySessionChainOnCurrent, tryRecover,
  formatAnchoredContext, formatMismatchError,
  HEADTAIL_DRIFT_WARNING, RECOVERY_EXTERNAL_WARNING,
  RECOVERY_SESSION_CHAIN_WARNING, RECOVERY_SESSION_REPLAY_WARNING,
  MISMATCH_CONTEXT,
};
export default HashlinePlugin;
export { HashlinePlugin };
