import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAllowedMethods, extractAllowed } from '../scripts/sync-allowlist.ts'

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
    components: { schemas: { GetOneParams: { description: 'Reads one.' } } },
  }
  assert.deepEqual(buildAllowedMethods(FIXTURE, openapi), [
    { method: 'facade.A.get#One', description: 'Reads one.' },
    { method: 'facade.A.list#Two', description: '' },
    { method: 'facade.B.run#Three', description: '' },
  ])
  assert.equal(buildAllowedMethods(FIXTURE)[0]!.description, '')
})
