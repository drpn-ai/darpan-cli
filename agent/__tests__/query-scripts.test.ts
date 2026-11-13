import assert from 'node:assert/strict'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
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
const TS = 'facade.TenantScriptFacadeServices'
const SCRIPT_RUN = `${TS}.run#TenantScript`
const DEPLOY_RUN = `${TS}.run#TenantScriptDeployment`
const DEPLOY_SAVE = `${TS}.save#TenantScriptDeployment`
const DEPLOY_LIST = `${TS}.list#TenantScriptDeployments`
const OUTPUTS = 'facade.ReconciliationFacadeServices.list#GeneratedOutputs'

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

test('rows from query run feed script run --rows', async () => {
  const dir = workDir()
  const q = await go(['query', 'run', '--connection', 'NS1', '--suiteql', 'SELECT id FROM t'], { ...connections, [NS_QUERY]: () => ({ ok: true, rows: [{ id: '1' }, { id: '2' }], rowCount: 2 }) }, undefined, dir)
  const file = join(dir, 'rows.json')
  writeFileSync(file, q.stdout)
  const bodyFile = join(dir, 'body.jexl')
  writeFileSync(bodyFile, 'rows.size()')
  const r = await go(['script', 'run', '--body', bodyFile, '--rows', file], { [SCRIPT_RUN]: () => ({ ok: true, run: { ok: true, result: 2 }, inputSummary: { source: 'SAMPLE', characters: 10 } }) }, undefined, dir)
  assert.equal(r.exitCode, 0, r.stderr)
  const params = called(r, SCRIPT_RUN)[0]!.params
  assert.equal(params.inputSource, 'SAMPLE')
  assert.equal(params.scriptBody, 'rows.size()')
  assert.deepEqual(JSON.parse(params.inputJson).rows, [{ id: '1' }, { id: '2' }])
  assert.equal(params.tenantScriptId, undefined)
  assert.equal(JSON.parse(r.stdout).run.result, 2)
})

test('script run: saved script on a run result, sample, and the input rules', async () => {
  const dir = workDir()
  const ok = { [SCRIPT_RUN]: () => ({ ok: true, run: { ok: true, result: 'x' } }) }
  const a = await go(['script', 'run', '--saved', 'S1', '--result', 'run-1.json'], ok, undefined, dir)
  assert.deepEqual(called(a, SCRIPT_RUN)[0]!.params, { tenantScriptId: 'S1', inputSource: 'RUN_RESULT', fileName: 'run-1.json' })
  const b = await go(['script', 'run', '--saved', 'S1', '--sample'], ok, undefined, dir)
  assert.deepEqual(called(b, SCRIPT_RUN)[0]!.params, { tenantScriptId: 'S1', inputSource: 'SAMPLE' })
  for (const argv of [
    ['script', 'run', '--saved', 'S1'],
    ['script', 'run', '--sample'],
    ['script', 'run', '--saved', 'S1', '--sample', '--result', 'f.json'],
    ['script', 'run', '--saved', 'S1', '--body', join(dir, 'x'), '--sample'],
    ['script', 'run', '--saved', 'S1', '--rows', join(dir, 'missing.json')],
  ]) {
    const r = await go(argv, ok, undefined, dir)
    assert.equal(r.exitCode, EXIT.usage, `${argv.join(' ')}: ${r.stderr}`)
    assert.equal(called(r, SCRIPT_RUN).length, 0)
  }
})

test('script run --rows refuses a file over the 2,000,000 character limit', async () => {
  const dir = workDir()
  const big = join(dir, 'big.json')
  writeFileSync(big, JSON.stringify({ rows: ['x'.repeat(2_000_001)] }))
  const r = await go(['script', 'run', '--saved', 'S1', '--rows', big], { [SCRIPT_RUN]: () => ({ ok: true }) }, undefined, dir)
  assert.equal(r.exitCode, EXIT.usage)
  assert.match(r.stderr, /2,000,000/)
  assert.equal(called(r, SCRIPT_RUN).length, 0)
})

test('scripts, script save and script delete', async () => {
  const dir = workDir()
  const body = join(dir, 'b.jexl')
  writeFileSync(body, 'a < b')
  const list = await go(['scripts'], { [`${TS}.list#TenantScripts`]: () => ({ ok: true, scripts: [{ tenantScriptId: 'S1', scriptName: 'n' }], library: [{ name: 'd:x', help: 'h' }], limits: {} }) })
  assert.equal(JSON.parse(list.stdout).scripts[0].tenantScriptId, 'S1')
  const existing = { tenantScriptId: 'S1', scriptName: 'Old', description: 'keep me', scriptProfile: 'SCRIPT', inputSource: 'RUN_RESULT', sampleInputJson: '{"a":1}', isActive: 'N' }
  const save = await go(['script', 'save', '--name', 'Daily', '--body', body, '--id', 'S1', '--profile', 'EXPRESSION'], { [`${TS}.list#TenantScripts`]: () => ({ ok: true, scripts: [existing] }), [`${TS}.save#TenantScript`]: () => ({ ok: true, script: { tenantScriptId: 'S1' }, validation: { ok: true } }) }, undefined, dir)
  assert.equal(save.exitCode, 0, save.stderr)
  assert.deepEqual(called(save, `${TS}.save#TenantScript`)[0]!.params, { scriptName: 'Daily', scriptBody: 'a < b', tenantScriptId: 'S1', description: 'keep me', scriptProfile: 'EXPRESSION', inputSource: 'RUN_RESULT', sampleInputJson: '{"a":1}', isActive: false })
  const unknown = await go(['script', 'save', '--name', 'D', '--body', body, '--id', 'NOPE'], { [`${TS}.list#TenantScripts`]: () => ({ ok: true, scripts: [existing] }) }, undefined, dir)
  assert.equal(unknown.exitCode, EXIT.usage)
  const noName = await go(['script', 'save', '--body', body], {}, undefined, dir)
  assert.equal(noName.exitCode, EXIT.usage)
  const del = await go(['script', 'delete', 'S1'], { [`${TS}.delete#TenantScript`]: () => ({ ok: true }) })
  assert.deepEqual(called(del, `${TS}.delete#TenantScript`)[0]!.params, { tenantScriptId: 'S1' })
})

test('deploy without --on saves isActive N', async () => {
  const handlers = { [DEPLOY_SAVE]: (p: any) => ({ ok: true, deployment: { tenantScriptDeploymentId: 'D1', isActive: p.isActive ? 'Y' : 'N' } }) }
  const off = await go(['deploy', '--script', 'S1', '--input', 'RUN1', '--space', 'CS1', '--daily', '09:05'], handlers)
  assert.equal(off.exitCode, 0, off.stderr)
  assert.deepEqual(called(off, DEPLOY_SAVE)[0]!.params, { tenantScriptId: 'S1', inputSavedRunId: 'RUN1', chatSpaceId: 'CS1', scheduleExpr: '0 5 9 * * ?', isActive: false })
  assert.equal(JSON.parse(off.stdout).deployment.isActive, 'N')
  const on = await go(['deploy', '--script', 'S1', '--input', 'RUN1', '--space', 'CS1', '--cron', '0 0 7 * * ?', '--on'], handlers)
  assert.deepEqual(called(on, DEPLOY_SAVE)[0]!.params, { tenantScriptId: 'S1', inputSavedRunId: 'RUN1', chatSpaceId: 'CS1', scheduleExpr: '0 0 7 * * ?', isActive: true })
  for (const argv of [
    ['deploy', '--script', 'S1', '--space', 'CS1', '--daily', '09:00'],
    ['deploy', '--script', 'S1', '--input', 'RUN1', '--space', 'CS1', '--daily', '25:00'],
    ['deploy', '--script', 'S1', '--input', 'RUN1', '--space', 'CS1', '--daily', '9:5'],
    ['deploy', '--script', 'S1', '--input', 'RUN1', '--space', 'CS1'],
    ['deploy', '--script', 'S1', '--input', 'RUN1', '--space', 'CS1', '--daily', '09:00', '--cron', '0 0 9 * * ?'],
    ['deploy', '--input', 'RUN1', '--space', 'CS1', '--daily', '09:00'],
  ]) {
    const r = await go(argv, handlers)
    assert.equal(r.exitCode, EXIT.usage, `${argv.join(' ')}: ${r.stderr}`)
    assert.equal(called(r, DEPLOY_SAVE).length, 0)
  }
})

const dep = { tenantScriptDeploymentId: 'D1', tenantScriptId: 'S1', scheduleExpr: '0 0 9 * * ?', inputSavedRunId: 'RUN1', chatSpaceId: 'CS1', isActive: 'Y' }

test('deployments, deploy off and deploy delete', async () => {
  const handlers = { [DEPLOY_LIST]: () => ({ ok: true, deployments: [dep], timeZone: 'America/New_York' }), [DEPLOY_SAVE]: () => ({ ok: true, deployment: { ...dep, isActive: 'N' } }), [`${TS}.delete#TenantScriptDeployment`]: () => ({ ok: true }) }
  const list = await go(['deployments', '--script', 'S1'], handlers)
  assert.deepEqual(called(list, DEPLOY_LIST)[0]!.params, { tenantScriptId: 'S1' })
  assert.equal(JSON.parse(list.stdout).timeZone, 'America/New_York')
  const off = await go(['deploy', 'off', 'D1'], handlers)
  assert.equal(off.exitCode, 0, off.stderr)
  assert.deepEqual(called(off, DEPLOY_SAVE)[0]!.params, { tenantScriptDeploymentId: 'D1', tenantScriptId: 'S1', scheduleExpr: '0 0 9 * * ?', inputSavedRunId: 'RUN1', chatSpaceId: 'CS1', isActive: false })
  const missing = await go(['deploy', 'off', 'NOPE'], handlers)
  assert.equal(missing.exitCode, EXIT.usage)
  const del = await go(['deploy', 'delete', 'D1'], handlers)
  assert.deepEqual(called(del, `${TS}.delete#TenantScriptDeployment`)[0]!.params, { tenantScriptDeploymentId: 'D1' })
})

test('deploy preview and deploy send run the deployment as its schedule would, send=false then send=true', async () => {
  const sent: Record<string, any> = { status: 'SENT', message: 'Posted to Ops.', text: 'text to post' }
  let outcome: Record<string, any> = { status: 'PREVIEW', message: 'Preview only: nothing was sent.', text: 'text to post' }
  const handlers = { [DEPLOY_RUN]: () => ({ ok: true, outcome, deployment: dep }) }
  const preview = await go(['deploy', 'preview', 'D1'], handlers)
  assert.equal(preview.exitCode, 0, preview.stderr)
  assert.deepEqual(called(preview, DEPLOY_RUN)[0]!.params, { tenantScriptDeploymentId: 'D1', send: false })
  assert.equal(JSON.parse(preview.stdout).outcome.text, 'text to post')
  outcome = sent
  const send = await go(['deploy', 'send', 'D1'], handlers)
  assert.equal(send.exitCode, 0, send.stderr)
  assert.deepEqual(called(send, DEPLOY_RUN)[0]!.params, { tenantScriptDeploymentId: 'D1', send: true })
  assert.equal(JSON.parse(send.stdout).outcome.status, 'SENT')
  outcome = { status: 'NOTHING_TO_SEND', message: 'The script returned no text, so nothing was sent.', text: '' }
  assert.equal((await go(['deploy', 'send', 'D1'], handlers)).exitCode, 0)
  assert.equal((await go(['deploy', 'send'], handlers)).exitCode, EXIT.usage)
})

test('deploy send fails when nothing reached the chat space, though the service answered ok', async () => {
  for (const outcome of [
    { status: 'NOT_DELIVERED', message: 'The chat space was deleted, switched off or has no webhook.' },
    { status: 'SCRIPT_ERROR', message: 'Line 3: boom' },
    { status: 'NO_INPUT', message: 'The saved run has no finished result to read yet.' },
    { status: 'SCRIPT_MISSING', message: 'The script was deleted or switched off.' },
    {},
  ]) {
    const r = await go(['deploy', 'send', 'D1'], { [DEPLOY_RUN]: () => ({ ok: true, outcome }) })
    assert.equal(r.exitCode, EXIT.failed, `${outcome.status}: ${r.stderr}`)
    if (outcome.message) assert.ok(r.stderr.includes(outcome.message), r.stderr)
  }
  // a preview that would not post (no input yet) fails too, rather than showing empty text
  const p = await go(['deploy', 'preview', 'D1'], { [DEPLOY_RUN]: () => ({ ok: true, outcome: { status: 'NO_INPUT', message: 'The saved run has no finished result to read yet.' } }) })
  assert.equal(p.exitCode, EXIT.failed)
})

test('every method these commands use is allowlisted, send-now included, and each is described', () => {
  const allowed = new Set(loadAllowedMethods().map((m) => m.method))
  for (const m of [NS_QUERY, OMS_QUERY, SH_QUERY, SCRIPT_RUN, DEPLOY_RUN, DEPLOY_SAVE, DEPLOY_LIST, `${TS}.list#TenantScripts`, `${TS}.save#TenantScript`, `${TS}.delete#TenantScript`, `${TS}.delete#TenantScriptDeployment`, OUTPUTS]) {
    assert.ok(allowed.has(m), `${m} not allowlisted`)
  }
  for (const name of ['query run', 'scripts', 'script run', 'script save', 'script delete', 'deployments', 'deploy', 'deploy off', 'deploy delete', 'deploy preview', 'deploy send']) {
    const c = COMMANDS.find((x) => x.name === name)
    assert.ok(c, name)
    assert.equal(c.tenant, 'required')
    assert.ok(c.description.length > 40, name)
  }
  const q = COMMANDS.find((x) => x.name === 'query run')!
  assert.match(q.description, /read-only/i)
  assert.match(q.description, /2,000/)
  assert.match(q.description, /darpan describe/)
})

test('file inputs: config dir and symlinks refused, oversize refused, inline forms work, both forms is a usage error', async () => {
  const dir = workDir()
  const ok = { [SCRIPT_RUN]: () => ({ ok: true, run: { ok: true, result: 1 } }) }
  const other = workDir()
  // run() writes config.json into dir; make sure it exists first.
  const cfg = join(dir, 'cfg')
  saveConfig(cfg, { current: 'prod', instances: { prod: { url: 'https://api.test', token: 'KEY123', tenant: 'ACME' } } })
  writeFileSync(join(cfg, 'secret.txt'), 'x')
  const link = join(other, 'link.json')
  symlinkSync(join(cfg, 'config.json'), link)
  for (const argv of [
    ['script', 'run', '--body', join(cfg, 'config.json'), '--sample'],
    ['script', 'run', '--body', join(cfg, 'secret.txt'), '--sample'],
    ['script', 'run', '--body', link, '--sample'],
    ['script', 'run', '--saved', 'S1', '--rows', link],
    ['script', 'save', '--name', 'n', '--body', link],
  ]) {
    const r = await go(argv, ok, undefined, dir)
    assert.equal(r.exitCode, EXIT.usage, `${argv.join(' ')}: ${r.stderr}`)
    assert.match(r.stderr, /config folder/)
    assert.equal(called(r, SCRIPT_RUN).length, 0)
  }
  const big = join(other, 'big.jexl')
  writeFileSync(big, 'x'.repeat(300_000))
  const tooBig = await go(['script', 'run', '--body', big, '--sample'], ok, undefined, dir)
  assert.equal(tooBig.exitCode, EXIT.usage)
  assert.match(tooBig.stderr, /limited to 64,000/)
  const notFile = await go(['script', 'run', '--body', other, '--sample'], ok, undefined, dir)
  assert.equal(notFile.exitCode, EXIT.usage)
  assert.match(notFile.stderr, /not a regular file/)
  const longInline = await go(['script', 'run', '--body-text', 'y'.repeat(64_001), '--sample'], ok, undefined, dir)
  assert.equal(longInline.exitCode, EXIT.usage)

  const inline = await go(['script', 'run', '--body-text', 'rows.size()', '--rows-json', '{"rows":[1]}'], ok, undefined, dir)
  assert.equal(inline.exitCode, 0, inline.stderr)
  assert.deepEqual(called(inline, SCRIPT_RUN)[0]!.params, { scriptBody: 'rows.size()', inputSource: 'SAMPLE', inputJson: '{"rows":[1]}' })
  const both = await go(['script', 'run', '--body-text', 'a', '--body', join(other, 'big.jexl'), '--sample'], ok, undefined, dir)
  assert.equal(both.exitCode, EXIT.usage)
  const bothRows = await go(['script', 'run', '--saved', 'S1', '--rows', big, '--rows-json', '{}'], ok, undefined, dir)
  assert.equal(bothRows.exitCode, EXIT.usage)
  const badJson = await go(['script', 'run', '--saved', 'S1', '--rows-json', '{nope'], ok, undefined, dir)
  assert.equal(badJson.exitCode, EXIT.usage)
  const save = await go(['script', 'save', '--name', 'n', '--body-text', 'a < b'], { [`${TS}.save#TenantScript`]: () => ({ ok: true }) }, undefined, dir)
  assert.deepEqual(called(save, `${TS}.save#TenantScript`)[0]!.params, { scriptName: 'n', scriptBody: 'a < b' })
  assert.deepEqual(COMMANDS.find((x) => x.name === 'script run')!.cliOnly, ['body', 'rows'])
  assert.deepEqual(COMMANDS.find((x) => x.name === 'script save')!.cliOnly, ['body'])
})

test('final review minor: --offset 0 is accepted, a leading zero is not', async () => {
  const handlers = { ...connections, [NS_QUERY]: () => ({ ok: true, rows: [], rowCount: 0, hasMore: false, truncated: false, durationMs: 1 }) }
  const zero = await go(['query', 'run', '--connection', 'NS1', '--suiteql', 'SELECT 1', '--offset', '0'], handlers)
  assert.equal(zero.exitCode, 0, zero.stderr)
  assert.equal(called(zero, NS_QUERY)[0]!.params.offset, 0)
  const bad = await go(['query', 'run', '--connection', 'NS1', '--suiteql', 'SELECT 1', '--offset', '01'], handlers)
  assert.equal(bad.exitCode, EXIT.usage)
})
