# darpan-cli

A POSIX-shell CLI that bootstraps and runs a local Darpan development stack, designed for distribution via Homebrew. It generalizes the workspace `dev-stack.sh` into a portable command that clones the repos, loads setup data, and starts the backend + UI with the JDK 21 runtime flags Moqui 4 / Spark 3.5 require.

Tracked in **DAR-287**.

## Layout

```
darpan-cli/
  bin/darpan                       CLI
  scripts/package.sh               build a release tarball + sha256
  .github/workflows/release.yml    tag-triggered release
  LICENSE  .gitignore  README.md
```

The Homebrew formula lives in the separate tap repo **drpn-ai/homebrew-tap** (`Formula/darpan.rb`). Tracked in DAR-287.

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

The formula is in `tap/Formula/darpan.rb`. It installs only `bin/darpan`; all network/build work happens at runtime in `darpan up` (Homebrew forbids it at install time).

Release flow (automated by `.github/workflows/release.yml`):

1. In `drpn-ai/darpan-cli`, push a tag: `git tag v0.1.0 && git push origin v0.1.0`.
2. The `release` workflow runs `scripts/package.sh`, attaches `darpan-0.1.0.tar.gz` to a GitHub release, and prints the `url` / `sha256` / `version` in the job summary.
3. Paste those into `Formula/darpan.rb` in `drpn-ai/homebrew-tap` and commit.
4. Users: `brew tap drpn-ai/tap && brew install darpan`.

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
- `openjdk@21` is keg-only; the CLI resolves it via `brew --prefix openjdk@21` / `/usr/libexec/java_home` (validating the actual major version). Worth a check on a machine where JDK 21 exists only via Homebrew.
