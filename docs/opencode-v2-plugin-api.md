# OpenCode v2.0.10 Plugin API — Verified Reference

Reverse-engineered from the running binary at `/home/opus/.opencode/bin/opencode`
(`opencode v2.0.10`, Bun-compiled). All facts below were extracted from the binary's
embedded source unless marked *unverified*.

> **⚠️ Do not trust the reference repo or the installed npm package for this.**
> `/home/opus/.local/share/opencode/repos/github.com/anomalyco/opencode` (branch `dev`,
> package version `1.17.9`) and `@opencode-ai/plugin@1.17.9` in `node_modules` both
> describe the **v1 `Hooks` API**, which does **not** exist in the v2.0.10 binary.
> Grep for `tool.execute.before`, `experimental.chat.system.transform`, or
> `experimental.session.compacting` in the binary returns **zero matches**. The v2 binary
> is a rewrite built on Effect, with a domain-object plugin API.

## 1. Plugin module shape

```ts
export default {
  id: "opencode-hashline",
  async setup(ctx) { /* register hooks/tools */ },
}
```

- The loader reads `mod.default`, then:
  `const v = ...; const w = "effect" in v ? v : dv(v)` — a module may export either an
  `effect` (an Effect program) **or** a `setup` function.
- Error if the default export is malformed:
  `"Plugin must export a default definition with an id and an effect or setup function."`
- `dv(v)` wraps a `setup`-style module into the internal Effect plugin shape; it builds the
  context object (§2) from the server's ClientApi endpoint groups and calls
  `e.setup(ve)`.
- The `setup` return value, if defined, is used as a disposer:
  `yield*Ft(oe(()=>Promise.resolve(e.setup(ve))),(le)=>le?oe(()=>Promise.resolve(le())):U)`
  — return a function (or nothing) from `setup`.
- Plugin IDs appear in diagnostics as e.g. `opencode.tool.input.repair`,
  `QuestionTool.Plugin`, `ReadTool.Plugin`, `OpenCodeTools.Plugin`,
  `NativeCompactionPlugin`. Built-ins use `A("Name.Plugin")` effect tags.

## 2. The `setup(ctx)` context object

The context (`ve`) is a set of domain objects. Each domain's methods either call a server
endpoint or register a hook/transform. Async callbacks are bridged:
`hook(name, cb)` → `ee(a.<domain>.hook(name, (ev) => Promise.resolve(cb(ev))))`.

```
app, location, options, rpc
agent:         { get, list, transform, reload }
aisdk:         { hook }
command:       { list, transform, reload }
event:         { subscribe }
experimental:  { terminal: { read } }
generate:      { text }
integration:   { list, get, connect: { key }, oauth: {...}, connection: {...}, transform, reload }
mcp:           { list, transform, reload }
model:         { list, default, transform, reload }
permission:    { hook, list, get, reply }
plugin:        { list }
provider:      { list, get, transform, reload }
reference:     { list, transform, reload }
session:       { hook, create, get, switchAgent, switchModel, prompt, generate,
                 command, synthetic, interrupt, update, move, wait, context }
shell:         { hook }
skill:         { list, transform, reload }
storage:       { get, set, remove, scan }
tool:          { reload, list, transform, hook }
vcs:           { get, base, branch: { list }, status, diff, reload, transform }
websearch:     { providers, query, reload, transform }
worktree:      { list, create, remove, refresh, reload, transform }
```

There is **no `experimental.*` hook namespace** — system-prompt injection, tool filtering,
and compaction all moved to `session.hook`.

## 3. Hooks

Hook names observed in use inside the binary:

| Domain | Hook name | Purpose |
|---|---|---|
| `tool` | `execute.before` | mutate tool input before a tool runs |
| `tool` | `execute.after` | observe/rewrite tool results |
| `session` | `context` | per-request LLM context: **system prompt + tool list** |
| `session` | `compaction` | compaction prompt context |
| `session` | `generate` | generation-time context (same payload shape as `context`) |
| `session` | `sdk` | SDK plumbing |
| `session` | `language` | *unverified* |
| `aisdk` | `model.request`, `http.request`, `http.response`, `retry`, `sdk` | AI SDK layer |
| `permission` | (hook registered via `permission.hook`) | permission decisions |
| `shell` | (hook registered via `shell.hook`) | shell plumbing |
| `experimental` | `ws.handshake` | *unverified* |

### 3.1 `tool.hook("execute.before", (event) => ...)`

Event shape (from the `Tool.execute` implementation):

```ts
{ tool, sessionID, agent, messageID, id, input }
```

- `input` **is the live args object** — mutating its properties in place changes what the
  tool receives. The built-in input-repair plugin does exactly this:
  `if (a.tool === "execute") return; ... a.input = Or(a.input, u, u, 0)` (JSON-schema
  coercion/repair of the tool input).
- **Mutation must be in-place.** Rebinding `event.input = newObj` is not read back by the
  caller — the same object reference is passed to `tool.execute`.

### 3.2 `tool.hook("execute.after", (event) => ...)`

```ts
// success
{ tool, sessionID, agent, messageID, id, input, status: "completed",
  result: { content, output?, metadata? } }

// failure
{ tool, sessionID, agent, messageID, id, input, status: "error", error }
```

- To rewrite tool output, mutate `event.result.output` / `event.result.content`
  in place (same in-place rule as `before`).
- The built-in permission-recovery hook watches `status === "error"` for
  `edit`/`write`/`patch` tools and rewrites `event.error`.

### 3.3 `session.hook("context", (event) => ...)`

This replaces `experimental.chat.system.transform` **and** the tool-filter use cases.

```ts
event: {
  system: string[],      // push/append to inject into the system prompt
  tools: Record<string, ToolDef>,  // live map; delete/rename/rewrite entries
  model: { id, ... },
  ...                    // agent/session info
}
```

Verified usage patterns from built-ins:

```js
// OpenCodeTools.Plugin — inject system text
session.hook("context", (i) => { i.system.push(Kl.make("When you create a worktree...")); })

// GPT patch-model filter — remove tools by key
session.hook("context", (_) => {
  if (_.model.id.includes("gpt-") && !_.model.id.includes("oss") && !_.model.id.includes("gpt-4")) {
    delete _.tools.edit; delete _.tools.write; return;
  }
  delete _.tools.patch;
});

// WebSearch gating + description rewrite
session.hook("context", (s) => { if (disabled) delete s.tools[Ug]; });
session.hook("context", (N) => { const P = N.tools[Ep]; if (P) P.description = e3(...); });
```

Built-ins register the **same callback** on `context`, `compaction`, and `generate`
(`yield* e.session.hook("context", c); yield* e.session.hook("compaction", c); yield* e.session.hook("generate", c)`),
implying the three share a payload shape.

## 4. Tool registration — `tool.transform`

```ts
ctx.tool.transform((editor) => {
  editor.namespace({ name: "opencode", description: "..." });
  editor.add({
    name: "session_rename",
    description: "...",
    input: <Zod schema>,            // see §4.1
    output: <Zod schema>,           // optional
    options: { namespace: "opencode", codemode: true, permission: "edit" },
    execute: (args, ctx) => Effect,  // or Promise
  });
  editor.update(name, (def) => { ... });
  editor.remove(name);
  editor.get(name);
  editor.list();
});
```

The editor object given to your callback:
```js
{ list, get, namespace, add, update, remove }
```
and `add` wraps your execute: `add: (Te) => ye.add({...Te, execute: (Pe, Le) => lv(Te, Pe, Le)})`.

Verified built-in registrations (Edit, Glob, Grep, Write, Question, apply_patch) all use
this shape with `name` (not `id`), a Zod `input`, and `options`.

### 4.1 `input` must be a Zod schema, not JSON Schema

Tool definitions are converted for the LLM via:
```js
DD = (e) => ({ type: "tool", name: Wr(e), description: e.description,
               inputSchema: sd(e.input), ...e.output === void 0 ? {} : { outputSchema: ad(e.output) } })
```
where `sd` produces a JSON Schema **from a Zod schema** (the binary embeds Zod v4;
`$ZodType`, `toJSONSchema`, `__zod` markers are all present). A raw JSON Schema object
will not typecheck/convert correctly. The WIP migration's
`input: { type: "object", properties: {...} }` was wrong.

### 4.2 Override semantics

Plugin tools are merged with built-ins; on key collision the plugin entry wins (the
built-in `usePatch` filter in `session.hook("context")` deletes `tools.edit` for GPT
models — see §3.3 — which applies by **name**, so a plugin `edit` tool is subject to the
same filter).

## 5. Tool execute context

`execute(args, ctx)` receives a context with at least:
```ts
{ sessionID, messageID, agent, id, directory, worktree, ... }
```
Verified field accesses in built-in executes: `i.sessionID`, `i.agent`, `i.messageID`,
`i.id`, and `f.directory` (from `s.resolve(...)` / worktree context).

## 6. Built-in tool names & arg shapes (from string table)

| Tool | Args |
|---|---|
| `read` | `path` ("File or directory to read"), `offset` ("The line or directory entry to start reading from (1-based)"), `limit` ("The maximum number of lines or directory entries to read (defaults to 2000)") |
| `write` | `filePath` ("Path to the file to write to"), `content` ("Content to write to the file") |
| `edit` | *see binary* — str_replace-style |
| `grep` | `pattern`, `path`, `include`, ... |
| `glob` | `path`, `pattern` |
| `shell` | `command`, `cwd`, `timeout`, `background` |

> **Note:** `read` takes **`path`**, not `filePath`. The WIP migration's
> `event.input?.filePath` on read is wrong; it should be `event.input?.path`.

Read output line format (verified from string table + tool description):
- Each text line is prefixed with its 1-based line number as `<line>: <content>`.
- Directory entries are returned one per line.
- Long lines are truncated with the marker `... (line truncated to N chars)`.
- The v1-style `<path>…</path>` / `<content>` XML wrapper seen in the reference repo's
  `read.ts` is **not present in this binary** (`</content>` count: 0, `(Showing ` count: 0,
  `Use offset=` count: 0, `(End of file` count: 0). The reference repo's `read.ts` is newer
  than the shipped v2.0.10 binary — treat read output as plain `N: line` rows and verify
  empirically before relying on exact wrapper form.

## 7. What the WIP migration got right vs wrong

`src/index.ts` (uncommitted working tree):

| Guess | Verdict |
|---|---|
| `export default { id, async setup(ctx) }` | ✅ **Correct** module shape |
| `ctx.tool.hook("execute.before", cb)` | ✅ Correct |
| `ctx.tool.hook("execute.after", cb)` | ✅ Correct |
| `ctx.tool.transform((editor) => editor.add({...}))` | ✅ Correct |
| `ctx.session.hook("context", cb)` | ✅ Correct |
| `ctx.session.hook("compaction", cb)` | ✅ Correct |
| `event.input?.filePath` (read) | ❌ Read uses `input.path` |
| `event.output` in `execute.after` | ❌ Output is at `event.result.output` (success) / `event.error` (failure); mutate in place |
| `event.system.push(...)` on compaction | ⚠️ Likely correct (context/compaction/generate share payload) — *verify empirically* |
| `input: { type: "object", properties: {...} }` | ❌ Must be a Zod schema |
| `editor.add({ name, description, input, execute })` | ✅ shape correct, `input` wrong type |
| Keying pending calls by `sessionID` instead of `callID` | ⚠️ Events carry `id` (callID) and `sessionID`; the v1 callID-stash workaround is unnecessary — `execute.after` receives `input` directly |

## 8. Migration checklist

1. Restore/keep `export default { id, setup(ctx) }`.
2. `tool.hook("execute.before", ...)` — unwrap `[path#TAG]` from `write`'s `filePath`
   (in-place mutation of `event.input.filePath` / `event.input.content`).
3. `tool.hook("execute.after", ...)` — inject `[path#TAG]` header into read output by
   mutating `event.result.content` (success) or handling `status === "error"`.
4. Use `event.input.path` for the `read` tool, `event.input.filePath` for `write`.
5. `session.hook("context", ...)` — append `HASHLINE_PROMPT` to `event.system[]`; also
   handle the `tools` map if needed.
6. `session.hook("compaction", ...)` — push the snapshot table.
7. `tool.transform` — register `edit` with a **Zod** `input` schema
   (`z.object({ input: z.string() })`), `options: { permission: "edit" }`, and an
   Effect-returning (or async) `execute`.
8. Drop the `@opencode-ai/plugin` v1 `Hooks`/`tool()` imports entirely — they describe an
   API that isn't in the binary. Write minimal local types or use `any` until the v2 types
   are published.
9. `diff`/`web-tree-sitter` runtime deps remain usable from `~/.config/opencode/package.json`.

## 9. Verification commands

```bash
# Confirm the binary has no v1 hooks
grep -a -c "experimental.chat.system.transform" ~/.opencode/bin/opencode   # → 0
grep -a -c "tool.execute.before"             ~/.opencode/bin/opencode       # → 0
grep -a -c 'hook("context"'                  ~/.opencode/bin/opencode       # → 9
grep -a -c 'tool.transform('                 ~/.opencode/bin/opencode       # → 16

# Confirm the installed npm types describe v1 (stale for this binary)
grep -c "experimental.chat.system.transform" opencode-hashline/node_modules/@opencode-ai/plugin/dist/index.d.ts  # → 1
```
