# Claude's permission modes: Manual, Edit automatically, Auto

Amends `2026-10-27-agentduo-channel-design.md` and `2026-10-28-agentduo-vscode-design.md`. Claude Code switches its
permission mode with Shift+Tab and a mode menu. The chat had `/edits ask|auto`, which only switched between asking
and `acceptEdits`. It now offers three of Claude Code's modes, by Claude Code's names. Plan is left out: the pipeline's
implementer has to edit.

## The modes

| `/mode` | Flag | Claude Code's name | What it does |
|---|---|---|---|
| `manual` | none, or `--permission-mode default` | Manual | Claude asks for approval before each edit |
| `acceptEdits` | `--permission-mode acceptEdits` | Edit automatically | Claude edits files without asking |
| `auto` | `--permission-mode auto` | Auto | Claude approves actions that pass a safety check and pauses for anything risky |

- The mode is the implementer's: `permissionMode(cfg)` reads the last `--permission-mode` of `claude.args` plus
  `claude.role_args.implementer`. None, `default` and `manual` read as `manual`. Any other mode (`plan`,
  `bypassPermissions`, `dontAsk`) is shown as the flag names it, and is left alone until another mode is chosen.
- `settings.mode(mode)` edits `claude.role_args.implementer` only, and is idempotent. Manual drops the flag, or writes
  `default` when `claude.args` sets a mode for every call. It writes `default` rather than `manual` because older Claude
  Code versions know only that name. Claude Code 2.1.311 takes both.
- Claude in the chat gets the same flag (`implementerPermissionArgs`), so a mode means the same in both places. The
  plan critic is not affected. Codex has no such modes, because `codex exec` cannot ask. `/codex permissions` is unchanged.

## `/edits` is gone

`/edits auto` meant `acceptEdits`. Claude Code's Auto is broader: it also approves commands that pass its safety check.
Keeping `/edits auto` under the new meaning would silently widen what an old command allows, so `/edits` is now an
unknown command, and `/mode` takes Claude Code's flag values. `duo --accept-edits` keeps its meaning (`acceptEdits`).

## Auto in `claude -p`

Verified on 2026-10-30 with Claude Code 2.1.311, using agentduo's own flags (stream-json, host mode with
`--permission-prompt-tool stdio`):

- `--permission-mode auto` runs, and the `init` event says `permissionMode: "auto"`.
- Actions the user asked for, which the safety check passed, ran with no `control_request`. These were writing a file
  inside and outside the workspace, `ls`, `git push --force` with no remote, and `sudo rm -rf` on a missing path.
- No block was provoked, because the check blocks what the user did not ask for. A blocked action can reach agentduo
  in two ways, and both are already handled:
  - as a denial (`tool_result` error, `permission_denials`), shown as a denied activity;
  - as a `can_use_tool` request, which is the permission prompt.
- Auto may depend on the account or the model. agentduo does not check: Claude Code's own error, or its `init` event,
  says so.

## Terminal chat

- Shift+Tab cycles Manual → Edit automatically → Auto → Manual, as Claude Code's does without Plan. From any other
  mode, it goes to Manual. The hint line shows `mode: <name> (Shift+Tab)`.
- `/mode` alone says the mode and what it does. `/mode <mode>` and `/settings mode <mode>` change it for this chat,
  or for good with `--save`.

## VS Code

- The composer's mode chip shows the mode's icon and name. Clicking it opens Claude Code's mode menu: "Modes" with
  "⇧+Tab to switch", then the three modes as radio items, each with its icon (`person`, `code`, `zap`; no codicon has
  Claude Code's hand), its name, what it does, and ✓ on the one in use. A pick applies to this chat, and every tab
  follows it.
- Shift+Tab in the message box, or in the open menu, cycles the mode, as Claude Code's does. In the message box that
  key therefore no longer moves the focus back. The user chose this over keeping the key for focus; Tab still moves
  forward.
- Settings has a Mode picker with the three modes. A mode from the configuration shows as named.
- Protocol 7 changes these names:
  - the `cycleMode` request and webview message replace `toggleEdits`;
  - the `mode` update replaces `edits`;
  - `InitializeResult.mode` and `SettingsView.claude.mode` replace their `edits` fields;
  - the setting target `mode` takes the three values.

## Tests

- `settings.test.ts`: the three modes, idempotence, a mode in `claude.args`, `default`/`manual`/`plan` read back, and
  the cycle.
- `commands.test.ts`: `/mode`, `/settings mode`, the completions, and `/edits` unknown.
- `chat.test.ts`: `/mode` and Shift+Tab for the implementer and for Claude in the chat. `ink.test.tsx`: the hint line.
- `vscode-protocol.test.ts`: protocol 7 and the setting values. `vscode-worker.test.ts`: every tab follows a cycled
  or picked mode. `vscode-session.test.ts`: `cycleMode` waits for initialize.
