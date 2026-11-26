import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { run } from '../main.ts'
import { saveConfig } from '../config.ts'
import { COMMANDS, loadAllowedMethods, readStdinText } from '../commands.ts'
import { EXIT } from '../rpc.ts'
import { fakeBackend } from './fakeBackend.ts'

const NS_LIST = 'facade.NetSuiteQueryFacadeServices.list#NsAgentConnections'
const OMS_LIST = 'facade.HotWaxOmsFacadeServices.list#HotWaxOmsRestSourceConfigs'
const SH_LIST = 'facade.ShopifyFacadeServices.list#ShopifyAuthConfigs'
const ENDPOINTS = 'facade.SourceEndpointFacadeServices.list#SourceConfigEndpoints'
const NS_QUERY = 'facade.NetSuiteQueryFacadeServices.run#NsSuiteQlAgentQuery'
const OMS_QUERY = 'facade.HotWaxOmsFacadeServices.run#OmsGraphqlAgentQuery'
const SH_QUERY = 'facade.ShopifyFacadeServices.run#ShopifyGraphqlAgentQuery'

function workDir() {
  return mkdtempSync(join(tmpdir(), 'darpan-cli-qs-'))
}

async function go(argv: string[], handlers: Record<string, any>, stdin?: string, dir = workDir()) {
  const cfg = join(dir, 'cfg')
  saveConfig(cfg, { current: 'prod', instances: { prod: { url: 'https://api.test', token: 'KEY123', tenant: 'ACME' } } })
  const backend = fakeBackend(handlers)
  const out = await run(argv, { env: { DARPAN_CONFIG_DIR: cfg }, fetchImpl: backend.fetchImpl, openUrl: () => {}, sleep: async () => {}, stdin: () => stdin ?? '' })
  return { ...out, ...backend, dir }
}

const connections: Record<string, any> = {
  [NS_LIST]: () => ({ ok: true, connections: [{ nsAuthConfigId: 'NS1', description: 'acme NetSuite' }] }),
  [OMS_LIST]: () => ({ ok: true, omsRestSourceConfigs: [{ omsRestSourceConfigId: 'OMS1', description: 'acme OMS' }] }),
  [SH_LIST]: () => ({ ok: true, shopifyAuthConfigs: [{ shopifyAuthConfigId: 'SH1', description: 'acme Shopify' }] }),
  [ENDPOINTS]: () => ({ ok: true, endpoints: [] }),
}
const called = (r: { requests: { method: string }[] }, method: string) => r.requests.filter((q) => q.method === method)

test('query run routes by system', async () => {
  const handlers = {
    ...connections,
    [NS_QUERY]: () => ({ ok: true, rows: [{ id: '1' }], rowCount: 1, hasMore: false, truncated: false, durationMs: 5 }),
    [OMS_QUERY]: () => ({ ok: true, data: { orders: [] }, truncated: false }),
    [SH_QUERY]: () => ({ ok: true, data: { shop: { name: 'x' } }, truncated: false }),
  }
  const ns = await go(['query', 'run', '--connection', 'NS1', '--suiteql', 'SELECT id FROM transaction', '--limit', '50', '--offset', '100'], handlers)
  assert.equal(ns.exitCode, 0, ns.stderr)
  assert.deepEqual(called(ns, NS_QUERY)[0]!.params, { nsAuthConfigId: 'NS1', sql: 'SELECT id FROM transaction', limit: 50, offset: 100 })
  assert.deepEqual(JSON.parse(ns.stdout).rows, [{ id: '1' }])

  const oms = await go(['query', 'run', '--connection', 'OMS1', '--graphql', '{ orders { id } }', '--variables', '{"first":5}'], handlers)
  assert.equal(oms.exitCode, 0, oms.stderr)
  assert.deepEqual(called(oms, OMS_QUERY)[0]!.params, { omsRestSourceConfigId: 'OMS1', document: '{ orders { id } }', variables: { first: 5 } })

  const sh = await go(['query', 'run', '--connection', 'SH1', '--graphql', '-'], handlers, '{ shop { name } }\n')
  assert.equal(sh.exitCode, 0, sh.stderr)
  assert.equal(called(sh, SH_QUERY)[0]!.params.shopifyAuthConfigId, 'SH1')
  assert.equal(called(sh, SH_QUERY)[0]!.params.document.trim(), '{ shop { name } }')
})

test('--suiteql on an OMS connection is a usage error', async () => {
  const handlers = { ...connections, [OMS_QUERY]: () => ({ ok: true }), [NS_QUERY]: () => ({ ok: true }) }
  const a = await go(['query', 'run', '--connection', 'OMS1', '--suiteql', 'SELECT 1'], handlers)
  assert.equal(a.exitCode, EXIT.usage)
  assert.match(a.stderr, /--graphql/)
  const b = await go(['query', 'run', '--connection', 'NS1', '--graphql', '{ a }'], handlers)
  assert.equal(b.exitCode, EXIT.usage)
  assert.match(b.stderr, /--suiteql/)
  assert.equal(called(a, OMS_QUERY).length + called(b, NS_QUERY).length, 0)
})

test('query run refuses malformed flags before any query', async () => {
  const handlers = { ...connections, [NS_QUERY]: () => ({ ok: true, rows: [] }), [OMS_QUERY]: () => ({ ok: true }) }
  for (const argv of [
    ['query', 'run', '--connection', 'NS1', '--suiteql', 'SELECT 1', '--limit', '007'],
    ['query', 'run', '--connection', 'NS1', '--suiteql', 'SELECT 1', '--limit', '0'],
    ['query', 'run', '--connection', 'NS1', '--suiteql', 'SELECT 1', '--offset', '-1'],
    ['query', 'run', '--connection', 'OMS1', '--graphql', '{ a }', '--variables', '[1]'],
    ['query', 'run', '--connection', 'OMS1', '--graphql', '{ a }', '--variables', 'nope'],
    ['query', 'run', '--connection', 'NS1'],
    ['query', 'run', '--connection', 'NS1', '--suiteql', 'SELECT 1', '--graphql', '{ a }'],
    ['query', 'run', '--suiteql', 'SELECT 1'],
    ['query', 'run', '--connection', 'NOPE', '--suiteql', 'SELECT 1'],
  ]) {
    const r = await go(argv, handlers)
    assert.equal(r.exitCode, EXIT.usage, `${argv.join(' ')}: ${r.stderr}`)
    assert.equal(called(r, NS_QUERY).length + called(r, OMS_QUERY).length, 0)
  }
})

test('a REFUSED query exits 5 with the server\'s reason', async () => {
  const r = await go(['query', 'run', '--connection', 'NS1', '--suiteql', 'DELETE FROM x'], {
    ...connections,
    [NS_QUERY]: () => ({ ok: false, code: 'REFUSED', error: 'Only SELECT or WITH queries are allowed.\u001b[31m' }),
  })
  assert.equal(r.exitCode, EXIT.failed)
  assert.match(r.stderr, /Only SELECT or WITH queries are allowed/)
  assert.ok(!r.stderr.includes('\u001b'))
  for (const code of ['TIMEOUT', 'ERROR']) {
    const t = await go(['query', 'run', '--connection', 'NS1', '--suiteql', 'SELECT 1'], { ...connections, [NS_QUERY]: () => ({ ok: false, code, error: `${code} reason` }) })
    assert.equal(t.exitCode, EXIT.failed)
    assert.match(t.stderr, new RegExp(`${code} reason`))
  }
})

test('a THROTTLED query exits 4 with retryAfterSeconds', async () => {
  const r = await go(['query', 'run', '--connection', 'NS1', '--suiteql', 'SELECT 1'], { ...connections, [NS_QUERY]: () => ({ ok: false, code: 'THROTTLED', error: 'Too many queries.', retryAfterSeconds: 12 }) })
  assert.equal(r.exitCode, EXIT.throttled)
  assert.match(r.stderr, /12/)
  const body = JSON.parse(r.stderr.split('\n').pop()!)
  assert.equal(body.retryAfterSeconds, 12)
  assert.equal(body.code, 'THROTTLED')
  assert.match(body.next, /12 seconds/)
})

test('- on a terminal is a usage error, not a hang', () => {
  assert.throws(() => readStdinText(true, () => { throw new Error('must not read') }), (e: any) => e.exitCode === EXIT.usage && /pipe the query in/.test(e.message))
  assert.equal(readStdinText(false, () => 'SELECT 1'), 'SELECT 1')
  assert.equal(readStdinText(undefined, () => 'x'), 'x')
})

test('every method query run uses is allowlisted, and the command is described', () => {
  const allowed = new Set(loadAllowedMethods().map((m) => m.method))
  for (const m of [NS_QUERY, OMS_QUERY, SH_QUERY, NS_LIST, OMS_LIST, SH_LIST]) {
    assert.ok(allowed.has(m), `${m} not allowlisted`)
  }
  const q = COMMANDS.find((x) => x.name === 'query run')!
  assert.equal(q.tenant, 'required')
  assert.match(q.description, /read-only/i)
  assert.match(q.description, /2,000/)
  assert.match(q.description, /darpan describe/)
})

test('final review minor: --offset 0 is accepted, a leading zero is not', async () => {
  const handlers = { ...connections, [NS_QUERY]: () => ({ ok: true, rows: [], rowCount: 0, hasMore: false, truncated: false, durationMs: 1 }) }
  const zero = await go(['query', 'run', '--connection', 'NS1', '--suiteql', 'SELECT 1', '--offset', '0'], handlers)
  assert.equal(zero.exitCode, 0, zero.stderr)
  assert.equal(called(zero, NS_QUERY)[0]!.params.offset, 0)
  const bad = await go(['query', 'run', '--connection', 'NS1', '--suiteql', 'SELECT 1', '--offset', '01'], handlers)
  assert.equal(bad.exitCode, EXIT.usage)
})
