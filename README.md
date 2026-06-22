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
# { "dependencies": { "xxhash-wasm": "^1.1.0" } }
```

### npm (future)

```json
{
  "plugin": ["opencode-hashline"]
}
```

## How It Works

1. **Read** — `tool.execute.after` hook prepends `[path#tag]` header, records snapshot
2. **Edit** — Custom `edit` tool validates tag against current file hash, applies patch
3. **Write** — `tool.execute.after` hook records snapshot of written content
4. **System prompt** — `experimental.chat.system.transform` injects hashline syntax

### Edit Operations (v1)

```
SWAP N.=M:     Replace lines N–M with body rows
DEL N          Delete line N
DEL N.=M       Delete lines N–M
INS.PRE N:     Insert before line N
INS.POST N:    Insert after line N
INS.HEAD:      Insert at start of file
INS.TAIL:      Insert at end of file
```

## Origin

Based on the [hashline system](https://blog.can.ac/2026/02/12/the-harness-problem/) from [oh-my-pi](https://github.com/can1357/oh-my-pi) by Can Bölük. Adapted from oh-my-pi's built-in library to OpenCode's plugin API.

## License

MIT
