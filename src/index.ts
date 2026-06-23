import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { readFileSync, realpathSync, writeFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import * as path from "path";
import { createRequire } from "module";
import { createTwoFilesPatch, structuredPatch, applyPatch } from "diff";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Snapshot {
  path: string;
  text: string;
  hash: string;
  recordedAt: number;
  seenLines?: Set<number>;
  sessionID?: string;
}

type EditOp =
  | { kind: "swap"; start: number; end: number; lines: string[] }
  | { kind: "delete"; start: number; end: number }
  | { kind: "insert"; position: "before" | "after" | "head" | "tail"; anchor: number; lines: string[] }
  | { kind: "block"; anchor: number; lines: string[]; blockOp: "swap" | "delete" | "insert_after" };

interface BlockSpan {
  start: number;
  end: number;
}

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

interface CompactDiffPreview {
  preview: string;
  addedLines: number;
  removedLines: number;
}

type EditContext = {
  sessionID: string;
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

// ─── Tokenizer Constants ────────────────────────────────────────────────────

const CHAR_LINE_FEED = 10;
const CHAR_CARRIAGE_RETURN = 13;
const CHAR_ZERO = 48;
const CHAR_NINE = 57;
const CHAR_HASH = 35;
const CHAR_TAB = 9;
const CHAR_SPACE = 32;
const CHAR_DOT = 46;
const CHAR_HYPHEN = 45;
const CHAR_ELLIPSIS = 0x2026;
const CHAR_EQUALS = 61;
const CHAR_UPPER_A = 65;
const CHAR_UPPER_F = 70;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_F = 102;
const CHAR_PAYLOAD_REPLACE = 43;
const CHAR_COLON = 58;
const CHAR_BRACKET_OPEN = 91;
const CHAR_BRACKET_CLOSE = 93;

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ABORT_MARKER = "*** Abort";

const BARE_BODY_AUTO_PIPED_WARNING = "Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines.";
const MINUS_ROW_REJECTED = "`-` rows are not valid; the range already names the lines being changed. For a literal `-` line, write `+-…`.";
const EMPTY_BLOCK_MSG = "`SWAP.BLK N:` needs at least one `+TEXT` body row. To delete a block, use `DEL.BLK N`.";
const EMPTY_INSERT_MSG = "`INS` needs at least one `+TEXT` body row.";
const DELETE_TAKES_NO_BODY_MSG = "`DEL N.=M` does not take body rows. Remove the body, or use `SWAP N.=M:`.";
const DELETE_BLOCK_TAKES_NO_BODY_MSG = "`DEL.BLK N` does not take body rows. Remove the body, or use `SWAP.BLK N:`.";
const EMPTY_REPLACE_MSG = "`SWAP N.=M:` needs at least one `+TEXT` body row. To delete lines, use `DEL N.=M`.";

const BARE_LITERAL_VALUE_RE = /^\s*(?:"[^"]*"|'[^']*'|[-+]?\d+(?:\.\d+)?)\s*,?\s*$/;

function isDigitCode(code: number): boolean { return code >= CHAR_ZERO && code <= CHAR_NINE; }
function isNonZeroDigitCode(code: number): boolean { return code > CHAR_ZERO && code <= CHAR_NINE; }
function isHexDigitCode(code: number): boolean {
  return isDigitCode(code) || (code >= CHAR_UPPER_A && code <= CHAR_UPPER_F) || (code >= CHAR_LOWER_A && code <= CHAR_LOWER_F);
}
function isWhitespaceCode(code: number): boolean {
  return code === CHAR_SPACE || (code >= CHAR_TAB && code <= CHAR_CARRIAGE_RETURN);
}
function skipWhitespace(line: string, index: number, end = line.length): number {
  while (index < end && isWhitespaceCode(line.charCodeAt(index))) index++;
  return index;
}
function trimEndIndex(line: string): number {
  let end = line.length;
  while (end > 0 && isWhitespaceCode(line.charCodeAt(end - 1))) end--;
  return end;
}
function isEmptyLine(line: string): boolean { return line.length === 0; }
function markerLineEquals(line: string, marker: string): boolean {
  const end = trimEndIndex(line);
  return end === marker.length && line.startsWith(marker);
}

export function splitHashlineLines(text: string): string[] {
  if (text.length === 0) return [""];
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== CHAR_LINE_FEED) continue;
    let end = index;
    if (end > start && text.charCodeAt(end - 1) === CHAR_CARRIAGE_RETURN) end--;
    lines.push(text.slice(start, end));
    start = index + 1;
  }
  if (start < text.length) {
    let end = text.length;
    if (end > start && text.charCodeAt(end - 1) === CHAR_CARRIAGE_RETURN) end--;
    lines.push(text.slice(start, end));
  }
  return lines;
}

// ─── Tokenizer Scanning ─────────────────────────────────────────────────────

interface Anchor { line: number; }
interface ParsedRange { start: Anchor; end: Anchor; }
interface NumberScan { line: number; nextIndex: number; }
interface RangeScan { range: ParsedRange; nextIndex: number; }

type BlockTarget =
  | { kind: "replace"; range: ParsedRange }
  | { kind: "block"; anchor: Anchor }
  | { kind: "delete"; range: ParsedRange }
  | { kind: "delete_block"; anchor: Anchor }
  | { kind: "insert_before"; anchor: Anchor }
  | { kind: "insert_after"; anchor: Anchor }
  | { kind: "insert_after_block"; anchor: Anchor }
  | { kind: "bof" }
  | { kind: "eof" };

interface TargetScan { target: BlockTarget; nextIndex: number; }
interface ParsedHunkHeader { target: BlockTarget; }

function scanLineNumber(line: string, index: number, end: number): NumberScan | null {
  if (index >= end || !isNonZeroDigitCode(line.charCodeAt(index))) return null;
  let lineNumber = 0;
  let nextIndex = index;
  while (nextIndex < end) {
    const code = line.charCodeAt(nextIndex);
    if (!isDigitCode(code)) break;
    lineNumber = lineNumber * 10 + (code - CHAR_ZERO);
    nextIndex++;
  }
  return { line: lineNumber, nextIndex };
}

function scanRangeSeparator(line: string, index: number, end: number): number | null {
  let cursor = index;
  let consumedSeparator = false;
  while (cursor < end) {
    const code = line.charCodeAt(cursor);
    if (isWhitespaceCode(code) || code === CHAR_HYPHEN || code === CHAR_ELLIPSIS || code === CHAR_DOT || code === CHAR_EQUALS) {
      cursor++;
      consumedSeparator = true;
      continue;
    }
    break;
  }
  if (!consumedSeparator) return null;
  if (cursor >= end || !isNonZeroDigitCode(line.charCodeAt(cursor))) return null;
  return cursor;
}

function scanHeaderRange(line: string, index = 0, end = trimEndIndex(line), allowSingle = false): RangeScan | null {
  const numberStart = skipWhitespace(line, index, end);
  const start = scanLineNumber(line, numberStart, end);
  if (start === null) return null;
  const afterFirst = scanRangeSeparator(line, start.nextIndex, end);
  if (afterFirst === null) {
    if (!allowSingle) return null;
    return {
      range: { start: { line: start.line }, end: { line: start.line } },
      nextIndex: skipWhitespace(line, start.nextIndex, end),
    };
  }
  const endNumber = scanLineNumber(line, afterFirst, end);
  if (endNumber === null) return null;
  return {
    range: { start: { line: start.line }, end: { line: endNumber.line } },
    nextIndex: skipWhitespace(line, endNumber.nextIndex, end),
  };
}

function scanKeyword(line: string, index: number, end: number, keyword: string): number | null {
  if (!line.startsWith(keyword, index)) return null;
  const next = index + keyword.length;
  if (next < end) {
    const code = line.charCodeAt(next);
    if (!isWhitespaceCode(code) && code !== CHAR_COLON && code !== CHAR_DOT) return null;
  }
  return next;
}

function consumeOptionalColon(line: string, index: number, end: number): number {
  const cursor = skipWhitespace(line, index, end);
  return cursor < end && line.charCodeAt(cursor) === CHAR_COLON ? skipWhitespace(line, cursor + 1, end) : cursor;
}

function scanInsertTarget(line: string, index: number, end: number): TargetScan | null {
  if (index >= end || line.charCodeAt(index) !== CHAR_DOT) return null;
  const cursor = skipWhitespace(line, index + 1, end);
  const beforeEnd = scanKeyword(line, cursor, end, "PRE");
  if (beforeEnd !== null) {
    const anchor = scanLineNumber(line, skipWhitespace(line, beforeEnd, end), end);
    if (anchor === null) return null;
    return { target: { kind: "insert_before", anchor: { line: anchor.line } }, nextIndex: consumeOptionalColon(line, anchor.nextIndex, end) };
  }
  const afterEnd = scanKeyword(line, cursor, end, "POST");
  if (afterEnd !== null) {
    const anchor = scanLineNumber(line, skipWhitespace(line, afterEnd, end), end);
    if (anchor === null) return null;
    return { target: { kind: "insert_after", anchor: { line: anchor.line } }, nextIndex: consumeOptionalColon(line, anchor.nextIndex, end) };
  }
  const headEnd = scanKeyword(line, cursor, end, "HEAD");
  if (headEnd !== null) return { target: { kind: "bof" }, nextIndex: consumeOptionalColon(line, headEnd, end) };
  const tailEnd = scanKeyword(line, cursor, end, "TAIL");
  if (tailEnd !== null) return { target: { kind: "eof" }, nextIndex: consumeOptionalColon(line, tailEnd, end) };
  return null;
}

function scanHunkAnchor(line: string, start: number, end: number): TargetScan | null {
  const cursor = skipWhitespace(line, start, end);
  const replaceBlockEnd = scanKeyword(line, cursor, end, "SWAP.BLK");
  if (replaceBlockEnd !== null) {
    const anchor = scanLineNumber(line, skipWhitespace(line, replaceBlockEnd, end), end);
    if (anchor === null) return null;
    return { target: { kind: "block", anchor: { line: anchor.line } }, nextIndex: consumeOptionalColon(line, anchor.nextIndex, end) };
  }
  const replaceEnd = scanKeyword(line, cursor, end, "SWAP");
  if (replaceEnd !== null) {
    const range = scanHeaderRange(line, replaceEnd, end, true);
    if (range === null) return null;
    return { target: { kind: "replace", range: range.range }, nextIndex: consumeOptionalColon(line, range.nextIndex, end) };
  }
  const deleteBlockEnd = scanKeyword(line, cursor, end, "DEL.BLK");
  if (deleteBlockEnd !== null) {
    const anchor = scanLineNumber(line, skipWhitespace(line, deleteBlockEnd, end), end);
    if (anchor === null) return null;
    const next = skipWhitespace(line, anchor.nextIndex, end);
    if (next < end && line.charCodeAt(next) === CHAR_COLON) return null;
    return { target: { kind: "delete_block", anchor: { line: anchor.line } }, nextIndex: next };
  }
  const deleteEnd = scanKeyword(line, cursor, end, "DEL");
  if (deleteEnd !== null) {
    const range = scanHeaderRange(line, deleteEnd, end, true);
    if (range === null) return null;
    const next = skipWhitespace(line, range.nextIndex, end);
    if (next < end && line.charCodeAt(next) === CHAR_COLON) return null;
    return { target: { kind: "delete", range: range.range }, nextIndex: next };
  }
  const insertAfterBlockEnd = scanKeyword(line, cursor, end, "INS.BLK.POST");
  if (insertAfterBlockEnd !== null) {
    const anchor = scanLineNumber(line, skipWhitespace(line, insertAfterBlockEnd, end), end);
    if (anchor === null) return null;
    return { target: { kind: "insert_after_block", anchor: { line: anchor.line } }, nextIndex: consumeOptionalColon(line, anchor.nextIndex, end) };
  }
  const insertEnd = scanKeyword(line, cursor, end, "INS");
  if (insertEnd !== null) return scanInsertTarget(line, insertEnd, end);
  return null;
}

function tryParseHunkHeader(line: string): ParsedHunkHeader | null {
  const end = trimEndIndex(line);
  const start = skipWhitespace(line, 0, end);
  if (start >= end) return null;
  const scan = scanHunkAnchor(line, start, end);
  if (scan === null) return null;
  if (scan.nextIndex !== end) return null;
  return { target: scan.target };
}

function tryParseTokenizerHeader(line: string): { path: string; fileHash: string } | null {
  if (line.charCodeAt(0) !== CHAR_BRACKET_OPEN) return null;
  const end = trimEndIndex(line);
  if (end < 3 || line.charCodeAt(end - 1) !== CHAR_BRACKET_CLOSE) return null;
  const bodyEnd = end - 1;
  if (bodyEnd <= 1) return null;
  const trailingHashStart = bodyEnd - 5;
  if (trailingHashStart < 1 || line.charCodeAt(trailingHashStart) !== CHAR_HASH) return null;
  let allHex = true;
  for (let probe = trailingHashStart + 1; probe < bodyEnd; probe++) {
    if (!isHexDigitCode(line.charCodeAt(probe))) { allHex = false; break; }
  }
  if (!allHex) return null;
  const pathEnd = trailingHashStart;
  for (let i = 1; i < pathEnd; i++) {
    if (line.charCodeAt(i) === CHAR_HASH) return null;
  }
  if (pathEnd <= 1) return null;
  const pathText = stripApplyPatchPathNoise(line.slice(1, pathEnd));
  if (pathText.length === 0) return null;
  const fileHash = line.slice(trailingHashStart + 1, bodyEnd).toUpperCase();
  return { path: pathText, fileHash };
}

// ─── Tokenizer ──────────────────────────────────────────────────────────────

type Token =
  | { kind: "blank"; lineNum: number }
  | { kind: "envelope-begin"; lineNum: number }
  | { kind: "envelope-end"; lineNum: number }
  | { kind: "abort"; lineNum: number }
  | { kind: "header"; lineNum: number; path: string; fileHash: string }
  | { kind: "op-block"; lineNum: number; target: BlockTarget }
  | { kind: "payload-literal"; lineNum: number; text: string }
  | { kind: "raw"; lineNum: number; text: string };

function classifyLine(line: string, lineNum: number): Token {
  if (isEmptyLine(line)) return { kind: "blank", lineNum };
  if (markerLineEquals(line, BEGIN_PATCH_MARKER)) return { kind: "envelope-begin", lineNum };
  if (markerLineEquals(line, END_PATCH_MARKER)) return { kind: "envelope-end", lineNum };
  if (markerLineEquals(line, ABORT_MARKER)) return { kind: "abort", lineNum };
  if (line.charCodeAt(0) === CHAR_BRACKET_OPEN) {
    const header = tryParseTokenizerHeader(line);
    if (header !== null) {
      return { kind: "header", lineNum, path: header.path, fileHash: header.fileHash };
    }
    if (line.charCodeAt(line.length - 1) === CHAR_BRACKET_CLOSE) {
      const recovered = tryParseRecoveryHeader(line);
      if (recovered !== null) {
        return { kind: "header", lineNum, path: recovered.path, fileHash: recovered.hash };
      }
    }
  }
  const lead = skipWhitespace(line, 0);
  const isHunkLead =
    line.startsWith("SWAP", lead) ||
    line.startsWith("DEL", lead) ||
    line.startsWith("INS", lead);
  if (isHunkLead) {
    const hunk = tryParseHunkHeader(line);
    if (hunk !== null) return { kind: "op-block", lineNum, target: hunk.target };
  }
  if (line.charCodeAt(0) === CHAR_PAYLOAD_REPLACE) {
    return { kind: "payload-literal", lineNum, text: line.slice(1) };
  }
  return { kind: "raw", lineNum, text: line };
}

export class Tokenizer {
  #buffer = "";
  #nextLineNum = 1;
  #closed = false;

  feed(chunk: string): Token[] {
    if (this.#closed) throw new Error("Tokenizer is closed; call reset() before reusing.");
    if (chunk.length === 0) return [];
    this.#buffer = this.#buffer ? this.#buffer + chunk : chunk;
    return this.#drainCompleteLines();
  }

  end(): Token[] {
    if (this.#closed) return [];
    this.#closed = true;
    const buf = this.#buffer;
    this.#buffer = "";
    if (buf.length === 0) return [];
    let stop = buf.length;
    if (buf.charCodeAt(stop - 1) === CHAR_CARRIAGE_RETURN) stop--;
    return [classifyLine(buf.slice(0, stop), this.#nextLineNum++)];
  }

  reset(): void {
    this.#buffer = "";
    this.#nextLineNum = 1;
    this.#closed = false;
  }

  tokenizeAll(text: string): Token[] {
    this.reset();
    const first = this.feed(text);
    const last = this.end();
    return last.length === 0 ? first : first.concat(last);
  }

  tokenize(line: string, lineNum = 0): Token {
    return classifyLine(line, lineNum);
  }

  isOp(line: string): boolean {
    return tryParseHunkHeader(line) !== null;
  }

  isHeader(line: string): boolean {
    return tryParseTokenizerHeader(line) !== null || tryParseRecoveryHeader(line) !== null;
  }

  isEnvelopeMarker(line: string): boolean {
    return markerLineEquals(line, BEGIN_PATCH_MARKER) || markerLineEquals(line, END_PATCH_MARKER) || markerLineEquals(line, ABORT_MARKER);
  }

  #drainCompleteLines(): Token[] {
    const tokens: Token[] = [];
    const buf = this.#buffer;
    let start = 0;
    for (let index = 0; index < buf.length; index++) {
      if (buf.charCodeAt(index) !== CHAR_LINE_FEED) continue;
      let stop = index;
      if (stop > start && buf.charCodeAt(stop - 1) === CHAR_CARRIAGE_RETURN) stop--;
      tokens.push(classifyLine(buf.slice(start, stop), this.#nextLineNum++));
      start = index + 1;
    }
    this.#buffer = start < buf.length ? buf.slice(start) : "";
    return tokens;
  }
}

// ─── Executor ───────────────────────────────────────────────────────────────

interface PayloadRow { text: string; lineNum: number; bare?: boolean; }

interface Pending {
  target: BlockTarget;
  lineNum: number;
  payloads: PayloadRow[];
  deferredBlanks: PayloadRow[];
}

interface PendingComment {
  lineNum: number;
  text: string;
}

function validateRangeOrder(range: ParsedRange, lineNum: number): void {
  if (range.end.line < range.start.line) {
    throw new Error(`line ${lineNum}: range ${range.start.line}.=${range.end.line} ends before it starts.`);
  }
}

function isSkippableCommentLine(line: string): boolean {
  return line.trimStart().startsWith("#");
}

export class Executor {
  #sections: PatchSection[] = [];
  #currentSection: PatchSection | null = null;
  #warnings: string[] = [];
  #pending: Pending | undefined;
  #terminated = false;
  #skippableComments: PendingComment[] = [];

  #discardPendingSkippableComments(): void {
    this.#skippableComments = [];
  }

  #consumePendingSkippableComments(): void {
    this.#skippableComments = [];
  }

  feed(token: Token): void {
    if (this.#terminated) return;
    switch (token.kind) {
      case "envelope-begin":
        this.#consumePendingSkippableComments();
        return;
      case "envelope-end":
        this.#consumePendingSkippableComments();
        this.#terminated = true;
        return;
      case "abort":
        this.#terminated = true;
        return;
      case "header":
        this.#consumePendingSkippableComments();
        this.#flushPending();
        this.#currentSection = { path: token.path, hash: token.fileHash, edits: [] };
        this.#sections.push(this.#currentSection);
        return;
      case "blank":
        this.#consumePendingSkippableComments();
        this.#handleBlank("", token.lineNum);
        return;
      case "payload-literal":
        this.#consumePendingSkippableComments();
        this.#handleLiteralPayload(token.text, token.lineNum);
        return;
      case "raw":
        if (this.#pending === undefined && this.#currentSection !== null && isSkippableCommentLine(token.text)) {
          this.#skippableComments.push({ text: token.text, lineNum: token.lineNum });
          return;
        }
        this.#consumePendingSkippableComments();
        this.#handleRaw(token.text, token.lineNum);
        return;
      case "op-block":
        this.#discardPendingSkippableComments();
        if (token.target.kind === "replace" || token.target.kind === "delete") {
          validateRangeOrder(token.target.range, token.lineNum);
        }
        this.#flushPending();
        this.#pending = { target: token.target, lineNum: token.lineNum, payloads: [], deferredBlanks: [] };
        return;
    }
  }

  end(): { sections: PatchSection[]; warnings: string[] } {
    this.#consumePendingSkippableComments();
    this.#flushPending();
    this.#validateNoOverlappingDeletes();
    return { sections: this.#sections, warnings: this.#warnings };
  }

  endStreaming(): { sections: PatchSection[]; warnings: string[] } {
    this.#consumePendingSkippableComments();
    if (this.#pending && this.#pending.payloads.length > 0) this.#flushPending();
    else if (this.#pending?.target.kind === "delete" || this.#pending?.target.kind === "delete_block") this.#flushPending();
    else this.#pending = undefined;
    this.#validateNoOverlappingDeletes();
    return { sections: this.#sections, warnings: this.#warnings };
  }

  reset(): void {
    this.#sections = [];
    this.#currentSection = null;
    this.#warnings = [];
    this.#pending = undefined;
    this.#skippableComments = [];
    this.#terminated = false;
  }

  #validateNoOverlappingDeletes(): void {
    const deleteCountByStart = new Map<number, number>();
    for (const section of this.#sections) {
      for (const edit of section.edits) {
        if (edit.kind !== "delete") continue;
        const count = deleteCountByStart.get(edit.start);
        deleteCountByStart.set(edit.start, (count ?? 0) + 1);
      }
    }
    for (const [anchorLine, count] of deleteCountByStart) {
      if (count < 2) continue;
      throw new Error(
        `anchor line ${anchorLine} is already targeted by another delete hunk. ` +
        "Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.",
      );
    }
  }

  #handleLiteralPayload(text: string, lineNum: number): void {
    const pending = this.#pending;
    if (!pending) {
      throw new Error(`line ${lineNum}: payload line has no preceding hunk header. Got ${JSON.stringify(`+${text}`)}.`);
    }
    if (pending.target.kind === "delete") throw new Error(`line ${lineNum}: ${DELETE_TAKES_NO_BODY_MSG}`);
    if (pending.target.kind === "delete_block") throw new Error(`line ${lineNum}: ${DELETE_BLOCK_TAKES_NO_BODY_MSG}`);
    this.#commitDeferredBlanks(pending);
    pending.payloads.push({ text, lineNum });
  }

  #handleRaw(text: string, lineNum: number): void {
    const contamination = detectContamination(text);
    if (contamination !== null) throw new Error(`line ${lineNum}: ${contamination}`);
    if (this.#pending) {
      if (text.trim().length === 0) {
        this.#handleBlank(text, lineNum);
        return;
      }
      if (this.#pending.target.kind === "delete") throw new Error(`line ${lineNum}: ${DELETE_TAKES_NO_BODY_MSG}`);
      if (this.#pending.target.kind === "delete_block") throw new Error(`line ${lineNum}: ${DELETE_BLOCK_TAKES_NO_BODY_MSG}`);
      if (text.trimStart().charCodeAt(0) === 45) throw new Error(`line ${lineNum}: ${MINUS_ROW_REJECTED}`);
      if (!this.#warnings.includes(BARE_BODY_AUTO_PIPED_WARNING)) this.#warnings.push(BARE_BODY_AUTO_PIPED_WARNING);
      this.#commitDeferredBlanks(this.#pending);
      this.#pending.payloads.push({ text, lineNum, bare: true });
      return;
    }
    if (text.trim().length === 0) return;
    if (this.#currentSection === null) return;
    throw new Error(
      `line ${lineNum}: payload line has no preceding hunk header. ` +
      `Use \`SWAP N.=M:\`, \`DEL N.=M\`, or \`INS.PRE|POST|HEAD|TAIL:\` above the body. Got ${JSON.stringify(text)}.`,
    );
  }

  #handleBlank(text: string, lineNum: number): void {
    const pending = this.#pending;
    if (!pending) return;
    if (pending.target.kind === "delete" || pending.target.kind === "delete_block") return;
    if (pending.payloads.length === 0) return;
    pending.deferredBlanks.push({ text, lineNum, bare: true });
  }

  #commitDeferredBlanks(pending: Pending): void {
    if (pending.deferredBlanks.length === 0) return;
    if (!this.#warnings.includes(BARE_BODY_AUTO_PIPED_WARNING)) this.#warnings.push(BARE_BODY_AUTO_PIPED_WARNING);
    pending.payloads.push(...pending.deferredBlanks);
    pending.deferredBlanks = [];
  }

  #stripBarePrefixesIfUniform(payloads: PayloadRow[]): void {
    let sawBare = false;
    let allLiteralValues = true;
    for (const row of payloads) {
      if (!row.bare || row.text.trim().length === 0) continue;
      sawBare = true;
      const stripped = stripLeadingHashlinePrefix(row.text);
      if (stripped === row.text) return;
      allLiteralValues = allLiteralValues && BARE_LITERAL_VALUE_RE.test(stripped);
    }
    if (!sawBare) return;
    if (allLiteralValues) return;
    for (const row of payloads) {
      if (row.bare && row.text.trim().length > 0) row.text = stripLeadingHashlinePrefix(row.text);
    }
  }

  #flushPending(): void {
    const pending = this.#pending;
    if (!pending) return;
    const { target, lineNum, payloads } = pending;
    this.#stripBarePrefixesIfUniform(payloads);
    this.#pending = undefined;
    const section = this.#currentSection;
    if (!section) return;
    if (target.kind === "delete") {
      section.edits.push({ kind: "delete", start: target.range.start.line, end: target.range.end.line });
      return;
    }
    if (target.kind === "delete_block") {
      section.edits.push({ kind: "block", anchor: target.anchor.line, lines: [], blockOp: "delete" });
      return;
    }
    if (target.kind === "block") {
      if (payloads.length === 0) throw new Error(`line ${lineNum}: ${EMPTY_BLOCK_MSG}`);
      section.edits.push({ kind: "block", anchor: target.anchor.line, lines: payloads.map(p => p.text), blockOp: "swap" });
      return;
    }
    if (target.kind === "insert_after_block") {
      if (payloads.length === 0) throw new Error(`line ${lineNum}: ${EMPTY_INSERT_MSG}`);
      section.edits.push({ kind: "block", anchor: target.anchor.line, lines: payloads.map(p => p.text), blockOp: "insert_after" });
      return;
    }
    if (payloads.length === 0) {
      if (target.kind === "replace") {
        throw new Error(`line ${lineNum}: ${EMPTY_REPLACE_MSG}`);
      }
      throw new Error(`line ${lineNum}: ${EMPTY_INSERT_MSG}`);
    }
    const lines = payloads.map(p => p.text);
    if (target.kind === "replace") {
      section.edits.push({ kind: "swap", start: target.range.start.line, end: target.range.end.line, lines });
      return;
    }
    if (target.kind === "insert_before") {
      section.edits.push({ kind: "insert", position: "before", anchor: target.anchor.line, lines });
      return;
    }
    if (target.kind === "insert_after") {
      section.edits.push({ kind: "insert", position: "after", anchor: target.anchor.line, lines });
      return;
    }
    const cursor = target.kind === "bof" ? "head" : "tail";
    section.edits.push({ kind: "insert", position: cursor, anchor: 0, lines });
  }
}

// ─── Snapshot Store ──────────────────────────────────────────────────────────

const MAX_PATHS = 30;
const MAX_VERSIONS_PER_PATH = 4;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_GREP_SNAPSHOT_BYTES = 4 * 1024 * 1024;

function mergeSeenLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
  if (lines === undefined) return;
  if (snapshot.seenLines === undefined) snapshot.seenLines = new Set<number>();
  for (const line of lines) snapshot.seenLines.add(line);
}

class SnapshotStore {
  private store = new Map<string, Snapshot[]>();
  private totalBytes = 0;

  record(path: string, text: string, seenLines?: Iterable<number>, sessionID?: string): string {
    const normalized = normalizeForStorage(text);
    const hash = computeFileHash(normalized);
    const snapshot: Snapshot = { path, text: normalized, hash, recordedAt: Date.now(), sessionID };
    mergeSeenLines(snapshot, seenLines);

    let versions = this.store.get(path);
    if (!versions) {
      versions = [];
      this.store.set(path, versions);
    }

    const existing = versions.find((s) => s.hash === hash);
    if (existing) {
      existing.recordedAt = Date.now();
      if (existing.sessionID === undefined) existing.sessionID = sessionID;
      mergeSeenLines(existing, seenLines);
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

  recordSeenLines(path: string, hash: string, lines: Iterable<number>): void {
    const versions = this.store.get(path);
    if (!versions) return;
    const snapshot = versions.find(s => s.hash === hash);
    if (snapshot) mergeSeenLines(snapshot, lines);
  }

  head(path: string): Snapshot | null {
    const versions = this.store.get(path);
    if (!versions || versions.length === 0) return null;
    return versions[versions.length - 1]!;
  }

  entriesForSession(sessionID?: string): Array<{ path: string; hash: string; seenLines?: Set<number>; lineCount: number; recordedAt: number }> {
    const result: Array<{ path: string; hash: string; seenLines?: Set<number>; lineCount: number; recordedAt: number }> = [];
    for (const [, versions] of this.store) {
      const head = versions[versions.length - 1];
      if (!head) continue;
      if (sessionID !== undefined && head.sessionID !== undefined && head.sessionID !== sessionID) continue;
      result.push({
        path: head.path,
        hash: head.hash,
        seenLines: head.seenLines,
        lineCount: head.text.split("\n").length,
        recordedAt: head.recordedAt,
      });
    }
    return result;
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
    try {
      const parent = realpathSync(path.dirname(filePath));
      return path.join(parent, path.basename(filePath));
    } catch {
      return filePath;
    }
  }
}

function relativePath(from: string, to: string): string {
  const rel = path.relative(from, to);
  return rel || to;
}

const HL_PREFIX_RE = /^\s*(?:>>>|>>)?\s*(?:[+*-]\s*)?\d+:/;
const HL_HEADER_RE = /^\s*\[[^#\r\n]+#[0-9a-fA-F]{4}\]\s*$/;
const READ_TRUNCATION_NOTICE_RE = /^\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines? in (?:file|\S+))\b.*\bUse :L?\d+/;
const APPLY_PATCH_PATH_NOISE_RE = /^\*{0,3}\s*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?\s*\*{0,3}\s*/i;

function stripApplyPatchPathNoise(pathText: string): string {
  return pathText.replace(APPLY_PATCH_PATH_NOISE_RE, "");
}

function tryParseRecoveryHeader(line: string): { path: string; hash: string } | null {
  if (!line.startsWith("[") || !line.endsWith("]")) return null;
  const body = stripApplyPatchPathNoise(line.slice(1, line.length - 1).trim());
  if (body.length === 0) return null;
  const trailing = new RegExp("#([0-9A-Fa-f]{4})\\s*$").exec(body);
  let pathText: string;
  let fileHash: string | undefined;
  if (trailing !== null) {
    pathText = body.slice(0, trailing.index);
    fileHash = trailing[1]!.toUpperCase();
  } else {
    pathText = body.replace(/\s+$/, "");
  }
  if (pathText.includes("#")) return null;
  if (pathText.length === 0) return null;
  return fileHash !== undefined ? { path: pathText, hash: fileHash } : null;
}

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

const HASHLINE_LINE_PREFIX = /^[ *]?(\d+)(?:-(\d+))?:/;

function parseSeenLinesFromHashlineBody(body: string): number[] {
  const seen: number[] = [];
  for (const row of body.split("\n")) {
    const match = HASHLINE_LINE_PREFIX.exec(row);
    if (!match) continue;
    seen.push(Number(match[1]));
    if (match[2] !== undefined) seen.push(Number(match[2]));
  }
  return seen;
}

// ─── Grep Output Parsing ─────────────────────────────────────────────────────

interface GrepMatch {
  line: number;
  text: string;
}

interface GrepFileMatches {
  path: string;
  matches: GrepMatch[];
}

interface ParsedGrepOutput {
  header: string;
  files: GrepFileMatches[];
  footer: string;
}

function parseGrepOutput(output: string): ParsedGrepOutput | null {
  const lines = output.split("\n");
  if (lines.length === 0) return null;

  const first = lines[0];
  if (first === undefined) return null;
  const headerMatch = /^Found (\d+) matches/.exec(first);
  if (!headerMatch) return null;

  const header = first;
  const files: GrepFileMatches[] = [];
  let footer = "";

  let i = 1;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line === "") {
      i++;
      continue;
    }

    const fileMatch = /^(\/.+):$/.exec(line);
    if (fileMatch) {
      const filePath = fileMatch[1] ?? "";
      if (filePath === "") { i++; continue; }
      const matches: GrepMatch[] = [];
      i++;
      while (i < lines.length) {
        const matchLine = /^  Line (\d+): (.*)$/.exec(lines[i] ?? "");
        if (!matchLine) break;
        matches.push({ line: Number(matchLine[1] ?? "0"), text: matchLine[2] ?? "" });
        i++;
      }
      files.push({ path: filePath, matches });
      continue;
    }

    if (/^\(Results truncated/.test(line)) {
      footer = line;
      i++;
      continue;
    }

    i++;
  }

  return { header, files, footer };
}

// ─── Call Tracking (tool.execute.before → after bridge) ──────────────────────

interface CallInfo {
  filePath?: string;
  rawContent?: string;
  writeContent?: string;
}

const pendingCalls = new Map<string, CallInfo>();

// ─── Noop Loop Guard ─────────────────────────────────────────────────────────

interface NoopLoopEntry {
  hash: string;
  count: number;
}

const NOOP_HARD_LIMIT = 3;
const noopGuards = new Map<string, Map<string, NoopLoopEntry>>();

function hashPatchInput(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

function recordNoopEdit(sessionID: string, canonicalPath: string, inputHash: string): { count: number; escalate: boolean } {
  let sessionGuard = noopGuards.get(sessionID);
  if (!sessionGuard) {
    sessionGuard = new Map();
    noopGuards.set(sessionID, sessionGuard);
  }
  const prev = sessionGuard.get(canonicalPath);
  const count = prev && prev.hash === inputHash ? prev.count + 1 : 1;
  sessionGuard.set(canonicalPath, { hash: inputHash, count });
  return { count, escalate: count >= NOOP_HARD_LIMIT };
}

function resetNoopEdit(sessionID: string, canonicalPath: string): void {
  const sessionGuard = noopGuards.get(sessionID);
  if (!sessionGuard) return;
  sessionGuard.delete(canonicalPath);
}

function noChangeDiagnostic(path: string): string {
  return (
    `Edits to ${path} parsed and applied cleanly, but produced no change: ` +
    `your body row(s) are byte-identical to the file at the targeted lines. ` +
    `The bug is somewhere else — re-read the file before issuing another edit. ` +
    `Do NOT widen the payload or add lines; verify the anchor first.`
  );
}

function noChangeLoopDiagnostic(path: string, count: number): string {
  return (
    `STOP. Edits to ${path} have been a byte-identical no-op ${count} times in a row — ` +
    `the patch body matches the file at the targeted lines and the soft hint did not break the cycle. ` +
    `Cease re-issuing this payload. Either the intended change is already on disk (move on), ` +
    `or your anchor is wrong (re-read the file with \`read\` to observe the current line numbers and ` +
    `tag, then author a different edit). This exact payload will keep being rejected until it changes.`
  );
}

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
  if (/^DEL\s+[1-9]\d*(?:\s*(?:\.\.|\.=|-|…|\s)\s*[1-9]\d*)?\s*:/.test(trimmed)) {
    return "`DEL N.=M` has no colon and no body. Remove the colon and body rows.";
  }
  if (/^[1-9]\d*\s*$/.test(trimmed)) {
    return `hunk headers need a verb. Use \`SWAP ${trimmed}.=${trimmed}:\` to replace, or \`DEL ${trimmed}\` to delete.`;
  }
  const bareRange = /^([1-9]\d*)\s*[-. …=]+\s*([1-9]\d*)\s*:?$/.exec(trimmed);
  if (bareRange !== null) {
    return (
      `bare range hunk header ${JSON.stringify(trimmed)} is not valid. ` +
      `Hunk headers need a verb: write \`SWAP ${bareRange[1]}.=${bareRange[2]}:\` or \`DEL ${bareRange[1]}.=${bareRange[2]}\`.`
    );
  }
  return null;
}

function parsePatch(input: string): PatchSection[] {
  const tokenizer = new Tokenizer();
  const executor = new Executor();
  for (const token of tokenizer.feed(input)) executor.feed(token);
  for (const token of tokenizer.end()) executor.feed(token);
  return executor.end().sections;
}

function parsePatchStreaming(input: string): { sections: PatchSection[]; warnings: string[] } {
  const tokenizer = new Tokenizer();
  const executor = new Executor();
  for (const token of tokenizer.feed(input)) executor.feed(token);
  for (const token of tokenizer.end()) executor.feed(token);
  return executor.endStreaming();
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

async function applyPartialTo(
  edits: readonly EditOp[],
  text: string,
  filePath: string,
): Promise<{ text: string; warnings: string[] }> {
  const { edits: resolved, warnings } = await resolveBlockEdits(edits, text, filePath, { onUnresolved: "drop" });
  const resultText = applyEdits(text, resolved);
  return { text: resultText, warnings };
}

function getAnchorLine(edit: EditOp): number {
  switch (edit.kind) {
    case "swap":
    case "delete":
      return edit.start;
    case "insert":
      return edit.anchor;
    case "block":
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
      case "block":
        break;
    }
  }
  return null;
}

function trailingPhantomLine(fileLines: readonly string[]): number {
  return fileLines.length > 1 && fileLines[fileLines.length - 1]! === "" ? fileLines.length : 0;
}

function dropTrailingPhantomDeletes(edits: readonly EditOp[], fileLines: readonly string[]): EditOp[] {
  const phantomLine = trailingPhantomLine(fileLines);
  if (phantomLine === 0) return [...edits];
  const result: EditOp[] = [];
  for (const edit of edits) {
    if (edit.kind === "delete") {
      if (edit.start === phantomLine && edit.end === phantomLine) continue;
      if (edit.end === phantomLine && edit.start < phantomLine) {
        result.push({ kind: "delete", start: edit.start, end: phantomLine - 1 });
        continue;
      }
    }
    result.push(edit);
  }
  return result;
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
      return lines;
    }
    case "block":
      return lines;
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

// ─── Compact Diff Preview ────────────────────────────────────────────────────

const DEFAULT_ADDED_RUN_CONTEXT_LINES = 2;
const PREVIEW_ELISION_MARKER = "…";
const PREVIEW_GAP_ROW = "";
const RAW_ELISION_MARKERS = new Set(["...", PREVIEW_ELISION_MARKER, `+${PREVIEW_ELISION_MARKER}`]);

function isPreviewSeparator(line: string | undefined): boolean {
  return line === PREVIEW_ELISION_MARKER || line === PREVIEW_GAP_ROW;
}

function appendPreviewLine(output: string[], line: string): void {
  const normalized = RAW_ELISION_MARKERS.has(line) ? PREVIEW_ELISION_MARKER : line;
  if (isPreviewSeparator(normalized) && (output.length === 0 || isPreviewSeparator(output[output.length - 1]))) {
    return;
  }
  output.push(normalized);
}

interface ParsedNumberedDiffLine {
  kind: "+" | "-" | " ";
  lineNumber: number;
  content: string;
}

function parseNumberedDiffLine(line: string): ParsedNumberedDiffLine | undefined {
  const kind = line[0];
  if (kind !== "+" && kind !== "-" && kind !== " ") return undefined;

  const body = line.slice(1);
  const sep = body.indexOf("|");
  if (sep === -1) return undefined;

  const lineNumber = Number.parseInt(body.slice(0, sep), 10);
  if (!Number.isFinite(lineNumber)) return undefined;

  return { kind, lineNumber, content: body.slice(sep + 1) };
}

function appendAddedRun(output: string[], run: string[], edgeLines: number): void {
  if (run.length === 0) return;

  const collapseThreshold = edgeLines * 2 + 1;
  if (run.length <= collapseThreshold) {
    for (const text of run) appendPreviewLine(output, text);
    return;
  }

  for (let i = 0; i < edgeLines; i++) appendPreviewLine(output, run[i]!);
  appendPreviewLine(output, PREVIEW_ELISION_MARKER);
  for (let i = run.length - edgeLines; i < run.length; i++) appendPreviewLine(output, run[i]!);
}

function buildCompactDiffPreview(diff: string): CompactDiffPreview {
  const lines = diff.length === 0 ? [] : diff.split("\n");
  const addedRunContext = DEFAULT_ADDED_RUN_CONTEXT_LINES;
  let addedLines = 0;
  let removedLines = 0;
  const formatted: string[] = [];
  const addedRun: string[] = [];

  const flushAddedRun = (): void => {
    appendAddedRun(formatted, addedRun, addedRunContext);
    addedRun.length = 0;
  };

  for (const line of lines) {
    const parsed = parseNumberedDiffLine(line);
    if (!parsed) {
      flushAddedRun();
      appendPreviewLine(formatted, line);
      continue;
    }

    switch (parsed.kind) {
      case "+": {
        addedLines++;
        addedRun.push(`${parsed.lineNumber}:${parsed.content}`);
        break;
      }
      case "-":
        flushAddedRun();
        removedLines++;
        break;
      default: {
        flushAddedRun();
        const newLineNumber = parsed.lineNumber + addedLines - removedLines;
        appendPreviewLine(formatted, `${newLineNumber}:${parsed.content}`);
        break;
      }
    }
  }
  flushAddedRun();
  while (formatted.length > 0 && isPreviewSeparator(formatted[formatted.length - 1])) formatted.pop();

  return { preview: formatted.join("\n"), addedLines, removedLines };
}

function buildNumberedDiff(oldText: string, newText: string): string {
  const patch = structuredPatch("", "", oldText, newText, "", "", { context: 3 });
  const lines: string[] = [];
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const hunkLine of hunk.lines) {
      const prefix = hunkLine[0];
      const content = hunkLine.slice(1);
      if (prefix === " ") {
        lines.push(` ${oldLine}|${content}`);
        oldLine++;
        newLine++;
      } else if (prefix === "-") {
        lines.push(`-${oldLine}|${content}`);
        oldLine++;
      } else if (prefix === "+") {
        lines.push(`+${newLine}|${content}`);
        newLine++;
      }
    }
  }
  return lines.join("\n");
}

// ─── Streaming Diff Preview ───────────────────────────────────────────────────

async function buildStreamingSectionDiff(
  edits: readonly EditOp[],
  normalized: string,
  filePath: string,
): Promise<{ diff: string; firstChangedLine?: number } | { error: string }> {
  const { edits: resolved } = await resolveBlockEdits(edits, normalized, filePath, { onUnresolved: "drop" });
  const fileLines = normalized.split("\n");
  const sorted = [...resolved].sort((a, b) => getAnchorLine(a) - getAnchorLine(b));

  const groups: Map<number, EditOp[]> = new Map();
  for (const edit of sorted) {
    const key = getAnchorLine(edit);
    const list = groups.get(key);
    if (list) list.push(edit);
    else groups.set(key, [edit]);
  }

  const rows: string[] = [];
  let firstChangedLine: number | undefined;

  for (const [, group] of groups) {
    const deletes: number[] = [];
    const inserts: string[] = [];
    let insertBase: number | undefined;
    let baseSet = false;

    for (const edit of group) {
      if (edit.kind === "swap") {
        for (let l = edit.start; l <= edit.end; l++) deletes.push(l);
        for (const text of edit.lines) inserts.push(text);
        if (!baseSet) { insertBase = edit.start; baseSet = true; }
      } else if (edit.kind === "delete") {
        for (let l = edit.start; l <= edit.end; l++) deletes.push(l);
        if (!baseSet) { insertBase = edit.start; baseSet = true; }
      } else if (edit.kind === "insert") {
        for (const text of edit.lines) inserts.push(text);
        if (!baseSet) {
          switch (edit.position) {
            case "head":
              insertBase = 1;
              break;
            case "tail":
              insertBase = fileLines.length + 1;
              break;
            case "before":
              insertBase = edit.anchor;
              break;
            case "after":
              insertBase = edit.anchor + 1;
              break;
          }
          baseSet = true;
        }
      }
    }

    deletes.sort((a, b) => a - b);

    for (const line of deletes) {
      if (firstChangedLine === undefined) firstChangedLine = line;
      const content = line >= 1 && line <= fileLines.length ? (fileLines[line - 1] ?? "") : "";
      rows.push(`-${line}|${content}`);
    }

    let newLine = insertBase ?? deletes[0] ?? 1;
    for (const text of inserts) {
      if (firstChangedLine === undefined) firstChangedLine = newLine;
      rows.push(`+${newLine}|${text}`);
      newLine++;
    }
  }

  if (rows.length === 0) {
    return { error: "No changes would be made." };
  }

  return { diff: rows.join("\n"), firstChangedLine };
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
    } else if (edit.kind === "insert" && (edit.position === "before" || edit.position === "after")) {
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

// ─── Block Resolver (tree-sitter) ────────────────────────────────────────────

const EXTENSION_TO_WASM: Record<string, string> = {
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
  ".py": "tree-sitter-python.wasm",
  ".rs": "tree-sitter-rust.wasm",
  ".go": "tree-sitter-go.wasm",
  ".rb": "tree-sitter-ruby.wasm",
  ".java": "tree-sitter-java.wasm",
  ".c": "tree-sitter-c.wasm",
  ".cpp": "tree-sitter-cpp.wasm",
  ".cc": "tree-sitter-cpp.wasm",
  ".cxx": "tree-sitter-cpp.wasm",
  ".h": "tree-sitter-c.wasm",
  ".hpp": "tree-sitter-cpp.wasm",
  ".cs": "tree-sitter-c_sharp.wasm",
  ".css": "tree-sitter-css.wasm",
  ".dart": "tree-sitter-dart.wasm",
  ".php": "tree-sitter-php.wasm",
  ".swift": "tree-sitter-swift.wasm",
  ".sol": "tree-sitter-solidity.wasm",
  ".vue": "tree-sitter-vue.wasm",
};

const _require = createRequire(import.meta.url);
let _wasmDir: string | null = null;
function wasmDir(): string {
  if (_wasmDir) return _wasmDir;
  _wasmDir = path.join(path.dirname(_require.resolve("@repomix/tree-sitter-wasms/package.json")), "out");
  return _wasmDir;
}

let parserInstance: any = null;
const languageCache = new Map<string, any>();
const resolutionCache = new Map<string, BlockSpan | null>();
const RESOLUTION_CACHE_MAX = 512;

async function ensureParser(): Promise<any> {
  if (!parserInstance) {
    const { Parser } = await import("web-tree-sitter");
    await Parser.init();
    parserInstance = new Parser();
  }
  return parserInstance;
}

async function loadLanguage(ext: string): Promise<any | null> {
  const cached = languageCache.get(ext);
  if (cached) return cached;
  const wasmFile = EXTENSION_TO_WASM[ext];
  if (!wasmFile) return null;
  const { Language } = await import("web-tree-sitter");
  const lang = await Language.load(path.join(wasmDir(), wasmFile));
  languageCache.set(ext, lang);
  return lang;
}

function resolveBlockSpan(text: string, line: number): BlockSpan | null {
  const row = line - 1;
  const lines = text.split("\n");
  if (row < 0 || row >= lines.length) return null;

  const lineText = lines[row]!;
  let col = 0;
  while (col < lineText.length && (lineText[col] === " " || lineText[col] === "\t")) col++;
  if (col >= lineText.length) return null;

  const parser = parserInstance!;
  const tree = parser.parse(text);
  if (!tree) return null;

  const root = tree.rootNode;
  const node = root.descendantForPosition({ row, column: col });
  if (!node) return null;

  let resolved = node;
  while (resolved.parent && resolved.parent.parent !== null && resolved.parent.startPosition.row === resolved.startPosition.row) {
    resolved = resolved.parent;
  }

  if (resolved.hasError) return null;

  const start = resolved.startPosition.row + 1;
  const end = resolved.endPosition.column === 0 ? resolved.endPosition.row : resolved.endPosition.row + 1;

  return { start, end };
}

async function resolveBlock(filePath: string, text: string, line: number): Promise<BlockSpan | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (!EXTENSION_TO_WASM[ext]) return null;

  const contentHash = createHash("md5").update(text).digest("hex").slice(0, 8);
  const cacheKey = `${contentHash}:${text.length}:${line}:${filePath}`;
  const cached = resolutionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  await ensureParser();
  const lang = await loadLanguage(ext);
  if (!lang) return null;
  parserInstance.setLanguage(lang);

  const result = resolveBlockSpan(text, line);

  if (resolutionCache.size >= RESOLUTION_CACHE_MAX) {
    const oldest = resolutionCache.keys().next().value;
    if (oldest !== undefined) resolutionCache.delete(oldest);
  }
  resolutionCache.set(cacheKey, result);

  return result;
}

function hasBlockEdit(edits: readonly EditOp[]): boolean {
  return edits.some(e => e.kind === "block");
}

function blockUnresolvedMessage(line: number, op: "replace" | "delete", fileLines?: string[]): string {
  const phrase = op === "delete" ? `DEL.BLK ${line}` : `SWAP.BLK ${line}:`;
  const fallback = op === "delete" ? `DEL ${line}.=M` : `SWAP ${line}.=M:`;
  let message = `\`${phrase}\` could not resolve a syntactic block beginning on line ${line} (unsupported language, blank/closer line, or parse error). Use \`${fallback}\` with explicit lines.`;
  if (fileLines) {
    const context = formatAnchoredContext([line], fileLines);
    if (context.length > 0) message += `\n\n${context.join("\n")}`;
  }
  return message;
}

function blockSingleLineMessage(line: number, op: "replace" | "delete" | "insert_after"): string {
  const blockForm = op === "insert_after" ? "INS.BLK.POST" : op === "delete" ? "DEL.BLK" : "SWAP.BLK";
  const plainForm = op === "insert_after" ? `INS.POST ${line}:` : op === "delete" ? `DEL ${line}` : `SWAP ${line}.=${line}:`;
  return `\`${blockForm} ${line}\` resolved a single-line block—line ${line} is a bare statement, not the opening line of a multi-line construct. For that one line use \`${plainForm}\`; to act on an enclosing construct, anchor ${blockForm} on the line that OPENS it (e.g. its \`function\`/\`if\`/\`case\` header), never a statement inside it.`;
}

const BLOCK_RESOLVER_UNAVAILABLE = "`SWAP.BLK`/`DEL.BLK`/`INS.BLK.POST` are not available here (no block resolver configured). Use a concrete line range.";

function insertAfterBlockCloserLoweredWarning(line: number): string {
  return `\`INS.BLK.POST ${line}:\` anchors on a closing delimiter, so it was applied as plain \`INS.POST ${line}:\`. Anchor on the line that OPENS the construct.`;
}

function insertAfterBlockUnresolvedLoweredWarning(line: number): string {
  return `\`INS.BLK.POST ${line}:\` could not resolve a syntactic block on line ${line}, so it was applied as plain \`INS.POST ${line}:\`. Verify the landing line; anchor on a line that OPENS a construct.`;
}

async function resolveBlockEdits(
  edits: readonly EditOp[],
  text: string,
  filePath: string,
  options?: { onUnresolved?: "throw" | "drop" },
): Promise<{ edits: EditOp[]; warnings: string[] }> {
  if (!hasBlockEdit(edits)) return { edits: [...edits], warnings: [] };

  const onUnresolved = options?.onUnresolved ?? "throw";
  const resolved: EditOp[] = [];
  const warnings: string[] = [];
  const fileLines = text.split("\n");

  for (const edit of edits) {
    if (edit.kind !== "block") {
      resolved.push(edit);
      continue;
    }

    const op = edit.blockOp;
    const span = await resolveBlock(filePath, text, edit.anchor);

    if (span === null) {
      if (op === "insert_after") {
        const anchorText = fileLines[edit.anchor - 1];
        const isCloser = anchorText !== undefined && /^\s*[}\])>;]+\s*$/.test(anchorText);
        warnings.push(isCloser ? insertAfterBlockCloserLoweredWarning(edit.anchor) : insertAfterBlockUnresolvedLoweredWarning(edit.anchor));
        resolved.push({ kind: "insert", position: "after", anchor: edit.anchor, lines: edit.lines });
        continue;
      }
      if (onUnresolved === "drop") {
        const opLabel = op === "delete" ? "DEL.BLK" : "SWAP.BLK";
        warnings.push(`\`${opLabel} ${edit.anchor}\` could not be resolved (tree-sitter unavailable or block not found). Skipped in streaming preview.`);
        continue;
      }
      throw new Error(blockUnresolvedMessage(edit.anchor, op === "delete" ? "delete" : "replace", fileLines));
    }

    if (span.start === span.end) {
      if (op === "insert_after") {
        warnings.push(`\`INS.BLK.POST ${edit.anchor}:\` resolved a single-line block. Applied as plain \`INS.POST ${edit.anchor}:\`.`);
        resolved.push({ kind: "insert", position: "after", anchor: edit.anchor, lines: edit.lines });
        continue;
      }
      if (onUnresolved === "drop") {
        const opLabel = op === "delete" ? "DEL.BLK" : "SWAP.BLK";
        warnings.push(`\`${opLabel} ${edit.anchor}\` resolved to a single-line block. Skipped in streaming preview.`);
        continue;
      }
      throw new Error(blockSingleLineMessage(edit.anchor, op === "delete" ? "delete" : "replace"));
    }

    if (op === "insert_after") {
      resolved.push({ kind: "insert", position: "after", anchor: span.end, lines: edit.lines });
    } else if (op === "delete") {
      resolved.push({ kind: "delete", start: span.start, end: span.end });
    } else {
      resolved.push({ kind: "swap", start: span.start, end: span.end, lines: edit.lines });
    }
  }

  return { edits: resolved, warnings };
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
    if (edit.kind === "block") return true;
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
    } else if (edit.kind === "block") {
      lines.push(edit.anchor);
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

function formatLineRanges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i <= sorted.length; i++) {
    const current = sorted[i]!;
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = current;
    prev = current;
  }
  return parts.join(", ");
}

function buildSnapshotTable(
  entries: Array<{ path: string; hash: string; seenLines?: Set<number>; lineCount: number }>,
  worktree?: string,
): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
    const rel = worktree ? path.relative(worktree, e.path) : e.path;
    const seen = e.seenLines && e.seenLines.size > 0
      ? ` seen:${formatLineRanges([...e.seenLines])}`
      : "";
    return `[${rel}#${e.hash}]${seen}`;
  });
  return lines.join("\n");
}

function unseenLinesMessage(sectionPath: string, unseenLines: readonly number[], tag: string): string {
  const ranges = formatLineRanges(unseenLines);
  return (
    `This edit anchors to lines ${ranges} of ${sectionPath} that ` +
    `#${tag} never displayed (it showed a partial range, a search hit, or a folded summary). ` +
    `Re-read them in full first with a ranged read like \`${sectionPath}:${ranges.replace(/, /g, ",")}\` — ` +
    `it skips summarization and mints a fresh tag (a plain re-read just re-folds them) — then re-issue the edit.`
  );
}

function assertSeenLines(section: PatchSection, canonical: string, expected: string): string | null {
  const seen = snapshotStore.byHash(canonical, expected)?.seenLines;
  if (!seen || seen.size === 0) return null;
  const anchorLines = collectAnchorLines(section.edits);
  const unseen = anchorLines.filter(line => !seen.has(line));
  if (unseen.length === 0) return null;
  return unseenLinesMessage(section.path, unseen, expected);
}

interface MismatchDetails {
  path: string;
  expectedHash: string;
  actualHash: string;
  fileLines: string[];
  anchorLines: readonly number[];
  hashRecognized: boolean;
}

class MismatchError extends Error {
  readonly path: string;
  readonly expectedHash: string;
  readonly actualHash: string;
  readonly fileLines: string[];
  readonly anchorLines: readonly number[];
  readonly hashRecognized: boolean;

  constructor(details: MismatchDetails) {
    super(MismatchError.formatMessage(details));
    this.name = "MismatchError";
    this.path = details.path;
    this.expectedHash = details.expectedHash;
    this.actualHash = details.actualHash;
    this.fileLines = details.fileLines;
    this.anchorLines = details.anchorLines;
    this.hashRecognized = details.hashRecognized;
  }

  get displayMessage(): string {
    return MismatchError.formatMessage(this);
  }

  static rejectionHeader(details: MismatchDetails): string[] {
    const pathText = ` for ${details.path}`;
    return details.hashRecognized
      ? [
          `Edit rejected${pathText}: file changed between read and edit.`,
          `Section is bound to #${details.expectedHash}, but the current file hashes to #${details.actualHash}. If a prior edit in this session modified this file, copy the [${details.path}#newhash] header from that edit's response; otherwise re-read the file with \`read\` to refresh the tag before retrying.`,
        ]
      : [
          `Edit rejected${pathText}: hash #${details.expectedHash} is not from this session.`,
          `The current file hashes to #${details.actualHash}. Re-read the file with \`read\` to copy a current [${details.path}#${details.actualHash}] header — never invent the tag and never reuse one from a prior session.`,
        ];
  }

  static formatMessage(details: MismatchDetails): string {
    const header = MismatchError.rejectionHeader(details);
    const context = formatAnchoredContext(details.anchorLines, details.fileLines);
    if (context.length === 0) return header.join("\n");
    return [...header, "", ...context].join("\n");
  }
}

function formatMismatchError(details: MismatchDetails): string {
  return new MismatchError(details).displayMessage;
}

function assertUniqueCanonicalPaths(sections: PatchSection[]): string | null {
  const seen = new Map<string, string>();
  for (const section of sections) {
    const canonical = canonicalPath(section.path);
    const previous = seen.get(canonical);
    if (previous !== undefined) {
      return `Multiple sections resolve to the same file (${previous} and ${section.path}). Merge their ops under one [PATH#TAG] header before applying.`;
    }
    seen.set(canonical, section.path);
  }
  return null;
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
  const dupError = assertUniqueCanonicalPaths(sections);
  if (dupError) return { output: `Error: ${dupError}` };

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
        const phantomSafeEdits = dropTrailingPhantomDeletes(repairedEdits, fileLines);
        const newText = applyEdits(normalized, phantomSafeEdits);
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
          let resolvedText = recovered.text;
          let resolvedWarnings = recovered.warnings;
          if (hasBlockEdit(section.edits)) {
            try {
              const { edits: resolvedEdits, warnings: blockWarnings } = await resolveBlockEdits(section.edits, resolvedText, section.path);
              const rfileLines = resolvedText.split("\n");
              const rboundsError = validateLineBounds(resolvedEdits, rfileLines);
              if (rboundsError) return { output: `Error: ${rboundsError}` };
              const { edits: rRepairedEdits, warnings: rRepairWarnings } = repairEdits(resolvedEdits, rfileLines);
              const rPhantomSafeEdits = dropTrailingPhantomDeletes(rRepairedEdits, rfileLines);
              resolvedText = applyEdits(resolvedText, rPhantomSafeEdits);
              resolvedWarnings = [...resolvedWarnings, ...rRepairWarnings, ...blockWarnings];
            } catch (e) {
              return { output: `Error: ${(e as Error).message}` };
            }
          }
          prepared.push({ path: section.path, newText: resolvedText, oldText: normalized, bom, lineEnding, warnings: resolvedWarnings });
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

    const seenError = assertSeenLines(section, canonical, section.hash);
    if (seenError) return { output: `Error: ${seenError}` };

    let editsToApply: EditOp[];
    let extraWarnings: string[];
    if (hasBlockEdit(section.edits)) {
      try {
        const { edits: resolvedEdits, warnings: blockWarnings } = await resolveBlockEdits(section.edits, normalized, section.path);
        editsToApply = resolvedEdits;
        extraWarnings = blockWarnings;
      } catch (e) {
        return { output: `Error: ${(e as Error).message}` };
      }
    } else {
      editsToApply = section.edits;
      extraWarnings = [];
    }

    const fileLines = normalized.split("\n");
    const boundsError = validateLineBounds(editsToApply, fileLines);
    if (boundsError) {
      return { output: `Error: ${boundsError}` };
    }
    const { edits: repairedEdits, warnings: repairWarnings } = repairEdits(editsToApply, fileLines);
    const phantomSafeEdits = dropTrailingPhantomDeletes(repairedEdits, fileLines);
    const newText = applyEdits(normalized, phantomSafeEdits);
    prepared.push({ path: section.path, newText, oldText: normalized, bom, lineEnding, warnings: [...extraWarnings, ...repairWarnings] });
  }

  const inputHash = hashPatchInput(args.input);
  for (const entry of prepared) {
    if (entry.newText === entry.oldText) {
      const canonical = canonicalPath(entry.path);
      const { count, escalate } = recordNoopEdit(context.sessionID, canonical, inputHash);
      if (escalate) {
        return { output: noChangeLoopDiagnostic(entry.path, count) };
      }
      return { output: noChangeDiagnostic(entry.path) };
    }
  }

  const results: string[] = [];
  const filediffs: FileDiffMetadata[] = [];

  for (const entry of prepared) {
    const restored = entry.bom + restoreLineEndings(entry.newText, entry.lineEnding);
    writeFileSync(entry.path, restored);
    const canonical = canonicalPath(entry.path);
    resetNoopEdit(context.sessionID, canonical);
    const newHash = snapshotStore.record(canonical, entry.newText);

    const { additions, deletions } = lineDiff(entry.oldText, entry.newText);
    const diffString = createTwoFilesPatch(entry.path, entry.path, entry.oldText, entry.newText);
    const filediff: FileDiffMetadata = {
      file: entry.path,
      before: entry.oldText,
      after: entry.newText,
      patch: diffString,
      additions,
      deletions,
    };
    filediffs.push(filediff);

    const title = context.worktree ? relativePath(context.worktree, entry.path) : entry.path;
    context.metadata({ metadata: { diff: diffString, filediff, diagnostics: {} }, title });

    const numberedDiff = buildNumberedDiff(entry.oldText, entry.newText);
    const compactPreview = buildCompactDiffPreview(numberedDiff);
    const linePreview = compactPreview.preview;
    const warningPrefix = entry.warnings.length > 0 ? entry.warnings.map(w => `⚠ ${w}`).join("\n") + "\n" : "";
    results.push(`${warningPrefix}Edited [${entry.path}#${newHash}]\n${linePreview}`);
  }

  if (filediffs.length > 0) {
    const last = filediffs[filediffs.length - 1]!;
    const title = context.worktree ? relativePath(context.worktree, last.file) : last.file;
    return { output: results.join("\n\n"), metadata: { diff: last.patch, filediff: last, diagnostics: {} }, title };
  }
  return { output: results.join("\n\n") };
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const HASHLINE_PROMPT = `
<hashline>
Your edit tool uses hash-anchored patches. When you \`read\` a file, the output starts with \`[PATH#TAG]\` where TAG is a 4-hex content hash. Each line is prefixed with its line number: \`N:content\`.

To edit, call the \`edit\` tool with a patch. Every file section starts with \`[PATH#TAG]\` — the tag from your latest \`read\`/\`search\`. The tag is REQUIRED on every section — no hashless form. Create new files with \`write\`; hashline only edits existing files.

<ops>
\`SWAP N.=M:\` — replace original lines N through M (inclusive) with the body rows below. Single line: \`SWAP N.=N:\`. The range is the ORIGINAL lines you touch; body length is irrelevant (replacing 1 line with 10 is still \`SWAP N.=N:\`).
\`DEL N\` — delete line N. Range: \`DEL N.=M\` — delete lines N through M. No body.
\`INS.PRE N:\` — insert body rows immediately before line N.
\`INS.POST N:\` — insert body rows immediately after line N.
\`INS.HEAD:\` — insert body rows at the very start of the file.
\`INS.TAIL:\` — insert body rows at the very end of the file.
\`SWAP.BLK N:\` — replace the whole syntactic block that BEGINS on line N; tree-sitter resolves the closing line. Body rows below.
\`DEL.BLK N\` — delete the whole syntactic block that BEGINS on line N.
\`INS.BLK.POST N:\` — insert the body rows after the END of the block that BEGINS on line N—outside it, at sibling depth. To append inside a block, use \`INS.POST\`.
</ops>

<body-rows>
Body rows appear only under a \`:\` header. Every body row is \`+TEXT\` — add a literal line TEXT, verbatim (leading whitespace kept). \`+\` alone adds a blank line. No other row kind. NEVER write \`-old\` or a bare/context line. To keep a line, leave it out of every range. To insert a literal line starting with \`-\` or \`+\`, prefix it: \`+-x\`, \`++x\`.
</body-rows>

<rules>
- Line numbers + \`[PATH#TAG]\` header come from your latest \`read\`/\`search\` (\`LINE:TEXT\` rows).
- Numbers refer to the ORIGINAL file; never shift as hunks apply.
- Every applied edit mints a fresh \`#TAG\` and renumbers — anchor the next edit on the edit response or a fresh \`read\`.
- Touch only lines your latest \`read\`/\`search\` literally displayed as \`LINE:TEXT\`; the tag certifies the snapshot, not your memory. A hunk anchored on a line you never displayed is REJECTED — re-\`read\` first. Seeing a line ≠ it holds the code you mean; confirm numbers map to the construct you intend, especially far from your read window.
- Elided regions are UNSEEN: \`…\`/\`..\` markers and a collapsed \`N-M:\` summary row (only boundary lines N and M shown) hide their interior. NEVER place or span a hunk inside one — \`read\` the range first.
- Never start or end a range mid-expression or mid-block.
- Ranges cover ONLY lines whose content changes. Never widen over unchanged lines — a stale wide range shreds everything it spans.
- Indent body rows exactly for the depth they should live at.
- On a stale-tag rejection or any surprising result: STOP and re-\`read\` before further edits.
- One hunk per range; body = final content, never an old/new pair.
- Non-adjacent changes = separate hunks; untouched lines stay out of every range.
- Pure additions use \`INS.PRE\`/\`INS.POST\`/\`INS.HEAD\`/\`INS.TAIL\`, never a widened \`SWAP\` — retyped keepers are exactly what gets dropped. (A multi-line \`SWAP\` whose body restates the line just past the range is auto-dropped as an off-by-one keeper with a warning — issue the payload for the range only; never lean on the repair.)
- NEVER format/restyle code with this tool; run the project formatter instead.
- Whole construct → \`SWAP.BLK N\` (tree-sitter resolves the end); lines inside it → \`SWAP N.=M\`.
- \`SWAP.BLK N\` resolves EXACTLY the node at N. Leading decorators/attributes/doc-comments are separate nodes: point N at the FIRST decorator to sweep both; standalone line-comments are never swept—use \`SWAP N.=M\`.
- Block ops (\`SWAP.BLK\`/\`DEL.BLK\`/\`INS.BLK.POST\`) anchor the OPENING line of a MULTI-LINE construct—never its closer, last line, or a bare inner statement. Anchoring one statement resolves to ONE line and is REJECTED: use the plain op (\`SWAP N.=N\` / \`DEL N\` / \`INS.POST N:\`), or point N at the real opener. Saw the closer? Use plain \`INS.POST M:\`.
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

Add a header and trailer:
\`\`\`
[greet.py#A1B2]
INS.HEAD:
+# generated header
INS.TAIL:
+greet("everyone")
\`\`\`

Replace the whole \`greet\` function block—\`SWAP.BLK 1:\` resolves lines 1–3 (the \`def\` header through \`print(msg)\`); line 4 is a separate statement and stays:
\`\`\`
[greet.py#A1B2]
SWAP.BLK 1:
+def greet(name):
+    print(f"Hello, {name}")
\`\`\`

A decorator/doc-comment is a SEPARATE block—\`SWAP.BLK\` on the \`def\`/\`fn\` line keeps it. Point N at the decorator to take both; here line 1 is \`@cache\`, so anchoring on the \`def\` (line 2) would orphan \`@cache\`:
\`\`\`
[svc.py#C3D4]
SWAP.BLK 1:
+@cache
+def load(key):
+    return store[key]
\`\`\`
</example>

<anti-patterns>
# WRONG—empty \`SWAP\` to delete. RIGHT: \`DEL 4\`
SWAP 4.=4:

# WRONG—range describes post-edit size. RIGHT: \`SWAP 1.=1:\` (body length is irrelevant)
SWAP 1.=2:
+def greet(name):

# WRONG—\`-\` rows / bare context lines do not exist. The range deletes; the body is only the new content.
SWAP 3.=3:
    msg = "Hello, " + name
-   print(msg)
+   return msg
# RIGHT
SWAP 3.=3:
+   return msg

# WRONG—a pure insertion done as a widened \`SWAP\`: you want to add one line after 2,
# but you replace 2.=4, retype the keepers, and drop one (here line 4, \`greet("world")\`).
SWAP 2.=4:
+    msg = "Hello, " + name
+    extra = compute(name)
+    print(msg)
# RIGHT—touch nothing you keep; the new line is the whole body.
INS.POST 2:
+    extra = compute(name)

# WRONG—\`INS.BLK.POST N:\` anchored on a closing delimiter / last visible line. RIGHT: plain \`INS.POST M:\`
INS.BLK.POST 3:
+after()
# RIGHT
INS.POST 3:
+after()
</anti-patterns>

<critical>
If you remember nothing else:
1. RE-GROUND AFTER EVERY EDIT. Every apply mints a fresh \`#TAG\` and renumbers — take the next edit's numbers from the edit response or a fresh \`read\`. Stale tag or surprise? STOP, re-\`read\`.
2. RANGES ARE TIGHT. Cover only lines that change; a stale wide range shreds everything it spans. Whole construct → \`SWAP.BLK N\`.
3. THE BODY IS THE FINAL CONTENT. Only \`+TEXT\` rows; never \`-old\`/context lines. The range does the deleting.
</critical>
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
        const hash = snapshotStore.record(canonical, rawContent, undefined, input.sessionID);
        const seenLines = parseSeenLinesFromHashlineBody(output.output ?? "");
        if (seenLines.length > 0) {
          snapshotStore.recordSeenLines(canonical, hash, seenLines);
        }
        output.output = `[${callInfo.filePath}#${hash}]\n${output.output}`;
      }

      if (input.tool === "write" && callInfo?.filePath) {
        pendingCalls.delete(input.callID);
        const canonical = canonicalPath(callInfo.filePath);
        const content = callInfo.writeContent ?? "";
        const hash = snapshotStore.record(canonical, content, undefined, input.sessionID);
        if (output.output) {
          output.output = `[${callInfo.filePath}#${hash}]\n${output.output}`;
        } else {
          output.output = `[${callInfo.filePath}#${hash}]`;
        }
      }

      if (input.tool === "grep") {
        const parsed = parseGrepOutput(output.output ?? "");
        if (parsed && parsed.files.length > 0) {
          const sections: string[] = [];
          if (parsed.header) sections.push(parsed.header);

          for (const file of parsed.files) {
            let tag: string | null = null;
            let canonical = "";
            try {
              const content = readFileSync(file.path, "utf-8");
              if (content.length <= MAX_GREP_SNAPSHOT_BYTES) {
                canonical = canonicalPath(file.path);
                tag = snapshotStore.record(canonical, content, undefined, input.sessionID);
              }
            } catch {}

            if (tag) {
              const rel = worktree ? path.relative(worktree, file.path) : file.path;
              const body = file.matches.map((m) => `${m.line}:${m.text}`).join("\n");
              const seenLines = parseSeenLinesFromHashlineBody(body);
              if (seenLines.length > 0) {
                snapshotStore.recordSeenLines(canonical, tag, seenLines);
              }
              sections.push(`[${rel}#${tag}]\n${body}`);
            } else {
              const originalLines = [`${file.path}:`];
              for (const m of file.matches) {
                originalLines.push(`  Line ${m.line}: ${m.text}`);
              }
              sections.push(originalLines.join("\n"));
            }
          }

          if (parsed.footer) sections.push(parsed.footer);
          output.output = sections.join("\n\n");
        }
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (isInternalAgent(output.system)) return;

      let prompt = HASHLINE_PROMPT;
      const entries = snapshotStore.entriesForSession(input.sessionID);
      if (entries.length > 0) {
        const table = buildSnapshotTable(entries, worktree);
        if (table) {
          prompt += "\n\n<hashline-snapshots>\nActive file tags — use these in edit operations. Re-read the file if a tag doesn't match.\n" + table + "\n</hashline-snapshots>";
        }
      }

      if (output.system.length > 0) {
        output.system[output.system.length - 1] += "\n\n" + prompt;
      } else {
        output.system.push(prompt);
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const entries = snapshotStore.entriesForSession(input.sessionID);
      if (entries.length === 0) return;
      const table = buildSnapshotTable(entries, worktree);
      if (!table) return;
      output.context.push(
        "Active file snapshots — these [path#tag] anchors remain valid after compaction. " +
        "The model uses them in edit operations. Preserve the tags and file paths in your summary.\n\n" + table,
      );
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
  type CompactDiffPreview, type BlockSpan,
  detectLineEnding, normalizeToLF, restoreLineEndings, stripBom, normalizeForStorage,
  normalizeFileText, computeFileHash, SnapshotStore, snapshotStore, canonicalPath,
  parsePatch, applyEdits, getAnchorLine, applySingleEdit, lineDiff,
  isStructuralCloserLine, computeDelimiterBalance, balanceDelta, balanceNegate,
  balanceEqual, balanceIsZero, hasNonWhitespace, leadingIndent, isIndentDeeper,
  countDuplicateLeadingBoundaryLines, countDuplicateTrailingBoundaryLines,
  findBoundaryEcho, findDuplicateSuffix, findDuplicatePrefix,
  findOneSidedBoundaryEcho, bodyTargetIndent, resolveShiftedLanding, repairEdits,
  hasAnchorScopedEdit, collectAnchorLines, verifyAnchorContent, findFirstChangedLine,
  applyEditsToSnapshot, replaySessionChainOnCurrent, tryRecover,
  formatAnchoredContext, formatMismatchError, MismatchError,
  parseSeenLinesFromHashlineBody, formatLineRanges, unseenLinesMessage, assertSeenLines,
  hashPatchInput, recordNoopEdit, resetNoopEdit,
  noChangeDiagnostic, noChangeLoopDiagnostic, NOOP_HARD_LIMIT,
  HEADTAIL_DRIFT_WARNING, RECOVERY_EXTERNAL_WARNING,
  RECOVERY_SESSION_CHAIN_WARNING, RECOVERY_SESSION_REPLAY_WARNING,
  MISMATCH_CONTEXT,
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
  parsePatchStreaming,
  type Token, type BlockTarget, type ParsedRange, type Anchor,
};
export default HashlinePlugin;
export { HashlinePlugin };
