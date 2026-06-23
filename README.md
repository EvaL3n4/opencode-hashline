# opencode-hashline

Hash-anchored editing plugin for [OpenCode](https://opencode.ai). Replaces the built-in `edit` tool with a patch-based system that rejects edits to stale file snapshots, preventing silent corruption.

## The Problem

Current edit tools (`apply_patch`, `str_replace`) require the model to perfectly reproduce content it already saw—including whitespace. When it can't (hallucination, truncation, drift from external changes), edits silently corrupt files.

## The Solution

When the model reads a file, it gets a `[path#tag]` header where `tag` is a 4-hex content hash. Edits reference this tag. If the file changed since last read, the hash doesn't match—edit rejected before corruption.

```
read output:                    edit input:
[src/foo.ts#1A2B]              [src/foo.ts#1A2B]
1:const x = 1;                 SWAP 1.=1:
2:function foo() {             +const x = 2;
3:  return x;
4:}
```

## Installation

### Local plugin

```bash
# Clone
git clone https://github.com/EvaL3n4/opencode-hashline.git ~/opencode-hashline

# Symlink to plugins directory
ln -sf ~/opencode-hashline/src/index.ts ~/.config/opencode/plugins/hashline-edit.ts

# Add dependency to ~/.config/opencode/package.json
# No external deps needed—uses node:crypto (built-in)
```

### npm (future)

```json
{
  "plugin": ["opencode-hashline"]
}
```

## How It Works

1. **Read** — `tool.execute.after` hook prepends `[path#tag]` header, records snapshot + seen lines
2. **Edit** — Custom `edit` tool validates tag against current file hash, checks seen lines, validates line bounds, applies patch, returns fresh tag + compact diff preview
3. **Write** — `tool.execute.after` hook unwraps `[path#TAG]` from path, strips `N:` prefixes from content, records snapshot, echoes `[path#hash]` header
4. **System prompt** — `experimental.chat.system.transform` injects hashline syntax

### Edit Operations

```
SWAP N.=M:       Replace lines N–M with body rows
DEL N            Delete line N
DEL N.=M         Delete lines N–M
INS.PRE N:       Insert before line N
INS.POST N:      Insert after line N
INS.HEAD:        Insert at start of file
INS.TAIL:        Insert at end of file
SWAP.BLK N:      Replace whole syntactic block (tree-sitter resolves end)
DEL.BLK N        Delete whole syntactic block
INS.BLK.POST N:  Insert after end of block
```

### Validation & Safety Features

- **Seen lines enforcement** — edits anchored on lines the model never saw are rejected
- **Line bounds validation** — out-of-bounds anchor lines rejected before apply
- **Trailing phantom line handling** — deletes targeting the empty trailing line from `split("\n")` are dropped/clamped
- **Multi-section duplicate path detection** — two sections resolving to the same file are rejected
- **Noop loop guard** — after 3 byte-identical no-op edits, escalates from soft hint to hard STOP
- **Parser contamination detection** — rejects `@@` hunks, `-` rows, and apply_patch sentinels
- **Header recovery** — strips apply_patch noise from `[path#TAG]` headers (e.g. `[***Update File:foo.ts#CB5A]`)
- **Hash mismatch recovery** — 3-way merge, session-chain replay, head/tail drift tolerance
- **Block operations** — `SWAP.BLK`/`DEL.BLK`/`INS.BLK.POST` resolve whole syntactic blocks via tree-sitter (17 languages supported)
- **Compact diff preview** — post-edit line numbers so the model can chain edits without re-reading

## Testing

Automated test suite: `bun test ./test.ts` (524 assertions across 55 test sections). Typecheck: `./node_modules/.bin/tsc --noEmit`.

## Origin

Based on the [hashline system](https://blog.can.ac/2026/02/12/the-harness-problem/) from [oh-my-pi](https://github.com/can1357/oh-my-pi) by Can Bölük. Adapted from oh-my-pi's built-in library to OpenCode's plugin API.

## License

MIT
