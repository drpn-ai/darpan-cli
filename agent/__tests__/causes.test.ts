// DAR-CLI-008 part 2: a person explains a finding (cause add), marks a cause expected (cause expect), or proposes any
// other audit change (cause propose); the proposal is reviewed (change show) and applied only with --yes --plan.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { run } from '../main.ts'
import { saveConfig } from '../config.ts'
import { COMMANDS, loadAllowedMethods } from '../commands.ts'
import { annotationsFor } from '../mcp.ts'
import { EXIT } from '../rpc.ts'
import { fakeBackend } from './fakeBackend.ts'

const CHANGE = 'facade.AgentChangeFacadeServices'
const PROPOSE = `${CHANGE}.propose#AuditChange`
const GET = `${CHANGE}.get#AuditChangeProposal`
const LIST = `${CHANGE}.list#AuditChangeProposals`
const APPLY = `${CHANGE}.apply#AuditChange`
const REJECT = `${CHANGE}.reject#AuditChange`
const REVERT = `${CHANGE}.revert#AuditChange`
const LOOKALIKES = 'facade.AgentReadFacadeServices.find#AuditFindingLookalikes'
const RECHECK_ALL = 'facade.AuditFacadeServices.verify#AuditFindings'

async function go(argv: string[], handlers: Record<string, any> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'darpan-cli-causes-'))
  saveConfig(dir, { current: 'prod', instances: { prod: { url: 'https://api.test', token: 'KEY123', tenant: 'ACME' } } })
  const backend = fakeBackend(handlers)
  const out = await run(argv, { env: { DARPAN_CONFIG_DIR: dir }, fetchImpl: backend.fetchImpl, openUrl: () => {}, sleep: async () => {} })
  return { ...out, ...backend }
}

const proposed = () => ({ ok: true, proposalId: 'P1', status: 'PLANNED', provenanceStatus: 'BLOCKED', unconfirmedIds: ['NOT_PAID'], backtest: { moved: 12 } })

test('cause add proposes one cause row from the --when conditions, with the person\'s words and the finding', async () => {
  const r = await go(['cause', 'add', '--run', 'RS_1', '--code', 'CONC_9', '--when', 'paymentStatus IN NOT_PAID,PENDING; oppId IS_EMPTY',
    '--words', 'not paid yet, the OPP is missing', '--finding', 'F-1', '--fix', 'Wait for payment'], { [PROPOSE]: proposed })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(r.requests[0]!.params, {
    kind: 'CONCLUSION_ROWS', target: { savedRunId: 'RS_1' },
    after: { rows: [{ conclusionCode: 'CONC_9', fixActionTemplate: 'Wait for payment', conditions: [
      { fieldExpression: 'paymentStatus', operator: 'IN', checkValue: 'NOT_PAID,PENDING' },
      { fieldExpression: 'oppId', operator: 'IS_EMPTY' }] }] },
    personWords: 'not paid yet, the OPP is missing', findingId: 'F-1',
  })
  const out = JSON.parse(r.stdout)
  assert.equal(out.proposalId, 'P1')
  assert.deepEqual(out.unconfirmedIds, ['NOT_PAID'])
  assert.match(out.next, /darpan change show P1/)
})

test('cause add refuses a condition with no operator, and missing words, before any call', async () => {
  for (const argv of [
    ['cause', 'add', '--run', 'RS_1', '--code', 'CONC_9', '--when', 'paymentStatus', '--words', 'w'],
    ['cause', 'add', '--run', 'RS_1', '--code', 'CONC_9', '--when', 'paymentStatus in NOT_PAID', '--words', 'w'],
    ['cause', 'add', '--run', 'RS_1', '--code', 'CONC_9', '--when', 'paymentStatus IN NOT_PAID'],
    ['cause', 'add', '--code', 'CONC_9', '--when', 'a IN b', '--words', 'w'],
  ]) {
    const r = await go(argv, { [PROPOSE]: proposed })
    assert.equal(r.exitCode, EXIT.usage, `${argv.join(' ')}: ${r.stderr}`)
    assert.equal(r.requests.length, 0)
  }
})

test('cause expect proposes the codes as expected causes of the check', async () => {
  const r = await go(['cause', 'expect', '--audit', 'ACME_MC', '--check', 'returns-open', '--codes', 'CONC_STORE, CONC_PENDING',
    '--words', 'store never finished is a pending return, that is expected'], { [PROPOSE]: proposed })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(r.requests[0]!.params, {
    kind: 'EXPECTED_CAUSES', target: { auditId: 'ACME_MC', checkCode: 'returns-open' }, after: { expectedCodes: ['CONC_STORE', 'CONC_PENDING'] },
    personWords: 'store never finished is a pending return, that is expected',
  })
})

test('cause propose sends any kind as given', async () => {
  const r = await go(['cause', 'propose', '--kind', 'FIX_TEXT', '--target', '{"savedRunId":"RS_1","conclusionCode":"CONC_9"}',
    '--after', '{"fixActionTemplate":"Ask finance"}', '--words', 'ask finance', '--reason', 'r'], { [PROPOSE]: proposed })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(r.requests[0]!.params, { kind: 'FIX_TEXT', target: { savedRunId: 'RS_1', conclusionCode: 'CONC_9' },
    after: { fixActionTemplate: 'Ask finance' }, personWords: 'ask finance', reasonText: 'r' })
})

test('change show answers the proposal; change list passes its filters', async () => {
  const view = { proposalId: 'P1', status: 'PLANNED', planHash: 'H1', unconfirmedIds: ['NOT_PAID'], before: {}, after: {}, backtest: { moved: 12 } }
  const shown = await go(['change', 'show', 'P1'], { [GET]: () => ({ ok: true, proposal: view }) })
  assert.equal(shown.exitCode, 0, shown.stderr)
  assert.deepEqual(JSON.parse(shown.stdout).proposal, view)
  assert.match(JSON.parse(shown.stdout).next, /--plan H1 --confirm 'NOT_PAID'/)
  const listed = await go(['change', 'list', '--status', 'OPEN', '--origin', 'PERSON'], { [LIST]: () => ({ ok: true, proposals: [] }) })
  assert.deepEqual(listed.requests[0]!.params, { status: 'OPEN', origin: 'PERSON' })
})

test('change apply needs --yes and --plan, sends the confirmations, and reports a stale plan as failed', async () => {
  const noYes = await go(['change', 'apply', 'P1', '--plan', 'H1'], { [APPLY]: () => ({ ok: true }) })
  assert.equal(noYes.exitCode, EXIT.usage)
  assert.equal(noYes.requests.length, 0)
  const noPlan = await go(['change', 'apply', 'P1', '--yes'], { [APPLY]: () => ({ ok: true }) })
  assert.equal(noPlan.exitCode, EXIT.usage)
  assert.equal(noPlan.requests.length, 0)
  const ok = await go(['change', 'apply', 'P1', '--yes', '--plan', 'H1', '--confirm', 'NOT_PAID, PENDING'],
    { [APPLY]: () => ({ ok: true, status: 'APPLIED', appliedVersionId: 'V2' }) })
  assert.equal(ok.exitCode, 0, ok.stderr)
  assert.deepEqual(ok.requests[0]!.params, { proposalId: 'P1', planHash: 'H1', confirmedIds: ['NOT_PAID', 'PENDING'] })
  assert.equal(JSON.parse(ok.stdout).status, 'APPLIED')
  const stale = await go(['change', 'apply', 'P1', '--yes', '--plan', 'H0'],
    { [APPLY]: () => ({ ok: true, status: 'STALE', statusMessage: 'The config changed since this was planned. Plan it again.' }) })
  assert.equal(stale.exitCode, EXIT.failed)
  assert.match(stale.stderr, /changed since this was planned/)
})

test('change reject and change revert', async () => {
  const rejected = await go(['change', 'reject', 'P1', '--reason', 'not this'], { [REJECT]: () => ({ ok: true, status: 'REJECTED' }) })
  assert.deepEqual(rejected.requests[0]!.params, { proposalId: 'P1', reason: 'not this' })
  const reverted = await go(['change', 'revert', 'P1'], { [REVERT]: () => ({ ok: true, newProposalId: 'P2', status: 'PLANNED', planHash: 'H2' }) })
  assert.equal(reverted.exitCode, 0, reverted.stderr)
  const out = JSON.parse(reverted.stdout)
  assert.equal(out.newProposalId, 'P2')
  assert.match(out.next, /darpan change show P2/)
})

test('findings lookalikes and the statement re-check', async () => {
  const like = await go(['findings', 'lookalikes', 'F-1', '--limit', '5'], { [LOOKALIKES]: () => ({ ok: true, byCause: {} }) })
  assert.deepEqual(like.requests[0]!.params, { findingId: 'F-1', limit: 5 })
  const all = await go(['findings', 'recheck', '--audit', 'ACME_MC', '--period', '2026-11', '--statement', 'R4'],
    { [RECHECK_ALL]: () => ({ ok: true, findings: 40, runs: 2, skipped: 0 }) })
  assert.equal(all.exitCode, 0, all.stderr)
  assert.deepEqual(all.requests[0]!.params, { audit: 'ACME_MC', period: '2026-11', statement: 'R4' })
  assert.equal(JSON.parse(all.stdout).findings, 40)
})

test('MCP classes: proposing only drafts, applying and reverting change things, reads are reads; every method is allowlisted', () => {
  const byName = (n: string) => COMMANDS.find((c) => c.name === n)!
  for (const n of ['cause add', 'cause expect', 'cause propose']) assert.deepEqual(annotationsFor(byName(n)), { readOnlyHint: false, destructiveHint: false }, n)
  for (const n of ['change apply', 'change reject', 'change revert']) assert.deepEqual(annotationsFor(byName(n)), { readOnlyHint: false, destructiveHint: true }, n)
  for (const n of ['change list', 'change show', 'findings lookalikes']) assert.deepEqual(annotationsFor(byName(n)), { readOnlyHint: true }, n)
  const allowed = new Set(loadAllowedMethods().map((m) => m.method))
  for (const m of [PROPOSE, GET, LIST, APPLY, REJECT, REVERT, LOOKALIKES, RECHECK_ALL]) assert.ok(allowed.has(m), m)
})

test('the guide teaches the explain, expected and undo flows, and the two rules', async () => {
  const { GUIDE } = await import('../guide.ts')
  for (const needle of ['Explain a finding', 'This is expected', 'Undo', 'findings lookalikes', 'conclusions code --label', 'cause add',
    'cause expect', 'change show', 'change apply', '--plan', 'findings recheck --audit', 'change revert']) {
    assert.ok(GUIDE.includes(needle), needle)
  }
  assert.match(GUIDE, /--words is what the person said/)
  assert.match(GUIDE, /never pass --confirm with values the person has not seen/i)
})

// ---- final review fixes ----------------------------------------------------------------------------------------------
const PLAN = `${CHANGE}.plan#AuditChange`

test('change plan re-plans a stale proposal, and change show points to it', async () => {
  const stale = { proposalId: 'P1', status: 'STALE', statusMessage: 'The config changed since this was planned. Plan it again.', origin: 'PERSON', unconfirmedIds: [] }
  const shown = await go(['change', 'show', 'P1'], { [GET]: () => ({ ok: true, proposal: stale }) })
  assert.match(JSON.parse(shown.stdout).next, /darpan change plan P1/)
  const planned = await go(['change', 'plan', 'P1'], { [PLAN]: () => ({ ok: true, status: 'PLANNED', planHash: 'H2', backtest: { moved: 3 } }) })
  assert.equal(planned.exitCode, 0, planned.stderr)
  assert.deepEqual(planned.requests[0]!.params, { proposalId: 'P1' })
  assert.match(JSON.parse(planned.stdout).next, /darpan change show P1/)
  assert.deepEqual(annotationsFor(COMMANDS.find((c) => c.name === 'change plan')!), { readOnlyHint: false, destructiveHint: false })
})

test('an agent proposal\'s unconfirmed values are confirmed in the app, not with --confirm', async () => {
  const agent = { proposalId: 'P3', status: 'PLANNED', planHash: 'H3', origin: 'AGENT', unconfirmedIds: ['M1'] }
  const shown = await go(['change', 'show', 'P3'], { [GET]: () => ({ ok: true, proposal: agent }) })
  const next = JSON.parse(shown.stdout).next
  assert.doesNotMatch(next, /--confirm/)
  assert.match(next, /agent conversation in the app/)
})

test('the suggested --confirm is shell-quoted, and a value with a comma or space is passed as a JSON list', async () => {
  const view = { proposalId: 'P1', status: 'PLANNED', planHash: 'H1', origin: 'PERSON', unconfirmedIds: ['NOT PAID', 'A,B'] }
  const shown = await go(['change', 'show', 'P1'], { [GET]: () => ({ ok: true, proposal: view }) })
  assert.match(JSON.parse(shown.stdout).next, /--confirm '\["NOT PAID","A,B"\]'/)
  const applied = await go(['change', 'apply', 'P1', '--yes', '--plan', 'H1', '--confirm', '["NOT PAID","A,B"]'],
    { [APPLY]: () => ({ ok: true, status: 'APPLIED' }) })
  assert.equal(applied.exitCode, 0, applied.stderr)
  assert.deepEqual(applied.requests[0]!.params.confirmedIds, ['NOT PAID', 'A,B'])
  const simple = await go(['change', 'show', 'P1'], { [GET]: () => ({ ok: true, proposal: { ...view, unconfirmedIds: ['M1', 'M2'] } }) })
  assert.match(JSON.parse(simple.stdout).next, /--confirm 'M1,M2'/)
})

test('an empty --when is a usage error, not a cause with no conditions', async () => {
  for (const when of ['', ' ; ']) {
    const r = await go(['cause', 'add', '--run', 'RS_1', '--code', 'CONC_9', `--when=${when}`, '--words', 'w'], { [PROPOSE]: proposed })
    assert.equal(r.exitCode, EXIT.usage, `"${when}": ${r.stderr}`)
    assert.equal(r.requests.length, 0)
  }
  const bare = await go(['cause', 'add', '--run', 'RS_1', '--code', 'CONC_9', '--when', '--words', 'w'], { [PROPOSE]: proposed })
  assert.equal(bare.exitCode, EXIT.usage)
})
