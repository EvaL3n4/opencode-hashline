import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { readFileSync, realpathSync, writeFileSync, existsSync } from "fs";
import { createHash } from "crypto";

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

// ─── Hash Computation ────────────────────────────────────────────────────────

const HASH_BITS = 16;
const HASH_MASK = (1 << HASH_BITS) - 1;
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

// ─── Snapshot Store ──────────────────────────────────────────────────────────

const MAX_PATHS = 30;
const MAX_VERSIONS_PER_PATH = 4;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

class SnapshotStore {
  private store = new Map<string, Snapshot[]>();
  private totalBytes = 0;

  record(path: string, text: string): string {
    const hash = computeFileHash(text);
    const snapshot: Snapshot = { path, text, hash, recordedAt: Date.now() };

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

// ─── Call Tracking (tool.execute.before → after bridge) ──────────────────────

interface CallInfo {
  filePath?: string;
  content?: string;
}

const pendingCalls = new Map<string, CallInfo>();

// ─── Read Post-Processing ────────────────────────────────────────────────────

function processReadOutput(filePath: string, output: string): string {
  const canonical = canonicalPath(filePath);
  const hash = snapshotStore.record(canonical, output);
  return `[${filePath}#${hash}]\n${output}`;
}

// ─── Write Post-Processing ───────────────────────────────────────────────────

function processWriteOutput(filePath: string, content: string): string {
  const canonical = canonicalPath(filePath);
  const hash = snapshotStore.record(canonical, content);
  return `[${filePath}#${hash}]`;
}

// ─── Patch Parser ────────────────────────────────────────────────────────────

function parsePatch(input: string): PatchSection[] {
  const sections: PatchSection[] = [];
  const lines = input.split("\n");

  let currentSection: PatchSection | null = null;
  let currentOp: { lines: string[] } | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
      i++;
      continue;
    }

    const headerMatch = line.match(/^\[([^\]]+)#([0-9A-Fa-f]{4})\]\s*$/);
    if (headerMatch) {
      if (currentSection && currentOp) {
        flushOp(currentSection, currentOp);
        currentOp = null;
      }
      if (currentSection) sections.push(currentSection);
      currentSection = {
        path: headerMatch[1]!,
        hash: headerMatch[2]!.toUpperCase(),
        edits: [],
      };
      i++;
      continue;
    }

    if (!currentSection) {
      i++;
      continue;
    }

    const swapMatch = line.match(/^SWAP\s+(\d+)\s*\.?=\s*(\d+):\s*$/);
    const delMatch = line.match(/^DEL\s+(\d+)\s*(?:\.?=\s*(\d+))?\s*$/);
    const insPreMatch = line.match(/^INS\.PRE\s+(\d+):\s*$/);
    const insPostMatch = line.match(/^INS\.POST\s+(\d+):\s*$/);
    const insHeadMatch = line.match(/^INS\.HEAD:\s*$/);
    const insTailMatch = line.match(/^INS\.TAIL:\s*$/);

    if (swapMatch || delMatch || insPreMatch || insPostMatch || insHeadMatch || insTailMatch) {
      if (currentOp) flushOp(currentSection, currentOp);
      currentOp = { lines: [] };

      if (swapMatch) {
        const start = parseInt(swapMatch[1]!, 10);
        const end = parseInt(swapMatch[2]!, 10);
        currentSection.edits.push({ kind: "swap", start, end, lines: [] });
        currentOp = { lines: [] };
        const op = currentSection.edits[currentSection.edits.length - 1] as Extract<EditOp, { kind: "swap" }>;
        currentOp = { lines: op.lines };
      } else if (delMatch) {
        const start = parseInt(delMatch[1]!, 10);
        const end = delMatch[2] ? parseInt(delMatch[2]!, 10) : start;
        currentSection.edits.push({ kind: "delete", start, end });
        currentOp = null;
      } else if (insPreMatch) {
        const anchor = parseInt(insPreMatch[1]!, 10);
        currentSection.edits.push({ kind: "insert", position: "before", anchor, lines: [] });
        const op = currentSection.edits[currentSection.edits.length - 1] as Extract<EditOp, { kind: "insert" }>;
        currentOp = { lines: op.lines };
      } else if (insPostMatch) {
        const anchor = parseInt(insPostMatch[1]!, 10);
        currentSection.edits.push({ kind: "insert", position: "after", anchor, lines: [] });
        const op = currentSection.edits[currentSection.edits.length - 1] as Extract<EditOp, { kind: "insert" }>;
        currentOp = { lines: op.lines };
      } else if (insHeadMatch) {
        currentSection.edits.push({ kind: "insert", position: "head", anchor: 0, lines: [] });
        const op = currentSection.edits[currentSection.edits.length - 1] as Extract<EditOp, { kind: "insert" }>;
        currentOp = { lines: op.lines };
      } else if (insTailMatch) {
        currentSection.edits.push({ kind: "insert", position: "tail", anchor: 0, lines: [] });
        const op = currentSection.edits[currentSection.edits.length - 1] as Extract<EditOp, { kind: "insert" }>;
        currentOp = { lines: op.lines };
      }
      i++;
      continue;
    }

    if (currentOp && line.startsWith("+")) {
      currentOp.lines.push(line.slice(1));
      i++;
      continue;
    }

    i++;
  }

  if (currentSection && currentOp) {
    flushOp(currentSection, currentOp);
  }
  if (currentSection) sections.push(currentSection);

  return sections;
}

function flushOp(section: PatchSection, op: { lines: string[] }): void {
  // Lines already pushed to the op's lines array via reference
  // This is a no-op placeholder for the pattern
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

// ─── Edit Tool ───────────────────────────────────────────────────────────────

async function executeHashlineEdit(args: { input: string }, context: { sessionID: string }): Promise<string> {
  const sections = parsePatch(args.input);

  if (sections.length === 0) {
    return "Error: no valid patch sections found. Expected [PATH#TAG] header followed by operations.";
  }

  const prepared: { path: string; newText: string; hash: string }[] = [];

  for (const section of sections) {
    const canonical = canonicalPath(section.path);

    if (!existsSync(section.path)) {
      return `Error: file not found: ${section.path}`;
    }

    const rawContent = readFileSync(section.path, "utf-8");
    const normalized = rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const currentHash = computeFileHash(normalized);

    if (currentHash !== section.hash) {
      const snapshot = snapshotStore.byHash(canonical, section.hash);
      if (snapshot) {
        return `Error: edit rejected—file changed since last read.\n\nSection is bound to #${section.hash}, but the current file hashes to #${currentHash}.\n\nRe-read the file with \`read\` to get a fresh [${section.path}#${currentHash}] header, then retry your edit.`;
      } else {
        return `Error: edit rejected—hash #${section.hash} is not from this session.\n\nThe current file hashes to #${currentHash}.\n\nRe-read the file with \`read\` to get a fresh [${section.path}#${currentHash}] header—never invent the tag and never reuse one from a prior session.`;
      }
    }

    const newText = applyEdits(normalized, section.edits);
    prepared.push({ path: section.path, newText, hash: "" });
  }

  const results: string[] = [];

  for (const entry of prepared) {
    writeFileSync(entry.path, entry.newText);
    const canonical = canonicalPath(entry.path);
    const newHash = snapshotStore.record(canonical, entry.newText);
    entry.hash = newHash;

    const changedLines = entry.newText.split("\n");
    const linePreview = changedLines.slice(0, 50).map((line, i) => `${i + 1}:${line}`).join("\n");
    results.push(`Edited [${entry.path}#${newHash}]\n${linePreview}`);
  }

  return results.join("\n\n");
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

export const HashlinePlugin: Plugin = async ({ client, $, directory, worktree }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "read" || input.tool === "write") {
        const filePath = output.args?.filePath;
        if (filePath) {
          pendingCalls.set(input.callID, { filePath });
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      const callInfo = pendingCalls.get(input.callID);

      if (input.tool === "read" && callInfo?.filePath) {
        pendingCalls.delete(input.callID);
        const processed = processReadOutput(callInfo.filePath, output.output);
        output.output = processed;
      }

      if (input.tool === "write" && callInfo?.filePath) {
        pendingCalls.delete(input.callID);
        const content = output.args?.content ?? "";
        const header = processWriteOutput(callInfo.filePath, content);
        if (output.output) {
          output.output = `${header}\n${output.output}`;
        } else {
          output.output = header;
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
          return executeHashlineEdit(args, { sessionID: context.sessionID });
        },
      }),
    },
  };
};
