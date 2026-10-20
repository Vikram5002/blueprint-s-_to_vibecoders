# VibeCoder for VS Code

Drop a file onto the **VibeCoder** panel and:

1. See which of your project's architecture rules the file breaks, with the exact import lines.
2. Get a reworked version from a model: the forbidden imports removed, the rest of the file kept.
3. Review it in VS Code's side-by-side diff, then **Keep** or **Discard**.
4. Changed your mind? **Undo** in the panel (or Ctrl+Z) puts the original back.

The rules come from your project (a blueprint file, or rules stated in your docs), and every
proposal is checked again before you see it: each violating import is looked for in the new
version, including the same module under another spelling (a `require`, a sibling file).
The model's word is never taken for it.

## How to use

- Drag one or more files from the Explorer onto **VibeCoder > Rework**, or
- right-click a file > **VibeCoder: Rework this file**, or
- the sparkle button in the editor title bar (reworks the open file).

If a file breaks no rule, VibeCoder asks what you want changed instead.

## The whole workspace in VS Code

**VibeCoder: Open Workspace** (the layout button on the VibeCoder panel, or the Command Palette)
opens the full VibeCoder workspace in a VS Code tab - the same one the browser and the desktop
app show. Describe an app and review its plan, edit its pages in the **Page Builder**, use
**Update backend & database** to generate the API and tables a page's form needs, and **Run app**
to see it working. Generated files are written into the folder you have open, so the Explorer
shows them as they appear.

Rule of thumb for blueprint rules: name folders by path (`src/routes must not import src/db`).
A bare word ("routes") only works when VibeCoder's own module grouping happens to use it.

## Server

The extension talks to a VibeCoder server; it has no logic of its own.

| Setting | Default | Meaning |
|---|---|---|
| `vibecoder.serverUrl` | empty | Use this server (for example a hosted one). Empty = start one for the workspace. |
| `vibecoder.cliCommand` | `npx --yes vibe-blueprint` | How to start the local server. For a copy of the repository: `node <repo>/dist/cli.js`. |
| `vibecoder.accessCode` | empty | Access code of a hosted server. |

The model is whichever one the server is set to use (choose it in the VibeCoder app, or with
`VIBE_LLM_PROVIDER` and an API key). Output from the server is in **Output > VibeCoder**.
