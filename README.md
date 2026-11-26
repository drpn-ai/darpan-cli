# darpan-cli

One `darpan` command, designed for distribution via Homebrew. A POSIX-shell launcher bootstraps and runs a local Darpan development stack; the data and action commands (sign in, runs, audit findings, fresh queries, scripts, MCP) run in Node from `agent/`. It generalizes the workspace `dev-stack.sh` into a portable command that clones the repos, loads setup data, and starts the backend + UI with the JDK 21 runtime flags Moqui 4 / Spark 4 require.

## Status

Released through Homebrew (`brew tap drpn-ai/tap && brew trust --formula drpn-ai/tap/darpan && brew install darpan`). The source is split across two repos:

- `drpn-ai/darpan-cli` — the CLI source, release workflow, and packaging (everything here except `tap/`).
- `drpn-ai/homebrew-tap` — the contents of `tap/` (`Formula/darpan.rb` + tap README).

```
darpan-cli/                 -> drpn-ai/darpan-cli
  bin/darpan                launcher: stack commands in sh, everything else execs agent/main.ts
  agent/                    the Node CLI (Node 22.18+, no build step, no dependency)
  scripts/package.sh        build a release tarball + sha256
  .github/workflows/release.yml   tag-triggered release
  LICENSE  .gitignore  README.md
  tap/                      -> drpn-ai/homebrew-tap
    Formula/darpan.rb       Homebrew formula
    README.md
```

## Try it locally (no install)

```bash
# from the workspace root
./darpan-cli/bin/darpan doctor
./darpan-cli/bin/darpan help
./darpan-cli/bin/darpan bootstrap --dir /tmp/darpan-try   # set up without launching
./darpan-cli/bin/darpan up --dir ~/darpan                 # set up and run
```

## Commands

| Command | What it does |
| --- | --- |
| `darpan up [--dir <path>] [--reload]` | Clone/update all repos, `getRuntime`, `load` (first run), `npm install`, start the stack |
| `darpan start [--dir <path>]` | Start an already-set-up stack |
| `darpan stop` | Stop backend/frontend listeners (ports 8080/5173) |
| `darpan load [--dir <path>]` | Reload setup data via `./gradlew load` (backend must be stopped) |
| `darpan update [--dir <path>]` | `git pull` all repos to their pinned refs |
| `darpan doctor` | Check JDK 21, Node 20+, `git`/`npm`/`lsof`, free ports |
| `darpan version` / `darpan help` | Version / usage |

## Use Darpan from Claude Code

The same `darpan` command reads a tenant's data and starts runs, as you. It needs Node 22.18 or newer on the machine (the formula does not install it: https://nodejs.org, or `brew install node`) and Darpan running somewhere you can sign in.

```bash
brew tap drpn-ai/tap && brew trust --formula drpn-ai/tap/darpan && brew install darpan
darpan login                         # a page opens in your browser: type the code your terminal shows
claude mcp add darpan -- darpan mcp  # every command below becomes a tool in Claude Code
darpan guide                         # the usual path, limits and roles
```

`darpan login` keeps a key for your user in `~/.config/darpan` (override with `DARPAN_CONFIG_DIR`), valid as long as an app sign-in. The key is not tied to a tenant: each call runs in the tenant you chose, and only in tenants you belong to. It reaches only an allowlist of methods: reads, run starters, and saving, running and scheduling tenant scripts (scripts and their deployments); `darpan api` lists them. Pick a tenant with `darpan tenant use <id>`, or pass `--tenant <id>` for one call.

| Command | What it does |
| --- | --- |
| `darpan login` / `logout` / `whoami` | Sign in through the browser, end the session, show who you are, your tenant and role |
| `darpan tenants` / `tenant use <id>` | Your tenants; choose one for later commands (local only) |
| `darpan api` / `call <method> [--yes]` | Every method your role can use, each marked `writes: true` if it changes something; call one (a write only with `--yes`) |
| `darpan systems` / `describe <id>` | Your NetSuite, HotWax OMS and Shopify connections; what one holds and how to query it |
| `darpan runs` | The saved runs you can start |
| `darpan run start <id>` / `run status <id>` / `run wait <id>` | Start a saved run, check it, wait for it |
| `darpan result <id\|file>` | Read a run's result, or only its differences |
| `darpan audits` / `report` | The tenant's audits; an audit's report for one morning, as the audit page shows it |
| `darpan findings list` / `findings show <id>` | Audit findings, filtered and paged; one finding in full, every record field the page shows |
| `darpan findings by-order` / `findings recheck <id>` | Every open finding, one per order, past the report's 50; re-check one finding now (the page's Re-check) |
| `darpan audit settings` / `audit progress` | An audit's statements, checks and schedule; what its checks are doing while it runs |
| `darpan audit extracts --check C --period P [--system S]` | What each system's read wrote for a check on one morning; `--system` returns that file |
| `darpan month export --month YYYY-MM` | A month's open findings as one JSON document |
| `darpan lookup <id> [--all]` | Follow an order id through Shopify, HotWax and NetSuite, with its open findings; order facts by default, customer details with `--all` |
| `darpan query run --connection <id>` | A fresh read-only SuiteQL or GraphQL question to one system (200 rows by default, 2,000 at most) |
| `darpan conclusions show\|save\|code` / `automation sync <id>` | A run's cause tree: read it, replace it (preview first, `--yes` saves), add a cause code; copy a run's sources and filters onto its automation |
| `darpan cause add` / `cause expect` / `cause propose` | Propose a cause for a finding (from the person's own words), mark causes expected, or any other audit change; planned and backtested on the server, nothing changes yet |
| `darpan change list` / `change show <id>` | Proposals; one with its before and after, how many findings move, and values to confirm |
| `darpan change apply <id> --yes --plan <hash> [--confirm …]` / `change reject` / `change revert` | Make a proposal as shown (a config version you can revert), decline it, or propose undoing it |
| `darpan findings lookalikes <id>` / `findings recheck --audit A --period P [--statement S]` | A finding's look-alikes by cause; re-check every open finding of a statement after a change |
| `darpan config restore <versionId> [--yes --plan <hash>]` | Put the tenant's config back to an earlier version: the preview answers a planHash, and `--yes --plan <hash>` restores exactly that plan |
| `darpan mcp` / `darpan guide` | Serve every command as MCP tools over stdio; print the guide |

Output is JSON on stdout. An error is JSON on stderr, `{"error", "next"}`, and `next` says what to do. Exit codes: 0 ok, 1 unreachable, 2 usage, 3 not signed in, 4 throttled, 5 failed, 7 not allowed.

What it does and does not do: anything your role can do in the Darpan app, checked by the server on every call (most edits go through `darpan call <method> --yes`). Connection credentials (passwords, tokens, keys, webhook URLs), sign-in, two-factor, passkeys, CLI access and Shopify or Slack installs stay in the app: a secret given to an AI is kept in its transcript. It never writes to NetSuite, HotWax OMS or Shopify (queries are read-only and the server refuses anything else).

Output shape: `report` and `findings show` print the audit page's own documents, `darpan.audit.report/v1` and `darpan.audit.finding/v1` (DAR-CLI-004; before, they printed a GraphQL response that left out most record fields, and `findings show --fields` is gone). `findings list` (one page) prints the GraphQL response untouched; `findings list --all` and `month export` print one document, `{"query", "sortKey", "reverse", "edges": [{"cursor", "node"}, ...]}`.

The GraphQL API keys (`dgql_...`) still exist for headless integrations that call [the GraphQL API](https://docs.drpn.ai/graphql/overview) directly; the CLI no longer reads `DARPAN_URL` or `DARPAN_GQL_KEY`.

## How it maps to the manual setup

`darpan up` reproduces [`darpan-docs/getting-started/set-up-darpan-independently.mdx`](../darpan-docs/getting-started/set-up-darpan-independently.mdx):

1. Clone `moqui-framework` → `darpan-backend`, the 4 Darpan components + `moqui-sftp` into `runtime/component/`, and `darpan-ui` as a sibling (see the `REPO_MANIFEST` in `bin/darpan`).
2. `./gradlew getRuntime`
3. `./gradlew load` (`types=all`, loads framework + `darpan-seed-initial`/`darpan-seed`)
4. Export `JAVA_TOOL_OPTIONS` (Spark `--add-opens` set) and start both processes.

## Version pinning

Each manifest entry has a `ref` (branch or tag). Override per repo with `DARPAN_REF_<NAME>`:

```bash
DARPAN_REF_DARPAN=2.0.0 DARPAN_REF_DARPAN_UI=2.0.0 darpan up
```

For reproducible installs, the published manifest refs should point at coordinated release tags rather than `main`/`master`.

## Packaging for Homebrew

The formula is in `tap/Formula/darpan.rb`. It installs `bin/darpan` and `agent/` into libexec and links the launcher into the prefix (the launcher follows symlinks to find `agent/`); all network/build work happens at runtime in `darpan up` (Homebrew forbids it at install time).

Release flow (automated by `.github/workflows/release.yml`):

1. In `drpn-ai/darpan-cli`, push a tag: `git tag v0.1.0 && git push origin v0.1.0`.
2. The `release` workflow runs `scripts/package.sh`, attaches `darpan-0.1.0.tar.gz` to a GitHub release, and prints the `url` / `sha256` / `version` in the job summary.
3. Paste those into `Formula/darpan.rb` in `drpn-ai/homebrew-tap` and commit.
   Then build the one bottle every platform pours (an install from a bottle skips Homebrew's build checks, so it never needs Xcode or the Command Line Tools, which a macOS beta refuses to build with when they are older). After pushing the url/sha256 bump:
   ```bash
   export HOMEBREW_NO_AUTOREMOVE=1   # uninstalling darpan would otherwise remove packages only darpan pulled in
   brew uninstall darpan; brew trust --formula drpn-ai/tap/darpan   # uninstall drops the formula's trust
   brew install --build-bottle drpn-ai/tap/darpan
   brew bottle --no-rebuild --json --root-url=https://github.com/drpn-ai/darpan-cli/releases/download/v<X.Y.Z> drpn-ai/tap/darpan
   # the files are platform-free, so tag it all; the download URL uses ONE dash (darpan-<X.Y.Z>…), the local file two
   mv darpan--<X.Y.Z>.*.bottle.tar.gz darpan-<X.Y.Z>.all.bottle.tar.gz
   gh release upload v<X.Y.Z> darpan-<X.Y.Z>.all.bottle.tar.gz --repo drpn-ai/darpan-cli
   ```
   Put `bottle do root_url "…/v<X.Y.Z>"; sha256 cellar: :any_skip_relocation, all: "<sha256 of that file>" end` in the formula and push. A new release asset can 404 for about a minute. `brew install darpan` then says **Pouring darpan-<X.Y.Z>.all.bottle.tar.gz**.
4. Users: `brew tap drpn-ai/tap && brew trust --formula drpn-ai/tap/darpan && brew install darpan`.

Build a tarball locally without CI:

```bash
sh scripts/package.sh 0.1.0   # writes dist/darpan-0.1.0.tar.gz and prints the sha256
```

## Validation status

- **Bootstrap pipeline verified end-to-end** (`darpan bootstrap --dir /tmp/...`): clone framework → `getRuntime` (real runtime download) → clone components + UI → `./gradlew load` (BUILD SUCCESSFUL, H2 DB populated) → `npm install`. Confirms public repos clone without auth, JDK 21 + `JAVA_TOOL_OPTIONS` are applied, and `load` (`types=all`) loads the Darpan custom seed types.
- `doctor` / `help` / `version` / arg-dispatch exercised; JDK-21 resolution validated against a wrong JDK 11.

## Known gaps

- The dual-process `darpan start` (foreground supervision of `gradlew run` + Vite) has not been run via the CLI because the Moqui backend binds `:8080` from its conf and would collide with an already-running local stack. The supervision logic itself is lifted verbatim from the proven `dev-stack.sh`.
- Manifest refs default to `main`/`master` until coordinated release tags are chosen.
- The formula installs no dependencies; Node 22.18+, JDK 21 and `git` are the local stack's to bring (`darpan doctor` says how). If JDK 21 comes from Homebrew's keg-only `openjdk@21`, the CLI resolves it via `brew --prefix openjdk@21` / `/usr/libexec/java_home` (validating the actual major version). Worth a check on a machine where JDK 21 exists only via Homebrew.

## Tests

```sh
./test-darpan.sh
```

POSIX sh, no framework (run it under `sh` and `dash`). The Node agent has its own tests: `node --test agent/__tests__/*.test.ts`. Covers JDK-21 detection (including the `JAVA_TOOL_OPTIONS`
notice the JVM prints ahead of the version), `sync_repo` refusing a ref that does
not resolve instead of silently taking the default branch, the `doctor` failure
count, `up` refusing to load while a backend holds the port, and the hand-off to Node (`darpan whoami` with no sign-in exits 3, `darpan guide` prints the guide, also through symlinks).
