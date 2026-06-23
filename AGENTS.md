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
- **Input**: Entire normalized file text (BOM stripped, line endings normalized to LF, trailing `[ \t]` stripped per line). Original line endings + BOM detected and restored on write-back.
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
4. **Hash mismatch** → try recovery before rejecting:
   - **Head/tail drift tolerance**: INS.HEAD/INS.TAIL apply despite stale tag (position-stable), with HEADTAIL_DRIFT_WARNING
   - **3-way merge** (head snapshot, external write): Apply edits to snapshot text → `structuredPatch` (context=3) → `applyPatch` to current text (fuzzFactor=0). Conservative—fails if context lines changed.
   - **Session-chain replay** (non-head, prior in-session edit): Fast-path when 3-way merge refuses. Guards: equal line counts AND `verifyAnchorContent` (every anchor line identical in previous and current). Emits RECOVERY_SESSION_REPLAY_WARNING.
   - **Recovery fails** → hard reject with actionable error ("re-read the file to refresh tag")
5. **All-or-nothing commit**: preflight all sections in memory before writing any

**Deferred to v2**: `seenLines` tracking, block ops (SWAP.BLK, DEL.BLK, INS.BLK.POST), noop-loop guard, write tool hashline integration, search tool hashline mode, streaming diff preview, tokenizer refactor, header recovery, parser contamination detection. See beads for full v2 scope.

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

- [x] Hash computation + normalization (`node:crypto` MD5 → 4-hex, 16-bit)
- [x] Snapshot store (Map + LRU, 30 paths × 4 versions, 64 MiB cap)
- [x] Read post-processing (header injection via `tool.execute.after`)
- [x] Write post-processing (snapshot recording via `tool.execute.after`)
- [x] Patch parser (state machine → Edit[])
- [x] Edit application (apply SWAP/DEL/INS to line array)
- [x] Edit tool replacement (`tool: { edit: tool(...) }`)
- [x] System prompt injection (`experimental.chat.system.transform`)
- [x] TUI diff preview (`metadata.diff` unified diff string via `createTwoFilesPatch`)

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

**Completed:**
- ~~3-way merge recovery (apply edit to snapshot, diff, merge to current)~~ ✅ Done
- ~~Session-chain replay (apply to current with anchor-content guards)~~ ✅ Done
- ~~Head/tail drift tolerance (INS.HEAD/INS.TAIL despite stale tag)~~ ✅ Done
- ~~Boundary repair (auto-fix model's off-by-one mistakes)~~ ✅ Done

**In progress (beads):**
- `seenLines` tracking (reject edits to lines never displayed) — `q67`
- Noop detection + loop guard — `ys1`

**Ready (beads):**
- Block ops (SWAP.BLK, DEL.BLK, INS.BLK.POST) — requires tree-sitter — `3tu`
- DCP compaction survival (`experimental.session.compacting` hook) — `65v`
- Compact diff preview (post-edit line numbers for chaining) — `ci5`
- Multi-section duplicate path detection — `tpk`
- Write tool hashline integration (strip prefixes, echo tag, unwrap path) — `wyv`
- Header recovery (strip apply_patch noise from headers) — `8se`
- Parser contamination detection (reject `@@`/`-`/sentinels) — `2rh`
- Line bounds validation — `7kz`
- Trailing phantom line handling — `xso`
- canonicalPath for non-existing files — `jy7`
- Boundary repair 2-pass — `2k9`
- Tokenizer (char-level state machine) — `8dy`
- MismatchError class — `dkj`

**Blocked (beads):**
- System prompt expansion (depends on `q67` + `3tu`) — `dua`
- Streaming diff preview (depends on `8dy`) — `25c`
- Search/grep tool hashline mode (depends on `q67`) — `7id`

**Final:**
- npm publish — `10r` (gated on all above)

## Development

### Local Testing

The plugin lives in `~/.config/opencode/plugins/opencode-hashline/`. A symlink exposes it to OpenCode:

```bash
ln -sf ~/.config/opencode/plugins/opencode-hashline/src/index.ts ~/.config/opencode/plugins/hashline-edit.ts
```

OpenCode loads `.ts` files from the plugins directory at startup. Restart OpenCode after changes.

### Dependencies

Managed in `~/.config/opencode/package.json` (OpenCode runs `bun install` at startup):

| `@opencode-ai/plugin` | TypeScript types for plugin development |
| `diff` | Unified diff generation (`createTwoFilesPatch`) for TUI diff preview |
| `@types/diff` | TypeScript types for `diff` package (devDependency) |

Runtime dependency: `diff` (for `metadata.diff` string). Hash uses `node:crypto` (built-in).

### Testing Approach

Manual testing in OpenCode sessions:
1. Read a file → verify `[path#tag]` header appears
2. Edit via hashline syntax → verify changes apply, fresh tag returned
3. Edit → verify TUI renders diff preview (unified diff view, not one-line fallback)
4. Modify file externally → try to edit with old tag → verify rejection
5. Chain edits → edit → edit → edit without re-reading → verify fresh tags work

## Reference: oh-my-pi Source

Research clone at `~/research/oh-my-pi`. Key files studied:

**`packages/hashline/src/` (core library, 20 files):**

| File | Role |
|---|---|
| `format.ts` | Hash computation (`computeFileHash`), normalization |
| `normalize.ts` | BOM strip, line-ending detect/restore |
| `snapshots.ts` | `InMemorySnapshotStore` with `seenLines` tracking |
| `types.ts` | Core types: `Snapshot`, `BlockResolver`, `BlockSpan`, `EditOp` |
| `tokenizer.ts` | Char-level `Tokenizer` class (feed/end/reset, streaming) |
| `parser.ts` | `Executor` state machine, `parsePatch`/`parsePatchStreaming`, contamination detection |
| `input.ts` | `Patch` class with lazy parse, `mergeSamePathSections`, header recovery |
| `apply.ts` | Edit application, 2-pass boundary repair, phantom line, line-bounds validation |
| `block.ts` | `BlockResolver` impl, `SWAP.BLK`/`DEL.BLK`/`INS.BLK.POST` resolution |
| `recovery.ts` | 3-way merge + session-chain replay, `Recovery` class |
| `mismatch.ts` | `MismatchError` class with structured `rejectionHeader` |
| `messages.ts` | `formatAnchoredContext`, block-unresolved/single-line messages, `MINUS_ROW_REJECTED` |
| `prefixes.ts` | `stripNewLinePrefixes`/`stripHashlinePrefixes` (for write tool) |
| `stream.ts` | `streamHashLines` async generator (byte-level streaming reads) |
| `diff-preview.ts` | `buildCompactDiffPreview` (post-edit line numbers) |
| `patcher.ts` | High-level `Patcher` (prepare/commit/preflight, `assertSeenLines`, `assertUniqueCanonicalPaths`) |
| `fs.ts` | `Filesystem` abstraction (`NodeFilesystem`/`InMemoryFilesystem`) |
| `prompt.md` | System prompt text (140 lines, block ops, anti-patterns) |
| `grammar.lark` | Lark grammar spec (reference) |
| `index.ts` | Package barrel export |

**`packages/coding-agent/src/edit/hashline/` (agent integration, 7 files):**

| File | Role |
|---|---|
| `execute.ts` | Edit tool → hashline driver, `noChangeDiagnostic` |
| `block-resolver.ts` | Tree-sitter `BlockResolver` via `@oh-my-pi/pi-natives` |
| `diff.ts` | `buildStreamingSectionDiff` (live preview while model types) |
| `filesystem.ts` | `writethrough`, `resolvePlanPath`, `assertEditableFileContent` |
| `noop-loop-guard.ts` | `NOOP_HARD_LIMIT=3`, escalating soft→hard rejection |
| `params.ts` | Arktype schema with `_input` alias |
| `index.ts` | Barrel export |

**`packages/coding-agent/src/tools/` (hashline-aware tools):**

| File | Role |
|---|---|
| `read.ts` | Read tool + snapshot recording + `seenLines` from displayed lines + summary hash context |
| `write.ts` | Write tool + `stripWriteContent` + `maybeWriteSnapshotHeader` + `unwrapHashlineHeaderPath` |
| `conflict-detect.ts` | Git merge conflict detection (`scanConflictLines`, `@ours`/`@theirs`/`@base`/`@both` tokens) |
| `search.ts` | Search tool hashline mode + `recordSeenLinesFromBody` |
| `match-line-format.ts` | `formatMatchLine({useHashLines})` for grep output |

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

### TUI Diff Preview Metadata (diff)

**The TUI and web UI are completely separate codebases.** The TUI's `Edit` component lives in `packages/tui/src/routes/session/index.tsx:2327`, NOT in `packages/ui/src/components/message-part.tsx` (that's the web app). The TUI has zero references to `filediff`, `fileDiff`, `resolveFileDiff`, or `DiffChanges`.

**The TUI gates on `metadata.diff`** — a top-level **unified diff string** (NOT `metadata.filediff`). If present → renders full diff view. If absent → falls back to a one-line `InlineTool` with no diff.

**TUI `Edit` component reads** (`packages/tui/src/routes/session/index.tsx:2327-2378`):
- `props.metadata.diff` — unified diff string (required for diff view to render)
- `props.input.filePath` — for title (`"← Edit " + path`) and filetype detection (syntax highlighting)
- `props.metadata.diagnostics` — for diagnostics rendering

**Built-in edit tool emits** (`packages/opencode/src/tool/edit.ts:181-211`):
```javascript
yield* ctx.metadata({ metadata: { diff, filediff, diagnostics: {} } })
return { metadata: { diagnostics, diff, filediff }, title: path.relative(worktree, filePath), output }
```
Where `diff` is a unified diff string from `createTwoFilesPatch` (from the `diff` npm package), and `filediff` is `{ file, patch, additions, deletions }` (has `patch`, NOT `before`/`after`).

**Our plugin emits** (matching built-in):
```typescript
const diffString = createTwoFilesPatch(entry.path, entry.path, entry.oldText, entry.newText)
context.metadata({ metadata: { diff: diffString, filediff: first, diagnostics: {} } })
return { output, metadata: { diff: diffString, filediff: first, diagnostics: {} }, title }
```
Where `filediff` is `{ file, before, after, patch, additions, deletions }` — includes both `before`/`after` (for web UI) and `patch` (unified diff string, for web UI compat).

**Two ways to emit metadata, BOTH used**:
1. `context.metadata({ metadata: { diff, filediff, diagnostics } })` — called during execute, enables live/streaming diff preview
2. Return `{ output, metadata: { diff, filediff, diagnostics }, title }` — structured `ToolResult`, sets final metadata + title

**Wrong approach** (attempted in commit 24a3db2): stashing metadata in a module-level variable and reading it in `tool.execute.after`. The built-in edit tool does NOT use `tool.execute.after` for filediff emission — it uses `context.metadata()` + structured return.

**Title**: worktree-relative path (e.g. `src/index.ts`), matching built-in tool's `path.relative(worktree, absPath)`.

**Known v1 limitation**: `input.filePath` is missing because our tool args are `{ input: string }` (the patch), not `{ filePath, oldString, newString }`. The `input` field comes from the model's tool call arguments and cannot be modified by the plugin. Impact: TUI title shows `"← Edit undefined"` and no syntax highlighting. The diff itself renders correctly. Deferred to v2 (could add `filePath` as optional arg).

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
- Hash algorithm differs from oh-my-pi (MD5 vs xxHash32 via `Bun.hash`); both produce 16-bit 4-hex tags but are not interchangeable across runtimes—each is self-contained
- Em dashes unspaced (—) in all prose
- Plugin loads as local `.ts` file (no build step needed—OpenCode uses Bun)


<!-- BEGIN BEADS INTEGRATION v:1 profile:full hash:f2c52d34 -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Dolt-powered version control with native sync
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Quality
- Use `--acceptance` and `--design` fields when creating issues
- Use `--validate` to check description completeness

### Lifecycle
- `bd defer <id>` / `bd supersede <id>` for issue management
- `bd stale` / `bd orphans` / `bd lint` for hygiene
- `bd human <id>` to flag for human decisions
- `bd formula list` / `bd mol pour <name>` for structured workflows

### Sync

bd stores issue history in Dolt:

- Each write auto-commits to Dolt history
- Do not treat `.beads/issues.jsonl` as the sync protocol

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.

<!-- END BEADS INTEGRATION -->
