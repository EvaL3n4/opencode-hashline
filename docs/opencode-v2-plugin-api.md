# OpenCode v2.0.10 Plugin API — Verified Reference

Reverse-engineered from the running binary at `/home/opus/.opencode/bin/opencode`
(`opencode v2.0.10`, Bun-compiled). All facts below were extracted from the binary's
embedded source unless marked _unverified_.

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
    async setup(ctx) {
        /* register hooks/tools */
    },
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

| Domain       | Hook name                                                                    | Purpose                                                          |
| ------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `tool`       | `execute.before`                                                             | mutate tool input before a tool runs                             |
| `tool`       | `execute.after`                                                              | observe/rewrite tool results                                     |
| `session`    | `context`                                                                    | per-request LLM context: **system prompt + tool list**           |
| `session`    | `compaction`                                                                 | compaction prompt context                                        |
| `session`    | `generate`                                                                   | generation-time context (same payload shape as `context`)        |
| `session`    | `title`                                                                      | title-generation context; set `result` to skip the model request |
| `session`    | `prompt`                                                                     | user prompt before dispatch                                      |
| `session`    | `retry`                                                                      | decide whether to retry a failed request (`attempt`, `decision`) |
| `session`    | `model.request` / `http.request` / `http.response`                           | request plumbing                                                 |
| `session`    | `experimental.ws.handshake` / `ws.send` / `ws.receive`                       | WebSocket channel plumbing                                       |
| `aisdk`      | `model.request`, `http.request`, `http.response`, `retry`, `sdk`, `language` | AI SDK layer                                                     |
| `permission` | `evaluate`                                                                   | permission decisions (`PermissionEvaluation`)                    |
| `shell`      | (hook registered via `shell.hook`)                                           | shell plumbing                                                   |

> **Verified from source** (`packages/plugin/src/promise/session.ts`, tag `v2.0.10`): the full
> `SessionHooks` map is `prompt, context, compaction, generate, title, model.request,
http.request, http.response, experimental.ws.handshake, experimental.ws.send,
experimental.ws.receive, retry`. The `experimental.ws.*` hooks above are therefore confirmed
> (previously marked _unverified_), and `title` / `prompt` / `retry` were missing from the
> binary-grep list. The `aisdk` `language` hook is confirmed by the plugin README's example
> (`event.model`, `event.sdk`, `event.language`).

### 3.1 `tool.hook("execute.before", (event) => ...)`

Event shape (from the `Tool.execute` implementation):

```ts
{
    ;(tool, sessionID, agent, messageID, id, input)
}
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
  system: SystemPart[],   // { type: "text", text, cache?, metadata? }[] — push/append to inject into the system prompt
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>,  // live map; delete/rename/rewrite entries
  messages: Message[],    // live array; the request's message history
  model: Model.Ref,
  options: SessionRequestOptions,  // generation settings + arbitrary provider options
  agent: Agent.ID,        // SessionContext only (not on SessionRequest)
  ...                    // agent/session info
}
```

> **Verified against `@opencode/plugin@2.0.10` types** (not inferred from the binary):
> `SessionContext extends SessionRequest` and `SessionRequest.system` is
> `Array<SystemPart>` where `SystemPart = { type: "text", text: string, cache?, metadata? }`
> (`@opencode/plugin/dist/promise/session.d.ts`, `@opencode/ai/dist/schema/messages.d.ts`).
> The `string[]` annotation above was wrong — but note the built-in examples in §3.3 that
> call `Kl.make("...")` are consistent with parts, since `Kl.make` builds a text part.

> **Source-verified** (`packages/plugin/src/promise/session.ts`, tag `v2.0.10`):
>
> ```ts
> interface SessionRequest {
>     readonly sessionID: Session.ID
>     readonly model: Model.Ref
>     system: Array<SystemPart>
>     messages: Array<Message>
>     options: SessionRequestOptions
> }
> interface SessionContext extends SessionRequest {
>     readonly agent: Agent.ID
>     tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>
> }
> interface SessionCompaction extends SessionContext {
>     /** Set to use this compaction and skip the model request. */
>     result?: SessionCompactionResult // { summary, providerState?, metadata?, tokens? }
> }
> interface SessionTitle extends SessionRequest {
>     result?: string
> } // same skip behavior
> ```
>
> The `tools` map value is **not** a full `ToolDef` — only `{ description, input }`. Note the
> compaction/title `result` fields: a hook can supply the summary/title itself and **skip the
> model request entirely**, which the binary grep could not reveal.

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
    input: <schema>,               // see §4.1 — Effect Schema / StandardSchemaV1 / JSON Schema
    output: <schema>,              // optional
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
{
    ;(list, get, namespace, add, update, remove)
}
```

and `add` wraps your execute: `add: (Te) => ye.add({...Te, execute: (Pe, Le) => lv(Te, Pe, Le)})`.

Verified built-in registrations (Edit, Glob, Grep, Write, Question, apply_patch) all use
this shape with `name` (not `id`), a schema `input` (see §4.1), and `options`.

### 4.1 `input` accepts Effect Schema, StandardSchemaV1, **or** plain JSON Schema

**This section's original claim is wrong — corrected from primary source.** The published contract
(`packages/schema/src/tool.ts`, tag `v2.0.10`) is:

```ts
export type ValueSchema<A = unknown> =
    | Schema.Codec<A, any> // Effect Schema (the canonical form in docs/examples)
    | StandardSchemaV1<any, A> // any standard-schema consumer (Zod v4 implements this)
    | JsonSchema.JsonSchema // a plain JSON Schema object
```

The official plugin README registers tools with Effect's `Schema.Struct`:

```ts
import { Schema } from "effect"

tools.add({
    name: "echo",
    options: { codemode: false },
    description: "Echo text",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: async ({ text }) => ({ output: { text }, content: text }),
})
```

The original binary-grep reasoning below is retained as a caution, but its conclusion does not hold:
the binary does embed Zod v4 and does convert `input` to a JSON Schema for the LLM
(`DD = (e) => ({ type: "tool", name: Wr(e), description: e.description, inputSchema: sd(e.input), ... })`),
but `sd` accepts any of the three `ValueSchema` members — embedding Zod does not mean _plugins_
must supply Zod. DCP's bridge (`tool.schema.object(definition.args)` from `@opencode-ai/plugin`,
which yields a plain JSON Schema object) typechecks and round-trips through 2.0.10 in the lab
harness across all four matrix legs, which settles it empirically as well.

> Caution: the tool editor's _context-side_ map (§3.3 `event.tools`) types `input` as
> `JsonSchema.JsonSchema` only — the narrower shape there is real, and reflects what is actually
> sent on the wire.

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

| Tool    | Args                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`  | `path` ("File or directory to read"), `offset` ("The line or directory entry to start reading from (1-based)"), `limit` ("The maximum number of lines or directory entries to read (defaults to 2000)") |
| `write` | `filePath` ("Path to the file to write to"), `content` ("Content to write to the file")                                                                                                                 |
| `edit`  | _see binary_ — str_replace-style                                                                                                                                                                        |
| `grep`  | `pattern`, `path`, `include`, ...                                                                                                                                                                       |
| `glob`  | `path`, `pattern`                                                                                                                                                                                       |
| `shell` | `command`, `cwd`, `timeout`, `background`                                                                                                                                                               |

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

| Guess                                                   | Verdict                                                                                                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export default { id, async setup(ctx) }`               | ✅ **Correct** module shape                                                                                                                                                |
| `ctx.tool.hook("execute.before", cb)`                   | ✅ Correct                                                                                                                                                                 |
| `ctx.tool.hook("execute.after", cb)`                    | ✅ Correct                                                                                                                                                                 |
| `ctx.tool.transform((editor) => editor.add({...}))`     | ✅ Correct                                                                                                                                                                 |
| `ctx.session.hook("context", cb)`                       | ✅ Correct                                                                                                                                                                 |
| `ctx.session.hook("compaction", cb)`                    | ✅ Correct                                                                                                                                                                 |
| `event.input?.filePath` (read)                          | ❌ Read uses `input.path`                                                                                                                                                  |
| `event.output` in `execute.after`                       | ❌ Output is at `event.result.output` (success) / `event.error` (failure); mutate in place                                                                                 |
| `event.system.push(...)` on compaction                  | ✅ **Verified** — context/compaction/generate share `SessionContext`, and `system` is `SystemPart[]`; push `{ type: "text", text }`, not a bare string (v1 pushed strings) |
| `input: { type: "object", properties: {...} }`          | ✅ **Actually fine** — §4.1 was wrong; plain JSON Schema is a valid `ValueSchema`                                                                                          |
| `editor.add({ name, description, input, execute })`     | ✅ Correct                                                                                                                                                                 |
| Keying pending calls by `sessionID` instead of `callID` | ⚠️ Events carry `id` (callID) and `sessionID`; the v1 callID-stash workaround is unnecessary — `execute.after` receives `input` directly                                   |

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
7. `tool.transform` — register `edit` with a schema `input` (Effect `Schema.Struct` is the
   canonical form; plain JSON Schema and StandardSchemaV1 are also accepted — see §4.1),
   `options: { permission: "edit" }`, and an Effect-returning (or async) `execute`.
8. The v1 `@opencode-ai/plugin` `Hooks`/`tool()` API is not how v2 loads plugins, but the
   package remains usable on npm (1.18.29) as a source of v1-shaped helpers — DCP keeps
   `tool.schema.object()` as a JSON-Schema bridge. Prefer the published v2 types
   (`@opencode/plugin`) for everything else.
9. `diff`/`web-tree-sitter` runtime deps remain usable from `~/.config/opencode/package.json`.

## 9. 2.0.4 → 2.0.10 drift found in practice

Verified by retargeting `origin/v2` (pinned to `@opencode/plugin@2.0.4`) to 2.0.10 and running
the `tests/lab` container matrix against `@opencode/cli@2.0.10`.

1. **`transport` moved off the model.** In 2.0.10, `Model.Settings` declares **only `compaction`**
   (as a `StructWithRest`, so extra keys are silently swallowed). Setting
   `providers.x.models.y.transport = "websocket"` is dropped and requests **fall back to HTTP
   with no error**. The schema's own doc string: _"websocket" on a route without a WebSocket
   channel warns and falls back to HTTP._ `transport` now lives on **route-level
   `Provider.Settings`** (`providers.x.settings.transport`) and on agent route overlays
   (`agent.<name>.request.settings.transport`). Symptom in the lab: `assert.ok(sent.length > 0)`
   failed with "v2 did not use websocket". Fix: move it to `providers.x.settings`.
2. **Model `compaction` changed shape.** 2.0.10 model settings use
   `compaction: { type: "summary" | "native" }`, not 2.0.4's `{ mode: "local" }`. **Resolved
   empirically**: `tests/lab/run.mjs` now sets `{ type: "summary" }`, and all four matrix legs
   produce results identical to the old `{ mode: "local" }` run (`compression: true`,
   `contexts: 3`, `compaction: true`, same assertions passing), proving the `mode` value was
   inert dead config that 2.0.10 silently dropped. Note the **top-level** config `compaction`
   (`ConfigCompaction.Info`) is a different shape entirely — `{ auto?, keep?: { tokens? },
buffer? }` — and also has no `mode` field.
3. **The `system` shape** — see §3.3 correction above.
4. **Tool `input` accepts a plain JSON Schema** per the published 2.0.10 types
   (`ValueSchema = Schema.Codec | StandardSchemaV1 | JsonSchema`), which is how `lib/v2` keeps
   using `@opencode-ai/plugin`'s `tool.schema.object` bridge. §4.1's "must be Zod" claim is about
   the _binary's_ runtime conversion, which the npm types cannot confirm — the lab is the
   authority here, and the `compress` tool round-trips fine through 2.0.10 in all four legs.

## 10. Hook semantics (source-verified)

Non-obvious rules from `packages/plugin/src/**` and `services/www/src/docs/content/build/plugins/**`
at tag `v2.0.10`:

- **Register per kind.** `context` covers the agent loop only. A transform that must apply to
  every model request kind must register `context`, `compaction`, `generate`, and `title`
  separately. DCP's `lib/v2` registers `context` + `compaction` — `generate`/`title` are
  currently uncovered, by choice.
- **Only `tool.execute.before` may fail.** `ToolFailures` maps `execute.before → Tool.Error`,
  `execute.after → never`; session/permission/shell/aisdk hooks have no failure channel either.
  Throwing in a before-hook rejects the tool call; after-hooks must not throw.
- **Mutation in place is the contract.** Hook callbacks return `void`; the dispatcher
  (`packages/core/src/plugin/hooks.ts` `trigger`) threads the same event object through every
  callback in registration order. Note `event.result` itself is **mutable** — an after-hook may
  replace it wholesale (`event.result = { ...event.result, metadata: {...} }`), not just mutate
  its fields.
- **Transform editor callbacks are synchronous.** Load async data before registering and call
  `reload()` afterwards.
- **`event.options` starts empty per model call** — it does not contain resolved model settings.
- **Provider scoping:** the third arg to `session.hook` is `ModelHookOptions` (`{ providerID? }`)
  only for events that carry a `model` field; the `prompt` hook has `never`.
- **Hooks are not exactly-once.** Docs warn prompt hooks are retry-safe but not an exactly-once
  side-effect boundary.

## 11. v1 → v2 extension-point map

Verbatim table from `services/www/src/docs/content/build/plugins/migrate-v1.mdx` (tag `v2.0.10`) —
the authoritative destination for each v1 hook DCP uses:

| V1 extension point                     | V2 API                                                       |
| -------------------------------------- | ------------------------------------------------------------ |
| `event`                                | `ctx.event.subscribe()`                                      |
| `dispose`                              | cleanup function returned by `setup`                         |
| `config`                               | transforms on the affected domains                           |
| `tool` map                             | `ctx.tool.transform(...)`                                    |
| `auth`                                 | `ctx.integration.transform(...)` and integration APIs        |
| `provider`                             | `ctx.provider.transform(...)` and `ctx.model.transform(...)` |
| `chat.message`                         | `ctx.session.hook("prompt", ...)`                            |
| `chat.params`                          | `ctx.session.hook("context", ...)`                           |
| `chat.headers`                         | `ctx.session.hook("model.request", ...)` or `"http.request"` |
| `permission.ask`                       | `ctx.permission.hook("evaluate", ...)`                       |
| `command.execute.before`               | command transforms or the prompt hook, depending on intent   |
| `tool.execute.before`                  | `ctx.tool.hook("execute.before", ...)`                       |
| `tool.execute.after`                   | `ctx.tool.hook("execute.after", ...)`                        |
| `shell.env`                            | `ctx.shell.hook("create.before", ...)`                       |
| `tool.definition`                      | `ctx.tool.transform(...)`                                    |
| `experimental.chat.system.transform`   | `ctx.session.hook("context", ...)` and edit `event.system`   |
| `experimental.chat.messages.transform` | `ctx.session.hook("context", ...)` and edit `event.messages` |
| `experimental.session.compacting`      | `ctx.session.hook("compaction", ...)`                        |

> "These are migration destinations, not always exact renames." — `prompt` runs before durable
> prompt admission; `context` runs immediately before an agent model request.

**No V2 equivalent exists for** `experimental.compaction.autocontinue`,
`experimental.provider.small_model`, `experimental.text.complete`, or a global
`command.execute.before`. DCP's `createTextCompleteHandler` (v1 `experimental.text.complete`)
therefore has no v2 destination — it is correctly absent from the stripped `index.ts`. Re-evaluate
any reliance on these against the session/provider/model/event APIs rather than preserving the v1
lifecycle assumption.

## 12. Authoritative sources

Prefer these over binary-grep or this document's inferences:

- **Source**: `github.com/anomalyco/opencode` tag **`v2.0.10`** (the `dev` branch is the v1
  codebase — do not consult it for v2 questions).
- **Published types**: `@opencode/plugin@2.0.10` (`packages/plugin`), `@opencode/schema@2.0.10`
  (`packages/schema`), `@opencode/ai@2.0.10` (`packages/ai`).
- **Package docs**: `packages/plugin/src/README.md` (Promise API), `packages/plugin/src/effect/README.md`.
- **Site docs** (served at opencode.ai/docs): `services/www/src/docs/content/build/plugins/` —
  `index.mdx` (authoring guide), **`migrate-v1.mdx` (v1→v2 migration guide)**, `effect.mdx`,
  `rpc.mdx`, `cli.mdx`.
- **Reference plugins**: `packages/core/test/plugin/fixtures/greeting.ts` (minimal Promise plugin),
  `packages/server/test/fixture/worktree-plugin/`, and the built-in Effect plugins under
  `packages/core/src/plugin/` (provider, websearch, vcs, compaction, …).
- **Local clone**: `~/.local/share/opencode/repos/github.com/anomalyco/opencode` — fetch
  `refs/tags/v2.0.10` and read via `FETCH_HEAD` (the tag ref is not created by a depth-1 fetch).

## 13. Verification commands

```bash
# Confirm the binary has no v1 hooks
grep -a -c "experimental.chat.system.transform" ~/.opencode/bin/opencode   # → 0
grep -a -c "tool.execute.before"             ~/.opencode/bin/opencode       # → 0
grep -a -c 'hook("context"'                  ~/.opencode/bin/opencode       # → 9
grep -a -c 'tool.transform('                 ~/.opencode/bin/opencode       # → 16

# Confirm the installed npm types describe v1 (stale for this binary)
grep -c "experimental.chat.system.transform" opencode-hashline/node_modules/@opencode-ai/plugin/dist/index.d.ts  # → 1
```
