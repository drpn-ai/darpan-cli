// darpan agent CLI: one command per task, JSON on stdout, `{error, next}` JSON on stderr, exit codes in rpc.ts.
import { COMMANDS, matchCommand, spawnOpen, type Command, type Ctx } from './commands.ts'
import { configDir, currentInstance, dropToken, loadConfig, saveConfig, type Instance } from './config.ts'
import { CliError, EXIT, LOGIN_HINT, createSession, stripControl, type FetchLike } from './rpc.ts'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GUIDE } from './guide.ts'
import { runMcp } from './mcp.ts'

export type Flags = Record<string, string | boolean>

/** Flags that never take a value, whatever the command. Each command's own boolean inputs are added from its schema. */
const GLOBAL_BOOLEAN_FLAGS = ['help']

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** The command's boolean inputs as flags (differences -> --differences, dryRun -> --dry-run). */
export function booleanFlagsOf(command: Command | undefined): Set<string> {
  const names = Object.entries(command?.input.properties ?? {}).filter(([, spec]) => spec.type === 'boolean').map(([name]) => kebab(name))
  return new Set([...GLOBAL_BOOLEAN_FLAGS, ...names])
}

export function parseArgs(argv: string[], booleanFlags: Set<string> = new Set(GLOBAL_BOOLEAN_FLAGS)): { positionals: string[]; flags: Flags } {
  const positionals: string[] = []
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (!token.startsWith('--') || token === '--') {
      positionals.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq > 0 ? token.slice(2, eq) : token.slice(2)
    if (eq > 0) flags[name] = token.slice(eq + 1)
    else if (booleanFlags.has(name)) flags[name] = true
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) flags[name] = argv[++i]!
    else flags[name] = true
  }
  return { positionals, flags }
}

const camel = (flag: string) => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** Map CLI flags and positional words to the command's args by its input schema. */
export function toArgs(command: Command, positionals: string[], flags: Flags): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  command.positional?.forEach((name, i) => {
    if (positionals[i] !== undefined) args[name] = positionals[i]
  })
  for (const [flag, value] of Object.entries(flags)) {
    const name = camel(flag)
    const spec = command.input.properties[name]
    if (!spec) continue
    if (spec.type === 'object' || spec.type === 'array') {
      try {
        args[name] = JSON.parse(String(value))
      } catch {
        throw new CliError(`--${flag} must be valid JSON.`, EXIT.usage, `example: --${flag} '{"key":"value"}'`)
      }
    } else if (spec.type === 'number') {
      args[name] = Number(value)
    } else if (spec.type === 'boolean') {
      args[name] = value === true || value === 'true'
    } else {
      args[name] = value
    }
  }
  return args
}

export function helpText(): string {
  return [
    'darpan <command> [--tenant <id>]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.summary}`),
    '  guide   how to use darpan well (the usual path, limits, roles)',
    '  mcp     serve every command above as MCP tools over stdio (claude mcp add darpan -- darpan mcp)',
    '',
    'Output is JSON on stdout. Errors are JSON on stderr: {"error": ..., "next": ...}.',
    'Exit codes: 0 ok, 1 unreachable, 2 usage, 3 not signed in, 4 throttled, 5 failed, 7 not allowed.',
  ].join('\n')
}

export interface RunOutput {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  env: Record<string, string | undefined>
  fetchImpl?: FetchLike
  openUrl?: (url: string) => void
  sleep?: (ms: number) => Promise<void>
  /** Standard input for a `-` flag value (injectable for tests). */
  stdin?: () => string
  /** Write progress lines to the terminal as they happen (the real binary); they are also collected. */
  live?: boolean
}

const NEXT_BY_EXIT: Record<number, string> = {
  [EXIT.unreachable]: 'check the instance URL and your network',
  [EXIT.usage]: 'run `darpan --help`',
  [EXIT.unauthenticated]: LOGIN_HINT,
  [EXIT.throttled]: 'retry shortly',
  [EXIT.failed]: 'read the error, adjust and retry',
  [EXIT.forbidden]: 'this is done in the Darpan app',
}

/** Load the config and build a fresh Ctx for one command, enforcing the sign-in and tenant gates. Shared by the CLI and `darpan mcp`. */
export function buildCtx(command: Command, options: RunOptions, extra: { tenant?: string; log?: (line: string) => void }): { ctx: Ctx; config: ReturnType<typeof loadConfig>; name: string } {
  const dir = configDir(options.env)
  const config = loadConfig(dir)
  const found = currentInstance(config)
  const name = found?.name ?? ''
  // --tenant changes this call only; it is never saved.
  const instance: Instance = found ? { ...found.instance, ...(extra.tenant ? { tenant: extra.tenant } : {}) } : { url: '' }

  if (command.auth !== false) {
    if (!found || !instance.token) throw new CliError('You are not signed in.', EXIT.unauthenticated, LOGIN_HINT)
    if (instance.tokenExpiresAt && Date.parse(instance.tokenExpiresAt) <= Date.now()) {
      dropToken(config, name)
      saveConfig(dir, config)
      throw new CliError('Your CLI session has expired.', EXIT.unauthenticated, LOGIN_HINT)
    }
  }
  if (command.tenant === 'required' && !instance.tenant) {
    throw new CliError('No tenant chosen.', EXIT.usage, 'run `darpan tenants`, then `darpan tenant use <id>` (or pass --tenant <id>)')
  }
  const ctx: Ctx = {
    session: createSession(instance, options.fetchImpl),
    tenant: instance.tenant || undefined,
    config,
    dir,
    env: options.env,
    fetchImpl: options.fetchImpl,
    openUrl: options.openUrl ?? (options.env.DARPAN_NO_BROWSER ? () => {} : spawnOpen),
    log: extra.log,
    sleep: options.sleep,
    stdin: options.stdin,
  }
  return { ctx, config, name }
}

export async function run(argv: string[], options: RunOptions): Promise<RunOutput> {
  const lines: string[] = []
  const log = (line: string) => {
    line = stripControl(line)
    lines.push(line)
    if (options.live) process.stderr.write(`${line}\n`)
  }
  const fail = (message: string, exitCode: number, next?: string, details?: Record<string, unknown>): RunOutput => {
    lines.push(JSON.stringify({ error: stripControl(message), next: next === undefined ? (NEXT_BY_EXIT[exitCode] ?? null) : stripControl(next), ...details }))
    return { exitCode, stdout: '', stderr: lines.join('\n') }
  }

  // Two passes: the first finds the command; the second reads the flags with that command's boolean inputs, so a
  // boolean flag never swallows the word after it (`--differences 100`, `--reverse R2`).
  const first = parseArgs(argv)
  if (first.flags.help || first.positionals.length === 0 || first.positionals[0] === 'help') return { exitCode: EXIT.ok, stdout: helpText(), stderr: '' }
  if (first.positionals[0] === 'guide') return { exitCode: EXIT.ok, stdout: GUIDE, stderr: '' }
  if (first.positionals[0] === 'mcp') return fail('`darpan mcp` serves over stdio and is started by an MCP client.', EXIT.usage, 'run `claude mcp add darpan -- darpan mcp`')
  const found = matchCommand(first.positionals)
  if (!found) return fail(`Unknown command "${first.positionals.join(' ')}".`, EXIT.usage, 'run `darpan --help`')
  const { positionals, flags } = parseArgs(argv, booleanFlagsOf(found.command))
  const matched = matchCommand(positionals)
  if (!matched) return fail(`Unknown command "${positionals.join(' ')}".`, EXIT.usage, 'run `darpan --help`')
  const { command, rest } = matched

  let name = ''
  try {
    const built = buildCtx(command, options, { tenant: typeof flags.tenant === 'string' ? flags.tenant : undefined, log })
    name = built.name
    const { ctx, config } = built
    try {
      const result = await command.run(ctx, toArgs(command, rest, flags))
      return { exitCode: EXIT.ok, stdout: JSON.stringify(result, null, 2), stderr: lines.join('\n') }
    } catch (error) {
      if (error instanceof CliError && error.dropToken && name) {
        dropToken(config, name)
        saveConfig(built.ctx.dir, config)
      }
      throw error
    }
  } catch (error) {
    if (error instanceof CliError) return fail(error.message, error.exitCode, error.next, error.details)
    return fail((error as Error).message, EXIT.failed)
  }
}

// import.meta.url is the real path; argv[1] is as typed, so compare real paths (a symlinked prefix, macOS /var -> /private/var).
const realPath = (path: string) => { try { return realpathSync(path) } catch { return path } }
const invokedDirectly = Boolean(process.argv[1]) && realPath(fileURLToPath(import.meta.url)) === realPath(process.argv[1])
if (invokedDirectly && process.argv[2] === 'mcp') {
  const options: RunOptions = { env: process.env }
  await runMcp(process.stdin, process.stdout, (command, tenant) => buildCtx(command, options, { tenant }).ctx)
} else if (invokedDirectly) {
  const output = await run(process.argv.slice(2), { env: process.env, live: true })
  if (output.stdout) process.stdout.write(`${output.stdout}\n`)
  // Progress lines were already shown live; print only the final error JSON (the last line).
  if (output.exitCode !== EXIT.ok) process.stderr.write(`${output.stderr.split('\n').pop()}\n`)
  process.exitCode = output.exitCode
}
