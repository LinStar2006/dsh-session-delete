**English** | [简体中文](README.zh-CN.md)

# dsh-session-delete

A plugin for DeepSeek Harness (DSH) that adds a real **Delete conversation** action to the session menu.

DSH's built-in session menu only offers **Archive** — archiving merely hides a session from the list, while its log and workspace record are kept. This plugin adds an irreversible permanent delete and fills in the deletion pipeline the host does not provide.

---

## Features

- Adds **Delete conversation** (trash icon) at the end of the session row's "⋯" menu, right after "Copy Session ID".
- Clicking it opens a confirmation dialog; confirming deletes the session permanently and irreversibly.
- What gets deleted:
  1. Stops any activity still running for the session (turn / subagents / background jobs), waiting up to 8 seconds;
  2. Removes it from the session list of every workspace that contains it (`detachSession`);
  3. Clears it from `archivedSessionIds` and `pinnedSessionIds`;
  4. Optionally deletes the working folder that [dsh-conversation-folders](https://github.com/LinStar2006/dsh-conversation-folders) created for the session, and removes its index entry;
  5. Deletes the on-disk session log directory `<DSH_HOME>/sessions/<project>/<sessionId>/`;
  6. Deletes the projection cache `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`;
  7. Emits `api-session/removed` so the client removes the row immediately.

### Compared with "Archive"

| | Archive | Delete conversation |
| --- | --- | --- |
| Session log | Kept | Deleted |
| Workspace membership | Kept (slot preserved) | Removed |
| Recoverable | Yes (unarchive) | No |
| When to use | Temporarily put a session away | Session is no longer needed; free disk space |

### Idempotency and stale rows

Deletion is idempotent: if a session has already been deleted once (no log directory and no projection cache), deleting it again does not fail — it still runs the cleanup steps and emits the removal event, which repairs rows that may linger in the client list.

The `alreadyDeleted` field in the response tells whether a call was such a repeat cleanup.

### Deleting the standalone working folder

When [dsh-conversation-folders](https://github.com/LinStar2006/dsh-conversation-folders) is installed, every conversation gets its own folder at `<workspace>/conversations/<folder>`. When the confirmation dialog opens, this plugin first probes that folder via `POST /session-delete/inspect`:

- Found: the dialog shows a checked-by-default "also delete this conversation's standalone working folder" option together with the folder path;
- Not found: the option is not shown and behavior is identical to not having the plugin installed.

Safety: only a subdirectory that is registered in the index **and** located inside the index directory can be removed. Even a tampered index cannot make it delete anything outside.

---

## Installation

### Option 1: install from the DSH plugin page (recommended)

1. Open the **Plugins** settings page in DSH;
2. Click **Add plugin** in the top-right corner and paste this repository URL:

   ```text
   https://github.com/LinStar2006/dsh-session-delete
   ```

   The same input also accepts a local directory path (for example `D:\plugins\dsh-session-delete`) or a package name;
3. Click **Install** and wait for it to finish; reload the page (restart DSH if needed) and **Delete conversation** appears in the session menu.

> The installer uses pnpm under the hood — equivalent to `pnpm add github:LinStar2006/dsh-session-delete`. If GitHub is not reachable from your network, `git clone` the repository into a fixed local directory and paste that directory path into the same input instead.

### Option 2: CLI / let the agent install it

Equivalent to option 1 (`target` accepts either a GitHub repository or a local directory):

```text
plugin_manager action=install_bundle target=github:LinStar2006/dsh-session-delete
```

```text
plugin_manager action=install_bundle target=file:<absolute plugin path>
```

### Option 3: manual installation

1. Put the plugin directory at any fixed path (do **not** keep it inside a session working directory — renaming a session changes that path);
2. Add the dependency and the bundle entry to the profile's `package.json`:

   ```jsonc
   {
     "dependencies": {
       "dsh-session-delete": "file:<absolute plugin path>"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "dsh-session-delete"
         ]
       }
     }
   }
   ```

3. Copy the plugin directory to `<profile>/node_modules/dsh-session-delete`;
4. Restart DSH.

The profile directory looks like `<DSH_HOME>/profiles/<profile-name>/`.

### Uninstall

Remove the dependency and the `bundles` entry from the profile's `package.json`, delete `<profile>/node_modules/dsh-session-delete`, then restart DSH.

---

## Usage

1. Find the target conversation in the session list on the left;
2. Open its "⋯" menu and choose **Delete conversation**;
3. The dialog shows the conversation title and everything that will be permanently deleted; if [dsh-conversation-folders](https://github.com/LinStar2006/dsh-conversation-folders) is installed it also offers "also delete this conversation's standalone working folder";
4. Click **Delete permanently**.

The row disappears from the list immediately after deletion — no page reload needed.

---

## How deletion works

DSH does not expose a public "delete session" API, so deletion is composed of these steps:

1. **`sessionPersistence.stat(sessionId)`** — read the session header to obtain its working directory (`cwd`), used to locate the log directory;
2. **Stop activity** — query `workspace/session-activity` for running activity; if any, fire the `workspace/session-stop` parallel hook and poll until the activity ends (up to 8 seconds);
3. **Detach from workspaces** — walk `workspaceRegistry.list()` and call `detachSession(sessionId)` on each workspace that contains the session;
4. **Clear archive / pin** — call `unarchiveSession` and `unpinSession` (both are idempotent for unknown entries);
5. **Optionally clear the standalone folder** — see above;
6. **Delete the log directory** — locate it by DSH's `<DSH_HOME>/sessions/<project>/<sessionId>/` layout and remove it recursively;
7. **Delete the projection cache** — scan projection-related storage directories under `<DSH_HOME>/storages/` and delete the matching file;
8. **Emit the removal event** — `ctx.emit("api-session/removed", sessionId)`.

A failing step is logged and the remaining steps still run; the HTTP response reports every path actually removed in `removedPaths`.

---

## HTTP API

The Host half registers two endpoints under the `/session-delete` prefix, used by the client half (and usable from scripts or other plugins):

### `POST /session-delete/inspect`

Probes whether the session has a standalone working folder that can be deleted alongside it.

```jsonc
// request
{ "sessionId": "session-xxxxxxxx" }

// response
{ "ok": true, "sessionId": "session-xxxxxxxx", "folderPath": "<workspace>/conversations/<folder>" }
```

`folderPath` is `null` when no standalone folder was found.

### `POST /session-delete/delete`

Performs the deletion.

```jsonc
// request
{ "sessionId": "session-xxxxxxxx", "deleteFolder": true }

// response
{
  "ok": true,
  "sessionId": "session-xxxxxxxx",
  "removedPaths": ["..."],
  "folderRemoved": true,
  "alreadyDeleted": false
}
```

On failure it returns `{ "ok": false, "error": "<reason>" }` with HTTP status 400 / 405 / 404 / 500.

---

## Layout

```text
dsh-session-delete/
├── package.json          # package metadata, DSH bundle / client declarations, exports
├── cordis.patch.yml      # Loader patch: inserts the plugin into the profile
├── lib/
│   └── index.js          # Host half: HTTP routes and the deletion pipeline
├── client.js             # Client half: session menu item and confirmation dialog
├── locale/
│   ├── zh.json           # title and description shown in the plugin list (Chinese)
│   └── en.json           # title and description shown in the plugin list (English)
├── icon.svg              # plugin icon
└── README.md
```

- **Host half** (`lib/index.js`) registers the `/session-delete/inspect` and `/session-delete/delete` routes.
- **Client half** (`client.js`) registers the menu item in the `sidebar.workspaces.session.menu.item` slot and the confirmation dialog in `shell.overlay`, and calls the Host routes with a `fetch` URL resolved against the page base path.
- **Display metadata**: `meta.title` / `meta.description` in `locale/<lang>.json` are shown on the **Plugins** settings page by DSH's plugin metadata reader; the icon is served through `exports["./icon"]`.

---

## Compatibility

- Targets DSH `0.2.x` (verified on `0.2.1-rc.5`).
- Uses the `webServer`, `workspaceRegistry` and `sessionPersistence` Host services, plus the `workspace/session-activity` and `workspace/session-stop` event hooks.
- `detachSession()` and the `api-session/removed` broadcast are host-internal capabilities; if a DSH upgrade changes those internals, the plugin may need a matching update.

## Known limitations

- Deletion is irreversible and does not go through a recycle bin.
- If you delete the conversation that is currently open and still held in memory, the in-memory Session object may survive; if it keeps writing, the log file can be recreated. Switch to another conversation first.
- Projection-cache directories are discovered by name convention; if the host changes its storage layout, the matching logic in `removeProjectionCache` has to be updated.

## Development

After changing Host code you must reload the plugin (the Host half does not participate in HMR):

```text
plugin_manager action=remove_bundle target=dsh-session-delete
plugin_manager action=install_bundle target=file:<absolute plugin path>
```

Or, while developing, sync the files into the profile's `node_modules/dsh-session-delete` and restart DSH.

## License

MIT
