# DeepSeek Harness for IDE

DeepSeek Harness (DSH) for VS Code and Cursor. The extension runs inside the editor, presents chat in a sidebar, and keeps proposed edits in an isolated workspace mirror until review. DeepSeek and OpenRouter API routes start the pinned `@deepseek-ai/dsh` `0.2.0-rc.2` package. ChatGPT and Claude subscription routes run the official Codex and Claude Code CLIs using their browser sign-ins. Cursor models use the official Cursor Agent CLI over ACP.

## What works

- The extension activates through `src/extension.ts` and registers the sidebar and contributed commands.
- DSH runs as a child Node process over line-delimited JSON-RPC ACP on stdio. The provider and backend model are passed through a generated DSH patch; the API key is supplied through the child environment. The key is not put in process arguments or the patch file, and runtime output redacts it.
- The default model route is `DeepSeek V4 Flash` / `deepseek-official` / `deepseek-v4-flash`.
- `Cursor Auto` starts the official Cursor Agent CLI. After a Cursor session starts, the sidebar lists models advertised by the CLI and switches them through ACP. Cursor sign-in stays with the CLI; the extension does not copy Cursor tokens into SecretStorage.
- `Codex Default` and `Claude Default` use the respective CLIs with browser sign-in. Each connected account has its own CLI configuration directory so work and personal logins can coexist. No API key is requested for these routes.
- The sidebar has compact chat tabs and a Recent dropdown, grouped account lists, a provider-aware model editor, an in-sidebar model menu, speed routes and effort choices, prompts, cancellation, tool activity, and pending edit cards. The header actions use a bundled Google Material Symbols font. The **Settings** dropdown in the header opens **Behavior** (rules and skills), **Models**, **Subagents**, **Toolpacks**, **Customize** and **Accessibility**. **Behavior** opens native AGENTS/CLAUDE rules and SKILL.md entries plus workspace `AGENTS/` and `.agents/skills`. Access control sits in the former image-attachment slot; provider usage links open each provider's usage website.
- User message **Edit**/**Save** starts a fresh backend session that keeps earlier conversational context and removes later timeline entries.
- Attachments accept up to 8 files (10 MiB each, 20 MiB total). Text and binary files are copied into `.dsh/context` and referenced in the prompt path; supported images are sent to the provider natively.
- DSH automatic context compaction is enabled. The sidebar keeps the full visible message timeline. New activity persists tool, approval, and subagent output in that timeline; older text-only saved chats cannot recover tool data that was never saved.
- While a turn is running the send button becomes a split button with two options. **Interrupt & send** cancels the turn and starts the new request after cancellation settles. **Queue message** waits for the turn to finish and sends automatically; queued messages show above the composer and can be removed. **Cancel task** stops the current turn and clears the queue without sending anything.
- The Recent menu can delete a chat (click the trash icon twice). Deleting removes the saved timeline and the chat's private working copy, including any unapplied proposals. **Delete all** at the bottom of the menu does the same for every chat that is not running (click it twice; running chats are kept).
- Subagents run in parallel. `delegate_tasks` runs several profiles in one call; Claude Code and Codex may also issue several `delegate_task` calls at once. Parallel edit subagents must lock disjoint files, and each DSH-routed subagent gets its own runtime process.
- Updates use one flow. Five seconds after startup (or from **DSH: Check for Updates**) the extension checks the npm registry for a newer `@deepseek-ai/dsh` and GitHub (`dsh.updates.repository`, default `raisinhvh/DSH-IDE`) for a newer DSH-IDE release. If a DSH update exists and a newer DSH-IDE release is published, the DSH-IDE update is **required**: a modal prompt offers only **Update now**, chats are blocked until it is installed, and the window must be reloaded afterward. The DSH runtime is installed into extension storage first and is preferred over the bundled pin until the bundle catches up. If only one of the two has an update, it is offered as an optional prompt (**Update**, **Later**, and for DSH alone **Skip this version**). Set `dsh.updates.check` to `false` to silence optional prompts; required updates still apply. Failed or offline checks are logged to the DeepSeek Harness output channel and never block chats.

To publish an extension update, increase `package.json`'s version, run `npm run package`, and attach the resulting `dsh-ide-<version>.vsix` to a published GitHub Release tagged `v<version>` (for example, `v5.0.1` with `dsh-ide-5.0.1.vsix`). The tag must match the packaged version. Use a stable release, not a draft or prerelease. The updater checks GitHub's latest release endpoint and requires that exact asset name. Publishing a release alone is enough; the source code can live in a separate repository. This implementation uses public releases without a token.
- Diffs are computed with a Myers line diff, so one-line edits stay small in large files, and line-ending-only rewrites (for example LF written over a CRLF file) are aligned to the reviewed file's style instead of showing as a whole-file change.
- The review controller opens native `vscode.diff` views and a multi-file changes editor, supports apply/reject for a file, apply/reject all, and apply/reject one selected hunk. Unambiguous content-preserving moves are applied as VS Code rename edits. Reject restores the mirror baseline and clears pending proposal animations.
- Applying a proposal checks the live file against its review base, rejects workspace escaping and symlink targets, and updates the mirror baseline only after VS Code accepts the `WorkspaceEdit`.
- With `dsh.runtime.mirror` off, there is no private copy. At the start of each turn DSH snapshots the workspace's text files (skipping gitignored ones), and anything that changes during the turn is listed as already applied. Files you save in the editor during a turn count as your edits, not the agent's. Changes made between turns are never attributed to the agent.

## Requirements

- Windows x64 or ARM64. On startup, DSH checks Node.js and npm; if a compatible installation is missing, it downloads a private Node 24 LTS distribution (including npm) into extension storage and verifies its SHA-256 checksum. Existing compatible installations are reused.
- Internet access for first-time dependency downloads and provider installation.
- VS Code `1.96.0` or newer, or a compatible Cursor release.
- A DeepSeek API key for the default direct route, or a Codex, Claude Code, or Cursor Agent account for its corresponding route. Missing CLIs can be installed from the model configuration form.
- A trusted, local file workspace. DSH refuses to start without a local workspace folder and workspace trust.

## Setup

For development, install the pinned dependencies from the repository root (VSIX users do not need this step):

```sh
npm install
```

Open this project in VS Code or Cursor after building the extension. For development, launch the extension host using the editor's standard extension debugging workflow and reload after rebuilding.

## Add a DeepSeek account

1. Open a local workspace and trust it.
2. Open the **DeepSeek Harness** activity-bar view.
3. Open **Accounts** in the sidebar and choose **Add API key** under **DeepSeek Accounts**.
4. Enter an account name, optional email, and DeepSeek API key in the inline form.
5. Start a new chat.

Account labels and provider metadata are stored in VS Code global state. DeepSeek and OpenRouter API keys are stored in VS Code `SecretStorage`. The Accounts page groups ChatGPT, Claude, Cursor, DeepSeek, and OpenRouter accounts. If a selected model needs an account, the sidebar opens Accounts.

## Connect ChatGPT or Claude subscriptions

1. Open model configuration and select Codex or Claude Code. If its CLI is missing, click **Install**. Codex is installed in DSH storage; Claude's official installer uses your Windows user profile. Installation progress and retry errors appear in the form.
2. Open **Accounts** and choose **Connect account** under **ChatGPT Accounts** or **Claude Accounts**.
3. Enter a display name and, optionally, an email address. Select **Continue in browser** and complete the CLI's browser sign-in.
4. Choose **Codex Default** or **Claude Default** in the model selector. The matching CLI runs in the staged workspace copy.

The extension stores each account's OAuth login in its own Codex `CODEX_HOME` or Claude `CLAUDE_CONFIG_DIR` below VS Code extension storage. It does not request or store subscription tokens in its account registry. Claude Code [documents separate configuration directories for multiple claude.ai accounts](https://code.claude.com/docs/en/authentication). To use a specific model, add a model route with the corresponding provider and model ID; `default` uses the CLI's default model.

## Use Cursor models inside VS Code

1. Select Cursor in model configuration and click **Install** if its CLI is missing. The official Windows installer uses the standard `%LOCALAPPDATA%\cursor-agent` installation. Other locations can be set with `dsh.runtime.cursorAgentPath`.
2. Open **Accounts** in the sidebar and choose **Connect Cursor**. The extension starts the official CLI login and opens Cursor's browser sign-in page. **Refresh** updates the status if the browser flow completes later.
3. Select **Cursor Auto** in the sidebar and start a chat. The session returns Cursor's available model names; pick a specific model in the same sidebar.

Cursor's [ACP interface](https://prod.cursor.com/docs/cli/acp) supplies authentication, sessions, prompts, model configuration, and permissions. The extension runs the Cursor agent against the same staged workspace copy used for review.

## Models

`dsh.models` is a global configuration array of named routes:

```json
[
  {
    "name": "DeepSeek V4 Flash",
    "provider": "deepseek-official",
    "backend": "deepseek-v4-flash",
    "account": "default",
    "enabled": true
  },
  {
    "name": "Cursor Auto",
    "provider": "cursor-acp",
    "backend": "auto",
    "account": "cursor-login",
    "enabled": true
  },
  {
    "name": "Codex Default",
    "provider": "codex-cli",
    "backend": "default",
    "account": "default",
    "enabled": true
  },
  {
    "name": "Claude Default",
    "provider": "claude-cli",
    "backend": "default",
    "account": "default",
    "enabled": true
  }
]
```

`account: "default"` resolves the selected account for that provider. An explicit account value resolves that account ID. `cursor-acp` uses the active Cursor CLI login. Use **DSH: Pick Model** or the sidebar model selector to change the active route. Choose the **Manage models** icon to add or edit a route, including its provider and account. Cursor model choices are loaded from its ACP session. The direct API mapping supports `deepseek-official` and `openrouter`. Older OpenAI and Anthropic API routes remain readable for existing configurations; their saved keys appear under **Previous API accounts** for removal. New ChatGPT and Claude accounts use OAuth through their CLIs.

The model editor also accepts speed routes such as `Fast=provider-model-id, Ultrafast=another-model-id`; **None** uses the base model ID. These are explicit model routes, so they only change speed when the chosen provider exposes a corresponding faster model. Effort choices such as `low, medium, high, xhigh` appear under the model selector. Codex and Claude receive the selected effort through their CLI options. DSH and Cursor receive it through ACP when the live model advertises that value; an unsupported choice produces a clear error. The default effort leaves the provider's setting unchanged.

DSH's pinned base profile supplies file search, file editing, shell, web search/fetch, subagents, and task tools. Tool calls appear in the sidebar as status cards. Web search uses the default DeepSeek account's API key, including when the chat model uses another DSH API provider. CLI-backed Codex, Claude, and Cursor routes use their own agents' tool sets and permissions.

## Workspace mirror and review

When a chat starts, the extension copies the workspace into extension global storage under a per-workspace, per-session mirror and runs the selected DSH, Cursor, Codex, or Claude process with that mirror as its working directory. The real workspace is not given to the agent as its working directory. Dirty text buffers are copied from the editor when the mirror is created.

The mirror respects Git ignore rules when Git is available and excludes `.git`, dependency and build directories, `.dsh`, `.npm-cache`, virtual environments, `.env` files, `.key` files, and `.pem` files. It skips symlinks and paths that resolve outside the workspace. Binary files are copied but are not tracked as text review changes, and files over 2 MiB are skipped during scans. The copy is bounded by `dsh.runtime.maxWorkspaceFiles` (default `4000`) and `dsh.runtime.maxWorkspaceBytes` (default `104857600`). Changes are scanned on file events where supported and by a two-second polling fallback. The working copy is an edit staging area, not an operating system sandbox for shell tools.

The sidebar shows pending proposals found in the mirror. Opening one uses a native virtual `dsh-review:` base/proposed diff. Apply operations are guarded by workspace trust, path and symlink checks, and a live-content conflict check. A conflict leaves the proposal unapplied so it can be reconciled in a new chat or review.

## Commands

The extension contributes:

- **DSH: New Chat**, **DSH: Continue Chat**, and **DSH: Cancel**
- **DSH: Pick Model**, **DSH: Manage Models**, and **DSH: Manage Accounts**
- **DSH: Apply All Diffs**, **DSH: Reject All Diffs**, **DSH: Review Next File**, **DSH: Review All Files**
- **DSH: Apply Hunk** and **DSH: Reject Hunk**
- **DSH: Open Runtime Logs** and **DSH: Restart Runtime**
- **DSH: Open Working Copy Terminal** opens a VS Code terminal in the session's staging copy.

`Ctrl+Alt+N` starts a new chat on Windows/Linux; macOS uses `Cmd+Alt+N`.

## Configuration

| Setting | Purpose | Default |
| --- | --- | --- |
| `dsh.models` | Named provider/backend/account routes | DeepSeek V4 Flash, Cursor Auto, Codex Default, Claude Default |
| `dsh.runtime.nodePath` | Optional Node executable for the local DSH ACP process | Empty, uses `node` |
| `dsh.runtime.cursorAgentPath` | Official Cursor Agent CLI path or installation directory | `agent`; auto-detects standard Windows install |
| `dsh.runtime.codexPath` | Optional Codex CLI executable | `codex` |
| `dsh.runtime.claudePath` | Optional Claude Code executable | `claude`; auto-detects standard Windows npm install |
| `dsh.runtime.maxWorkspaceFiles` | Maximum files copied into a mirror | `4000` |
| `dsh.runtime.maxWorkspaceBytes` | Maximum bytes copied into a mirror | `104857600` |
| `dsh.runtime.mirror` | Give each new chat a private copy of the workspace. When off, agents edit the real workspace, see your edits and other agents' edits right away, and each turn's changes are listed for review with Reject to undo. Set per chat when the chat is created. | `true` |
| `dsh.mcpServers` | MCP declarations passed to DSH `session/new` and `session/resume` | `[]` |
| `dsh.features.activityRail` | Show the activity rail left of the chat (the top chat tabs return when off) | `true` |
| `dsh.features.autoName` | Name new chats with `dsh.nameModel` | `true` |
| `dsh.nameModel` | Model (and optional effort/speed) that writes chat titles from the first message | `{}` (first-message titles) |
| `dsh.features.shareRules` | Copy global rules and skills into Claude Code and Codex account directories before each turn | `true` |
| `dsh.features.editorContext` | Add open files, cursor, selection and diagnostics to each message | `true` |
| `dsh.features.reduceMotion` | Turn off sidebar animations (shown on the Accessibility page) | `false` |
| `dsh.accessibility` | Text size, line spacing, spacing, letter spacing, higher contrast, larger click targets, underlined links | `{}` (defaults) |

## Accessibility

**Settings → Accessibility** changes how the sidebar reads. Every change shows immediately and is saved to `dsh.accessibility` in your user settings.

- **Text size** (85–160%) scales text, icons, buttons, rows and the activity rail together, so nothing clips at larger sizes.
- **Line spacing** (Normal, Relaxed, Loose) applies to chat messages and help text.
- **Spacing** (Compact, Default, Roomy) changes the room between messages, list rows and controls.
- **Letter spacing** (Normal, Wide) can make text easier to read, including for people with dyslexia.
- **Higher contrast** shows secondary text at full strength and uses stronger borders and thicker focus outlines.
- **Larger click targets** makes buttons, menu items and rail tabs bigger.
- **Underline links** underlines links and text buttons so they do not rely on color alone.
- **Reduce motion** turns off sidebar animations. A system-wide reduced-motion preference is always respected.
- **Reset to defaults** restores everything except Reduce motion.

## Customize

**Settings → Customize** turns features on or off. Switches write the user-level settings above, so they follow VS Code Settings Sync.

- **Activity rail**: a narrow rail left of the chat holds one vertical tab per chat that needs tracking. Running chats are gray with a loading bar. A chat waiting for an approval or an answer turns amber and moves to the top. A chat that finished while you were looking at another chat, a settings page, or another view turns blue, moves up and widens. Opening a blue tab removes it from the rail. Idle chats you have already seen stay in **Recent**. With the rail on, the top of the chat shows only the open chat's name and **Recent**.
- **Name chats automatically**: a chat first shows its first message as its name. When a name model is selected, it runs once in the background on that first message and replaces the name with a short title. Tools are denied for that run, and it stops after two minutes. Renaming a chat yourself keeps your name.
- **Share global rules and skills**: Claude Code and Codex run with a private configuration directory per account, so they do not read `~/.dsh/AGENTS.md` or `~/.agents/skills`. Before each Claude or Codex turn (including subagents), DSH copies the global rules into a marked block in that account's `CLAUDE.md` or `AGENTS.md`. It also copies global skills into the account's `skills/` folder and records them in `skills/.dsh-shared.json`. Codex already reads `~/.agents/skills` itself, so only `~/.dsh/skills` is copied for Codex. Files outside the marked block and skills DSH did not copy are never changed. Turning the switch off removes the copies on the next turn.

MCP command and URL entries require workspace trust. The extension passes this setting through to DSH; it does not implement MCP servers itself.

## Build and test

```sh
npm run check       # TypeScript check
npm run build       # dist/extension.js
npm test            # review hunk tests
npm run package     # check, build, and create a VSIX
```

The checked-in test script bundles the pure review helpers to `dist/` and runs the Node tests under `test/`. The tests cover hunk selection, large files, changed and dirty buffers, untitled documents, and exact rename inference. `node scripts/smoke-acp.mjs` checks DSH's initialize, new-session, and close-session handshake. `node scripts/smoke-cursor-acp.mjs` checks Cursor CLI initialization on Windows. Neither makes a provider call.

## Install a VSIX locally

After `npm run package` succeeds:

1. Open the Extensions view in VS Code or Cursor.
2. Choose the Extensions view menu and **Install from VSIX...**.
3. Select the generated `.vsix`, then reload the editor.

This package is marked `private` and uses the local publisher ID `dsh-local`; it is intended for local installation and is not published to a marketplace by this repository.

## Current limitations

- The client supports ACP initialization, authentication for Cursor, session creation/load/resume, model configuration, prompt, cancellation, permissions, and Cursor question and plan requests. Other incoming runtime requests are rejected as unsupported.
- Assistant text is streamed from committed `agent_message_chunk` updates. The sidebar shows tool names, state, and available details from ACP or CLI events. DSH's ACP surface does not provide live terminal views for agent shell calls or raw provider token deltas. The working copy terminal is for direct user inspection.
- The sidebar links simple relative file references found in assistant text. The native multi-file changes editor uses VS Code's `vscode.changes` command and falls back to a per-file diff if that command is unavailable.
- The mirror is not an operating system sandbox. DSH shell tools can access paths outside it if permitted; only edits detected inside the mirror enter the IDE review queue.
- Session records are retained locally for up to 100 entries. The DSH runtime owns live conversation state; the sidebar timeline for new chats includes persisted tool, approval, and subagent output, but older text-only saved chats cannot backfill never-saved tool data.
- ACP resume restores agent state. Reloaded chats replay the saved sidebar timeline when present; backend-only history may still differ from what was never persisted.
- The mirror intentionally excludes secret-like files. Binary files can be present in the mirror, but are not tracked as text review changes; files over 2 MiB are skipped during scans.
- Review is line based. Hunk calculation uses an in-memory LCS table and is bounded by the mirror's scan/file limits.
- A moved file that is also edited is reviewed as a delete and a create; only unambiguous content-preserving moves are inferred as renames.
- Only the first workspace folder is used. Remote workspaces and non-file workspace schemes are unsupported.
- The extension targets the VS Code API and runs in VS Code or Cursor. Automated build and smoke tests cover the ACP handshake; end-to-end provider sign-in, attachments, and sidebar flows still require user verification in a live editor session.
- ChatGPT and Claude browser sign-in depends on their installed official CLIs. An interactive browser login and a paid-model request still need the user to complete sign-in; the build tests do not consume a subscription turn. Codex and Claude CLI replies appear when their structured message event completes. Cursor's CLI exposes one active browser login to this extension.
- The VSIX includes the pinned DSH runtime and its production dependencies. It is currently large (about 155 MB); keep that in mind for local installation and distribution.

## License

MIT. See the LICENSE file in this project.

Google Material Symbols Rounded is bundled under the Apache License 2.0 license; see `media/MATERIAL_SYMBOLS_LICENSE.txt`.

## Custom tool calls

The **Custom Tool Calls** tab (extension icon in the top bar) lets you upload TypeScript "toolpacks" that give the agent extra tools. A toolpack is one `.ts` file that `export default`s:

```ts
export default {
  name: 'mypack',                 // lowercase id; agents see tools as mypack_<tool>
  description: 'What this pack does',
  tools: [
    { name: 'hello', description: 'Say hello', inputSchema: { type: 'object', properties: { who: { type: 'string' } } },
      run: (args, ctx) => `hello ${args.who}` },   // return a string or any JSON value
  ],
  setup(ctx) { ctx.status('ready'); },  // optional: open servers, show a status line in the tab
  teardown() {},                        // optional
};
```

Packs are compiled with esbuild and run in their own Node child process (60s per call, output capped). They are arbitrary code, so only upload scripts you trust. New or changed packs appear in chats started afterwards.

## Questions

Agents can call `ask_questions` to show single-choice questions in the chat. Every question also offers an "Other…" text answer, and the user can skip.
