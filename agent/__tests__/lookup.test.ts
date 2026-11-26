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

test('lookup sends the value and prints the chain; order facts only by default', async () => {
  const r = await go(['lookup', '19014662389929'], { [LOOKUP]: () => ({ ok: true, lookup: answer }) })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(r.requests[0]!.params, { value: '19014662389929', all: false })
  assert.deepEqual(JSON.parse(r.stdout), answer)
  assert.equal(r.stderr, '', 'no reminder without --all')
})

test('lookup --all asks for every field and reminds that customer details now sit in the transcript', async () => {
  const r = await go(['lookup', '#GOR197527791', '--all'], { [LOOKUP]: () => ({ ok: true, lookup: answer }) })
  assert.equal(r.exitCode, 0)
  assert.deepEqual(r.requests[0]!.params, { value: '#GOR197527791', all: true })
  assert.match(r.stderr, /customer details/i)
  assert.match(r.stderr, /transcript/i)
})

test('lookup needs a value; it is a read-only MCP tool; its method is allowlisted', async () => {
  const r = await go(['lookup'], {})
  assert.equal(r.exitCode, EXIT.usage)
  assert.equal(r.requests.length, 0)
  assert.deepEqual(annotationsFor(COMMANDS.find((c) => c.name === 'lookup')!), { readOnlyHint: true })
  assert.ok(loadAllowedMethods().some((m) => m.method === LOOKUP && m.writes === false))
})

test('the guide starts the explain flow with lookup and keeps --all for when the person asks', async () => {
  const { GUIDE } = await import('../guide.ts')
  assert.match(GUIDE, /lookup <order id>/)
  assert.match(GUIDE, /--all only when the person asks/)
})
