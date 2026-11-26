// DAR-CLI-007: conclusions show / save / code and automation sync. Both writers preview by default, write only with
// --yes, and send nothing the save does not read.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { run } from '../main.ts'
import { saveConfig } from '../config.ts'
import { loadAllowedMethods, treeChanges } from '../commands.ts'
import { annotationsFor } from '../mcp.ts'
import { COMMANDS } from '../commands.ts'
import { EXIT } from '../rpc.ts'
import { fakeBackend } from './fakeBackend.ts'

const GET_TREE = 'facade.RunConclusionFacadeServices.get#RunConclusions'
const SAVE_TREE = 'facade.RunConclusionFacadeServices.save#RunConclusions'
const NEW_CODE = 'facade.RunConclusionFacadeServices.create#RunConclusionCode'
const GET_AUTO = 'facade.ReconciliationFacadeServices.get#Automation'
const SYNC_AUTO = 'facade.ReconciliationFacadeServices.sync#Automation'

function signedIn() {
  const dir = mkdtempSync(join(tmpdir(), 'darpan-cli-edits-'))
  saveConfig(dir, { current: 'prod', instances: { prod: { url: 'https://api.test', token: 'KEY123', tenant: 'ACME' } } })
  return dir
}

async function go(argv: string[], handlers: Record<string, any>) {
  const backend = fakeBackend(handlers)
  const out = await run(argv, { env: { DARPAN_CONFIG_DIR: signedIn() }, fetchImpl: backend.fetchImpl, openUrl: () => {}, sleep: async () => {} })
  return { ...out, ...backend }
}

const storeCond = { subject: 'FILE_1', presence: 'ANY', keyScope: 'FULL', quantifier: 'ALL', field: 'shipmentMethodTypeId', operator: 'IN', values: ['POS_COMPLETED'], checkLabel: 'Sold in a store' }
const node9 = { key: '9', parent: null, conclusion: 'CONC_100486', label: 'Sold in store', bucket: 'MISSING_FROM_FILE_2', question: null, fix: 'Receive the stock.', outcome: null, engine: null, suggestedFilterJson: null, conditions: [storeCond] }
const node10 = { key: '10', parent: null, conclusion: 'CONC_100459', label: 'Backordered', bucket: 'MISSING_FROM_FILE_2', question: null, fix: 'Fulfil it.', outcome: null, engine: null, suggestedFilterJson: null, conditions: [] }
const tree = () => ({ ok: true, conclusions: { savedRunId: 'RS_1', conclusions: [node9, node10], lookups: [], catalog: [], operators: ['IN'] } })

test('conclusions show answers the tree document, not the envelope', async () => {
  const r = await go(['conclusions', 'show', 'RS_1'], { [GET_TREE]: tree })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(r.requests[0]!.params, { savedRunId: 'RS_1' })
  assert.deepEqual(JSON.parse(r.stdout).conclusions.map((n: any) => n.key), ['9', '10'])
})

test('conclusions save previews by default and saves only with --yes, without the label', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'darpan-tree-'))
  const file = join(dir, 'tree.json')
  const edited = { ...tree().conclusions, conclusions: [{ ...node9, conditions: [{ ...storeCond, values: ['POS_COMPLETED', 'NO_SHIPPING'] }] }, node10] }
  writeFileSync(file, JSON.stringify(edited))
  const preview = await go(['conclusions', 'save', 'RS_1', '--file', file], { [GET_TREE]: tree })
  assert.equal(preview.exitCode, 0, preview.stderr)
  const p = JSON.parse(preview.stdout)
  assert.equal(p.saved, false)
  assert.equal(p.preview, true)
  assert.deepEqual(p.changed.map((c: any) => c.key), ['9'])
  assert.deepEqual(Object.keys(p.changed[0].fields), ['conditions'])
  assert.equal(p.unchanged, 1)
  assert.ok(!preview.requests.some((q) => q.method === SAVE_TREE), 'a preview never saves')

  const saved = await go(['conclusions', 'save', 'RS_1', '--file', file, '--yes'], { [GET_TREE]: tree, [SAVE_TREE]: () => ({ ok: true }) })
  assert.equal(saved.exitCode, 0, saved.stderr)
  const call = saved.requests.find((q) => q.method === SAVE_TREE)!
  assert.equal(call.params.savedRunId, 'RS_1')
  assert.equal(call.params.lookups, undefined, 'lookups are left as they are')
  assert.ok(call.params.conclusions.every((n: any) => n.label === undefined), 'label is display only')
  assert.deepEqual(call.params.conclusions[0].conditions[0].values, ['POS_COMPLETED', 'NO_SHIPPING'])
  assert.equal(JSON.parse(saved.stdout).saved, true)
})

test('conclusions save refuses an empty or malformed tree, and saves nothing when nothing changes', async () => {
  for (const bad of ['[]', '{"conclusions": []}', 'not json', '{"x": 1}', '[1]']) {
    const r = await go(['conclusions', 'save', 'RS_1', '--tree', bad, '--yes'], { [GET_TREE]: tree, [SAVE_TREE]: () => ({ ok: true }) })
    assert.equal(r.exitCode, EXIT.usage, bad)
    assert.ok(!r.requests.some((q) => q.method === SAVE_TREE), bad)
  }
  const same = await go(['conclusions', 'save', 'RS_1', '--tree', JSON.stringify(tree().conclusions), '--yes'], { [GET_TREE]: tree, [SAVE_TREE]: () => ({ ok: true }) })
  assert.equal(same.exitCode, 0, same.stderr)
  assert.equal(JSON.parse(same.stdout).saved, false)
  assert.ok(!same.requests.some((q) => q.method === SAVE_TREE))
})

test('treeChanges names added, removed and changed nodes by key', () => {
  const c = treeChanges([node9, node10], [{ ...node9, fix: 'New fix.' }, { ...node10, key: '11' }])
  assert.deepEqual(c.changed, [{ key: '9', fields: { fix: { from: 'Receive the stock.', to: 'New fix.' } } }])
  assert.deepEqual(c.added.map((n) => n.key), ['11'])
  assert.deepEqual(c.removed.map((n) => n.key), ['10'])
  assert.equal(c.unchanged, 0)
})

test('conclusions code makes a tenant code by label', async () => {
  const r = await go(['conclusions', 'code', '--label', 'Backordered at the store'], { [NEW_CODE]: () => ({ ok: true, conclusionEnumId: 'CONC_9' }) })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(r.requests[0]!.params, { label: 'Backordered at the store' })
  assert.equal(JSON.parse(r.stdout).conclusionEnumId, 'CONC_9')
  const none = await go(['conclusions', 'code'], {})
  assert.equal(none.exitCode, EXIT.usage)
})

const drifted = () => ({
  ok: true,
  syncStatus: { inSync: false, changedFields: ['FILE_1.excludeFilters'], savedRunMissing: false },
  automation: {
    automationName: 'Month close: Completed - HotWax vs NetSuite', savedRunId: 'RS_100515',
    sources: [{ fileSide: 'FILE_1', excludeFilters: [{ fieldExpression: 'unitState', operator: 'INCLUDE_IN', values: ['COMPLETED'] }] },
              { fileSide: 'FILE_2', excludeFilters: [] }],
    savedRun: { file1ExcludeFilters: [{ sequenceNum: 1, fieldExpression: 'unitState', operator: 'INCLUDE_IN', values: ['COMPLETED'] },
                                      { sequenceNum: 2, fieldExpression: 'productId', operator: 'EXCLUDE_IN', values: ['142036'] }],
                file2ExcludeFilters: [] },
  },
})

test('automation sync shows both sides\' filters and syncs only with --yes', async () => {
  const preview = await go(['automation', 'sync', '100513'], { [GET_AUTO]: drifted })
  assert.equal(preview.exitCode, 0, preview.stderr)
  const p = JSON.parse(preview.stdout)
  assert.equal(p.inSync, false)
  assert.equal(p.preview, true)
  assert.deepEqual(p.changedFields, ['FILE_1.excludeFilters'])
  assert.deepEqual(p.filters, [{ side: 'FILE_1', automation: [{ fieldExpression: 'unitState', operator: 'INCLUDE_IN', values: ['COMPLETED'] }],
    run: [{ fieldExpression: 'unitState', operator: 'INCLUDE_IN', values: ['COMPLETED'] }, { fieldExpression: 'productId', operator: 'EXCLUDE_IN', values: ['142036'] }] }])
  assert.ok(!preview.requests.some((q) => q.method === SYNC_AUTO), 'a preview never syncs')

  const done = await go(['automation', 'sync', '100513', '--yes'], { [GET_AUTO]: drifted, [SYNC_AUTO]: () => ({ ok: true, changedFields: ['FILE_1.excludeFilters'] }) })
  assert.equal(done.exitCode, 0, done.stderr)
  assert.deepEqual(done.requests.find((q) => q.method === SYNC_AUTO)!.params, { automationId: '100513' })
  assert.equal(JSON.parse(done.stdout).synced, true)
})

test('automation sync does nothing for an automation already in sync', async () => {
  const inSync = () => ({ ...drifted(), syncStatus: { inSync: true, changedFields: [] } })
  const r = await go(['automation', 'sync', '100513', '--yes'], { [GET_AUTO]: inSync, [SYNC_AUTO]: () => ({ ok: true }) })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).synced, false)
  assert.ok(!r.requests.some((q) => q.method === SYNC_AUTO))
})

test('the new commands call only allowlisted methods and say whether they change things', () => {
  const allowed = new Set(loadAllowedMethods().map((m) => m.method))
  for (const m of [GET_TREE, SAVE_TREE, NEW_CODE, GET_AUTO, SYNC_AUTO]) assert.ok(allowed.has(m), m)
  const byName = (n: string) => COMMANDS.find((c) => c.name === n)!
  assert.deepEqual(annotationsFor(byName('conclusions show')), { readOnlyHint: true })
  assert.deepEqual(annotationsFor(byName('conclusions code')), { readOnlyHint: false, destructiveHint: false })
  assert.deepEqual(annotationsFor(byName('conclusions save')), { readOnlyHint: false, destructiveHint: true })
  assert.deepEqual(annotationsFor(byName('automation sync')), { readOnlyHint: false, destructiveHint: true })
})

test('bin/darpan hands every command\'s first word to the Node CLI', () => {
  // Found live 2026-11-21: `darpan conclusions` and `darpan automation` died in the shell launcher ("unknown command")
  // while every node test passed, because the launcher keeps its own list of words it passes on.
  const launcher = readFileSync(new URL('../../bin/darpan', import.meta.url), 'utf8')
  const line = launcher.split('\n').find((l) => /^\s*login\|logout\|/.test(l))
  assert.ok(line, 'the launcher\'s run_agent case line')
  const words = new Set(line.replace(/\).*$/, '').trim().split('|'))
  for (const first of new Set(COMMANDS.map((c) => c.name.split(' ')[0]!))) assert.ok(words.has(first), `bin/darpan does not pass "${first}" to the Node CLI`)
})

test('conclusions save --file: the config folder, links into it, non-files and oversize files are refused; --file and --tree together is a usage error', async () => {
  // Moved from the deleted `script run` tests (DAR-CLI-008): conclusions save is now the shared file reader's caller.
  const cfg = signedIn()
  const other = mkdtempSync(join(tmpdir(), 'darpan-tree-files-'))
  writeFileSync(join(cfg, 'secret.txt'), 'x')
  const link = join(other, 'link.json')
  symlinkSync(join(cfg, 'config.json'), link)
  const backend = (argv: string[]) => {
    const b = fakeBackend({ [GET_TREE]: tree })
    return run(argv, { env: { DARPAN_CONFIG_DIR: cfg }, fetchImpl: b.fetchImpl, openUrl: () => {}, sleep: async () => {} }).then((out) => ({ ...out, ...b }))
  }
  for (const path of [join(cfg, 'config.json'), join(cfg, 'secret.txt'), link]) {
    const r = await backend(['conclusions', 'save', 'RS_1', '--file', path])
    assert.equal(r.exitCode, EXIT.usage, `${path}: ${r.stderr}`)
    assert.match(r.stderr, /config folder/)
    assert.equal(r.requests.length, 0, 'nothing is read from the server before the file is accepted')
  }
  const notFile = await backend(['conclusions', 'save', 'RS_1', '--file', other])
  assert.equal(notFile.exitCode, EXIT.usage)
  assert.match(notFile.stderr, /not a regular file/)
  const big = join(other, 'big.json')
  writeFileSync(big, 'x'.repeat(2_100_000))
  const tooBig = await backend(['conclusions', 'save', 'RS_1', '--file', big])
  assert.equal(tooBig.exitCode, EXIT.usage)
  assert.match(tooBig.stderr, /limited to 500,000/)
  const both = await backend(['conclusions', 'save', 'RS_1', '--file', big, '--tree', '{}'])
  assert.equal(both.exitCode, EXIT.usage)
  assert.deepEqual(COMMANDS.find((x) => x.name === 'conclusions save')!.cliOnly, ['file'])
})

// ---- DAR-CLI-008: config restore previews by default and restores the previewed plan only with --yes ----------------
const PREVIEW_RESTORE = 'facade.TenantConfigFacadeServices.preview#TenantConfigRestore'
const RESTORE = 'facade.TenantConfigFacadeServices.restore#TenantConfigVersion'
const version = { id: 'CV_7', seq: 7, createdDate: '2026-11-25T10:00:00Z' }
const plan = { lines: [{ kind: 'STATEMENT', ref: 'R4', label: 'Every order is billed', action: 'UPDATE' }] }
const preview = () => ({ ok: true, version, plan, planHash: 'HASH7' })

test('config restore without --yes only previews, and answers the planHash a restore must name', async () => {
  const r = await go(['config', 'restore', 'CV_7'], { [PREVIEW_RESTORE]: preview })
  assert.equal(r.exitCode, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.preview, true)
  assert.equal(out.restored, false)
  assert.deepEqual(out.version, version)
  assert.deepEqual(out.plan, plan)
  assert.equal(out.planHash, 'HASH7')
  assert.match(out.next, /--yes --plan HASH7/)
  assert.deepEqual(r.requests.map((q) => q.method), [PREVIEW_RESTORE])
  assert.deepEqual(r.requests[0]!.params, { id: 'CV_7' })
})

test('config restore preview with blocking items says so, and offers no --yes', async () => {
  const blocked = () => ({ ok: true, version, plan: { ...plan, blocking: [{ message: 'Run RS_9 is gone; restore it first.' }] }, planHash: 'HASH7' })
  const r = await go(['config', 'restore', 'CV_7'], { [PREVIEW_RESTORE]: blocked })
  assert.equal(r.exitCode, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.blocked, true)
  assert.deepEqual(out.blocking, ['Run RS_9 is gone; restore it first.'])
  assert.equal(out.planHash, undefined, 'a blocked plan cannot be restored, so no hash to pass')
  assert.doesNotMatch(out.next, /--yes/)
})

test('config restore --yes restores exactly the plan the person saw (--plan), without previewing again', async () => {
  const before = { id: 'CV_9', seq: 9 }
  const after = { id: 'CV_10', seq: 10 }
  const r = await go(['config', 'restore', 'CV_7', '--yes', '--plan', 'HASH7'], { [PREVIEW_RESTORE]: preview, [RESTORE]: () => ({ ok: true, restored: true, before, after, plan }) })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(r.requests.map((q) => q.method), [RESTORE], 'a second preview would pick up a plan nobody saw')
  assert.deepEqual(r.requests[0]!.params, { id: 'CV_7', planHash: 'HASH7' })
  const out = JSON.parse(r.stdout)
  assert.equal(out.restored, true)
  assert.deepEqual(out.before, before)
  assert.deepEqual(out.after, after)
})

test('config restore --yes without --plan is a usage error and sends nothing', async () => {
  const r = await go(['config', 'restore', 'CV_7', '--yes'], { [PREVIEW_RESTORE]: preview })
  assert.equal(r.exitCode, EXIT.usage)
  assert.equal(r.requests.length, 0)
  assert.match(r.stderr, /--plan/)
})

test('config restore reports a refused (stale) restore as failed, in the server\'s words', async () => {
  const r = await go(['config', 'restore', 'CV_7', '--yes', '--plan', 'HASH7'], {
    [RESTORE]: () => ({ ok: false, errors: ['The config changed since the preview. Preview the restore again.'] }),
  })
  assert.equal(r.exitCode, EXIT.failed)
  assert.match(r.stderr, /changed since the preview/)
})

test('config restore needs a version id, is a destructive MCP tool, and its methods are allowlisted', async () => {
  const r = await go(['config', 'restore'], {})
  assert.equal(r.exitCode, EXIT.usage)
  assert.equal(r.requests.length, 0)
  const command = COMMANDS.find((c) => c.name === 'config restore')!
  assert.deepEqual(annotationsFor(command), { readOnlyHint: false, destructiveHint: true })
  const allowed = new Set(loadAllowedMethods().map((m) => m.method))
  assert.ok(allowed.has(PREVIEW_RESTORE) && allowed.has(RESTORE))
})
