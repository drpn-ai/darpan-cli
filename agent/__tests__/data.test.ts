import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { run } from '../main.ts'
import { saveConfig } from '../config.ts'
import { COMMANDS, loadAllowedMethods, matchCommand } from '../commands.ts'
import { EXIT } from '../rpc.ts'
import { fakeBackend } from './fakeBackend.ts'

const URL_ = 'https://api.test'
const NS_LIST = 'facade.NetSuiteQueryFacadeServices.list#NsAgentConnections'
const OMS_LIST = 'facade.HotWaxOmsFacadeServices.list#HotWaxOmsRestSourceConfigs'
const SH_LIST = 'facade.ShopifyFacadeServices.list#ShopifyAuthConfigs'
const ENDPOINTS = 'facade.SourceEndpointFacadeServices.list#SourceConfigEndpoints'
const NS_OPTIONS = 'facade.NetSuiteQueryFacadeServices.get#NsSuiteQlQueryOptions'
const NS_QUERIES = 'facade.NetSuiteQueryFacadeServices.list#NsSuiteQlSourceQueries'
const OMS_SCHEMA = 'facade.HotWaxOmsFacadeServices.get#OmsGraphqlSchema'
const SAVED_RUNS = 'facade.ReconciliationFacadeServices.list#SavedRuns'
const RUN_DIFF = 'facade.ReconciliationFacadeServices.run#SavedRunDiff'
const RUN_STATUS = 'facade.ReconciliationFacadeServices.get#ReconciliationRunStatus'
const OUTPUTS = 'facade.ReconciliationFacadeServices.list#GeneratedOutputs'
const OUTPUT_DIFFS = 'facade.ReconciliationFacadeServices.get#GeneratedOutputDifferences'
const AUDITS = 'facade.AuditFacadeServices.get#Audits'

function signedIn() {
  const dir = mkdtempSync(join(tmpdir(), 'darpan-cli-data-'))
  saveConfig(dir, { current: 'prod', instances: { prod: { url: URL_, token: 'KEY123', tenant: 'ACME' } } })
  return dir
}

async function go(argv: string[], handlers: Record<string, any>) {
  const backend = fakeBackend(handlers)
  const out = await run(argv, { env: { DARPAN_CONFIG_DIR: signedIn() }, fetchImpl: backend.fetchImpl, openUrl: () => {}, sleep: async () => {} })
  return { ...out, ...backend }
}

const SECRETS = { password: 'PW-SECRET', privateKey: 'PK-SECRET', clientSecret: 'CS-SECRET', apiToken: 'TOKEN-SECRET', accessToken: 'AT-SECRET', host: 'host.secret.example', baseUrl: 'https://base.secret.example', shopApiUrl: 'https://shop.secret.example' }
const endpoints = () => ({ ok: true, endpoints: [{ systemEnumId: 'ENUM_X', endpointLabel: 'Sales orders', isEnabled: true }] })
const connections: Record<string, any> = {
  [NS_LIST]: () => ({ ok: true, connections: [{ nsAuthConfigId: 'NS1', description: 'acme NetSuite', authType: 'OAUTH2', ...SECRETS }] }),
  [OMS_LIST]: () => ({ ok: true, omsRestSourceConfigs: [{ omsRestSourceConfigId: 'OMS1', description: 'acme OMS', ...SECRETS }] }),
  [SH_LIST]: () => ({ ok: true, shopifyAuthConfigs: [{ shopifyAuthConfigId: 'SH1', description: 'acme Shopify', ...SECRETS }] }),
  [ENDPOINTS]: endpoints,
}

test('systems emits only the allowlisted keys', async () => {
  const r = await go(['systems'], connections)
  assert.equal(r.exitCode, 0, r.stderr)
  for (const secret of Object.values(SECRETS)) assert.ok(!r.stdout.includes(secret), `${secret} leaked`)
  const out = JSON.parse(r.stdout)
  assert.deepEqual(out.connections.map((c: any) => c.system), ['NetSuite', 'HotWax OMS', 'Shopify'])
  for (const c of out.connections) assert.deepEqual(Object.keys(c).sort(), ['connectionId', 'description', 'endpoints', 'name', 'system'])
  assert.deepEqual(out.connections[0].endpoints, [{ label: 'Sales orders', enabled: true }])
  assert.deepEqual(r.requests.find((q) => q.method === ENDPOINTS)!.params, { configTypeEnumId: 'SCFG_NS_AUTH', configId: 'NS1' })
})

test('systems skips a system whose list method is unknown', async () => {
  const r = await go(['systems'], { ...connections, [SH_LIST]: () => ({ rpcError: 'No service found with name facade.ShopifyFacadeServices.list#ShopifyAuthConfigs' }) })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).connections.map((c: any) => c.system), ['NetSuite', 'HotWax OMS'])
})

test('systems reports a fenced list as unavailable instead of failing', async () => {
  const r = await go(['systems'], { ...connections, [OMS_LIST]: () => ({ rpcError: 'facade.HotWaxOmsFacadeServices.list#HotWaxOmsRestSourceConfigs is not available to the Darpan CLI; use the app.' }) })
  assert.equal(r.exitCode, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.connections.length, 2)
  assert.equal(out.unavailable[0].system, 'HotWax OMS')
  assert.match(out.unavailable[0].reason, /not available/)
})

const savedRuns = () => ({
  ok: true,
  pagination: { pageIndex: 0, pageSize: 200, totalCount: 2, pageCount: 1 },
  savedRuns: [
    { savedRunId: 'R1', runName: 'Shopify vs NetSuite orders', runType: 'ruleset', isActive: true, systemOptions: [{ label: 'Shopify', sourceConfigId: 'SH1', sourceConfigType: 'SCFG_SHOPIFY_AUTH', extractParametersJson: '{"secret":1}' }, { label: 'NetSuite', sourceConfigId: 'NS1', sourceConfigType: 'SCFG_NS_AUTH' }] },
    { savedRunId: 'R2', runName: 'OMS only', runType: 'mapping', isActive: true, systemOptions: [{ label: 'HotWax OMS', sourceConfigId: 'OMS1' }] },
  ],
})

test('describe for NetSuite names the saved runs that read it', async () => {
  const r = await go(['describe', 'NS1'], {
    ...connections,
    [NS_OPTIONS]: () => ({ ok: true, options: { recordTypes: ['transaction', 'item'] } }),
    [NS_QUERIES]: () => ({ ok: true, queries: [{ queryName: 'open invoices' }] }),
    [SAVED_RUNS]: savedRuns,
  })
  assert.equal(r.exitCode, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.system, 'NetSuite')
  assert.equal(out.connectionId, 'NS1')
  assert.deepEqual(out.savedRuns.map((s: any) => s.savedRunId), ['R1'])
  assert.deepEqual(out.recordTypes, { recordTypes: ['transaction', 'item'] })
  assert.match(out.howToQuery, /darpan query run --connection NS1 --suiteql/)
  assert.ok(!r.stdout.includes('"secret"'), 'extract parameters are not echoed')
})

test('describe for OMS reads its GraphQL schema', async () => {
  const r = await go(['describe', 'OMS1'], { ...connections, [OMS_SCHEMA]: () => ({ ok: true, schema: { types: ['Order'] } }), [SAVED_RUNS]: savedRuns })
  const out = JSON.parse(r.stdout)
  assert.equal(out.system, 'HotWax OMS')
  assert.deepEqual(out.schema, { types: ['Order'] })
  assert.deepEqual(out.savedRuns.map((s: any) => s.savedRunId), ['R2'])
  assert.match(out.howToQuery, /--graphql/)
  assert.equal(r.requests.find((q) => q.method === OMS_SCHEMA)!.params.omsRestSourceConfigId, 'OMS1')
})

test('describe refuses an unknown connection with exit 2', async () => {
  const r = await go(['describe', 'NOPE'], connections)
  assert.equal(r.exitCode, EXIT.usage)
})

test('runs lists saved runs with their sources described', async () => {
  const r = await go(['runs'], { [SAVED_RUNS]: savedRuns })
  const out = JSON.parse(r.stdout)
  assert.equal(out.runs.length, 2)
  assert.deepEqual(out.runs[0].sources.map((s: any) => s.label), ['Shopify', 'NetSuite'])
  assert.ok(!r.stdout.includes('"secret"'))
})

test('run start uses run#SavedRunDiff and returns the run id', async () => {
  const r = await go(['run', 'start', 'R1', '--from', '2026-10-01', '--thru', '2026-10-31'], {
    [SAVED_RUNS]: savedRuns,
    [RUN_DIFF]: () => ({ ok: true, runResult: { savedRunId: 'R1', reconciliationRunResultId: 'RUN9', generatedOutput: { fileName: 'out.json', totalDifferences: 3 } } }),
  })
  assert.equal(r.exitCode, 0, r.stderr)
  const call = r.requests.find((q) => q.method === RUN_DIFF)!
  // what the app sends: both pairs, end exclusive (Task 14 live check — local dates alone were refused)
  assert.deepEqual(call.params, { savedRunId: 'R1', windowStartDate: '2026-10-01T00:00:00.000Z', windowEndDate: '2026-11-01T00:00:00.000Z',
    windowStartLocalDate: '2026-10-01', windowEndLocalDate: '2026-11-01' })
  const out = JSON.parse(r.stdout)
  assert.equal(out.runId, 'RUN9')
  assert.match(out.next, /run wait RUN9/)
})

test('run start window: --from alone is one day, the year and month roll over, bad windows never reach the backend', async () => {
  const handlers = { [SAVED_RUNS]: savedRuns, [RUN_DIFF]: () => ({ ok: true, runResult: { reconciliationRunResultId: 'RUN9', generatedOutput: {} } }) }
  const one = await go(['run', 'start', 'R1', '--from', '2026-12-31'], handlers)
  assert.equal(one.exitCode, 0, one.stderr)
  assert.deepEqual(one.requests.find((q) => q.method === RUN_DIFF)!.params, { savedRunId: 'R1', windowStartDate: '2026-12-31T00:00:00.000Z',
    windowEndDate: '2027-01-01T00:00:00.000Z', windowStartLocalDate: '2026-12-31', windowEndLocalDate: '2027-01-01' })
  const none = await go(['run', 'start', 'R1'], handlers)
  assert.deepEqual(none.requests.find((q) => q.method === RUN_DIFF)!.params, { savedRunId: 'R1' })
  for (const argv of [['--thru', '2026-10-31'], ['--from', '2026-10-31', '--thru', '2026-10-01'], ['--from', '2026-02-30'], ['--from', '10/01/2026']]) {
    const bad = await go(['run', 'start', 'R1', ...argv], handlers)
    assert.equal(bad.exitCode, EXIT.usage, `${argv.join(' ')}: ${bad.stderr}`)
    assert.equal(bad.requests.filter((q) => q.method === RUN_DIFF).length, 0)
  }
})

test('run wait polls until done and exits 5 on a failed run', async () => {
  const statuses = ['AUT_STAT_RUNNING', 'AUT_STAT_RUNNING', 'AUT_STAT_FAILED']
  const r = await go(['run', 'wait', 'RUN9'], { [RUN_STATUS]: () => ({ ok: true, statusEnumId: statuses.shift(), currentStage: 'x', errorMessage: 'NetSuite refused the query' }) })
  assert.equal(r.exitCode, EXIT.failed)
  assert.equal(r.requests.filter((q) => q.method === RUN_STATUS).length, 3)
  assert.match(r.stderr, /NetSuite refused the query/)
})

test('run wait returns the status once the run succeeded, and gives up at the timeout', async () => {
  const done = ['AUT_STAT_PENDING', 'AUT_STAT_SUCCESS']
  const ok = await go(['run', 'wait', 'RUN9'], { [RUN_STATUS]: () => ({ ok: true, statusEnumId: done.shift(), progressPercent: 100 }) })
  assert.equal(ok.exitCode, 0, ok.stderr)
  assert.equal(JSON.parse(ok.stdout).statusEnumId, 'AUT_STAT_SUCCESS')
  const slow = await go(['run', 'wait', 'RUN9', '--timeout', '20'], { [RUN_STATUS]: () => ({ ok: true, statusEnumId: 'AUT_STAT_RUNNING' }) })
  assert.equal(slow.exitCode, EXIT.failed)
  assert.match(slow.stderr, /still running/)
})

test('result takes the newest output of a saved run and its differences', async () => {
  const r = await go(['result', 'R1', '--differences', '--first', '25'], {
    [OUTPUTS]: () => ({ ok: true, generatedOutputs: [{ fileName: 'new.json', totalDifferences: 2 }, { fileName: 'old.json' }] }),
    [OUTPUT_DIFFS]: (p: any) => ({ ok: true, totalDifferences: 2, differences: [{ id: 'A' }, { id: 'B' }], pageIndex: p.pageIndex, pageSize: p.pageSize }),
  })
  assert.equal(r.exitCode, 0, r.stderr)
  const diff = r.requests.find((q) => q.method === OUTPUT_DIFFS)!
  assert.equal(diff.params.fileName, 'new.json')
  assert.equal(diff.params.pageSize, 25)
  assert.equal(JSON.parse(r.stdout).differences.length, 2)
  assert.equal(r.requests.find((q) => q.method === OUTPUTS)!.params.savedRunId, 'R1')
})

test('result --first 050 is refused and a file name skips the listing', async () => {
  const bad = await go(['result', 'R1', '--differences', '--first', '050'], {})
  assert.equal(bad.exitCode, EXIT.usage)
  const r = await go(['result', 'out.json'], { [OUTPUT_DIFFS]: () => ({ ok: true, totalDifferences: 0, differences: [], summary: {} }) })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.ok(!r.requests.some((q) => q.method === OUTPUTS))
})

test('audits lists the tenant audits', async () => {
  const r = await go(['audits'], { [AUDITS]: () => ({ ok: true, audits: [{ audit: { id: 'month-close', name: 'Month close', period: 'monthly' } }] }) })
  assert.deepEqual(JSON.parse(r.stdout).audits, [{ id: 'month-close', name: 'Month close', period: 'monthly' }])
})

const gqlReply = (edges: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ data: { findings: { edges, pageInfo: { hasNextPage, endCursor } } }, errors: [] })

test('findings list sends terms as $q with no >= in the document', async () => {
  const r = await go(['findings', 'list', '--statement', 'R2,R8', '--state', 'open', '--since', '2026-10-01', '--sort', 'statement', '--reverse', '--first', '20'], { graphql: () => gqlReply([{ cursor: 'c1', node: { id: 'F-1' } }]) })
  assert.equal(r.exitCode, 0, r.stderr)
  const req = r.requests[0]!
  assert.equal(req.path, '/rest/s1/graphql')
  assert.deepEqual(req.body.variables, { q: 'statement:R2,R8 state:open firstFound:>=2026-10-01' })
  assert.ok(!req.body.query.includes('>='), 'no >= in the document')
  assert.match(req.body.query, /findings\(first: 20, query: \$q, sortKey: STATEMENT, reverse: true\)/)
  assert.deepEqual(JSON.parse(r.stdout).errors, [], 'printed as the sh did: the whole response')
  assert.equal(req.headers.login_key, 'KEY123')
  assert.equal(req.headers['X-Darpan-Tenant'], 'ACME')
  assert.equal(JSON.parse(r.stdout).data.findings.edges[0].node.id, 'F-1')
})

test('findings --all follows cursors', async () => {
  const pages = [gqlReply([{ cursor: 'a', node: { id: 'F-1' } }], true, 'a'), gqlReply([{ cursor: 'b', node: { id: 'F-2' } }], true, 'b'), gqlReply([{ cursor: 'c', node: { id: 'F-3' } }])]
  const r = await go(['findings', 'list', '--all', '--state', 'open'], { graphql: () => pages.shift() })
  assert.equal(r.exitCode, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.deepEqual(out.edges.map((e: any) => e.node.id), ['F-1', 'F-2', 'F-3'])
  assert.equal(out.query, 'state:open')
  assert.equal(r.requests[1]!.body.variables.after, 'a')
  assert.equal(r.requests[2]!.body.variables.after, 'b')
  assert.ok(r.requests.every((q) => !q.body.query.includes('"a"') && !q.body.query.includes('"b"')), 'cursors are variables, not document text')
})

test('findings --all stops when the cursor does not move', async () => {
  const r = await go(['findings', 'list', '--all'], { graphql: () => gqlReply([], true, 'same') })
  assert.equal(r.exitCode, EXIT.failed)
  assert.match(r.stderr, /cursor did not move/)
})

test('month export = findings --all --period --state open', async () => {
  const r = await go(['month', 'export', '--month', '2026-10'], { graphql: () => gqlReply([]) })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(r.requests[0]!.body.variables, { q: 'state:open period:2026-10' })
  assert.match(r.requests[0]!.body.query, /findings\(first: 100, query: \$q\)/)
  const withAudit = await go(['month', 'export', '--month', '2026-10', '--audit', 'daily-ops', '--state', 'open'], { graphql: () => gqlReply([]) })
  assert.deepEqual(withAudit.requests[0]!.body.variables, { q: 'audit:daily-ops state:open period:2026-10' })
  assert.equal((await go(['month', 'export'], {})).exitCode, EXIT.usage)
  assert.equal((await go(['month', 'export', '--month', '2026-13'], {})).exitCode, EXIT.usage)
})

const REPORT = 'facade.AuditFacadeServices.get#AuditReport'
const FINDING = 'facade.AuditFacadeServices.get#AuditFinding'
const BY_ORDER = 'facade.AuditFacadeServices.get#AuditFindingsByOrder'
const VERIFY = 'facade.AuditFacadeServices.verify#AuditFinding'
const PROGRESS = 'facade.AuditFacadeServices.get#AuditProgress'
const SETTINGS = 'facade.AuditFacadeServices.get#AuditSettings'
const EXTRACTS = 'facade.AuditFacadeServices.get#AuditCheckExtracts'
const OUTPUT = 'facade.ReconciliationFacadeServices.get#GeneratedOutput'

test('report reads the page\'s JSON document, month-close by default, values held to their shape', async () => {
  const reply = () => ({ ok: true, messages: [], report: { schema: 'darpan.audit.report/v1', report: { period: '2026-Q4' } } })
  const q = await go(['report', '--period', '2026-Q4'], { [REPORT]: reply })
  assert.equal(q.exitCode, 0, q.stderr)
  assert.deepEqual(q.requests[0]!.params, { audit: 'month-close', period: '2026-Q4' })
  assert.deepEqual(JSON.parse(q.stdout), { schema: 'darpan.audit.report/v1', report: { period: '2026-Q4' } }, 'the document, not the envelope')
  const d = await go(['report', '--date', '2026-10-08', '--audit', 'daily-ops'], { [REPORT]: reply })
  assert.deepEqual(d.requests[0]!.params, { audit: 'daily-ops', date: '2026-10-08' })
  for (const flags of [['--date', '10/08/2026'], ['--audit', 'Month Close'], ['--period', '2026-13x']]) {
    const bad = await go(['report', ...flags], { [REPORT]: reply })
    assert.equal(bad.exitCode, EXIT.usage, flags.join(' '))
    assert.equal(bad.requests.length, 0)
  }
  const none = await go(['report'], { [REPORT]: () => ({ ok: true, report: null }) })
  assert.equal(none.exitCode, EXIT.failed)
})

test('findings show returns every record field the page shows, and refuses a malformed id', async () => {
  const record = { id: 'GOR123', internalId: '991', status: 'Billed', customer: 'A. Buyer', sku: 'NK-01', location: 'WH1', fulfillments: ['IF77'], orderTotal: { amount: '10.00', currency: 'USD' } }
  const doc = { schema: 'darpan.audit.finding/v1', finding: { id: 'F-20790', records: { NetSuite: { invoice: [record] } } }, access: { mode: 'read-only' } }
  const ok = await go(['findings', 'show', 'F-20790'], { [FINDING]: () => ({ ok: true, finding: doc }) })
  assert.equal(ok.exitCode, 0, ok.stderr)
  assert.deepEqual(ok.requests[0]!.params, { findingId: 'F-20790' })
  assert.deepEqual(JSON.parse(ok.stdout), doc)
  assert.ok(!ok.requests.some((q) => q.method === 'graphql'))
  assert.equal((await go(['findings', 'show', 'F-1") { x } #'], {})).exitCode, EXIT.usage)
  assert.equal((await go(['findings', 'show'], {})).exitCode, EXIT.usage)
  const gone = await go(['findings', 'show', 'F-9'], { [FINDING]: () => ({ ok: false, errors: ['Finding F-9 was not found'] }) })
  assert.equal(gone.exitCode, EXIT.failed)
  assert.match(gone.stderr, /F-9 was not found/)
  const stringErrors = await go(['findings', 'list'], { graphql: () => ({ errors: 'HTML sanitizer refused the query' }) })
  assert.equal(stringErrors.exitCode, EXIT.failed)
})

test('findings by-order passes statement and period; recheck submits and points at findings show', async () => {
  const r = await go(['findings', 'by-order', '--statement', 'R2', '--period', '2026-10'], { [BY_ORDER]: () => ({ ok: true, findings: [{ id: 'F-1', order: 'GOR1' }] }) })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(r.requests[0]!.params, { audit: 'month-close', period: '2026-10', statement: 'R2' })
  assert.deepEqual(JSON.parse(r.stdout).findings, [{ id: 'F-1', order: 'GOR1' }])
  assert.equal((await go(['findings', 'by-order', '--statement', 'R2,R8'], {})).exitCode, EXIT.usage, 'one statement: the service takes one')
  const re = await go(['findings', 'recheck', 'F-7'], { [VERIFY]: () => ({ ok: true, submitted: true }) })
  assert.equal(re.exitCode, 0, re.stderr)
  assert.deepEqual(re.requests[0]!.params, { findingId: 'F-7' })
  const out = JSON.parse(re.stdout)
  assert.equal(out.submitted, true)
  assert.match(out.next, /darpan findings show F-7/)
  const viewer = await go(['findings', 'recheck', 'F-7'], { [VERIFY]: () => ({ ok: false, errors: ['Your active tenant only has view access for audits.'] }) })
  assert.equal(viewer.exitCode, EXIT.failed)
})

test('audit progress and settings unwrap their documents', async () => {
  const p = await go(['audit', 'progress', '--audit', 'daily-ops'], { [PROGRESS]: () => ({ ok: true, progress: { running: [] } }) })
  assert.equal(p.exitCode, 0, p.stderr)
  assert.deepEqual(p.requests[0]!.params, { audit: 'daily-ops' })
  assert.deepEqual(JSON.parse(p.stdout), { running: [] })
  const s = await go(['audit', 'settings'], { [SETTINGS]: () => ({ ok: true, settings: { name: 'Month close', statements: [] } }) })
  assert.deepEqual(JSON.parse(s.stdout), { name: 'Month close', statements: [] })
  assert.equal(matchCommand(['audits'])!.command.name, 'audits', '`audit` commands do not shadow `audits`')
})

test('audit extracts lists the rows; --system fetches that file, csv by its extension', async () => {
  const rows = [{ system: 'NetSuite', records: 120, filePath: 'dbresource://x/ns.csv' }, { system: 'OMS', records: 118, filePath: 'dbresource://x/oms.json' }]
  const handlers = { [EXTRACTS]: () => ({ ok: true, extracts: rows }), [OUTPUT]: () => ({ ok: true, outputFile: { contentText: 'id\n1', contentType: 'text/csv' } }) }
  const list = await go(['audit', 'extracts', '--check', 'invoices-without-etail-id', '--period', '2026-10'], handlers)
  assert.equal(list.exitCode, 0, list.stderr)
  assert.deepEqual(list.requests[0]!.params, { audit: 'month-close', period: '2026-10', check: 'invoices-without-etail-id' })
  assert.deepEqual(JSON.parse(list.stdout).extracts, rows)
  assert.ok(!list.requests.some((q) => q.method === OUTPUT), 'no file read without --system')
  const file = await go(['audit', 'extracts', '--check', 'c1', '--period', '2026-10', '--date', '2026-10-08', '--system', 'netsuite'], handlers)
  assert.equal(file.exitCode, 0, file.stderr)
  assert.deepEqual(file.requests[1]!.params, { fileName: 'dbresource://x/ns.csv', format: 'csv' })
  assert.equal(JSON.parse(file.stdout).content.contentText, 'id\n1')
  const missing = await go(['audit', 'extracts', '--check', 'c1', '--period', '2026-10', '--system', 'Shopify'], handlers)
  assert.equal(missing.exitCode, EXIT.failed)
  assert.match(missing.stderr, /kept: NetSuite, OMS/)
  assert.equal((await go(['audit', 'extracts', '--period', '2026-10'], {})).exitCode, EXIT.usage)
  assert.equal((await go(['audit', 'extracts', '--check', 'c 1', '--period', '2026-10'], {})).exitCode, EXIT.usage)
})

test('--first 050 is refused before any request', async () => {
  for (const first of ['050', '0', '101', 'abc']) {
    const r = await go(['findings', 'list', '--first', first], { graphql: () => gqlReply([]) })
    assert.equal(r.exitCode, EXIT.usage, first)
    assert.equal(r.requests.length, 0)
  }
  const ok = await go(['findings', 'list', '--first', '100'], { graphql: () => gqlReply([]) })
  assert.equal(ok.exitCode, 0)
})

test('findings list refuses malformed values before any request', async () => {
  for (const flags of [['--state', 'bogus'], ['--audit', 'A B'], ['--period', '2026-13x'], ['--since', 'yesterday'], ['--sort', 'name'], ['--after', 'a"b'], ['--statement', 'R2;R8']]) {
    const r = await go(['findings', 'list', ...flags], { graphql: () => gqlReply([]) })
    assert.equal(r.exitCode, EXIT.usage, flags.join(' '))
    assert.equal(r.requests.length, 0)
  }
})

test('every command calls only allowlisted methods and carries a description', async () => {
  const allowed = new Set(loadAllowedMethods().map((m) => m.method))
  const dataCommands = ['systems', 'describe', 'runs', 'run start', 'run status', 'run wait', 'result', 'audits', 'report', 'findings list', 'findings show', 'findings by-order', 'findings recheck', 'month export', 'audit progress', 'audit settings', 'audit extracts']
  for (const name of dataCommands) {
    const command = COMMANDS.find((c) => c.name === name)
    assert.ok(command, name)
    assert.ok(command.description.length > 40, `${name} needs a real description`)
    assert.equal(command.tenant, 'required', name)
  }
  const handlers: Record<string, any> = { ...connections, [NS_OPTIONS]: () => ({ ok: true, options: {} }), [NS_QUERIES]: () => ({ ok: true, queries: [] }), [OMS_SCHEMA]: () => ({ ok: true, schema: {} }), [SAVED_RUNS]: savedRuns, [RUN_DIFF]: () => ({ ok: true, runResult: { reconciliationRunResultId: 'X' } }), [RUN_STATUS]: () => ({ ok: true, statusEnumId: 'AUT_STAT_SUCCESS' }), [OUTPUTS]: () => ({ ok: true, generatedOutputs: [{ fileName: 'f.json' }] }), [OUTPUT_DIFFS]: () => ({ ok: true, differences: [] }), [AUDITS]: () => ({ ok: true, audits: [] }), 'facade.ReconciliationFacadeServices.get#GeneratedOutput': () => ({ ok: true, outputFile: { contentText: '{}' } }), [REPORT]: () => ({ ok: true, report: { schema: 'x' } }), [FINDING]: () => ({ ok: true, finding: { schema: 'x' } }), [BY_ORDER]: () => ({ ok: true, findings: [] }), [VERIFY]: () => ({ ok: true, submitted: true }), [PROGRESS]: () => ({ ok: true, progress: {} }), [SETTINGS]: () => ({ ok: true, settings: {} }), [EXTRACTS]: () => ({ ok: true, extracts: [{ system: 'OMS', filePath: 'a.json' }] }) }
  for (const argv of [['systems'], ['describe', 'NS1'], ['describe', 'OMS1'], ['runs'], ['run', 'start', 'R1'], ['run', 'status', 'X'], ['run', 'wait', 'X'], ['result', 'R1'], ['result', 'R1', '--content'], ['audits'], ['report'], ['findings', 'show', 'F-1'], ['findings', 'by-order'], ['findings', 'recheck', 'F-1'], ['audit', 'progress'], ['audit', 'settings'], ['audit', 'extracts', '--check', 'c1', '--period', '2026-10', '--system', 'OMS']]) {
    const r = await go(argv, handlers)
    assert.equal(r.exitCode, 0, `${argv.join(' ')}: ${r.stderr}`)
    for (const q of r.requests) if (q.method !== 'graphql') assert.ok(allowed.has(q.method), `${q.method} is not on the allowlist`)
  }
})

test('run wait knows every end state', async () => {
  const wait = (status: string) => go(['run', 'wait', 'RUN9'], { [RUN_STATUS]: () => ({ ok: true, statusEnumId: status, errorMessage: 'boom' }) })
  for (const status of ['AUT_STAT_NO_DATA', 'AUT_STAT_SKIP_DUP']) {
    const r = await wait(status)
    assert.equal(r.exitCode, 0, status)
    assert.equal(r.requests.length, 1, 'no polling past an end state')
    assert.ok(JSON.parse(r.stdout).note, status)
  }
  for (const status of ['AUT_STAT_FAILED', 'AUT_STAT_CANCELLED', 'AUT_STAT_DEAD_LETTER']) {
    const r = await wait(status)
    assert.equal(r.exitCode, EXIT.failed, status)
    assert.equal(r.requests.length, 1)
  }
  const odd = await wait('AUT_STAT_MYSTERY')
  assert.equal(odd.exitCode, EXIT.failed)
  assert.match(odd.stderr, /AUT_STAT_MYSTERY/)
})

test('a malformed server cursor or a null data is a clean failure', async () => {
  const evil = await go(['findings', 'list', '--all'], { graphql: () => gqlReply([], true, 'a"b') })
  assert.equal(evil.exitCode, EXIT.failed)
  assert.equal(evil.requests.length, 1)
  const nul = await go(['findings', 'list', '--all'], { graphql: () => ({ data: null }) })
  assert.equal(nul.exitCode, EXIT.failed)
  const after = await go(['findings', 'list', '--after', 'abc'], { graphql: () => gqlReply([]) })
  assert.equal(after.requests[0]!.body.variables.after, 'abc')
  assert.ok(!after.requests[0]!.body.query.includes('abc'))
})

test('final review Critical 1: a findings page declares exactly the variables it uses', async () => {
  const { pageDocument, buildFindingsQuery } = await import('../gql.ts')
  const { graphqlVariables } = await import('./fakeBackend.ts')
  // the fake's parser itself catches the old document
  assert.deepEqual(graphqlVariables('query($q: String, $after: String) { findings(first: 50) { edges { cursor } } }'), { declared: ['q', 'after'], used: [] })
  for (const terms of [{}, { state: 'open' }]) {
    const query = buildFindingsQuery(terms)
    for (const args of [query.baseArgs, `${query.baseArgs}, after: $after`]) {
      const { declared, used } = graphqlVariables(pageDocument(args))
      assert.deepEqual([...declared].sort(), [...used].sort(), pageDocument(args).slice(0, 80))
    }
  }
  assert.match(pageDocument('first: 50'), /^query \{ findings\(first: 50\)/)
})

test('final review Critical 1: an unfiltered first page, its next page and a month export all pass graphql-java validation', async () => {
  const one = await go(['findings', 'list'], { graphql: () => gqlReply([{ cursor: 'c1', node: { id: 'F-1' } }]) })
  assert.equal(one.exitCode, 0, one.stderr)
  assert.ok(!one.requests[0]!.body.query.includes('$'), one.requests[0]!.body.query)
  const pages = [gqlReply([{ cursor: 'a', node: { id: 'F-1' } }], true, 'a'), gqlReply([{ cursor: 'b', node: { id: 'F-2' } }])]
  const all = await go(['findings', 'list', '--all'], { graphql: () => pages.shift() })
  assert.equal(all.exitCode, 0, all.stderr)
  assert.match(all.requests[0]!.body.query, /^query \{/)
  assert.match(all.requests[1]!.body.query, /^query\(\$after: String\) \{/)
  const month = await go(['month', 'export', '--month', '2026-10'], { graphql: () => gqlReply([]) })
  assert.equal(month.exitCode, 0, month.stderr)
  assert.match(month.requests[0]!.body.query, /^query\(\$q: String\) \{/)
})

test('final review minor: run wait names AUT_STAT_NOT_RUN as an end state', async () => {
  const r = await go(['run', 'wait', 'RUN9'], { [RUN_STATUS]: () => ({ ok: true, statusEnumId: 'AUT_STAT_NOT_RUN' }) })
  assert.equal(r.exitCode, EXIT.failed)
  assert.equal(r.requests.length, 1)
  assert.match(r.stderr, /was not run/)
  assert.doesNotMatch(r.stderr, /unrecognised/)
})

test('final review minor: a boolean flag never swallows the next word', async () => {
  const r = await go(['result', '--differences', 'R1', '--first', '5'], {
    [OUTPUTS]: () => ({ ok: true, generatedOutputs: [{ fileName: 'new.json', totalDifferences: 1 }] }),
    [OUTPUT_DIFFS]: (p: any) => ({ ok: true, totalDifferences: 1, differences: [{ id: 'A' }], pageIndex: p.pageIndex, pageSize: p.pageSize }),
  })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(r.requests.find((q) => q.method === OUTPUTS)!.params.savedRunId, 'R1')
  assert.equal(r.requests.find((q) => q.method === OUTPUT_DIFFS)!.params.pageSize, 5)
  const rev = await go(['findings', 'list', '--reverse', '--state', 'open'], { graphql: () => gqlReply([]) })
  assert.equal(rev.exitCode, 0, rev.stderr)
  assert.match(rev.requests[0]!.body.query, /reverse: true/)
})
