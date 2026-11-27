<p align="center">
  <img src="docs/assets/run2skill-hero.png" alt="Run2Skill — Teach once. Reuse the skill." width="1000" />
</p>

<p align="center"><strong>Turn today's lessons into tomorrow's skills.</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.7.1-247C78" alt="version 1.7.1" />
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.2.2--rc.1-153B3C" alt="Supports any DSH from 0.2.2-rc.1 upwards (alpha/rc included)" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-EAB45C" alt="MIT license" /></a>
</p>

> **This is the duma520 fork (`@duma520/dsh-run2skill` v1.7.1).**
>
> Upstream: [qkycir-123/dsh-run2skill](https://github.com/qkycir-123/dsh-run2skill) v1.0.0.
>
> The fork adds four things on top of the upstream rename: **① the `peerDependencies` allow-list became a `>=0.2.2-rc.1` floor with no upper bound** (a future DSH upgrade, alpha or rc included, is no longer rejected by the plugin gate); **② four observability and rollback capabilities** (an own JSONL log, a runtime generation self-check, skill-usage recall telemetry, publication history snapshots); **③ a left sidebar entry** and much plainer wording for pending items; **④ three UI fixes in 1.4.0** — the panel scrolls, auto-skipped attempts fold into one row, and advanced recall is explained. The package is renamed to `@duma520/dsh-run2skill` so it can replace the original on the same machine.
>
> - Upstream 1.0.0 is rejected by the DSH 0.2.3-alpha.2 plugin gate ("incompatible … requires 0.2.2-rc.1 \|\| 0.2.2-rc.3").
> - **The 1.2.0 capabilities borrow design ideas only; the code is all original and adds no new `@deepseek-ai/*` dependency.**
> - 1.4.1 replaced the maintainer machine paths left in the docs with neutral example paths, and taught the publish gate to detect any absolute drive path. 1.4.2 cleared all 23 known dev-dependency advisories (`undici`, `vite`, `fast-uri`, `ansi-regex`, `source-map-js`, `katex` and friends) with zero change to the plugin runtime code. 1.4.3 fixes two real defects: **the "Skill distillery" panel opened from the left sidebar showed six empty sections**, because the sidebar path renders the page directly instead of going through the host `inject`, so it never received the session/workspace subscriptions and the scope degraded to user-only, which the backend rejects as a scope conflict; the panel now subscribes on its own and remembers the last genuinely selected session. Second, the "agent scope unavailable" health code kept firing with no explanation because the `catch` was empty; the underlying error is now written to the log (`plugin.scope_unavailable`) instead of being swallowed.
. 1.5.0 attacks the root cause of **why it never learned a single Skill**, and adds a button that clears the board at once. Three real defects: **an answer that mixes `reasoning` and `tool-call` blocks made the whole Turn observation incomplete** — and that mixed shape is the normal shape of a model answer, so 245 of 265 historical Turns died on this one rule; an incomplete observation must drop its evidence by contract, so the detector received none and rejected every model answer as unbound, which is exactly the "stuck at semantic detection" symptom. **The route-backfill branch could never fire** — a flag was set to "bound" on the very first scan of a Session, when the route was still empty, so "read further back in the log to recover the route" never ran; 11 of 20 Turns had no `request/header` inside the Turn window and relied entirely on inheritance, so losing it failed the whole batch as `ROUTE_UNAVAILABLE` (419 historical batches). **Turns carrying images are no longer dropped wholesale** — if a Turn has at least one text block, only the text is used as evidence (image-only Turns still fail closed rather than guessing). The pending list also gains **dismiss all**: one click clears every item whose only option was "dismiss", items offering "retry" are left untouched and stay listed for a separate decision, the button shows for any count, and a confirmation states that nothing is deleted.
. 1.6.0 closes the "no route means dead on arrival" path: the settings page gains a **which model should semantic detection use** section where you can pin the provider / model used for detection and add one fallback. `request/header` is the only event that proves which route a Turn actually used, and DSH does not log it on every Turn, so those Turns have no observable route at all and used to be failed permanently and never retried. They now run on the model you pick here; a Turn that does carry usable route information still wins over it. The catalog is read live from the providers wired up on this machine, picking a provider clears the model (so no cross-provider pair can be stored), and hosts without a catalog fall back to free text. Batches produced through a fallback carry a `fallback` marker so you can tell later that they were not run on the Session’s own model. Leaving both blank keeps the 1.5.0 behaviour exactly.
1.6.2 fixes two wiring mistakes that made shipped features unreachable. (1) The model catalog never loaded: `model-catalog/list` and the `recall-telemetry/list` used by "skill usage" were implemented but never added to the client endpoint allow-list, so every call threw "unknown endpoint" and the settings page fell back to free-text provider/model boxes forever. (2) The panel could not scroll: the sidebar container has no fixed height, so `height:100%` degraded to `auto` and the page neither filled nor scrolled. It now declares `max-height` plus explicit scrollbar styling, because some host themes set the scrollbar width to 0 and a scrollable area stays invisible. The model field is also always a dropdown whenever the catalog is readable; it only falls back to free text for a provider that listed no models at all.
1.7.0 replaces the "primary + fallback" pair with **a user-ordered candidate list**, and finally fixes panel scrolling. (1) You are no longer limited to two slots, and no longer forced to pick a provider before a model: the section is now an ordered list of up to 8 provider+model rows that you reorder with up/down/delete. Detection walks the list top-down and the first usable route wins. It is stored in the plugin's own storage domain instead of the host config-form chain — so "the value bounces back to unset" is gone at the root, and a failed save now shows the host's own message (`not saved: <reason>`) instead of silently reverting. (2) Scrolling: the plugin used to stack its own `height:100%` + `max-height:calc(100vh - 88px)` + `overflow-y:auto` container on top of the host containers that already scroll (`.pageBody` on the plugin detail page, `.mainPanel` in the sidebar). The inner container was taller than the space it had, so the outer one clipped it without ever scrolling. 1.4.0 and 1.6.2 both tried to fix this by adding declarations to that inner layer — the wrong direction. v1.7.0 removed it entirely and left scrolling to the host, which fixed the detail page but **left the sidebar unable to scroll at all** (see 1.7.1). Layout rules for `[data-run2skill-detection-route]` were also added; their absence was why the two selects were squeezed onto one line.

. 1.6.1 fixes a sentence that was actively misleading. Cases like "a brand new Session that has not picked a workspace yet" or "the Session directory is not inside any registered project" are **perfectly normal**, but the backend answered them with the same `conflict` and the UI reported it as "cannot read the learning status, probably a scope mismatch", which reads like a broken plugin. Those now come back as `UNSCOPED` and say plainly that the Session is not in the current project (possibly brand new without a workspace, or its directory is outside the project). The real error copy no longer offers "scope mismatch" as the default explanation either. The other direction is untouched: a Session that really is bound to a project, asked through the user-only scope, is still refused — that side is the actual boundary crossing and must not be relaxed along with this.
> - **A full process restart of the DSH desktop app is required** (closing the window or reloading does not count). See [软件升级迭代记录.md](软件升级迭代记录.md) for the full change log.
> - Not published to npm; used locally via `link:`.

<p align="center">
  <a href="#install">Install</a> · <a href="#see-the-complete-flow">Full flow</a> · <a href="docs/compatibility.md">Compatibility</a> · <a href="CHANGELOG.md">Changelog</a> · <a href="README.md">中文</a>
</p>

Run2Skill turns the corrections, constraints, and workflows you teach an Agent in DeepSeek Harness (DSH) into reusable Skills. Review a draft, request changes, and approve it to save.

## See the complete flow

![Run2Skill: open the plugin, review a draft, and save](docs/assets/run2skill-demo.gif)

*Main-branch interface · sample draft walkthrough*

1. Open **Sidebar → Plugins → Run2Skill**.
2. Review the draft’s purpose, scope, source conversation, and full content.
3. Request changes or **approve and save**.
4. Check **Recent activity**. The Skill is ready for a related task.

<details>
<summary>View key screens</summary>

![Draft inbox](docs/assets/01-proposal-inbox.png)

![Draft sources and content](docs/assets/02-review-details.png)

![Saved Skill and recent activity](docs/assets/03-saved-activity.png)

</details>

## Install

### On this machine (DSH 0.2.3-alpha.2 desktop) — read this section

This fork is **not distributed via npm**. It is mounted from a local directory with `link:`. Every step below was verified on 2026-11-25.

1. **Prepare the plugin directory**: the examples below use `D:\dsh-plugins\dsh-run2skill`; anywhere works, just remember where you put it.

   > **A fresh clone from GitHub has no `lib\`** — the repo ships source only and build output is in `.gitignore`. Build it once first:
   > ```bash
   > pnpm install
   > pnpm run build
   > ```
   > That produces 8 files in `lib\`: `client.js`, `index.js`, `index.d.ts`, `typert.host.js`, `typert.host.d.ts`, `typert.remote-client.js`, `typert.remote-client.d.ts`, `contract-*.js`.
   > Copying `version/20261125-v4/lib/` from the local backup directory works too — byte-identical.

   Steps 2–6 keep using that example path; replace it with your own if you installed elsewhere.
2. **Register the dependency** in `%USERPROFILE%\.dsh\profiles\desktop\package.json`:
   ```json
   "@duma520/dsh-run2skill": "link:D:/dsh-plugins/dsh-run2skill"
   ```
3. **Add** `"@duma520/dsh-run2skill"` to the `dsh.profile.bundles` array. Without it the host never assembles the Host/Client halves.
4. **Create the directory symlink** under `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@duma520\`:
   ```cmd
   mklink /D dsh-run2skill D:\dsh-plugins\dsh-run2skill
   ```
   If permission is denied, use `python -c "import os; os.symlink(r'D:\dsh-plugins\dsh-run2skill','dsh-run2skill',target_is_directory=True)"`.
5. **Edit `cordis.patch.yml`**: in the `- id: run2skill` block set `name` to `"@duma520/dsh-run2skill"` — **the quotes are mandatory**, because a bare scalar starting with `@` is invalid YAML.
6. **Quit the DSH desktop app completely and restart it.** The bundle manifest and client modules are assembled only at boot; hot reload does not apply them.

After restart, the **Plugins** page should list `dsh-run2skill` at version `1.7.1` with no red incompatibility banner.

### Why the `dsh plugin` CLI cannot be used here

`dsh plugin --profile desktop ...` fails with:

```
error: profile "desktop" is managed exclusively by the Electron application
```

The desktop profile is owned exclusively by the DSH Electron app. Configure it manually as above, or use the GUI plugin market's "install bundle" action.

### Upstream install instructions (Web / Mac / older Windows)

Kept for reference on other hosts. Note that `dsh-run2skill@1.0.0` is rejected by the DSH 0.2.3-alpha.2 gate.

**Web (DSH 0.2.2-rc.1)**: install Node.js `>=24.9.0` and make sure `pnpm` and `dsh` are available. Install `1.0.0`:

```bash
dsh plugin --profile web add dsh-run2skill@1.0.0
```

**Mac Desktop (DSH 0.2.2-rc.3).** On first launch, use **Manage dsh Command… → Install** in the app menu. Quit DSH completely and run this in a new terminal.

```bash
dsh plugin --profile desktop add dsh-run2skill@1.0.0
```

**Windows Desktop (DSH 0.2.0-rc.2)**: set up the command through **Manage dsh Command…**. Complete the first launch, exit the app, and install `0.5.0-alpha.4`:

```bash
dsh plugin --profile desktop add dsh-run2skill@0.5.0-alpha.4
```

Restart DSH after installation. Run2Skill uses the model selected in the current session. See [Compatibility](docs/compatibility.md) for version details.

## Use

Work with your Agent as usual and describe the practices you want to reuse:

- **Correction**: “Write a failing test before changing the implementation.”
- **Constraint**: “Use Chinese for GitHub copy in this project.”
- **Workflow**: “Check the upstream version, then run compatibility checks.”
- **Save request**: “Save this workflow as a Skill for reuse.”

Run2Skill organizes lessons when the session is idle or you request a save. DSH notifies you when a draft needs review. You can also open the plugin and choose **Organize this session now**.

Each draft includes its source conversation. Approve it, request changes, or discard it. Save Skills for the **current project** or **all projects**, using DSH’s default Skill directories.

## Settings

- **Learning status**: see the current session’s progress. Drafts are generated automatically while the plugin is enabled. You can also request immediate processing.
- **Recent activity**: see Skills created or updated in the last seven days.
- **Clear all caches**: preview and clear pending drafts and intermediate data, keeping saved Skills, conversations, and DSH settings.

Run2Skill manages drafts locally and sends selected, redacted conversation excerpts to the current model. See [Storage and upgrades](docs/storage-and-upgrades.md).

## Sidebar entry (since 1.3.0)

Once enabled, the left navigation gains a **Skill distillery** row (below **Turn notifications**). Clicking it opens this plugin's full-page panel, identical to the configuration area on the plugin detail page.

| Where | What it looks like | What it does |
| --- | --- | --- |
| Left navigation | A row labelled **Skill distillery** with a ✨ icon | Switches to the full-page panel |
| Plugin detail page | An **Open Skill distillery** button | Same |
| Main panel | Full-page UI | Run state, pending items, recent activity, skill usage, settings |

If the row does not appear, the host is older and has no `layout` service; sidebar registration is skipped on purpose (the settings page and detail page still work). Use **Plugins → dsh-run2skill → Configure** instead.

## What the pending items mean (copy rewritten in 1.3.0, auto-skips folded away in 1.4.0)

Every row under **Needs attention** is **one experience that could not be distilled automatically**. It is not a crash, and it does not touch existing Skills or session logs. Two cases cover almost everything:

| Title on screen | What actually happened | What to do |
| --- | --- | --- |
| This experience is left alone for now | You kept talking after that stretch, so distilling from the old tail could be inaccurate and the plugin stopped | Nothing; restate the practice later if you still want it |
| Needs your confirmation whether it was already saved | The Skill list from before that conversation is missing, so the plugin cannot tell whether the same Skill already exists | Click **Do not process this experience**, or restate it |

Each card also carries a **one-line progress summary** (e.g. `Stopped at "duplicate-save check"; later steps never started.`) and a collapsible **technical details** block with the per-stage state and the model used.

Buttons:

- **Do not process this experience**: removes the row from the list only. Existing Skills, session logs and plugin logs are **not deleted**.
- **Retry the lookup once**: only shown when the catalog scan failed temporarily.
- **Use the existing Skill, skip the draft**: only shown when a duplicate is suspected.

## Should you turn on advanced recall? (explained properly in 1.4.0)

**Off by default, and off is right for almost everyone.**

| | Off (default, recommended) | On |
| --- | --- | --- |
| How it matches | Reads each Skill summary page by page | Computes semantic vectors first, then verifies body coverage |
| External service | None, everything stays local | **Your own embedding service** (endpoint, model, credential env var name) |
| Cost | No extra cost | Every lookup calls your service and bills on your account |
| Suited for | Dozens of Skills | Hundreds of Skills where page-by-page gets slow |
| When it cannot connect | — | Falls back to standard recall silently; nothing fails |

The test is simple: **if you have never stood up an embedding service, leave it off.** Turning it on without one just makes every lookup wait for a connection that will fail, then fall back anyway.

## What 1.2.0 adds

Four capabilities about diagnosing, rolling back, and telling versions apart. None of them changes the upstream workflow.

### 1. A file log the plugin owns

- Path: `~/.dsh/dsh-run2skill/logs/run2skill.log` (on Windows, `%USERPROFILE%\.dsh\dsh-run2skill\logs\run2skill.log`).
- Format: one JSON object per line with `ts` / `level` / `name` / `message` / `args`. File mode `0600`.
- Rotation: once a file exceeds **5 MB** it is renamed to `run2skill.log.1` (one previous file, no unbounded growth).
- Redaction: every field is redacted before writing. Password-style key/value assignments, authentication headers, bearer tokens and credentials embedded in URLs become `[REDACTED]`; structured fields (numbers, booleans, arrays) are kept as-is.
- Safety valve: **a log write failure is never thrown** — logging must not break the agent loop.
- What gets logged: plugin apply/ready/dispose, ingress health codes, stale-generation warnings, failed generation probes.

### 2. Runtime generation self-check

At module import the plugin fingerprints the code it is actually running (12-char SHA-1). Each settings-page read re-reads the same file from disk and compares:

- Matching: nothing is shown.
- Disk already replaced (you updated but did not restart): a red banner appears at the top of the settings page stating that the running plugin is older than what sits on disk and that DSH must be restarted.
- Either side unreadable: **no warning** (a false alarm is worse than a missed one).

> Why: DSH plugin UI changes do not appear on hot reload, so previously the only signal was "I changed it and nothing happened". Now it says so directly. Probes are throttled to once per 60 seconds.

### 3. Skill usage (recall telemetry)

A new collapsible "Skill usage" section lists, for the **last 30 days**, how often each Skill's body was read out and handed to the model:

- Source: computed on read from the v2 domain's `experience_intents` recall candidates. **No derived index is persisted** — the same fact is not stored twice and cannot drift.
- Counting: a candidate counts only when `bodyDigest` exists (the body really was read); retries inside one recall do not double-count.
- Scope: `this project only` / `all projects` / `unknown origin`. Project-level records require a resolvable workspace, otherwise they are dropped — **numbers from different workspaces are never merged into one misleading total**.
- Honest limit (also stated in the UI): **this only means the body was handed to the model, never that the model used it.**
- Versus "Recent activity": that one is the **write side** (which Skills were created/updated), this one is the **read side** (which Skills were pulled out). They stay separate.

### 4. Publication history snapshots

- Every **merge update** of an existing Skill archives the replaced body to `skills/.run2skill-history/<skill-name>/<content-hash>.md`.
- At most **3 historical versions** per Skill; older ones are pruned by mtime.
- Named by content hash, so a crash retry copies the same bytes to the same name — idempotent by construction.
- First-time creation keeps no history (there is nothing to replace).
- A failed archive **never rolls back** an already-verified publication; the history copy is best-effort.
- To restore, copy `history/<hash>.md` back over `SKILL.md` manually (no automatic rollback button, to avoid clobbering a version you want to keep).

## Update and uninstall

Follow the installation instructions for your host version, then restart DSH.

**Uninstall / roll back this fork** (manual, because the desktop profile cannot use the CLI):

1. Remove `"@duma520/dsh-run2skill"` from `dependencies` and from `dsh.profile.bundles` in `%USERPROFILE%\.dsh\profiles\desktop\package.json`.
2. Remove the `- id: run2skill` block from `cordis.patch.yml` (or comment it out).
3. Delete the symlink `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@duma520\dsh-run2skill`.
4. Restart the DSH desktop app.

**Roll back to the upstream plugin**: rename `node_modules\dsh-run2skill.disabled-by-duma520` back to `node_modules\dsh-run2skill`, then restore `"dsh-run2skill": "1.0.0"` in `dependencies`, `"dsh-run2skill"` in `bundles`, and `name: "dsh-run2skill"` in `cordis.patch.yml`. The pre-change files are backed up in `%USERPROFILE%\.dsh\profiles\desktop\.backup-run2skill\`.

Upstream generic uninstall command (other hosts):

```bash
dsh plugin --profile desktop remove dsh-run2skill
```

For Web, replace `desktop` with `web`. Saved Skills and plugin data remain after uninstalling. To clear caches, use the plugin’s cleanup action before uninstalling.

## Version history

| Version | Date | Change |
| --- | --- | --- |
| 1.0.0 | 2026-11-14 | First stable upstream release |
| 1.1.0 | 2026-11-25 | Forked as `@duma520/dsh-run2skill`; widened peer allow-list for DSH 0.2.3-alpha.2 |
| 1.2.0 | 2026-11-25 | Added four capabilities: own file log, runtime generation self-check, skill recall telemetry, publication history snapshots |
| 1.2.1 | 2026-11-25 | Fix: one truncated Session log made recovery retry forever; also log health codes and recovery failure causes, and cache the historical Session hydration |
| 1.2.2 | 2026-11-25 | Fix: the event allow-list was missing 24 DSH 0.2.3 types, so recovery stayed DEGRADED; unprojectable Sessions are now skipped instead of aborting the batch |
| 1.2.3 | 2026-11-26 | Fix CI: log rotation only applies to regular files (cross-platform), boundary spec neutralises event literals, candidate verification tracks the fork identity |
| 1.3.0 | 2026-11-26 | Adds a left sidebar "Skill distillery" entry; rewrites the pending-item copy into plain language instead of the old catch-all sentence |
| 1.3.1 | 2026-11-26 | Compatibility declaration changed to a `>=0.2.2-rc.1` floor: no upper bound any more, so future DSH upgrades (alpha/rc included) are not blocked by the plugin gate, while hosts older than 0.2.2-rc.1 are still rejected |
| 1.4.0 | 2026-11-26 | Three UI fixes: the panel now scrolls vertically (overflow used to be clipped and unreachable); auto-skipped attempts fold into one summary row with a single bulk acknowledge instead of one card and one fake choice each; advanced recall is now explained (what it does, whether to enable it, what service it needs) |
| 1.4.1 | 2026-11-26 | Docs redaction and a stronger gate: maintainer machine paths left in README/INSTALL/changelog are replaced with neutral example paths, and `probes/candidate/verify.mjs` now detects any absolute drive path and scans git-tracked files, not just the npm tarball |
| 1.4.2 | 2026-11-26 | Dependency hygiene: all 23 known dev-dependency advisories cleared (upgraded `undici`/`vite`/`fast-uri`/`ansi-regex`/`source-map-js`/`vitest`/`jsdom` and pinned `katex` to 0.18.10 via `overrides` in `pnpm-workspace.yaml`); zero change to the plugin runtime code |
| 1.4.3 | 2026-11-26 | Two real defects fixed: the "Skill distillery" panel opened from the left sidebar showed six empty sections (the sidebar path never got the session/workspace subscriptions, so the scope degraded to user-only and the backend rejected it with a scope conflict; the panel now subscribes itself and remembers the last selected session); and the "agent scope unavailable" health code fired with its cause silently swallowed by an empty `catch`, which now writes the reason to the log |
| 1.5.0 | 2026-11-27 | Fixes three root causes of "it never learned a single Skill": an answer mixing reasoning/tool-call blocks made the whole observation incomplete (245 of 265 Turns died there, and the evidence is dropped with it, so detection always failed); the route-backfill branch never fired because its flag bound too early (Turns without request/header failed the batch as ROUTE_UNAVAILABLE); image-carrying Turns now use their text blocks as evidence (image-only still fails closed). Also adds a one-click "dismiss all" for single-option pending items, leaving retryable ones untouched |
| 1.6.0 | 2026-11-27 | The settings page gains "which model should semantic detection use": read the models wired up on this machine, pin a detection model and a fallback, so Turns that never logged their route no longer fail permanently; a half-filled pair is not a configuration, an observed route still wins, and fallback batches are marked |
| 1.6.1 | 2026-11-27 | A new Session that has not picked a workspace, or one whose directory is outside every registered project, is now reported as `UNSCOPED` instead of a scope conflict; the real error copy no longer blames a scope mismatch, and asking a project-bound Session through the user-only scope is still refused |
| 1.6.2 | 2026-11-27 | Two wiring fixes: `model-catalog/list` and `recall-telemetry/list` were missing from the endpoint allow-list, so the catalog never loaded and the settings page could only take typed ids; the sidebar container has no fixed height, so `height:100%` degraded to `auto` and the panel never scrolled — now uses `max-height` with explicit scrollbar styling. The model field is always a dropdown when the catalog is readable |
| 1.7.0 | 2026-11-28 | The "which model does semantic detection use" section becomes a **user-ordered candidate list**: up to 8 provider+model rows, reorderable with up/down/delete, tried top-down until one works — no longer just "primary + fallback", and no longer requiring a provider before a model. Stored in the plugin's own storage domain rather than the host config-form chain, so values no longer bounce back and a failed save shows the host's actual message. Panel scrolling is genuinely fixed: the plugin's own `max-height:calc(100vh-88px)` self-scrolling wrapper used to override the host's scroll container; scrolling is now left to the host |
| 1.7.1 | 2026-11-28 | Corrects the 1.7.0 scrolling conclusion: **the same page mounts in two places whose parents behave differently**. The plugin detail page's `.pageBody` scrolls by itself; the sidebar's `.mainPanel` does not (it only has `flex:1; min-height:0`, and the `.centreCol` above it is `overflow:hidden`, so overflow is simply clipped). "Leave scrolling to the host" therefore held only for the detail page. `.page` now declares `height:100% + overflow-y:auto` itself: in the sidebar the parent has a definite height, so it scrolls on its own; on the detail page the wrapper's height is auto, so `height:100%` resolves to content height, no overflow occurs, and the host still does the scrolling — no double scrollbar. Thin scrollbar styling is restored too, since some themes set global scrollbar width to 0 ("scrollable but invisible") |

See [软件升级迭代记录.md](软件升级迭代记录.md) for the full change log, verification and rollback steps.

## Help and contribute

- This fork: [duma520/dsh-run2skill/issues](https://github.com/duma520/dsh-run2skill/issues)
- Upstream: [qkycir-123/dsh-run2skill/issues](https://github.com/qkycir-123/dsh-run2skill/issues)
- [Compatibility](docs/compatibility.md) · [Changelog](CHANGELOG.md) · [Fork change log](软件升级迭代记录.md)
- [Contributing](CONTRIBUTING.md) · [Maintainer probes](probes/README.md)
- [Product requirements](docs/product/prd.md) · [Architecture and design](docs/architecture/baseline.md)

[MIT License](LICENSE) · [Third-party licenses](THIRD_PARTY_NOTICES.md)
