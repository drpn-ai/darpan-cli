import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAllowedMethods, extractAllowed, isWriteMethod } from '../scripts/sync-allowlist.ts'

const FIXTURE = `
class CliMethodAllowlist {
    static final List<String> CLI_PATHS = ["/rpc/json", "/rest/s1/graphql"].asImmutable()
    static final Set<String> ALLOWED = ([
            // a comment with "quoted" text
            "facade.A.get#One",
            "facade.A.list#Two", // trailing note

            "facade.B.run#Three",
    ] as LinkedHashSet<String>).asImmutable()
    static final Set<String> EXCLUDED = ([
            "admin.X.create#Nope",
    ] as LinkedHashSet<String>).asImmutable()
}`

test('extractAllowed reads only the quoted strings inside ALLOWED = [ ... ]', () => {
  assert.deepEqual(extractAllowed(FIXTURE), ['facade.A.get#One', 'facade.A.list#Two', 'facade.B.run#Three'])
})

test('extractAllowed fails loudly when ALLOWED is missing', () => {
  assert.throws(() => extractAllowed('class X {}'), /ALLOWED/)
})

test('buildAllowedMethods takes descriptions from the contract where present', () => {
  const openapi = {
    'x-darpan-methods': { 'facade.A.get#One': 'GetOne' },
    components: { schemas: { GetOneParams: { description: 'Reads one.', required: ['id'], properties: { id: { type: 'string' }, detail: { type: 'boolean' } } } } },
  }
  assert.deepEqual(buildAllowedMethods(FIXTURE, openapi), [
    { method: 'facade.A.get#One', description: 'Reads one.', writes: false, inputs: [{ name: 'id', required: true }, { name: 'detail', required: false }] },
    { method: 'facade.A.list#Two', description: '', writes: false, inputs: [] },
    { method: 'facade.B.run#Three', description: '', writes: true, inputs: [] },
  ])
  assert.equal(buildAllowedMethods(FIXTURE)[0]!.description, '')
})

test('isWriteMethod: only read verbs are reads; an unknown verb counts as a write (DAR-CLI-008)', () => {
  for (const read of ['get', 'list', 'search', 'preview', 'test', 'find', 'inspect', 'describe', 'validate', 'infer', 'flatten']) {
    assert.equal(isWriteMethod(`facade.X.${read}#Y`), false, read)
  }
  for (const write of ['save', 'delete', 'create', 'run', 'retry', 'restore', 'apply', 'acknowledge', 'frobnicate']) {
    assert.equal(isWriteMethod(`facade.X.${write}#Y`), true, write)
  }
})

test('the read-only fresh queries are reads though their verb is run (DAR-CLI-008)', () => {
  for (const m of ['facade.NetSuiteQueryFacadeServices.run#NsSuiteQlAgentQuery', 'facade.HotWaxOmsFacadeServices.run#OmsGraphqlAgentQuery',
    'facade.ShopifyFacadeServices.run#ShopifyGraphqlAgentQuery']) {
    assert.equal(isWriteMethod(m), false, m)
  }
  assert.equal(isWriteMethod('facade.TenantScriptFacadeServices.run#TenantQuery'), true)
})
