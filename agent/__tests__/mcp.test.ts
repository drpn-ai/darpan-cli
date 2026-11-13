import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { buildCtx, run } from '../main.ts'
import { saveConfig } from '../config.ts'
import { COMMANDS } from '../commands.ts'
import { GUIDE } from '../guide.ts'
import { ADDITIVE, DESTRUCTIVE, READ_ONLY, mcpCommands, runMcp, toolName } from '../mcp.ts'
import { fakeBackend } from './fakeBackend.ts'

const SESSION = 'facade.AuthFacadeServices.get#SessionInfo'

function setup(signedIn = true) {
  const dir = mkdtempSync(join(tmpdir(), 'darpan-cli-mcp-'))
  const cfg = join(dir, 'cfg')
  saveConfig(cfg, signedIn ? { current: 'prod', instances: { prod: { url: 'https://api.test', token: 'KEY123', tenant: 'ACME' } } } : { current: '', instances: {} })
  return { dir, cfg }
}

/** Feed lines to the server, collect everything it writes to stdout. */
async function serve(lines: unknown[], cfg: string, handlers: Record<string, any> = {}, rawLines: string[] = []) {
  const backend = fakeBackend(handlers)
  const options = { env: { DARPAN_CONFIG_DIR: cfg }, fetchImpl: backend.fetchImpl, openUrl: () => {}, sleep: async () => {} }
  const input = new PassThrough()
  const output = new PassThrough()
  let text = ''
  output.on('data', (chunk) => (text += chunk))
  const done = runMcp(input, output, (command, tenant) => buildCtx(command, options, { tenant }).ctx)
  for (const line of lines) input.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`)
  for (const raw of rawLines) input.write(`${raw}\n`)
  input.end()
  await done
  return { text, replies: text.split('\n').filter(Boolean).map((l) => JSON.parse(l)), ...backend }
}

const call = (id: number, name: string, args?: unknown) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
const whoamiHandlers = {
  [SESSION]: () => ({ ok: true, userAccountId: 'U1', username: 'a@b.c', canRun: true, canEdit: false, canManageDarpanCore: false, tenant: { id: 'ACME', label: 'Acme' }, tenants: [{ id: 'ACME', label: 'Acme' }] }),
}

test('initialize returns tools capability and the guide as instructions', async () => {
  const { cfg } = setup()
  const { replies } = await serve([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }], cfg)
  assert.equal(replies.length, 1, 'the notification gets no reply')
  const r = replies[0].result
  assert.equal(r.protocolVersion, '2025-03-26')
  assert.deepEqual(r.capabilities, { tools: {} })
  assert.equal(r.serverInfo.name, 'darpan')
  assert.equal(r.instructions, GUIDE)
  const other = await serve([{ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }], cfg)
  assert.equal(other.replies[0].result.protocolVersion, '2025-11-25')
})

test('tools/list matches the command table', async () => {
  const { cfg } = setup()
  const { replies } = await serve([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], cfg)
  const tools = replies[0].result.tools
  const expected = COMMANDS.filter((c) => !['login', 'logout', 'tenant use'].includes(c.name))
  assert.equal(tools.length, expected.length)
  assert.deepEqual(tools.map((t: any) => t.name), expected.map((c) => `darpan_${c.name.replace(/ /g, '_')}`))
  for (const t of tools) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/)
    assert.equal(t.inputSchema.type, 'object')
  }
  assert.ok(tools.some((t: any) => t.name === 'darpan_call') && tools.some((t: any) => t.name === 'darpan_api'))
})

test('every MCP tool is classed exactly once, and tools/list says which ones read and which can overwrite', async () => {
  for (const c of mcpCommands()) {
    const sets = [READ_ONLY, ADDITIVE, DESTRUCTIVE].filter((s) => s.has(c.name)).length
    assert.equal(sets, 1, `${c.name} must be in exactly one of READ_ONLY, ADDITIVE, DESTRUCTIVE`)
  }
  for (const name of [...READ_ONLY, ...ADDITIVE, ...DESTRUCTIVE]) assert.ok(mcpCommands().some((c) => c.name === name), `${name} is not an MCP command`)
  const { cfg } = setup()
  const { replies } = await serve([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], cfg)
  const byName = new Map<string, any>(replies[0].result.tools.map((t: any) => [t.name, t]))
  assert.deepEqual(byName.get('darpan_findings_list').annotations, { readOnlyHint: true })
  assert.deepEqual(byName.get('darpan_run_start').annotations, { readOnlyHint: false, destructiveHint: false })
  assert.deepEqual(byName.get('darpan_script_delete').annotations, { readOnlyHint: false, destructiveHint: true })
  assert.deepEqual(byName.get('darpan_call').annotations, { readOnlyHint: false, destructiveHint: true }, 'call can reach any allowlisted write')
})

test('no MCP tool schema exposes a cliOnly property, and a call that passes one is refused unread', async () => {
  const { cfg, dir } = setup()
  const { replies } = await serve([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], cfg)
  const byName = new Map(replies[0].result.tools.map((t: any) => [t.name, t]))
  let checked = 0
  for (const c of COMMANDS.filter((c) => c.cliOnly?.length)) {
    const tool: any = byName.get(toolName(c))
    for (const prop of c.cliOnly!) {
      checked += 1
      assert.equal(prop in tool.inputSchema.properties, false, `${c.name}.${prop}`)
      assert.equal((tool.inputSchema.required ?? []).includes(prop), false)
    }
  }
  assert.ok(checked >= 3)
  assert.ok('bodyText' in (byName.get('darpan_script_run') as any).inputSchema.properties)
  assert.ok('rowsJson' in (byName.get('darpan_script_run') as any).inputSchema.properties)
  const secret = join(dir, 'script.js')
  writeFileSync(secret, 'SECRET-BODY')
  const r = await serve([call(2, 'darpan_script_run', { saved: 'x', body: secret, sample: true }), call(3, 'darpan_script_save', { name: 'n', body: secret })], cfg)
  for (const reply of r.replies) {
    assert.equal(reply.result.isError, true)
    assert.match(JSON.parse(reply.result.content[0].text).error, /local file/)
  }
  assert.equal(r.requests.length, 0, 'nothing was sent')
})

test('login, logout and tenant use are not tools', async () => {
  const { cfg } = setup()
  const { replies } = await serve([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, call(2, 'darpan_login', {})], cfg)
  const names = replies[0].result.tools.map((t: any) => t.name)
  for (const n of ['darpan_login', 'darpan_logout', 'darpan_tenant_use']) assert.equal(names.includes(n), false)
  assert.equal(replies[1].error.code, -32602)
})

test('tools/call runs a command with the same output as the CLI', async () => {
  const { cfg } = setup()
  const viaMcp = await serve([call(1, 'darpan_whoami', {})], cfg, whoamiHandlers)
  const result = viaMcp.replies[0].result
  assert.equal(result.isError, false)
  const cli = await run(['whoami'], { env: { DARPAN_CONFIG_DIR: cfg }, fetchImpl: fakeBackend(whoamiHandlers).fetchImpl })
  assert.equal(cli.exitCode, 0, cli.stderr)
  assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(cli.stdout))
  assert.equal(result.content[0].type, 'text')
})

test('a forbidden call is isError with next', async () => {
  const { cfg } = setup()
  const r = await serve([call(1, 'darpan_whoami', {})], cfg, { [SESSION]: () => ({ rpcError: 'This is not one of your tenants.' }) })
  const res = r.replies[0].result
  assert.equal(res.isError, true)
  const body = JSON.parse(res.content[0].text)
  assert.ok(body.error)
  assert.ok(typeof body.next === 'string' && body.next.length > 0)
})

test('a throttled answer carries retryAfterSeconds in the error JSON', async () => {
  const { cfg } = setup()
  const r = await serve([call(1, 'darpan_whoami', {})], cfg, { [SESSION]: () => ({ ok: false, code: 'THROTTLED', retryAfterSeconds: 7, errors: ['slow down'] }) })
  const body = JSON.parse(r.replies[0].result.content[0].text)
  assert.equal(r.replies[0].result.isError, true)
  assert.equal(body.code, 'THROTTLED')
  assert.equal(body.retryAfterSeconds, 7)
})

test('not signed in answers isError with the login hint, and a login in another terminal takes effect without a restart', async () => {
  const { cfg } = setup(false)
  const input = new PassThrough()
  const output = new PassThrough()
  let text = ''
  output.on('data', (c) => (text += c))
  const backend = fakeBackend(whoamiHandlers)
  const options = { env: { DARPAN_CONFIG_DIR: cfg }, fetchImpl: backend.fetchImpl }
  const done = runMcp(input, output, (command, tenant) => buildCtx(command, options, { tenant }).ctx)
  input.write(`${JSON.stringify(call(1, 'darpan_whoami', {}))}\n`)
  await new Promise((r) => setTimeout(r, 50))
  const first = JSON.parse(text.split('\n')[0]!).result
  assert.equal(first.isError, true)
  assert.match(JSON.parse(first.content[0].text).next, /darpan login. in a terminal/)
  saveConfig(cfg, { current: 'prod', instances: { prod: { url: 'https://api.test', token: 'KEY123', tenant: 'ACME' } } })
  input.write(`${JSON.stringify(call(2, 'darpan_whoami', {}))}\n`)
  input.end()
  await done
  assert.equal(JSON.parse(text.split('\n')[1]!).result.isError, false)
})

test('bad arguments are isError and nothing is sent', async () => {
  const { cfg } = setup()
  const r = await serve([call(1, 'darpan_whoami', { surprise: 1 }), call(2, 'darpan_run_status', {}), call(3, 'darpan_runs', 'x')], cfg)
  for (const reply of r.replies) assert.equal(reply.result.isError, true)
  assert.equal(r.requests.length, 0)
})

test('standard input is never read for a - value', async () => {
  const { cfg } = setup()
  const handlers = { 'facade.NetSuiteQueryFacadeServices.list#NsAgentConnections': () => ({ ok: true, connections: [{ nsAuthConfigId: 'NS1', description: 'x' }] }), 'facade.HotWaxOmsFacadeServices.list#HotWaxOmsRestSourceConfigs': () => ({ ok: true, omsRestSourceConfigs: [] }), 'facade.ShopifyFacadeServices.list#ShopifyAuthConfigs': () => ({ ok: true, shopifyAuthConfigs: [] }), 'facade.SourceEndpointFacadeServices.list#SourceConfigEndpoints': () => ({ ok: true, endpoints: [] }) }
  const r = await serve([call(1, 'darpan_query_run', { connection: 'NS1', suiteql: '-' })], cfg, handlers)
  assert.equal(r.replies[0].result.isError, true)
  assert.match(r.replies[0].result.content[0].text, /standard input/)
})

test('stdout carries only JSON-RPC lines', async () => {
  const { cfg } = setup()
  const r = await serve([{ jsonrpc: '2.0', id: 1, method: 'ping' }, call(2, 'darpan_whoami', {}), { jsonrpc: '2.0', id: 3, method: 'nope' }], cfg, whoamiHandlers, ['{not json'])
  const lines = r.text.split('\n').filter(Boolean)
  assert.equal(lines.length, 4)
  for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, '2.0')
  assert.ok(!r.text.includes('KEY123'), 'the token is never written')
})

test('unknown method answers -32601 and bad JSON answers -32700', async () => {
  const { cfg } = setup()
  const r = await serve([{ jsonrpc: '2.0', id: 9, method: 'resources/list' }], cfg, {}, ['{not json'])
  const byId = (id: unknown) => r.replies.find((x) => x.id === id)
  assert.equal(byId(9).error.code, -32601)
  assert.equal(byId(null).error.code, -32700)
})

test('darpan guide prints the guide; plain, no bold', async () => {
  const out = await run(['guide'], { env: {} })
  assert.equal(out.exitCode, 0)
  assert.equal(out.stdout, GUIDE)
  assert.ok(!GUIDE.includes('**'))
  for (const word of ['whoami', 'SELECT', 'mutations', '2,000', '60 seconds', '5 MB', 'editor', 'automations', 'NetSuite']) assert.ok(GUIDE.includes(word), word)
})

test('a per-call tenant argument reaches the request header and is never saved; no saved tenant gets an MCP-specific next', async () => {
  const { cfg } = setup()
  const handlers = { 'facade.NetSuiteQueryFacadeServices.list#NsAgentConnections': () => ({ ok: true, connections: [] }), 'facade.HotWaxOmsFacadeServices.list#HotWaxOmsRestSourceConfigs': () => ({ ok: true, omsRestSourceConfigs: [] }), 'facade.ShopifyFacadeServices.list#ShopifyAuthConfigs': () => ({ ok: true, shopifyAuthConfigs: [] }), 'facade.SourceEndpointFacadeServices.list#SourceConfigEndpoints': () => ({ ok: true, endpoints: [] }) }
  const r = await serve([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, call(2, 'darpan_systems', { tenant: 'GLBX' }), call(3, 'darpan_whoami', { tenant: 'GLBX' }), call(4, 'darpan_toString', {}), call(5, 'darpan_systems', { constructor: 1 })], cfg, handlers)
  const tools = r.replies.find((x) => x.id === 1).result.tools
  assert.ok(tools.find((x: any) => x.name === 'darpan_systems').inputSchema.properties.tenant)
  assert.equal(r.replies.find((x) => x.id === 2).result.isError, false, r.replies.find((x) => x.id === 2).result.content[0].text)
  assert.ok(r.requests.length > 0 && r.requests.every((q) => q.headers['X-Darpan-Tenant'] === 'GLBX'), JSON.stringify(r.requests.map((q) => q.headers)))
  assert.equal(r.requests.filter((q) => q.method === SESSION).every((q) => q.headers['X-Darpan-Tenant'] === 'GLBX'), true, 'whoami takes the per-call tenant (final review Important 3b)')
  assert.equal(r.replies.find((x) => x.id === 5).result.isError, true)
  assert.match(r.replies.find((x) => x.id === 5).result.content[0].text, /unknown argument/)
  const saved = JSON.parse(readFileSync(join(cfg, 'config.json'), 'utf8'))
  assert.equal(saved.instances.prod.tenant, 'ACME')
  const bare = setup(true)
  saveConfig(bare.cfg, { current: 'prod', instances: { prod: { url: 'https://api.test', token: 'KEY123' } } })
  const n = await serve([call(1, 'darpan_systems', {})], bare.cfg, handlers)
  assert.match(JSON.parse(n.replies[0].result.content[0].text).next, /darpan_tenants/)
})

test('final review minor: limit, offset and first are integers over MCP, and no MCP description mentions standard input', async () => {
  const { cfg } = setup()
  const handlers = {
    'facade.NetSuiteQueryFacadeServices.list#NsAgentConnections': () => ({ ok: true, connections: [{ nsAuthConfigId: 'NS1', description: 'NS' }] }),
    'facade.HotWaxOmsFacadeServices.list#HotWaxOmsRestSourceConfigs': () => ({ ok: true, omsRestSourceConfigs: [] }),
    'facade.ShopifyFacadeServices.list#ShopifyAuthConfigs': () => ({ ok: true, shopifyAuthConfigs: [] }),
    'facade.SourceEndpointFacadeServices.list#SourceConfigEndpoints': () => ({ ok: true, endpoints: [] }),
    'facade.NetSuiteQueryFacadeServices.run#NsSuiteQlAgentQuery': () => ({ ok: true, rows: [], rowCount: 0, hasMore: false, truncated: false }),
  }
  const r = await serve([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, call(2, 'darpan_query_run', { connection: 'NS1', suiteql: 'SELECT 1', limit: 5, offset: 0 }),
    call(3, 'darpan_query_run', { connection: 'NS1', suiteql: 'SELECT 1', limit: '5' })], cfg, handlers)
  const tools = r.replies.find((x) => x.id === 1).result.tools
  const byName = (n: string) => tools.find((t: any) => t.name === n)
  assert.equal(byName('darpan_query_run').inputSchema.properties.limit.type, 'integer')
  assert.equal(byName('darpan_query_run').inputSchema.properties.offset.type, 'integer')
  assert.equal(byName('darpan_result').inputSchema.properties.first.type, 'integer')
  assert.equal(byName('darpan_findings_list').inputSchema.properties.first.type, 'integer')
  assert.equal(r.replies.find((x) => x.id === 2).result.isError, false, r.replies.find((x) => x.id === 2).result.content[0].text)
  assert.deepEqual(r.requests.find((q) => q.method === 'facade.NetSuiteQueryFacadeServices.run#NsSuiteQlAgentQuery')!.params, { nsAuthConfigId: 'NS1', sql: 'SELECT 1', limit: 5, offset: 0 })
  assert.equal(r.replies.find((x) => x.id === 3).result.isError, true)
  for (const t of tools) assert.doesNotMatch(JSON.stringify([t.description, t.inputSchema]), /standard input|`-`/, t.name)
})

test('final review Important 3b: darpan_whoami takes the per-call tenant and labels it', async () => {
  const { cfg } = setup()
  const handlers = { [SESSION]: (_p: any, req: any) => ({ ok: true, sessionInfo: { username: 'a', activeTenantUserGroupId: req.headers['X-Darpan-Tenant'],
    activeTenantPermissionGroupIds: ['DARPAN_TENANT_ADMIN'], availableTenants: [{ userGroupId: 'ACME', label: 'Acme' }, { userGroupId: 'GLBX', label: 'Globex' }] } }) }
  const r = await serve([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, call(2, 'darpan_whoami', { tenant: 'GLBX' })], cfg, handlers)
  assert.ok(r.replies.find((x) => x.id === 1).result.tools.find((t: any) => t.name === 'darpan_whoami').inputSchema.properties.tenant)
  const reply = r.replies.find((x) => x.id === 2).result
  assert.equal(reply.isError, false, reply.content[0].text)
  const out = JSON.parse(reply.content[0].text)
  assert.deepEqual(out.tenant, { id: 'GLBX', label: 'Globex' })
  assert.equal(out.role, 'admin')
  assert.equal(r.requests[0]!.headers['X-Darpan-Tenant'], 'GLBX')
})
