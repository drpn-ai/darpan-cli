// The command table. `darpan <name> [flags]` and, from Task 12, an MCP tool per entry: both pass the same
// `args` object. CLI flags map to args by the `input` schema's property names (kebab-case flags -> camelCase).
import { spawn } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { sep } from 'node:path'
import { hostname } from 'node:os'
import { currentInstance, dropToken, saveConfig, type Config } from './config.ts'
import { CliError, EXIT, LOGIN_HINT, createSession, stripControl, type FetchLike, type Session } from './rpc.ts'
import { PERIOD_RE, buildFindingsQuery, listFindings, monthExportQuery } from './gql.ts'

export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, { type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'; description?: string; default?: unknown }>
  required?: string[]
}

export interface Ctx {
  session: Session
  /** The tenant this call runs in: --tenant / the MCP tenant argument, else the saved choice; undefined when none. */
  tenant?: string
  config: Config
  dir: string
  env: Record<string, string | undefined>
  fetchImpl?: FetchLike
  openUrl(url: string): void
  /** One line of human progress; goes to stderr, never to the JSON result. */
  log?(line: string): void
  /** Injectable pause for the sign-in poll. */
  sleep?(ms: number): Promise<void>
  /** Reads standard input for a `-` flag value. */
  stdin?(): string
}

export interface Command {
  name: string
  summary: string
  description: string
  input: JsonSchemaObject
  /** 'required': a tenant must be chosen (darpan tenant use, or --tenant). 'optional': --tenant (and the MCP tenant
   *  argument) is honoured for the call, but none is needed. */
  tenant: 'none' | 'optional' | 'required'
  /** Names of `input` properties filled from positional words after the command name, in order. */
  positional?: string[]
  /** Input properties that name a local file path. The CLI accepts them; the MCP surface (Task 12) must omit them and expose only the inline forms. */
  cliOnly?: string[]
  /** false: runs without a stored sign-in key (login, api). */
  auth?: boolean
  run(ctx: Ctx, args: Record<string, unknown>): Promise<unknown>
}

export interface AllowedMethod {
  method: string
  description: string
}

export function loadAllowedMethods(): AllowedMethod[] {
  return JSON.parse(readFileSync(new URL('./allowed-methods.json', import.meta.url), 'utf8')) as AllowedMethod[]
}

const NONE = { type: 'object', properties: {} } as const satisfies JsonSchemaObject
const log = (ctx: Ctx, line: string) => ctx.log?.(line)

/** Open a page in the person's browser. Best effort: the URL is also printed. */
export function spawnOpen(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The URL was printed; the person can open it by hand.
  }
}

/** Darpan instances we know: backend host -> the app host that serves its sign-in page. */
const KNOWN_APP_HOSTS: Record<string, string> = {
  'api.drpn.ai': 'app.drpn.ai',
  'api-next.drpn.ai': 'app.drpn.ai',
  'api-uat.drpn.ai': 'app-uat.drpn.ai',
  'sm-darpan-maarg.hotwax.io': 'sm-darpan.hotwax.io',
}

/** The sign-in page URL when it is safe to open: http(s), no credentials, a single-slash path, and a host that is
 *  the instance itself, the --app-url host, or the known app host of a known Darpan instance. Otherwise null. */
export function safeSignInUrl(instanceUrl: string, appUrl: string | undefined, verificationUrl: string, verificationPath: string): string | null {
  try {
    if (!/^\/(?![/\\])/.test(verificationPath)) return null
    const instance = new URL(instanceUrl)
    const app = appUrl ? new URL(appUrl) : null
    if (app && !['http:', 'https:'].includes(app.protocol)) return null
    const page = app ? new URL(`${app.origin}${verificationPath}`) : new URL(verificationUrl)
    if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password) return null
    if (app) return page.href
    const host = page.hostname.toLowerCase()
    const ours = instance.hostname.toLowerCase()
    return host === ours || host === KNOWN_APP_HOSTS[ours] ? page.href : null
  } catch {
    return null
  }
}

interface SessionInfo {
  activeTenantPermissionGroupIds?: string[]
  username?: string
  displayName?: string
  activeTenantUserGroupId?: string
  activeTenantLabel?: string
  availableTenants?: { userGroupId: string; label: string }[]
  canViewActiveTenantData?: boolean
  canRunActiveTenantReconciliation?: boolean
  canEditActiveTenantData?: boolean
  canManageDarpanCore?: boolean
}

async function sessionInfo(ctx: Ctx, tenant?: string): Promise<SessionInfo> {
  const result = await ctx.session.call<{ sessionInfo?: SessionInfo }>('facade.AuthFacadeServices.get#SessionInfo', {}, tenant === undefined ? {} : { tenant })
  return result.sessionInfo ?? {}
}

/** The role in the tenant, from its permission groups, highest first. canManageDarpanCore is Darpan-wide (staff),
 *  not a tenant role, so it is reported separately as darpanStaff. */
const ROLE_BY_GROUP: [string, string][] = [
  ['DARPAN_TENANT_ADMIN', 'admin'],
  ['DARPAN_COMPANY_EDITOR', 'editor'],
  ['DARPAN_TENANT_USER', 'user'],
  ['DARPAN_COMPANY_VIEW_ONLY', 'view'],
]
export function role(info: SessionInfo): string {
  const groups = info.activeTenantPermissionGroupIds ?? []
  return ROLE_BY_GROUP.find(([group]) => groups.includes(group))?.[1] ?? 'none'
}

const login: Command = {
  name: 'login',
  summary: 'login [--instance <url>] [--name <n>] [--app-url <url>]   sign in through the browser',
  description: 'Sign in to a Darpan instance: shows a code, opens the approval page, waits for you to enter the code there.',
  input: {
    type: 'object',
    properties: {
      instance: { type: 'string', description: 'Backend URL', default: 'https://api.drpn.ai' },
      name: { type: 'string', description: 'Name to save this instance under', default: 'prod' },
      appUrl: { type: 'string', description: 'App base URL to open instead of the one the backend names (local dev: http://localhost:5173)' },
    },
  },
  tenant: 'none',
  auth: false,
  async run(ctx, args) {
    const url = String(args.instance || 'https://api.drpn.ai').replace(/\/+$/, '')
    const name = String(args.name || 'prod')
    const anon = createSession({ url }, ctx.fetchImpl)
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const begun = await anon.call<{ deviceCode: string; userCode: string; verificationUrl: string; verificationPath: string; expiresInSeconds?: number; intervalSeconds?: number }>(
      'facade.CliAuthFacadeServices.start#CliLogin',
      { hostLabel: hostname() },
      { anonymous: true },
    )
    // R18: the code is typed on the page, never carried in a URL.
    const saved = ctx.config.instances[name]
    const appUrl = args.appUrl ? String(args.appUrl) : saved?.url === url ? saved.appUrl : undefined
    const page = safeSignInUrl(url, appUrl, begun.verificationUrl, begun.verificationPath)
    // DAR-BE-209: no one can approve a sign-in for a person the CLI is not on for, so it ends denied or expired; say where to ask.
    const askAt = page ? new URL('/settings/user', page).toString() : "your Darpan app's /settings/user"
    const ask = ` If Approve CLI said the CLI is not turned on for you, ask for it in User settings: ${askAt}`
    log(ctx, `Enter this code in your browser: ${begun.userCode}`)
    if (page) {
      log(ctx, `Approval page: ${page}`)
      ctx.openUrl(page)
    } else {
      log(ctx, `Not opening the approval page automatically (${stripControl(String(begun.verificationUrl))}); open your Darpan app's /cli-login page yourself.`)
    }

    const intervalMs = Math.max(1, Number(begun.intervalSeconds) || 3) * 1000
    const deadline = Date.now() + (Number(begun.expiresInSeconds) || 600) * 1000
    for (;;) {
      if (Date.now() > deadline) throw new CliError(`The sign-in code expired before it was approved.${ask}`, EXIT.unauthenticated, LOGIN_HINT)
      await sleep(intervalMs)
      const polled = await anon.call<{ status: string; authToken?: string; authTokenExpiresInSeconds?: number; username?: string }>(
        'facade.CliAuthFacadeServices.poll#CliLogin',
        { deviceCode: begun.deviceCode },
        { anonymous: true },
      )
      if (polled.status === 'PENDING') continue
      if (polled.status === 'DENIED') throw new CliError(`The sign-in was denied in the browser.${ask}`, EXIT.unauthenticated, LOGIN_HINT)
      if (polled.status !== 'APPROVED' || !polled.authToken) throw new CliError(`The sign-in code expired or was already used.${ask}`, EXIT.unauthenticated, LOGIN_HINT)
      const expires = polled.authTokenExpiresInSeconds ? new Date(Date.now() + polled.authTokenExpiresInSeconds * 1000).toISOString() : undefined
      const previous = ctx.config.instances[name]
      ctx.config.instances[name] = { url, token: polled.authToken, tokenExpiresAt: expires, tenant: previous?.url === url ? previous.tenant : undefined, appUrl }
      ctx.config.current = name
      saveConfig(ctx.dir, ctx.config)
      return { signedIn: true, instance: name, url, username: polled.username, tokenExpiresAt: expires, next: 'darpan tenants, then darpan tenant use <id>' }
    }
  },
}

const logout: Command = {
  name: 'logout',
  summary: 'logout                                  end this CLI session',
  description: 'Revoke the CLI session on the server and forget the stored key.',
  input: NONE,
  tenant: 'none',
  async run(ctx) {
    const found = currentInstance(ctx.config)
    if (!found) return { signedOut: true }
    // Revoked on the server only when it said so, or when it says the key is already dead (exit 3).
    let revoked = false
    try {
      await ctx.session.call('facade.CliAuthFacadeServices.logout#CliSession', {}, { tenant: '' })
      revoked = true
    } catch (error) {
      if (error instanceof CliError && error.exitCode === EXIT.unauthenticated) revoked = true
    }
    dropToken(ctx.config, found.name)
    saveConfig(ctx.dir, ctx.config)
    return { signedOut: true, revokedOnServer: revoked }
  },
}

const whoami: Command = {
  name: 'whoami',
  summary: 'whoami                                  who you are, the tenant and your role',
  description: 'The signed-in person, the instance, the tenant this call runs in and the role there.',
  input: NONE,
  tenant: 'optional',
  async run(ctx) {
    const found = currentInstance(ctx.config)!
    const info = await sessionInfo(ctx)
    // The call's tenant (--tenant / the MCP tenant argument, else the saved choice), as the server resolved it.
    const id = ctx.tenant ? (info.activeTenantUserGroupId ?? ctx.tenant) : undefined
    const label = info.availableTenants?.find((t) => t.userGroupId === id)?.label ?? (info.activeTenantUserGroupId === id ? info.activeTenantLabel : undefined)
    return {
      username: info.username,
      displayName: info.displayName,
      instance: { name: found.name, url: found.instance.url },
      tenant: id ? { id, label } : null,
      role: id ? role(info) : null,
      ...(info.canManageDarpanCore ? { darpanStaff: true } : {}),
    }
  },
}

const tenants: Command = {
  name: 'tenants',
  summary: 'tenants                                 the tenants you can work in',
  description: 'Your tenants; the one this CLI uses is marked current.',
  input: NONE,
  tenant: 'none',
  async run(ctx) {
    const current = currentInstance(ctx.config)!.instance.tenant
    const info = await sessionInfo(ctx, '')
    return { tenants: (info.availableTenants ?? []).map((t) => ({ id: t.userGroupId, label: t.label, current: t.userGroupId === current })) }
  },
}

const tenantUse: Command = {
  name: 'tenant use',
  summary: 'tenant use <id-or-label>                choose the tenant for later commands (local only)',
  description: 'Choose the tenant this CLI works in. Stored in the local config only; the app\'s own active tenant is not changed.',
  input: { type: 'object', properties: { tenant: { type: 'string', description: 'Tenant id or label' } }, required: ['tenant'] },
  tenant: 'none',
  positional: ['tenant'],
  async run(ctx, args) {
    const wanted = String(args.tenant ?? '').trim()
    if (!wanted) throw new CliError('tenant use needs a tenant id or label.', EXIT.usage, 'run `darpan tenants`')
    const info = await sessionInfo(ctx, '')
    const all = info.availableTenants ?? []
    const exact = all.filter((t) => t.userGroupId === wanted)
    const matches = exact.length > 0 ? exact : all.filter((t) => t.label.toLowerCase() === wanted.toLowerCase() || t.userGroupId.toLowerCase() === wanted.toLowerCase())
    if (matches.length !== 1) {
      throw new CliError(matches.length === 0 ? `"${wanted}" is not one of your tenants.` : `"${wanted}" matches more than one tenant.`, EXIT.usage, 'run `darpan tenants` and use the id')
    }
    const found = currentInstance(ctx.config)!
    found.instance.tenant = matches[0]!.userGroupId
    saveConfig(ctx.dir, ctx.config)
    return { tenant: { id: matches[0]!.userGroupId, label: matches[0]!.label } }
  },
}

const api: Command = {
  name: 'api',
  summary: 'api                                     the methods `darpan call` may use',
  description: 'The allowlisted Darpan methods with a one-line description each.',
  input: NONE,
  tenant: 'none',
  auth: false,
  async run() {
    const methods = loadAllowedMethods()
    return { count: methods.length, methods }
  },
}

const call: Command = {
  name: 'call',
  summary: 'call <method> [--params <json>]         call one allowlisted method',
  description: 'Call one method from `darpan api` as you, in the chosen tenant.',
  input: {
    type: 'object',
    properties: { method: { type: 'string', description: 'Method name from `darpan api`' }, params: { type: 'object', description: 'Method parameters' } },
    required: ['method'],
  },
  tenant: 'required',
  positional: ['method'],
  async run(ctx, args) {
    const method = String(args.method ?? '')
    // Final review Important 2, defence in depth: never mint, approve or read a CLI sign-in from a CLI session (an
    // agent would print the new key into its transcript), whatever the allowlist file says.
    if (/#CliLogin/.test(method) || !loadAllowedMethods().some((m) => m.method === method)) {
      throw new CliError(`${method || '(none)'} is not available to the Darpan CLI.`, EXIT.forbidden, 'run `darpan api` for the methods you can call')
    }
    return ctx.session.call(method, (args.params as object | undefined) ?? {})
  },
}

// ---------------------------------------------------------------------------------------------------------------
// Data commands (Task 10). Every method below must be on agent/allowed-methods.json; a test pins that.
// ---------------------------------------------------------------------------------------------------------------
const RECON = 'facade.ReconciliationFacadeServices'

type Row = Record<string, unknown>
const asRows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : [])
const text = (value: unknown): string | undefined => (value === undefined || value === null || value === '' ? undefined : String(value))
const usageError = (message: string, next: string) => new CliError(message, EXIT.usage, next)

/** A failure that must stop the command: not signed in, unreachable, throttled. Anything else can be reported per item. */
const isHard = (error: unknown): boolean => !(error instanceof CliError) || [EXIT.unreachable, EXIT.unauthenticated, EXIT.throttled].includes(error.exitCode)

/** The instance does not know the method (its system repo is not installed). */
const isUnknownMethod = (error: unknown): boolean =>
  error instanceof CliError && error.exitCode === EXIT.failed && /no service|service .*not found|unknown (service|method)|could not find|no such|does not exist|not installed/i.test(error.message)

interface SystemKind {
  system: 'NetSuite' | 'HotWax OMS' | 'Shopify'
  method: string
  rows: string
  idKey: string
  configType: string
}

const SYSTEM_KINDS: SystemKind[] = [
  { system: 'NetSuite', method: 'facade.NetSuiteQueryFacadeServices.list#NsAgentConnections', rows: 'connections', idKey: 'nsAuthConfigId', configType: 'SCFG_NS_AUTH' },
  { system: 'HotWax OMS', method: 'facade.HotWaxOmsFacadeServices.list#HotWaxOmsRestSourceConfigs', rows: 'omsRestSourceConfigs', idKey: 'omsRestSourceConfigId', configType: 'SCFG_HOTWAX_OMS' },
  { system: 'Shopify', method: 'facade.ShopifyFacadeServices.list#ShopifyAuthConfigs', rows: 'shopifyAuthConfigs', idKey: 'shopifyAuthConfigId', configType: 'SCFG_SHOPIFY_AUTH' },
]

interface Connection {
  system: SystemKind['system']
  connectionId: string
  name: string
  description: string
  endpoints: { label: string; enabled: boolean }[]
}

/** Every connection the person's tenant can query. Only the allowlisted keys leave this function. */
async function listConnections(ctx: Ctx): Promise<{ connections: Connection[]; unavailable: { system: string; reason: string }[] }> {
  const connections: Connection[] = []
  const unavailable: { system: string; reason: string }[] = []
  for (const kind of SYSTEM_KINDS) {
    let rows: Row[]
    try {
      rows = asRows((await ctx.session.call<Row>(kind.method, {}))[kind.rows])
    } catch (error) {
      if (isUnknownMethod(error)) continue
      if (isHard(error)) throw error
      unavailable.push({ system: kind.system, reason: stripControl((error as CliError).message) })
      continue
    }
    for (const row of rows) {
      const connectionId = text(row[kind.idKey])
      if (!connectionId || row.isActive === 'N' || row.isActive === false) continue
      let endpoints: Connection['endpoints'] = []
      try {
        const listed = await ctx.session.call<Row>('facade.SourceEndpointFacadeServices.list#SourceConfigEndpoints', { configTypeEnumId: kind.configType, configId: connectionId })
        endpoints = asRows(listed.endpoints).map((e) => ({ label: text(e.endpointLabel) ?? '', enabled: e.isEnabled !== false }))
      } catch (error) {
        if (isHard(error)) throw error
      }
      const description = text(row.description) ?? ''
      connections.push({ system: kind.system, connectionId, name: description || connectionId, description, endpoints })
    }
  }
  return { connections, unavailable }
}

const systems: Command = {
  name: 'systems',
  summary: 'systems                                 your NetSuite, HotWax OMS and Shopify connections',
  description:
    'Lists the systems this tenant can read: each NetSuite, HotWax OMS and Shopify connection with its name, description and the data it exposes. Use it first to learn which connectionId to give `describe` and `query run`. Returns no credentials, hosts or keys.',
  input: NONE,
  tenant: 'required',
  async run(ctx) {
    const { connections, unavailable } = await listConnections(ctx)
    return unavailable.length > 0 ? { connections, unavailable } : { connections }
  },
}

/** Saved-run sources, described without extract parameters. */
function describeSources(run: Row): Row[] {
  return asRows(run.systemOptions).map((o) => ({
    label: text(o.label),
    side: text(o.fileSide),
    source: text(o.sourceTypeLabel),
    connectionId: text(o.sourceConfigId) ?? text(o.nsRestletConfigId),
    idField: text(o.idFieldExpression),
  }))
}

async function allSavedRuns(ctx: Ctx): Promise<Row[]> {
  const runs: Row[] = []
  for (let page = 0; page < 50; page += 1) {
    const result = await ctx.session.call<Row>(`${RECON}.list#SavedRuns`, { pageIndex: page, pageSize: 200 })
    runs.push(...asRows(result.savedRuns))
    const pagination = (result.pagination ?? {}) as Row
    if (page + 1 >= Number(pagination.pageCount ?? 1)) break
  }
  return runs
}

const runSummary = (run: Row) => ({
  savedRunId: text(run.savedRunId),
  runName: text(run.runName),
  description: text(run.description),
  runType: text(run.runType),
  isActive: run.isActive !== false,
  sources: describeSources(run),
})

const readsConnection = (run: Row, connectionId: string) =>
  asRows(run.systemOptions).some((o) => o.sourceConfigId === connectionId || o.nsRestletConfigId === connectionId)

const describe: Command = {
  name: 'describe',
  summary: 'describe <connectionId>                 what a connection holds and how to query it',
  description:
    'Explains one connection from `systems`: for NetSuite its queryable record types and saved SuiteQL queries, for HotWax OMS or Shopify its GraphQL schema, plus the saved runs that read it and the exact `darpan query run` flags to ask it a fresh question. Use it before writing a query.',
  input: { type: 'object', properties: { connectionId: { type: 'string', description: 'A connectionId from `darpan systems`' } }, required: ['connectionId'] },
  tenant: 'required',
  positional: ['connectionId'],
  async run(ctx, args) {
    const id = String(args.connectionId ?? '').trim()
    if (!id) throw usageError('describe needs a connectionId.', 'run `darpan systems`')
    const { connections } = await listConnections(ctx)
    const found = connections.find((c) => c.connectionId === id)
    if (!found) throw usageError(`"${id}" is not one of your connections.`, 'run `darpan systems` and use a connectionId from it')
    const savedRuns = (await allSavedRuns(ctx)).filter((r) => readsConnection(r, id)).map(runSummary)
    const base = { system: found.system, connectionId: id, name: found.name }

    if (found.system === 'NetSuite') {
      const options = await ctx.session.call<Row>('facade.NetSuiteQueryFacadeServices.get#NsSuiteQlQueryOptions', {})
      const queries = await ctx.session.call<Row>('facade.NetSuiteQueryFacadeServices.list#NsSuiteQlSourceQueries', {})
      return {
        ...base,
        howToQuery: `darpan query run --connection ${id} --suiteql "<SELECT ...>" [--limit 200] [--offset 0]   (one read-only SELECT; up to 2,000 rows a call)`,
        savedRuns,
        recordTypes: options.options ?? {},
        savedQueries: asRows(queries.queries),
      }
    }
    const isOms = found.system === 'HotWax OMS'
    let schema: unknown = null
    let schemaUnavailable: string | undefined
    try {
      const result = await ctx.session.call<Row>(
        isOms ? 'facade.HotWaxOmsFacadeServices.get#OmsGraphqlSchema' : 'facade.ShopifyFacadeServices.get#ShopifyGraphqlSchema',
        isOms ? { omsRestSourceConfigId: id } : { shopifyAuthConfigId: id },
      )
      schema = result.schema ?? null
    } catch (error) {
      if (isHard(error)) throw error
      schemaUnavailable = stripControl((error as CliError).message)
    }
    return {
      ...base,
      howToQuery: `darpan query run --connection ${id} --graphql "<query>" [--variables '<json>']   (read-only GraphQL; answers over 5 MB are refused, so ask for fewer fields)`,
      savedRuns,
      schema,
      ...(schemaUnavailable ? { schemaUnavailable } : {}),
    }
  },
}

const runs: Command = {
  name: 'runs',
  summary: 'runs                                    the saved runs (reconciliations) you can start',
  description:
    'Lists the tenant\'s saved runs: each comparison between two systems (for example Shopify against NetSuite orders) with the connections it reads. Use it to find the savedRunId to start with `run start` or to read with `result`.',
  input: NONE,
  tenant: 'required',
  async run(ctx) {
    const all = (await allSavedRuns(ctx)).map(runSummary)
    return { count: all.length, runs: all }
  },
}

const LOCAL_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** The window the app sends (flowchartRunState.buildRunPayload): whole days, --thru included. The backend requires
 *  windowStartDate/windowEndDate and re-anchors them to the tenant's time zone from the local dates, whose end is
 *  exclusive, so --thru becomes the day after. Task 14 live check: local dates alone were refused. */
function runWindow(from: string | undefined, thru: string | undefined): Row {
  for (const [flag, value] of [['--from', from], ['--thru', thru]] as const) {
    if (value && (!LOCAL_DATE.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value)) {
      throw usageError(`${flag} is a date, YYYY-MM-DD`, 'run `darpan run start --help`')
    }
  }
  if (!from && !thru) return {}
  if (!from) throw usageError('--thru needs --from.', 'run `darpan run start --help`')
  const last = thru ?? from
  if (last < from) throw usageError('--thru is before --from.', 'run `darpan run start --help`')
  const endExclusive = nextDay(last)
  return {
    windowStartDate: `${from}T00:00:00.000Z`,
    windowEndDate: `${endExclusive}T00:00:00.000Z`,
    windowStartLocalDate: from,
    windowEndLocalDate: endExclusive,
  }
}

const runStart: Command = {
  name: 'run start',
  summary: 'run start <savedRunId> [--from D] [--thru D]   run a saved run now',
  description:
    'Runs one saved run now and returns its run id and a summary of the differences found. A saved run that reads a system (API or database) needs a window: --from and --thru are whole days in the tenant\'s time zone, --thru included (--from alone is one day). Use `run wait` if it is still going, then `result` to read the differences. Runs in your tenant under your own role.',
  input: {
    type: 'object',
    properties: {
      savedRunId: { type: 'string', description: 'A savedRunId from `darpan runs`' },
      from: { type: 'string', description: 'First day of the window, YYYY-MM-DD (tenant time zone)' },
      thru: { type: 'string', description: 'Last day of the window, included, YYYY-MM-DD; defaults to --from' },
      reconciliationId: { type: 'string', description: 'Start a reconciliation by its id instead of a saved run (advanced)' },
    },
  },
  tenant: 'required',
  positional: ['savedRunId'],
  async run(ctx, args) {
    const savedRunId = text(args.savedRunId)
    const reconciliationId = text(args.reconciliationId)
    const from = text(args.from)
    const thru = text(args.thru)
    if (!savedRunId && !reconciliationId) throw usageError('run start needs a savedRunId.', 'run `darpan runs`')
    const window = runWindow(from, thru)
    if (!savedRunId) {
      const started = await ctx.session.call<Row>(`${RECON}.run#Reconciliation`, { reconciliationId, ...window })
      return { started: true, executionId: text(started.reconciliationExecutionId), next: 'darpan runs, then darpan result <savedRunId> once it finishes' }
    }
    const result = await ctx.session.call<Row>(`${RECON}.run#SavedRunDiff`, { savedRunId, ...window })
    const run = (result.runResult ?? {}) as Row
    const output = (run.generatedOutput ?? {}) as Row
    const runId = text(run.reconciliationRunResultId) ?? text(output.reconciliationRunResultId)
    return {
      savedRunId,
      runName: text(run.runName),
      runId,
      status: text(output.statusLabel) ?? text(output.statusEnumId),
      totalDifferences: output.totalDifferences,
      onlyInFile1Count: output.onlyInFile1Count,
      onlyInFile2Count: output.onlyInFile2Count,
      resultFile: text(output.fileName),
      validationErrors: run.validationErrors,
      processingWarnings: run.processingWarnings,
      next: output.resultAvailable === true ? `darpan result ${savedRunId}` : `darpan run wait ${runId}`,
    }
  },
}

async function runStatus(ctx: Ctx, runId: string): Promise<Row> {
  const s = await ctx.session.call<Row>(`${RECON}.get#ReconciliationRunStatus`, { reconciliationRunResultId: runId })
  return {
    runId,
    statusEnumId: text(s.statusEnumId),
    currentStage: text(s.currentStage),
    progressPercent: s.progressPercent,
    startedDate: s.startedDate,
    completedDate: s.completedDate,
    errorMessage: text(s.errorMessage),
    errorDetail: text(s.errorDetail),
    steps: s.steps,
    resultFileName: text(s.resultFileName),
  }
}

const statusOf = (s: Row) => String(s.statusEnumId ?? '')
// AutomationExecStatus (data/AutomationSeedData.xml). PENDING and RUNNING keep polling; every other status ends the wait.
const STILL_GOING = new Set(['AUT_STAT_PENDING', 'AUT_STAT_RUNNING'])
const ENDED_OK: Record<string, string | undefined> = {
  AUT_STAT_SUCCESS: undefined,
  AUT_STAT_NO_DATA: 'The run finished but found no input data to compare.',
  AUT_STAT_SKIP_DUP: 'The run was skipped as a duplicate of one already done.',
}
const ENDED_BAD: Record<string, string> = {
  AUT_STAT_FAILED: 'failed',
  AUT_STAT_CANCELLED: 'was cancelled',
  AUT_STAT_DEAD_LETTER: 'failed after exhausting its retries',
  AUT_STAT_NOT_RUN: 'was not run (a question above it in the flowchart failed or was switched off)',
}

const needRunId = (args: Record<string, unknown>): string => {
  const id = text(args.runId)
  if (!id) throw usageError('A run id is needed.', 'run `darpan run start <savedRunId>` to get one')
  return id
}

const runStatusCommand: Command = {
  name: 'run status',
  summary: 'run status <runId>                      progress of one run',
  description: 'Shows where one run is: its status, current stage, percent done, any error, and the result file once written. Use the run id that `run start` returned.',
  input: { type: 'object', properties: { runId: { type: 'string', description: 'Run id from `run start`' } }, required: ['runId'] },
  tenant: 'required',
  positional: ['runId'],
  async run(ctx, args) {
    return runStatus(ctx, needRunId(args))
  },
}

const POLL_SECONDS = 5

const runWait: Command = {
  name: 'run wait',
  summary: 'run wait <runId> [--timeout 900]       wait for a run to finish',
  description:
    'Waits for one run to finish (checking every few seconds, 900 seconds at most) and returns its final status. Exits with an error if the run failed or was cancelled, or is still going at the timeout. Then read it with `result`.',
  input: {
    type: 'object',
    properties: { runId: { type: 'string', description: 'Run id from `run start`' }, timeout: { type: 'number', description: 'Seconds to wait', default: 900 } },
    required: ['runId'],
  },
  tenant: 'required',
  positional: ['runId'],
  async run(ctx, args) {
    const runId = needRunId(args)
    const timeout = args.timeout === undefined ? 900 : Number(args.timeout)
    if (!Number.isFinite(timeout) || timeout < 0) throw usageError('--timeout is a number of seconds.', 'example: --timeout 900')
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (let waited = 0; ; waited += POLL_SECONDS) {
      const status = await runStatus(ctx, runId)
      const id = statusOf(status)
      if (id in ENDED_OK) return { ...status, done: true, ...(ENDED_OK[id] ? { note: ENDED_OK[id] } : {}) }
      if (!STILL_GOING.has(id)) {
        const what = ENDED_BAD[id] ?? `ended with the unrecognised status "${id || 'none'}"`
        throw new CliError(`The run ${what}${status.errorMessage ? `: ${status.errorMessage}` : '.'}`, EXIT.failed, `darpan run status ${runId} shows the steps; fix the cause and start the run again`)
      }
      if (waited >= timeout) throw new CliError(`Run ${runId} is still running after ${waited} seconds.`, EXIT.failed, `darpan run wait ${runId} --timeout ${Math.max(timeout, 60) * 2}`)
      log(ctx, `Run ${runId}: ${status.currentStage ?? 'working'}${status.progressPercent === undefined ? '' : ` (${status.progressPercent}%)`}`)
      await sleep(POLL_SECONDS * 1000)
    }
  },
}

const FILE_NAME = /\.[A-Za-z0-9]+$/

const result: Command = {
  name: 'result',
  summary: 'result <savedRunId|file> [--differences] [--first N]   read a run result',
  description:
    'Reads the newest result of a saved run (or a result file by name): the totals and how many differences fall in each bucket. Add --differences to list the differing records (--first N of them, up to 200; --page for the next page); add --content for the raw result file.',
  input: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'A savedRunId from `darpan runs`, or a result file name' },
      differences: { type: 'boolean', description: 'List the differing records' },
      first: { type: 'integer', description: 'How many differences to list, 1 to 200', default: 50 },
      page: { type: 'number', description: 'Page of differences, from 0' },
      buckets: { type: 'string', description: 'Only these differences: file-1, file-2, rule (comma list)' },
      search: { type: 'string', description: 'Only records whose id contains this text' },
      conclusionCode: { type: 'string', description: 'Only differences with this conclusion code' },
      content: { type: 'boolean', description: 'Return the raw result file instead' },
    },
    required: ['target'],
  },
  tenant: 'required',
  positional: ['target'],
  async run(ctx, args) {
    const target = text(args.target)
    if (!target) throw usageError('result needs a savedRunId or a result file name.', 'run `darpan runs`')
    const first = args.first === undefined ? '50' : String(args.first)
    if (!/^[1-9][0-9]*$/.test(first) || Number(first) > 200) throw usageError('--first is a number from 1 to 200', 'example: --first 50')
    let fileName = target
    let output: Row | undefined
    if (!FILE_NAME.test(target)) {
      const listed = await ctx.session.call<Row>(`${RECON}.list#GeneratedOutputs`, { savedRunId: target, pageIndex: 0, pageSize: 20 })
      output = asRows(listed.generatedOutputs)[0]
      if (!output || !text(output.fileName)) throw new CliError(`Saved run ${target} has no result yet.`, EXIT.failed, `darpan run start ${target}`)
      fileName = String(output.fileName)
    }
    if (args.content === true) {
      const file = await ctx.session.call<Row>(`${RECON}.get#GeneratedOutput`, { fileName })
      return { fileName, output, content: file.outputFile }
    }
    const listing = args.differences === true
    const params: Row = { fileName, pageIndex: listing ? Number(args.page ?? 0) : 0, pageSize: listing ? Number(first) : 1, includeFacets: true }
    for (const key of ['buckets', 'search', 'conclusionCode'] as const) if (text(args[key])) params[key] = String(args[key])
    const diffs = await ctx.session.call<Row>(`${RECON}.get#GeneratedOutputDifferences`, params)
    const { ok: _ok, messages: _messages, errors: _errors, differences, ...summary } = diffs
    return { fileName, output, ...summary, ...(listing ? { differences } : {}) }
  },
}

const audits: Command = {
  name: 'audits',
  summary: 'audits                                  the audits that run for this tenant',
  description: 'Lists the tenant\'s audits (for example month-close) with the id to pass to `report --audit` and `findings list --audit`.',
  input: NONE,
  tenant: 'required',
  async run(ctx) {
    const listed = await ctx.session.call<Row>('facade.AuditFacadeServices.get#Audits', {})
    return { audits: asRows(listed.audits).map((a) => (a.audit ?? a) as Row) }
  },
}

// The audit page's own documents (darpan.audit.report/v1, darpan.audit.finding/v1) over JSON-RPC, DAR-CLI-004: the
// JSON is primary and carries every record field the page shows; the GraphQL types are a reshaped subset.
const AUDIT = 'facade.AuditFacadeServices'
const AUDIT_PROP = { type: 'string', description: 'Audit code from `darpan audits`, such as month-close', default: 'month-close' } as const
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const CODE_RE = /^[A-Za-z0-9_-]+$/

/** The audit code (month-close by default) and, when given, the other values held to their shape. */
function auditParams(args: Record<string, unknown>, keys: { date?: boolean; period?: boolean; statement?: boolean; check?: boolean } = {}): Row {
  const audit = text(args.audit) ?? 'month-close'
  if (!/^[a-z0-9-]+$/.test(audit)) throw usageError('--audit is an audit code such as month-close', 'run `darpan audits`')
  const params: Row = { audit }
  const date = keys.date ? text(args.date) : undefined
  if (date !== undefined && !DAY_RE.test(date)) throw usageError('--date is YYYY-MM-DD', 'example: --date 2026-10-08')
  const period = keys.period ? text(args.period) : undefined
  if (period !== undefined && !PERIOD_RE.test(period)) throw usageError('--period is a period such as 2026-10 or 2026-Q4', 'example: --period 2026-10')
  const statement = keys.statement ? text(args.statement) : undefined
  if (statement !== undefined && !CODE_RE.test(statement)) throw usageError('--statement is one statement id, such as R2', 'run `darpan audit settings`')
  const check = keys.check ? text(args.check) : undefined
  if (check !== undefined && !CODE_RE.test(check)) throw usageError('--check is a check code, such as invoices-without-etail-id', 'run `darpan audit settings`')
  for (const [key, value] of Object.entries({ date, period, statement, check })) if (value !== undefined) params[key] = value
  return params
}

function findingId(value: unknown, command: string): string {
  const id = text(value)
  if (!id) throw usageError(`${command} needs a finding id, e.g. F-20790`, 'run `darpan findings list`')
  if (!CODE_RE.test(id)) throw usageError('a finding id looks like F-20790', 'run `darpan findings list`')
  return id
}

const report: Command = {
  name: 'report',
  summary: 'report [--audit <code>] [--date D] [--period P]   an audit report',
  description:
    'The audit report for one morning, as the audit page shows it (darpan.audit.report/v1): whether every source was read and every check ran, how many findings are open, new and fixed by category and statement, and up to 50 findings per statement with their records. Defaults to the month-close audit today. --period picks a period still being extended, e.g. 2026-10.',
  input: {
    type: 'object',
    properties: {
      audit: AUDIT_PROP,
      date: { type: 'string', description: 'The morning, YYYY-MM-DD; today in the tenant zone when left out' },
      period: { type: 'string', description: 'Which period\'s run, e.g. 2026-10 while October is extended' },
    },
  },
  tenant: 'required',
  async run(ctx, args) {
    const listed = await ctx.session.call<Row>(`${AUDIT}.get#AuditReport`, auditParams(args, { date: true, period: true }))
    if (!listed.report) throw new CliError('No report for that audit and morning.', EXIT.failed, 'run `darpan audits`, or try another --date')
    return listed.report
  },
}

const FINDINGS_PROPS: JsonSchemaObject['properties'] = {
  audit: { type: 'string', description: 'Audit code, such as month-close' },
  statement: { type: 'string', description: 'Rule id or list, e.g. R2,R8' },
  category: { type: 'string', description: 'Category id such as returns or refundsAndCredits (comma list)' },
  state: { type: 'string', description: 'open or fixed (comma list)' },
  period: { type: 'string', description: 'A year, quarter, month or day: 2026-10, 2026-Q4' },
  since: { type: 'string', description: 'First found on or after YYYY-MM-DD' },
  sort: { type: 'string', description: 'first-found or statement', default: 'first-found' },
  reverse: { type: 'boolean', description: 'Newest or last first' },
  first: { type: 'integer', description: 'Page size, 1 to 100', default: 50 },
  after: { type: 'string', description: 'Cursor from pageInfo.endCursor for the next page' },
  all: { type: 'boolean', description: 'Follow every page and return one document' },
}

const findingsList: Command = {
  name: 'findings list',
  summary: 'findings list [--state S] [--statement R] [--period P] [--all]   audit findings',
  description:
    'Lists audit findings: the orders, returns or payments that do not line up between systems. Filter by rule, category, state (open, fixed), period and first-found date. One page by default (pass --after for the next); --all follows every page into one document.',
  input: { type: 'object', properties: FINDINGS_PROPS },
  tenant: 'required',
  async run(ctx, args) {
    return listFindings(ctx.session, buildFindingsQuery(args))
  },
}

const findingsShow: Command = {
  name: 'findings show',
  summary: 'findings show <id>                      one finding in full',
  description:
    'One audit finding in full, as the audit page shows it (darpan.audit.finding/v1): every record involved in each system with its order, customer, SKU, location, channel, dates, totals and fulfilments, the evidence and amounts, the diagnosis, what to fix and where, and its history. Use an id such as F-20790 from `findings list` or `report`.',
  input: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Finding id, such as F-20790' } },
    required: ['id'],
  },
  tenant: 'required',
  positional: ['id'],
  async run(ctx, args) {
    const id = findingId(args.id, 'findings show')
    const got = await ctx.session.call<Row>(`${AUDIT}.get#AuditFinding`, { findingId: id })
    if (!got.finding) throw new CliError(`Finding ${id} was not found.`, EXIT.failed, 'run `darpan findings list`')
    return got.finding
  },
}

const findingsByOrder: Command = {
  name: 'findings by-order',
  summary: 'findings by-order [--audit <code>] [--statement R] [--period P]   open findings, one per order',
  description:
    'Every open finding of one audit, one row per order with its lines under it and the line holding it up named, each with its statement, category and cause in words: the audit page\'s board past its 50, and its export. Leave out --statement for every statement, --period for every period.',
  input: {
    type: 'object',
    properties: {
      audit: AUDIT_PROP,
      statement: { type: 'string', description: 'One statement id, such as R2; every statement when left out' },
      period: { type: 'string', description: 'The report period, e.g. 2026-10; every period when left out' },
    },
  },
  tenant: 'required',
  async run(ctx, args) {
    const params = auditParams(args, { statement: true, period: true })
    const listed = await ctx.session.call<Row>(`${AUDIT}.get#AuditFindingsByOrder`, params)
    return { ...params, findings: asRows(listed.findings) }
  },
}

const findingsRecheck: Command = {
  name: 'findings recheck',
  summary: 'findings recheck <id>                   re-check one finding now',
  description:
    'Re-checks one finding\'s record now, as the audit page\'s Re-check does: its check runs for that record only, each system read by key, and the finding closes if the problem is gone or is refreshed with today\'s cause. Runs in the background; `findings show` has the outcome once status.lastChecked moves. Needs user, editor or admin; writes nothing to NetSuite, HotWax OMS or Shopify.',
  input: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Finding id, such as F-20790' } },
    required: ['id'],
  },
  tenant: 'required',
  positional: ['id'],
  async run(ctx, args) {
    const id = findingId(args.id, 'findings recheck')
    const started = await ctx.session.call<Row>(`${AUDIT}.verify#AuditFinding`, { findingId: id })
    return { findingId: id, submitted: started.submitted === true, next: `darpan findings show ${id}  (status.lastChecked moves when the re-check is done)` }
  },
}

const auditProgress: Command = {
  name: 'audit progress',
  summary: 'audit progress [--audit <code>]         what the audit\'s checks are doing now',
  description:
    'The audit page\'s Run health while a play or the morning run is going: each automation with a run in progress or queued, the checks it feeds, its stage and progress, and whether it looks healthy, slow or stuck against its own last good run. Cheap enough to poll.',
  input: { type: 'object', properties: { audit: AUDIT_PROP } },
  tenant: 'required',
  async run(ctx, args) {
    const got = await ctx.session.call<Row>(`${AUDIT}.get#AuditProgress`, auditParams(args))
    return got.progress ?? {}
  },
}

const auditSettings: Command = {
  name: 'audit settings',
  summary: 'audit settings [--audit <code>]         the audit\'s statements, checks and schedule',
  description:
    'How an audit is set up: its name, its daily schedule, and each statement with its checks and the run each check reads. Gives the statement ids for `findings by-order --statement` and the check codes for `audit extracts --check`. Read only; settings change in the Darpan app.',
  input: { type: 'object', properties: { audit: AUDIT_PROP } },
  tenant: 'required',
  async run(ctx, args) {
    const got = await ctx.session.call<Row>(`${AUDIT}.get#AuditSettings`, auditParams(args))
    return got.settings ?? {}
  },
}

const auditExtracts: Command = {
  name: 'audit extracts',
  summary: 'audit extracts --check C --period P [--date D] [--system S]   what each system\'s read wrote for a check',
  description:
    'What each system\'s read wrote for one check on one morning: a row per system with how many records it read and its file. Add --system (NetSuite, OMS or Shopify, as the rows name it) for that file\'s content, as the audit page\'s extract download gives it. Empty when the check did not run that morning.',
  input: {
    type: 'object',
    properties: {
      audit: AUDIT_PROP,
      check: { type: 'string', description: 'Check code from `audit settings`, such as invoices-without-etail-id' },
      period: { type: 'string', description: 'The report period, e.g. 2026-10' },
      date: { type: 'string', description: 'The morning, YYYY-MM-DD; today in the tenant zone when left out' },
      system: { type: 'string', description: 'Return this system\'s file content' },
    },
    required: ['check', 'period'],
  },
  tenant: 'required',
  async run(ctx, args) {
    if (!text(args.check) || !text(args.period)) throw usageError('audit extracts needs --check and --period', 'run `darpan audit settings` for check codes; `darpan report` names the period')
    const params = auditParams(args, { check: true, period: true, date: true })
    const got = await ctx.session.call<Row>(`${AUDIT}.get#AuditCheckExtracts`, params)
    const extracts = asRows(got.extracts)
    const system = text(args.system)
    if (!system) return { ...params, extracts }
    const extract = extracts.find((e) => String(e.system ?? '').toLowerCase() === system.toLowerCase())
    if (!extract || !text(extract.filePath)) {
      const kept = extracts.map((e) => e.system).filter(Boolean).join(', ') || 'none'
      throw new CliError(`No ${system} extract was kept for that check and morning (kept: ${kept}).`, EXIT.failed, 'leave out --system to see what was kept')
    }
    const filePath = String(extract.filePath)
    const file = await ctx.session.call<Row>(`${RECON}.get#GeneratedOutput`, { fileName: filePath, format: filePath.endsWith('.csv') ? 'csv' : 'json' })
    return { ...params, extract, content: file.outputFile }
  },
}

const monthExport: Command = {
  name: 'month export',
  summary: 'month export --month YYYY-MM [--audit <code>] [--state open]   a month\'s open findings',
  description:
    'Every open finding of one month as a single document, for a month-close review. Same as `findings list --all --period <month> --state open`.',
  input: {
    type: 'object',
    properties: {
      month: { type: 'string', description: 'YYYY-MM' },
      audit: { type: 'string', description: 'Audit code, such as month-close' },
      state: { type: 'string', description: 'open or fixed (comma list)', default: 'open' },
    },
    required: ['month'],
  },
  tenant: 'required',
  async run(ctx, args) {
    return listFindings(ctx.session, monthExportQuery(args))
  },
}

// ---------------------------------------------------------------------------------------------------------------
// Fresh read-only queries and tenant scripts (Task 11).
// ---------------------------------------------------------------------------------------------------------------
const TS = 'facade.TenantScriptFacadeServices'
const MAX_INPUT_JSON = 2_000_000

const QUERY_METHOD: Record<SystemKind['system'], { method: string; idParam: string }> = {
  NetSuite: { method: 'facade.NetSuiteQueryFacadeServices.run#NsSuiteQlAgentQuery', idParam: 'nsAuthConfigId' },
  'HotWax OMS': { method: 'facade.HotWaxOmsFacadeServices.run#OmsGraphqlAgentQuery', idParam: 'omsRestSourceConfigId' },
  Shopify: { method: 'facade.ShopifyFacadeServices.run#ShopifyGraphqlAgentQuery', idParam: 'shopifyAuthConfigId' },
}

/** A positive integer with no leading zero, or undefined when the flag is absent. */
function positiveInt(args: Record<string, unknown>, key: string): number | undefined {
  if (args[key] === undefined) return undefined
  const raw = String(args[key])
  if (!/^[1-9][0-9]*$/.test(raw)) throw usageError(`--${key} must be a positive whole number (no leading zero).`, `example: --${key} 200`)
  return Number(raw)
}

/** A whole number from 0 with no leading zero (0 itself is fine), or undefined when the flag is absent. */
function nonNegativeInt(args: Record<string, unknown>, key: string): number | undefined {
  if (args[key] === undefined) return undefined
  const raw = String(args[key])
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw usageError(`--${key} must be a whole number from 0 (no leading zero).`, `example: --${key} 0`)
  return Number(raw)
}

/** Standard input for a `-` value. On a terminal there is nothing to read and the read would wait forever. */
export function readStdinText(isTTY: boolean | undefined, read: () => string): string {
  if (isTTY) throw usageError('`-` reads standard input; pipe the query in.', 'example: cat query.sql | darpan query run --connection <id> --suiteql -')
  return read()
}

const MAX_BODY = 64_000

/** A text input given either as a file (CLI only) or inline, exactly one. The file must be a regular file outside the
 *  darpan config dir (its sign-in key lives there), and is size-checked before it is read. */
function textInput(ctx: Ctx, fileFlag: string, inlineFlag: string, args: Record<string, unknown>, maxChars: number, what: string): string | undefined {
  const file = args[fileFlag]
  const inline = args[inlineFlag]
  if (file !== undefined && inline !== undefined) throw usageError(`Give --${fileFlag} or --${inlineFlag}, not both.`, `use one of them for the ${what}`)
  if (file === undefined && inline === undefined) return undefined
  let value: string
  if (inline !== undefined) {
    value = typeof inline === 'string' ? inline : JSON.stringify(inline)
    if (inline === true || value === '') throw usageError(`--${inlineFlag} needs the ${what} text.`, `example: --${inlineFlag} '...'`)
  } else {
    const path = text(file)
    if (!path || file === true) throw usageError(`--${fileFlag} needs a file path.`, `example: --${fileFlag} ./file`)
    let real: string
    try {
      real = realpathSync(path)
      const root = realpathSync(ctx.dir)
      if (real === root || real.startsWith(root + sep)) throw usageError(`--${fileFlag}: that file is inside the Darpan config folder and cannot be sent.`, `use a file outside ${'the config folder'}`)
      const info = statSync(real)
      if (!info.isFile()) throw usageError(`--${fileFlag}: ${path} is not a regular file.`, 'point it at an ordinary file')
      if (info.size > maxChars * 4) throw usageError(`--${fileFlag}: ${path} is ${info.size.toLocaleString('en-US')} bytes; the ${what} is limited to ${maxChars.toLocaleString('en-US')} characters.`, 'use a smaller file')
      value = readFileSync(real, 'utf8')
    } catch (error) {
      if (error instanceof CliError) throw error
      throw usageError(`--${fileFlag}: cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'}).`, `check the path given to --${fileFlag}`)
    }
  }
  if (value.length > maxChars) throw usageError(`The ${what} is ${value.length.toLocaleString('en-US')} characters; the limit is ${maxChars.toLocaleString('en-US')}.`, 'make it smaller')
  return value
}

const queryRun: Command = {
  name: 'query run',
  summary: 'query run --connection <id> (--suiteql <sql> | --graphql <doc> [--variables <json>]) [--limit N] [--offset N]   ask a system a fresh question (- reads the query from stdin)',
  description:
    'Asks one connection a fresh, read-only question right now, instead of reading a saved run. NetSuite takes --suiteql (a SELECT or WITH query); HotWax OMS and Shopify take --graphql (a GraphQL query, never a mutation) with optional --variables. Returns 200 rows by default and at most 2,000 (--limit, --offset to page); GraphQL answers over 5 MB are refused. Run `darpan describe <connectionId>` first to learn the record types and fields.',
  input: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'A connectionId from `darpan systems`' },
      suiteql: { type: 'string', description: 'NetSuite SuiteQL (SELECT or WITH)' },
      graphql: { type: 'string', description: 'GraphQL query for HotWax OMS or Shopify' },
      variables: { type: 'object', description: 'GraphQL variables as a JSON object' },
      limit: { type: 'integer', description: 'NetSuite rows to return, default 200, at most 2,000' },
      offset: { type: 'integer', description: 'NetSuite rows to skip, from 0 (use nextOffset from the last answer)' },
    },
    required: ['connection'],
  },
  tenant: 'required',
  async run(ctx, args) {
    const id = text(args.connection)
    if (!id) throw usageError('query run needs --connection <id>.', 'run `darpan systems`')
    const hasSql = args.suiteql !== undefined
    const hasGql = args.graphql !== undefined
    if (hasSql === hasGql) throw usageError('Give exactly one of --suiteql or --graphql.', 'NetSuite takes --suiteql; HotWax OMS and Shopify take --graphql')
    const limit = positiveInt(args, 'limit')
    const offset = nonNegativeInt(args, 'offset')
    let variables: Record<string, unknown> | undefined
    if (args.variables !== undefined) {
      if (!hasGql) throw usageError('--variables goes with --graphql.', 'drop --variables for a SuiteQL query')
      if (args.variables === null || typeof args.variables !== 'object' || Array.isArray(args.variables)) throw usageError('--variables must be a JSON object.', `example: --variables '{"first":10}'`)
      variables = args.variables as Record<string, unknown>
    }
    if ((limit !== undefined || offset !== undefined) && !hasSql) throw usageError('--limit and --offset page SuiteQL results; GraphQL pages with its own cursors in --variables.', 'drop --limit and --offset')
    let query = String(hasSql ? args.suiteql : args.graphql)
    if (query === '-') query = readStdinText(process.stdin.isTTY, ctx.stdin ?? (() => readFileSync(0, 'utf8')))
    if (!query.trim() || query === 'true') throw usageError(`--${hasSql ? 'suiteql' : 'graphql'} needs the query text (or - for standard input).`, 'pass the query as the flag value')

    const { connections } = await listConnections(ctx)
    const found = connections.find((c) => c.connectionId === id)
    if (!found) throw usageError(`"${id}" is not one of your connections.`, 'run `darpan systems` and use a connectionId from it')
    const sqlSystem = found.system === 'NetSuite'
    if (hasSql && !sqlSystem) throw usageError(`${found.system} connection ${id} takes --graphql, not --suiteql.`, `darpan query run --connection ${id} --graphql '<query>'`)
    if (hasGql && sqlSystem) throw usageError(`NetSuite connection ${id} takes --suiteql, not --graphql.`, `darpan query run --connection ${id} --suiteql '<SELECT ...>'`)

    const target = QUERY_METHOD[found.system]
    const params: Row = { [target.idParam]: id }
    if (sqlSystem) {
      params.sql = query
      if (limit !== undefined) params.limit = limit
      if (offset !== undefined) params.offset = offset
    } else {
      params.document = query
      if (variables) params.variables = variables
    }
    // A REFUSED / TIMEOUT / ERROR / THROTTLED answer is an ok:false envelope; the session maps it to exit 5 / 4.
    const answer = await ctx.session.call<Row>(target.method, params)
    const { ok: _ok, messages: _messages, errors: _errors, ...rest } = answer
    return rest
  },
}

const scripts: Command = {
  name: 'scripts',
  summary: 'scripts                                 the tenant\'s saved scripts',
  description:
    'Lists the tenant\'s saved scripts (name, body, profile, input) together with the d: functions a script may use and the size and time limits. Use it to find a scriptId before `script run`, `script save --id` or `deploy`.',
  input: NONE,
  tenant: 'required',
  async run(ctx) {
    const listed = await ctx.session.call<Row>(`${TS}.list#TenantScripts`, {})
    return { scripts: asRows(listed.scripts), library: asRows(listed.library), limits: listed.limits }
  },
}

const scriptRun: Command = {
  name: 'script run',
  summary: 'script run (--saved <id> | --body <file> | --body-text <script>) (--result <fileName> | --rows <json-file> | --rows-json <json> | --sample)   try a script',
  description:
    'Runs a script and returns what it gave back; nothing is saved or sent. Choose the script (a saved one with --saved, or a draft file with --body) and its input: --result <fileName> reads a run result file (from `darpan result`), --rows <json-file> feeds the output of `darpan query run` saved to a file (at most 2,000,000 characters), --sample uses the script\'s saved sample. A script error comes back as a result, not a failure.',
  input: {
    type: 'object',
    properties: {
      saved: { type: 'string', description: 'A tenantScriptId from `darpan scripts`' },
      body: { type: 'string', description: 'Path of a file holding the script text (CLI only)' },
      bodyText: { type: 'string', description: 'The script text itself, at most 64,000 characters' },
      profile: { type: 'string', description: 'EXPRESSION or SCRIPT (with a draft script)' },
      result: { type: 'string', description: 'A run result file name' },
      rows: { type: 'string', description: 'Path of a JSON file to use as the input (CLI only)' },
      rowsJson: { type: 'string', description: 'The input JSON itself, at most 2,000,000 characters (for example a `query run` answer)' },
      sample: { type: 'boolean', description: 'Use the saved sample input' },
    },
  },
  tenant: 'required',
  cliOnly: ['body', 'rows'],
  async run(ctx, args) {
    const saved = text(args.saved)
    const hasBody = args.body !== undefined || args.bodyText !== undefined
    if (!saved === !hasBody) throw usageError('Give exactly one of --saved <id>, --body <file> or --body-text <script>.', 'run `darpan scripts` for the saved ones')
    const inputs = [args.result !== undefined, args.rows !== undefined || args.rowsJson !== undefined, args.sample === true].filter(Boolean).length
    if (inputs !== 1) throw usageError('Give exactly one of --result <fileName>, --rows <json-file> / --rows-json <json>, or --sample.', 'example: --rows ./rows.json')
    const params: Row = {}
    if (saved) params.tenantScriptId = saved
    else {
      params.scriptBody = textInput(ctx, 'body', 'bodyText', args, MAX_BODY, 'script')
      if (text(args.profile)) params.scriptProfile = String(args.profile)
    }
    if (args.result !== undefined) {
      const fileName = text(args.result)
      if (!fileName || fileName === 'true') throw usageError('--result needs a run result file name.', 'run `darpan result <savedRunId>` to see it')
      params.inputSource = 'RUN_RESULT'
      params.fileName = fileName
    } else if (args.rows !== undefined || args.rowsJson !== undefined) {
      const rows = textInput(ctx, 'rows', 'rowsJson', args, MAX_INPUT_JSON, 'script input (2,000,000 characters at most; query fewer rows or columns)')!
      try {
        JSON.parse(rows)
      } catch {
        throw usageError('The rows input is not valid JSON.', 'pass the output of `darpan query run`')
      }
      params.inputSource = 'SAMPLE'
      params.inputJson = rows
    } else {
      params.inputSource = 'SAMPLE'
    }
    const { ok: _ok, messages: _messages, errors: _errors, ...rest } = await ctx.session.call<Row>(`${TS}.run#TenantScript`, params)
    return rest
  },
}

const scriptSave: Command = {
  name: 'script save',
  summary: 'script save --name <n> (--body <file> | --body-text <script>) [--id <id>] [--profile P] [--description D]   save a script',
  description:
    'Saves a script for the tenant from a file: a new one, or --id to change an existing one. The answer carries the validation result (problems and notes) so a bad script can be fixed before it is deployed. Try it first with `script run`.',
  input: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Script name, unique in the tenant' },
      body: { type: 'string', description: 'Path of a file holding the script text (CLI only)' },
      bodyText: { type: 'string', description: 'The script text itself, at most 64,000 characters' },
      id: { type: 'string', description: 'A tenantScriptId to update' },
      profile: { type: 'string', description: 'EXPRESSION or SCRIPT (default SCRIPT)' },
      description: { type: 'string', description: 'What the script is for' },
    },
    required: ['name'],
  },
  tenant: 'required',
  cliOnly: ['body'],
  async run(ctx, args) {
    const name = text(args.name)
    if (!name || args.name === true) throw usageError('script save needs --name <name>.', 'example: --name "Morning returns summary"')
    const body = textInput(ctx, 'body', 'bodyText', args, MAX_BODY, 'script')
    if (body === undefined) throw usageError('script save needs --body <file> or --body-text <script>.', 'example: --body ./script.jexl')
    const params: Row = { scriptName: name, scriptBody: body }
    if (text(args.id)) {
      // save#TenantScript rewrites every field it is not given (description, inputSource, sample input, on/off,
      // profile fall back to defaults), so an update resends what it is not changing.
      const id = String(args.id)
      const listed = await ctx.session.call<Row>(`${TS}.list#TenantScripts`, {})
      const existing = asRows(listed.scripts).find((s) => s.tenantScriptId === id)
      if (!existing) throw usageError(`"${id}" is not one of your scripts.`, 'run `darpan scripts`')
      params.tenantScriptId = id
      for (const key of ['description', 'scriptProfile', 'inputSource', 'sampleInputJson'] as const) if (text(existing[key])) params[key] = existing[key]
      params.isActive = existing.isActive !== 'N' && existing.isActive !== false
    }
    if (text(args.profile)) params.scriptProfile = String(args.profile)
    if (text(args.description)) params.description = String(args.description)
    const { ok: _ok, messages: _messages, errors: _errors, ...rest } = await ctx.session.call<Row>(`${TS}.save#TenantScript`, params)
    return rest
  },
}

const scriptDelete: Command = {
  name: 'script delete',
  summary: 'script delete <id>                     delete a saved script',
  description: 'Deletes one saved script by its tenantScriptId from `darpan scripts`. Deployments of it should be removed first with `deploy delete`.',
  input: { type: 'object', properties: { id: { type: 'string', description: 'A tenantScriptId' } }, required: ['id'] },
  tenant: 'required',
  positional: ['id'],
  async run(ctx, args) {
    const id = text(args.id)
    if (!id) throw usageError('script delete needs a script id.', 'run `darpan scripts`')
    await ctx.session.call(`${TS}.delete#TenantScript`, { tenantScriptId: id })
    return { deleted: true, tenantScriptId: id }
  },
}

async function listDeployments(ctx: Ctx, scriptId?: string): Promise<Row> {
  const { ok: _ok, messages: _messages, errors: _errors, ...rest } = await ctx.session.call<Row>(`${TS}.list#TenantScriptDeployments`, scriptId ? { tenantScriptId: scriptId } : {})
  return rest
}

async function findDeployment(ctx: Ctx, id: unknown): Promise<Row> {
  const wanted = text(id)
  if (!wanted) throw usageError('Give the deployment id.', 'run `darpan deployments`')
  const found = asRows((await listDeployments(ctx)).deployments).find((d) => d.tenantScriptDeploymentId === wanted)
  if (!found) throw usageError(`"${wanted}" is not one of your deployments.`, 'run `darpan deployments`')
  return found
}

const deployments: Command = {
  name: 'deployments',
  summary: 'deployments [--script <id>]            scheduled script deployments',
  description:
    'Lists the tenant\'s script deployments: which script runs on which schedule, over which saved run, posting to which chat space, whether it is on, and how its last run went. Schedules are read in the tenant\'s time zone, shown as timeZone.',
  input: { type: 'object', properties: { script: { type: 'string', description: 'Only deployments of this tenantScriptId' } } },
  tenant: 'required',
  async run(ctx, args) {
    return listDeployments(ctx, text(args.script))
  },
}

const DAILY = /^([01][0-9]|2[0-3]):([0-5][0-9])$/

const deploy: Command = {
  name: 'deploy',
  summary: 'deploy --script <id> --input <savedRunId> --space <chatSpaceId> (--daily HH:MM | --cron <expr>) [--on] [--id <deploymentId>]   schedule a script',
  description:
    'Schedules a saved script to run on its own and post its text to a chat space: --input is the saved run whose newest result it reads, --space the chat space, and the time is --daily HH:MM (24-hour, tenant time zone) or a Quartz --cron. It is saved switched OFF unless you pass --on; check it with `deploy preview` first. --id changes an existing deployment.',
  input: {
    type: 'object',
    properties: {
      script: { type: 'string', description: 'A tenantScriptId from `darpan scripts`' },
      input: { type: 'string', description: 'The savedRunId whose newest result the script reads' },
      space: { type: 'string', description: 'The chat space to post to' },
      daily: { type: 'string', description: 'Every day at HH:MM, 24-hour, tenant time zone' },
      cron: { type: 'string', description: 'A Quartz cron, e.g. 0 0 9 * * ?' },
      on: { type: 'boolean', description: 'Switch the deployment on (default off)' },
      id: { type: 'string', description: 'A tenantScriptDeploymentId to update' },
    },
    required: ['script', 'input', 'space'],
  },
  tenant: 'required',
  async run(ctx, args) {
    const script = text(args.script)
    const space = text(args.space)
    if (!script || args.script === true) throw usageError('deploy needs --script <id>.', 'run `darpan scripts`')
    if (!space || args.space === true) throw usageError('deploy needs --space <chatSpaceId>.', 'name the chat space to post to')
    if ((args.daily === undefined) === (args.cron === undefined)) throw usageError('Give exactly one of --daily HH:MM or --cron <expr>.', 'example: --daily 09:00')
    let scheduleExpr: string
    if (args.daily !== undefined) {
      const m = DAILY.exec(String(args.daily))
      if (!m) throw usageError('--daily must be HH:MM in 24-hour time.', 'example: --daily 09:00')
      scheduleExpr = `0 ${Number(m[2])} ${Number(m[1])} * * ?`
    } else {
      scheduleExpr = String(args.cron).trim()
      if (!scheduleExpr || scheduleExpr === 'true') throw usageError('--cron needs a Quartz expression.', 'example: --cron "0 0 9 * * ?"')
    }
    const input = text(args.input)
    if (!input || args.input === true) throw usageError('deploy needs --input <savedRunId>.', 'the saved run whose newest result the script reads; run `darpan runs`')
    const params: Row = { tenantScriptId: script, chatSpaceId: space, scheduleExpr, inputSavedRunId: input, isActive: args.on === true }
    if (text(args.id)) params.tenantScriptDeploymentId = String(args.id)
    const { ok: _ok, messages: _messages, errors: _errors, ...rest } = await ctx.session.call<Row>(`${TS}.save#TenantScriptDeployment`, params)
    return rest
  },
}

const DEPLOYMENT_ID = { type: 'object', properties: { id: { type: 'string', description: 'A tenantScriptDeploymentId from `darpan deployments`' } }, required: ['id'] } as const satisfies JsonSchemaObject

const deployOff: Command = {
  name: 'deploy off',
  summary: 'deploy off <id>                         switch a deployment off',
  description: 'Switches one deployment off, keeping its schedule, script and chat space, so it stops posting. Switch it on again with `deploy --id <id> ... --on`.',
  input: DEPLOYMENT_ID,
  tenant: 'required',
  positional: ['id'],
  async run(ctx, args) {
    const d = await findDeployment(ctx, args.id)
    const params: Row = {
      tenantScriptDeploymentId: d.tenantScriptDeploymentId,
      tenantScriptId: d.tenantScriptId,
      scheduleExpr: d.scheduleExpr,
      chatSpaceId: d.chatSpaceId,
      isActive: false,
    }
    if (text(d.inputSavedRunId)) params.inputSavedRunId = d.inputSavedRunId
    const { ok: _ok, messages: _messages, errors: _errors, ...rest } = await ctx.session.call<Row>(`${TS}.save#TenantScriptDeployment`, params)
    return rest
  },
}

const deployDelete: Command = {
  name: 'deploy delete',
  summary: 'deploy delete <id>                      delete a deployment',
  description: 'Deletes one deployment. The script itself stays.',
  input: DEPLOYMENT_ID,
  tenant: 'required',
  positional: ['id'],
  async run(ctx, args) {
    const id = text(args.id)
    if (!id) throw usageError('deploy delete needs a deployment id.', 'run `darpan deployments`')
    await ctx.session.call(`${TS}.delete#TenantScriptDeployment`, { tenantScriptDeploymentId: id })
    return { deleted: true, tenantScriptDeploymentId: id }
  },
}

/** Runs a deployment exactly as its schedule would (run#TenantScriptDeployment). The service answers ok even when
 *  nothing reached the chat space, so its outcome.status decides the exit: only `fine` statuses succeed. */
async function runDeployment(ctx: Ctx, id: unknown, send: boolean, fine: string[]): Promise<Row> {
  const wanted = text(id)
  if (!wanted) throw usageError('Give the deployment id.', 'run `darpan deployments`')
  const { ok: _ok, messages: _messages, errors: _errors, ...rest } = await ctx.session.call<Row>(`${TS}.run#TenantScriptDeployment`, { tenantScriptDeploymentId: wanted, send })
  const outcome = (rest.outcome ?? {}) as Row
  const status = text(outcome.status)
  if (!fine.includes(status)) {
    throw new CliError(text(outcome.message) || `The deployment ended ${status || 'without an outcome'}.`, EXIT.failed, 'run `darpan deployments` for its last outcome')
  }
  return { tenantScriptDeploymentId: wanted, ...rest }
}

const deployPreview: Command = {
  name: 'deploy preview',
  summary: 'deploy preview <id>                     what a deployment would post, without sending',
  description:
    'Shows what a deployment would post to its chat space right now, exactly as its schedule would run it (the script over the newest result of its input saved run). Nothing is sent and nothing is recorded.',
  input: DEPLOYMENT_ID,
  tenant: 'required',
  positional: ['id'],
  run: (ctx, args) => runDeployment(ctx, args.id, false, ['PREVIEW', 'NOTHING_TO_SEND']),
}

const deploySend: Command = {
  name: 'deploy send',
  summary: 'deploy send <id>                        post a deployment to its chat space now',
  description:
    'Runs a deployment now, exactly as its schedule would, and posts the text to its chat space; the outcome is stamped on the deployment. Fails when nothing was delivered (script error, no input yet, chat space gone). Use `deploy preview` first to see the text.',
  input: DEPLOYMENT_ID,
  tenant: 'required',
  positional: ['id'],
  run: (ctx, args) => runDeployment(ctx, args.id, true, ['SENT', 'NOTHING_TO_SEND']),
}

export const COMMANDS: Command[] = [
  login, logout, whoami, tenants, tenantUse, api, call,
  systems, describe, runs, runStart, runStatusCommand, runWait, result, audits, report, findingsList, findingsShow, findingsByOrder, findingsRecheck, monthExport,
  auditProgress, auditSettings, auditExtracts,
  queryRun, scripts, scriptRun, scriptSave, scriptDelete, deployments, deploy, deployOff, deployDelete, deployPreview, deploySend,
]

/** Longest command name that prefixes the positional words; the rest are its positionals. */
export function matchCommand(positionals: string[]): { command: Command; rest: string[] } | null {
  const sorted = [...COMMANDS].sort((a, b) => b.name.split(' ').length - a.name.split(' ').length)
  for (const command of sorted) {
    const words = command.name.split(' ')
    if (words.every((word, i) => positionals[i] === word)) return { command, rest: positionals.slice(words.length) }
  }
  return null
}

export { createSession }
