# opencode-hashline — Agent Context

Hash-anchored editing plugin for OpenCode. Replaces the built-in `edit` tool with a patch-based system that rejects edits to stale file snapshots, preventing silent corruption.

## Problem This Solves

Current edit tools (apply_patch, str_replace) require the model to perfectly reproduce content it already saw—including whitespace. When it can't (hallucination, truncation, drift from external changes), edits silently corrupt files. Cursor threw a separate 70B model at this problem. Aider benchmarks show format choice alone swung GPT-4 Turbo from 26% to 59% success.

**Hashline approach**: When the model reads a file, it gets a `[path#tag]` header where `tag` is a 4-hex content hash. Edits reference this tag. If the file changed since last read, the hash doesn't match—edit rejected before corruption. The model never needs to reproduce old content; it only writes what it wants changed.

Benchmarked in oh-my-pi: weakest models gain most (Grok Code Fast 1: 6.7%→68.3%, 10x improvement). Grok 4 Fast output tokens dropped 61%.

## Architecture

### Integration Points (OpenCode Plugin API)

All hooks confirmed against `@opencode-ai/plugin` type definitions and DCP plugin source.

| Hook | Signature | Purpose |
|---|---|---|
| `tool.execute.before` | `(input: {tool, sessionID, callID}, output: {args}) => Promise<void>` | Stash `callID → {filePath, content}` for read/write. The `after` hook lacks args, so we capture them here. |
| `tool.execute.after` | `(input: {tool, sessionID, callID, args}, output: {title, output, metadata}) => Promise<void>` | On read: prepend `[path#tag]` header to output, record snapshot. On write: record snapshot of written content. NOT for edit filediff—edit tools use `context.metadata()` + structured return instead. |
| `tool: { edit: tool(...) }` | Custom tool with `{ input: string }` arg | Replaces built-in edit entirely. Plugin tools with same name take precedence. |
| `experimental.chat.system.transform` | `(input: {model, sessionID}, output: {system: string[]}) => Promise<void>` | Inject hashline syntax prompt into system message. Append to `output.system[output.system.length - 1]`. |

**Critical API detail**: `tool.execute.after`'s input only has `{tool, sessionID, callID}`—no args. Must stash args in `tool.execute.before` keyed by `callID`.

### Hash & Snapshot System (adapted from oh-my-pi)

- **Algorithm**: MD5 via `node:crypto`, first 16 bits of digest (`& 0xffff`)
- **Format**: 4 uppercase hex chars (e.g., `1A2B`), collision space = 65,536
- **Input**: Entire normalized file text (trailing `[ \t\r]` stripped per line, LF normalized)
- **Line numbers NOT part of hash input**, file path NOT part of hash input
- **No collision handling** — 16-bit space is sufficient for session-local editing
- **Store**: In-memory `Map<realpath, Snapshot[]>`, LRU (30 paths × 4 versions, 64 MiB cap)
- **Path canonicalization**: `fs.realpathSync.native()`

### Snapshot Interface

```typescript
interface Snapshot {
  path: string;        // canonical realpath
  text: string;        // full normalized file text
  hash: string;        // 4-hex content tag
  recordedAt: number;  // ms since epoch
}

class SnapshotStore {
  record(path: string, text: string): string;     // returns hash
  byHash(path: string, hash: string): Snapshot | null;
  head(path: string): Snapshot | null;
  invalidate(path: string): void;
  clear(): void;
}
```

### Display Format (what the model sees)

Read output gets a header prepended:
```
[src/foo.ts#1A2B]
1:first line of file
2:second line of file
3:third line of file
```

### Edit Syntax (what the model writes)

Section header: `[PATH#TAG]` (TAG mandatory)

Operations (v1—no block ops):
```
SWAP N.=M:     — replace lines N through M (inclusive) with body rows
DEL N          — delete line N
DEL N.=M       — delete lines N through M (inclusive)
INS.PRE N:     — insert body rows immediately before line N
INS.POST N:    — insert body rows immediately after line N
INS.HEAD:      — insert body rows at very start of file
INS.TAIL:      — insert body rows at very end of file
```

Body rows: `+literal content` (`+` alone = blank line)
Range separator `.=` accepts variants: `-`, `..`, `…`, `=`, whitespace

### Validation Pipeline (v1—simplified)

1. Parse patch → sections with `[PATH#TAG]` headers
2. For each section: read file, normalize, compute hash
3. **Hash matches** → apply edits to line array, record new snapshot
4. **Hash mismatch** → hard reject with actionable error ("re-read the file to refresh tag")
5. **All-or-nothing commit**: preflight all sections in memory before writing any

**Deferred to v2**: 3-way merge recovery, session-chain replay, `seenLines` tracking, boundary repair, block ops (SWAP.BLK, DEL.BLK, INS.BLK.POST).

### Edit Tool Return Format

```
Edited [src/foo.py#NEW_TAG]
5:modified line
6:new line
```

Gives the model the fresh tag + changed lines so it can chain edits without re-reading.

### DCP Interaction

Snapshots live in plugin memory—DCP can't touch them. But DCP *can* compress tool results containing `[path#tag]` headers. If those vanish, the model loses its anchors.

**v1 mitigation**: The edit tool's error message handles this—if the model references a tag it never got (because DCP compressed the read result), the rejection message tells it to re-read.

**v2 mitigation**: Use `experimental.session.compacting` to inject active snapshot table into compaction context.

## Implementation Plan

### v1 scope (current)

- [ ] Hash computation + normalization (`node:crypto` MD5 → 4-hex, 16-bit)
- [ ] Snapshot store (Map + LRU, 30 paths × 4 versions, 64 MiB cap)
- [ ] Read post-processing (header injection via `tool.execute.after`)
- [ ] Write post-processing (snapshot recording via `tool.execute.after`)
- [ ] Patch parser (state machine → Edit[])
- [ ] Edit application (apply SWAP/DEL/INS to line array)
- [ ] Edit tool replacement (`tool: { edit: tool(...) }`)
- [ ] System prompt injection (`experimental.chat.system.transform`)

### Implementation Order

1. Hash + normalization
2. Snapshot store
3. Read post-processing
4. Write post-processing
5. Patch parser
6. Edit application
7. Edit tool (replaces built-in)
8. System prompt injection

### v2 (deferred)

- Block ops (SWAP.BLK, DEL.BLK, INS.BLK.POST) — requires tree-sitter
- 3-way merge recovery (apply edit to snapshot, diff, merge to current)
- Session-chain replay (apply to current with anchor-content guards)
- `seenLines` tracking (reject edits to lines never displayed)
- Boundary repair (auto-fix model's off-by-one mistakes)
- `experimental.session.compacting` hook (inject snapshot table for DCP survival)
- npm publish

## Development

### Local Testing

The plugin runs as a local file in `~/.config/opencode/plugins/`. For development, we symlink from the repo:

```bash
ln -sf ~/opencode-hashline/src/index.ts ~/.config/opencode/plugins/hashline-edit.ts
```

OpenCode loads `.ts` files from the plugins directory at startup. Restart OpenCode after changes.

### Dependencies

Managed in `~/.config/opencode/package.json` (OpenCode runs `bun install` at startup):

| Package | Purpose |
|---|---|
| `@opencode-ai/plugin` | TypeScript types for plugin development (already in `~/.config/opencode/package.json`) |

No runtime dependencies—hash uses `node:crypto` (built-in).

### Testing Approach

Manual testing in OpenCode sessions:
1. Read a file → verify `[path#tag]` header appears
2. Edit via hashline syntax → verify changes apply, fresh tag returned
3. Modify file externally → try to edit with old tag → verify rejection
4. Chain edits → edit → edit → edit without re-reading → verify fresh tags work

## Reference: oh-my-pi Source

Research clone at `~/research/oh-my-pi`. Key files studied:

| File | Role |
|---|---|
| `packages/hashline/src/format.ts` | Hash computation (`computeFileHash` at line 108) |
| `packages/hashline/src/snapshots.ts` | InMemorySnapshotStore |
| `packages/hashline/src/patcher.ts` | Core Patcher (prepare/commit/recovery) |
| `packages/hashline/src/recovery.ts` | 3-way merge + session-chain replay (v2 ref) |
| `packages/hashline/src/parser.ts` | Patch parser (state machine) |
| `packages/hashline/src/apply.ts` | Edit application with boundary repair |
| `packages/hashline/src/prompt.md` | System prompt text (adapted for our v1) |
| `packages/coding-agent/src/edit/hashline/execute.ts` | Edit tool → hashline driver |
| `packages/coding-agent/src/tools/read.ts` | Read tool + snapshot recording |
| `packages/coding-agent/src/tools/write.ts` | Write tool + hashline stripping |

**Critical difference from oh-my-pi**: oh-my-pi has its own coding agent with its own hook system (`ExtensionRunner`/`HookRunner`). Hashline is a built-in library there, not an OpenCode plugin. We adapt the concepts to OpenCode's plugin API.

## Reference: OpenCode Plugin API

### Plugin Structure

```typescript
import type { Plugin } from "@opencode-ai/plugin";

export const HashlinePlugin: Plugin = async ({ client, project, directory, worktree, $ }) => {
  return {
    "tool.execute.before": async (input, output) => { ... },
    "tool.execute.after": async (input, output) => { ... },
    "experimental.chat.system.transform": async (input, output) => { ... },
    "chat.message": async (input, output) => { ... },
    "event": async ({ event }) => { ... },
    "config": async (config) => { ... },
    tool: {
      edit: tool({ description, args, execute })
    }
  };
};
```

### Key Patterns from DCP Source

DCP (`~/.cache/opencode/packages/@tarquinen/opencode-dcp@latest/`) uses:
- `experimental.chat.system.transform` to inject system prompt (append to last element of `output.system`)
- `experimental.chat.messages.transform` to modify message history
- `config` hook to register commands and tools
- `event` hook for `session.compacted`
- Filters internal agents by signature strings (title generator, summarizer, etc.)

opencode-beads (`~/.cache/opencode/packages/opencode-beads@latest/`) uses:
- `chat.message` to inject context (via `client.session.prompt` with `noReply: true, synthetic: true`)
- `event` for `session.compacted` re-injection
- `config` to register commands and agents
- Checks agent mode (primary vs subagent) to skip subagent injection

### Tool Definition API

```typescript
import { tool } from "@opencode-ai/plugin";

const editTool = tool({
  description: "Edit files using hashline patch syntax",
  args: {
    input: tool.schema.string().describe("Hashline patch content")
  },
  async execute(args, context) {
    // context: ToolContext = {
    //   sessionID, messageID, agent, directory, worktree, abort,
    //   metadata(input: { title?, metadata? }): void,  // emit metadata DURING execute
    //   ask(input): Effect  // permission prompt
    // }
    //
    // ToolResult = string | { output: string, metadata?: {...} }
    // Return a structured object to emit metadata for the TUI (diffs, diagnostics, etc.)
    context.metadata({ metadata: { filediff: { ... } } });
    return { output: "Edited [path#tag]\n5:new content", metadata: { filediff: { ... } }, title: "rel/path" };
  }
});
```

If a plugin tool uses the same name as a built-in tool, the plugin tool takes precedence.

### TUI Diff Preview Metadata (filediff)

The TUI renders a diff preview for edit tools by reading `metadata.filediff` from the tool result. Confirmed by inspecting the opencode binary (v1.17.9) and SDK types.

**Built-in edit tool emits** (from binary source):
```javascript
// During execute — stream metadata for live preview:
yield* context.metadata({ metadata: { diff: m, filediff: O, diagnostics: {} } });
// On return — final metadata + title:
return { metadata: { diagnostics, diff: m, filediff: O }, title: relativePath, output: "Edit applied successfully." };
```

**filediff shape** (v1 SDK `FileDiff` type — the shape the TUI's diff renderer reads):
```typescript
type FileDiff = {
  file: string;       // absolute path
  before: string;     // full file content before edit
  after: string;      // full file content after edit
  additions: number;
  deletions: number;
};
```

The built-in edit tool ALSO emits a `patch` field (unified diff string) alongside `before`/`after`, but the TUI's `Yt` diff preview component reads `e.metadata?.filediff?.before` / `.after` (falling back to `e.input.oldString`/`.newString` for the built-in tool). Plugin tools have no `input.oldString`/`newString`, so `before`/`after` must be populated.

**Critical**: There are two ways to emit metadata, and BOTH should be used:
1. `context.metadata({ metadata: { filediff } })` — called during execute, enables live/streaming diff preview
2. Return `{ output, metadata: { filediff }, title }` — structured `ToolResult`, sets final metadata + title

**Wrong approach** (attempted in commit 24a3db2, didn't work): stashing metadata in a module-level variable (`pendingEditMetadata`) and reading it in `tool.execute.after`. The built-in edit tool does NOT use `tool.execute.after` for filediff emission — it uses `context.metadata()` + structured return. The `tool.execute.after` hook is for read/write snapshot recording, not edit metadata.

**Title**: should be the worktree-relative path (e.g. `src/index.ts`), matching what the built-in tool emits via `path.relative(worktree, absPath)`.

## Reference: The Harness Problem

Original blog post: https://blog.can.ac/2026/02/12/the-harness-problem/

Key benchmark results (16 models, 3 edit tools, 180 tasks × 3 runs):
- Patch worst for nearly every model
- Hashline matches or beats str_replace for most
- Weakest models gain most: Grok Code Fast 1 went 6.7%→68.3% (10x)
- Grok 4 Fast output tokens dropped 61%
- Gemini +8% (bigger than most model upgrades)

## Conventions

- TypeScript, single-file for v1 (`src/index.ts`)
- No comments unless requested
- Match oh-my-pi's hash algorithm exactly for compatibility
- Em dashes unspaced (—) in all prose
- Plugin loads as local `.ts` file (no build step needed—OpenCode uses Bun)
