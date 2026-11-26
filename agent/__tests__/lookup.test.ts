// DAR-CLI-008 part 3: darpan lookup follows an order through every connected system.
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

const LOOKUP = 'facade.LookupFacadeServices.lookup#Order'
const answer = { value: '19014662389929', records: [{ system: 'SHOPIFY', recordKind: 'ORDER', record: { name: '#1044966' } }], findings: [], skipped: [], readsUsed: 7, capped: false }

async function go(argv: string[], handlers: Record<string, any> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'darpan-cli-lookup-'))
  saveConfig(dir, { current: 'prod', instances: { prod: { url: 'https://api.test', token: 'KEY123', tenant: 'ACME' } } })
  const backend = fakeBackend(handlers)
  const out = await run(argv, { env: { DARPAN_CONFIG_DIR: dir }, fetchImpl: backend.fetchImpl, openUrl: () => {}, sleep: async () => {} })
  return { ...out, ...backend }
}

test('lookup sends the value and prints what Darpan holds', async () => {
  const r = await go(['lookup', '19014662389929'], { [LOOKUP]: () => ({ ok: true, lookup: answer }) })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(r.requests[0]!.params, { value: '19014662389929' })
  assert.deepEqual(JSON.parse(r.stdout), answer)
  assert.equal(r.stderr, '')
})

test('lookup says on stderr when no Darpan run has read the id', async () => {
  const r = await go(['lookup', '5550001'], { [LOOKUP]: () => ({ ok: true, lookup: { value: '5550001', records: [], findings: [], notSeen: true } }) })
  assert.equal(r.exitCode, 0)
  assert.match(r.stderr, /no darpan run has read this id/i)
})

test('lookup needs a value; it is a read-only MCP tool; its method is allowlisted', async () => {
  const r = await go(['lookup'], {})
  assert.equal(r.exitCode, EXIT.usage)
  assert.equal(r.requests.length, 0)
  assert.deepEqual(annotationsFor(COMMANDS.find((c) => c.name === 'lookup')!), { readOnlyHint: true })
  assert.ok(loadAllowedMethods().some((m) => m.method === LOOKUP && m.writes === false))
})


// DAR-BE-374: lookup --status and the guide.
const STATUS = 'facade.IdIndexFacadeServices.get#IdIndexStatus'

test('lookup --status lists each kept copy and names one the index is behind, with no value and no --yes', async () => {
  const status = { connections: [
    { connectionId: 'SHOP', systemEnumId: 'SHOPIFY', lastStatus: 'OK', behind: false, stale: false },
    { connectionId: 'OMS', systemEnumId: 'OMS_GQL', lastStatus: 'FAILED', lastError: 'Spark said no', behind: true, stale: true },
  ], rowCount: 12 }
  const r = await go(['lookup', '--status'], { [STATUS]: () => ({ ok: true, ...status }) })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(r.requests[0]!.method, STATUS)
  assert.deepEqual(JSON.parse(r.stdout), status)
  assert.match(r.stderr, /OMS_GQL OMS: the ID index is behind.*Spark said no/)
  assert.ok(loadAllowedMethods().some((m) => m.method === STATUS && m.writes === false))
})

test('the guide says lookup answers from what Darpan holds and calls no connected system', async () => {
  const { GUIDE } = await import('../guide.ts')
  const text = Array.isArray(GUIDE) ? GUIDE.join('\n') : String(GUIDE)
  assert.match(text, /ID index/)
  assert.match(text, /calls no connected system/)
  assert.match(text, /lookup --status/)
  assert.doesNotMatch(text, /--all/)
})
