import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { run } from '../main.ts'
import { loadConfig, saveConfig, configDir } from '../config.ts'
import { EXIT } from '../rpc.ts'
import { fakeBackend, http, redirect } from './fakeBackend.ts'

const URL_ = 'https://api.test'
const START = 'facade.CliAuthFacadeServices.start#CliLogin'
const POLL = 'facade.CliAuthFacadeServices.poll#CliLogin'
const SESSION = 'facade.AuthFacadeServices.get#SessionInfo'
const LOGOUT = 'facade.CliAuthFacadeServices.logout#CliSession'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'darpan-cli-'))
}

function signedIn(dir: string, extra: object = {}) {
  saveConfig(dir, { current: 'prod', instances: { prod: { url: URL_, token: 'KEY123', tenant: 'ACME', ...extra } } })
}

async function go(argv: string[], dir: string, handlers: Record<string, any>, extra: any = {}) {
  const backend = fakeBackend(handlers)
  const opened: string[] = []
  const out = await run(argv, {
    env: { DARPAN_CONFIG_DIR: dir },
    fetchImpl: backend.fetchImpl,
    openUrl: (u: string) => opened.push(u),
    sleep: async () => {},
    ...extra,
  })
  return { ...out, ...backend, opened }
}

const start = () => ({ ok: true, deviceCode: 'DEV', userCode: 'BCDF-2345', verificationUrl: `${URL_}/cli-login`, verificationPath: '/cli-login', expiresInSeconds: 600, intervalSeconds: 3 })

test('login polls until approved and saves a 0600 config', async () => {
  const dir = join(tmpDir(), 'cfg')
  const polls = [{ ok: true, status: 'PENDING' }, { ok: true, status: 'PENDING' }, { ok: true, status: 'APPROVED', authToken: 'SECRET-KEY', authTokenHeaderName: 'login_key', authTokenExpiresInSeconds: 3600, username: 'a@b.c' }]
  const r = await go(['login', '--instance', URL_], dir, { [START]: start, [POLL]: () => polls.shift() })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(r.requests.length, 4)
  assert.equal(r.requests[0]!.headers.login_key, undefined, 'start is anonymous')
  assert.equal(r.requests[1]!.params.deviceCode, 'DEV')
  assert.match(r.stderr, /Enter this code in your browser: BCDF-2345/)
  assert.deepEqual(r.opened, [`${URL_}/cli-login`])
  assert.ok(!r.opened[0]!.includes('BCDF'), 'the code never rides in the URL')
  assert.ok(!r.stdout.includes('SECRET-KEY') && !r.stderr.includes('SECRET-KEY'), 'token never printed')
  const cfg = loadConfig(dir)
  assert.equal(cfg.current, 'prod')
  assert.equal(cfg.instances.prod!.token, 'SECRET-KEY')
  assert.ok(cfg.instances.prod!.tokenExpiresAt)
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
})

test('login --app-url opens the app page without the code', async () => {
  const dir = tmpDir()
  const r = await go(['login', '--instance', URL_, '--app-url', 'http://localhost:5173'], dir, {
    [START]: start,
    [POLL]: () => ({ ok: true, status: 'APPROVED', authToken: 'K', authTokenExpiresInSeconds: 60 }),
  })
  assert.equal(r.exitCode, 0)
  assert.deepEqual(r.opened, ['http://localhost:5173/cli-login'])
})

test('login reports denied and expired with exit 3', async () => {
  for (const status of ['DENIED', 'EXPIRED']) {
    const dir = tmpDir()
    const r = await go(['login', '--instance', URL_], dir, { [START]: start, [POLL]: () => ({ ok: true, status }) })
    assert.equal(r.exitCode, EXIT.unauthenticated, status)
    assert.equal(JSON.parse(r.stderr.split('\n').filter((l) => l.startsWith('{')).pop()!).next, 'run `darpan login`')
    assert.equal(existsSync(join(dir, 'config.json')) ? loadConfig(dir).instances.prod?.token : undefined, undefined)
  }
})

// DAR-BE-209: a sign-in nobody could approve (the CLI is not on for that person) ends in expiry or denial; the error
// says where to ask for it, at the app the approval page is on.
test('a denied or expired sign-in says where to request CLI access', async () => {
  for (const [status, extra, settings] of [
    ['EXPIRED', [], `${URL_}/settings/user`],
    ['DENIED', ['--app-url', 'http://localhost:5173'], 'http://localhost:5173/settings/user'],
  ] as const) {
    const r = await go(['login', '--instance', URL_, ...extra], tmpDir(), { [START]: start, [POLL]: () => ({ ok: true, status }) })
    const error = JSON.parse(r.stderr.split('\n').filter((l) => l.startsWith('{')).pop()!).error as string
    assert.ok(error.includes(`ask for it in User settings: ${settings}`), error)
  }
})

test('every call carries login_key and X-Darpan-Tenant, and no cookie', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['whoami'], dir, { [SESSION]: () => ({ ok: true, authenticated: true, sessionInfo: { username: 'a@b.c', activeTenantUserGroupId: 'ACME', availableTenants: [{ userGroupId: 'ACME', label: 'Acme' }], canEditActiveTenantData: true } }) })
  assert.equal(r.exitCode, 0, r.stderr)
  const h = r.requests[0]!.headers
  assert.equal(h.login_key, 'KEY123')
  assert.equal(h['X-Darpan-Tenant'], 'ACME')
  assert.equal(Object.keys(h).some((k) => k.toLowerCase() === 'cookie'), false)
  assert.equal(JSON.parse(r.stdout).tenant.id, 'ACME')
})

test('--tenant overrides for one call without saving', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['call', 'facade.AuditFacadeServices.get#Audits', '--tenant', 'OTHER'], dir, { 'facade.AuditFacadeServices.get#Audits': () => ({ ok: true, audits: [] }) })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(r.requests[0]!.headers['X-Darpan-Tenant'], 'OTHER')
  assert.equal(loadConfig(dir).instances.prod!.tenant, 'ACME')
})

test('tenant use changes only the local config', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['tenant', 'use', 'globex'], dir, { [SESSION]: () => ({ ok: true, authenticated: true, sessionInfo: { availableTenants: [{ userGroupId: 'ACME', label: 'Acme' }, { userGroupId: 'GLBX', label: 'Globex' }] } }) })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(loadConfig(dir).instances.prod!.tenant, 'GLBX')
  assert.ok(r.requests.every((q) => q.method !== 'facade.AuthFacadeServices.save#ActiveTenant'))
  const miss = await go(['tenant', 'use', 'nope'], dir, { [SESSION]: () => ({ ok: true, sessionInfo: { availableTenants: [] } }) })
  assert.equal(miss.exitCode, EXIT.usage)
})

test('tenants lists the person\'s tenants and marks the current one', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['tenants'], dir, { [SESSION]: () => ({ ok: true, sessionInfo: { availableTenants: [{ userGroupId: 'ACME', label: 'Acme' }] } }) })
  assert.deepEqual(JSON.parse(r.stdout).tenants, [{ id: 'ACME', label: 'Acme', current: true }])
})

test('an auth failure exits 3 with next: darpan login, and a dead session drops the token', async () => {
  for (const message of ['This CLI session was signed out. Run darpan login to sign in again.', 'This CLI session has expired. Run darpan login to sign in again.']) {
    const dir = tmpDir()
    signedIn(dir)
    const r = await go(['call', 'facade.AuditFacadeServices.get#Audits'], dir, { 'facade.AuditFacadeServices.get#Audits': () => http(403, message) })
    assert.equal(r.exitCode, EXIT.unauthenticated)
    assert.equal(JSON.parse(r.stderr).next, 'run `darpan login`')
    assert.equal(loadConfig(dir).instances.prod!.token, undefined)
    assert.equal(loadConfig(dir).instances.prod!.url, URL_)
  }
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['whoami'], dir, { [SESSION]: () => http(401, { jsonrpc: '2.0', error: { message: 'User must be logged in' } }) })
  assert.equal(r.exitCode, 3)
  const none = tmpDir()
  const r2 = await go(['whoami'], none, {})
  assert.equal(r2.exitCode, 3)
  assert.equal(r2.requests.length, 0)
})

test('a fence refusal exits 7', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['call', 'facade.AuditFacadeServices.get#Audits'], dir, {
    'facade.AuditFacadeServices.get#Audits': () => ({ rpcError: 'facade.X.y#Z is not available to the Darpan CLI; use the app.' }),
  })
  assert.equal(r.exitCode, EXIT.forbidden)
  const r2 = await go(['call', 'facade.AuditFacadeServices.get#Audits'], dir, { 'facade.AuditFacadeServices.get#Audits': () => http(403, 'This address is not available to the Darpan CLI.') })
  assert.equal(r2.exitCode, EXIT.forbidden)
  const r3 = await go(['call', 'facade.AuditFacadeServices.get#Audits'], dir, { 'facade.AuditFacadeServices.get#Audits': () => ({ ok: false, errors: ['Tenant ZZ is not one of your tenants'] }) })
  assert.equal(r3.exitCode, EXIT.forbidden)
  assert.equal(loadConfig(dir).instances.prod!.token, 'KEY123', 'a fence refusal keeps the session')
})

test('THROTTLED exits 4', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['call', 'facade.AuditFacadeServices.get#Audits'], dir, { 'facade.AuditFacadeServices.get#Audits': () => ({ ok: false, code: 'THROTTLED', error: 'Busy', retryAfterSeconds: 10 }) })
  assert.equal(r.exitCode, EXIT.throttled)
  assert.match(JSON.parse(r.stderr).next, /10 seconds/)
})

test('call refuses a method outside the allowlist without a request', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['call', 'admin.UserAdminServices.reset#Password'], dir, {})
  assert.equal(r.exitCode, EXIT.forbidden)
  assert.equal(r.requests.length, 0)
})

test('call sends --params and prints the result as JSON', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['call', 'facade.AuditFacadeServices.get#Audits', '--params', '{"a":1}'], dir, { 'facade.AuditFacadeServices.get#Audits': (p: any) => ({ ok: true, echo: p }) })
  assert.deepEqual(JSON.parse(r.stdout).echo, { a: 1 })
  const bad = await go(['call', 'facade.AuditFacadeServices.get#Audits', '--params', '{nope'], dir, {})
  assert.equal(bad.exitCode, EXIT.usage)
})

test('api lists the allowlisted methods with descriptions', async () => {
  const dir = tmpDir()
  const r = await go(['api'], dir, {})
  assert.equal(r.exitCode, 0)
  const out = JSON.parse(r.stdout)
  assert.ok(out.methods.some((m: any) => m.method === 'facade.AuditFacadeServices.get#Audits'))
  assert.ok(!out.methods.some((m: any) => m.method.startsWith('admin.')))
})

test('logout revokes and drops the token', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['logout'], dir, { [LOGOUT]: () => ({ ok: true }) })
  assert.equal(r.exitCode, 0)
  assert.equal(loadConfig(dir).instances.prod!.token, undefined)
})

test('errors are JSON on stderr', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['call', 'facade.AuditFacadeServices.get#Audits'], dir, { 'facade.AuditFacadeServices.get#Audits': () => ({ ok: false, errors: ['boom'] }) })
  assert.equal(r.exitCode, EXIT.failed)
  const err = JSON.parse(r.stderr)
  assert.match(err.error, /boom/)
  assert.ok('next' in err)
  const unknown = await go(['frobnicate'], dir, {})
  assert.equal(unknown.exitCode, EXIT.usage)
  assert.ok(JSON.parse(unknown.stderr).error)
  const down = await go(['whoami'], dir, {}, { fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(down.exitCode, EXIT.unreachable)
})

test('a tenant-required command without a tenant is a usage error', async () => {
  const dir = tmpDir()
  signedIn(dir, { tenant: undefined })
  const r = await go(['call', 'facade.AuditFacadeServices.get#Audits'], dir, {})
  assert.equal(r.exitCode, EXIT.usage)
  assert.match(JSON.parse(r.stderr).next, /darpan tenant use/)
})

test('configDir honours DARPAN_CONFIG_DIR', () => {
  assert.equal(configDir({ DARPAN_CONFIG_DIR: '/x/y' }), '/x/y')
  assert.match(configDir({ HOME: '/home/u' }), /\/home\/u\/\.config\/darpan$/)
  assert.equal(readFileSync(new URL('../allowed-methods.json', import.meta.url), 'utf8').startsWith('['), true)
})

const AUDITS = 'facade.AuditFacadeServices.get#Audits'
const FILLER = '<p>x</p>'.repeat(200)

test('refusals are read from the whole body, HTML included; a bare 403 is forbidden', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const fence = await go(['call', AUDITS], dir, { [AUDITS]: () => http(403, `<html><body>${FILLER}<p>${AUDITS} is not available to the Darpan CLI; use the app.</p></body></html>`) })
  assert.equal(fence.exitCode, EXIT.forbidden)
  const gone = await go(['call', AUDITS], dir, { [AUDITS]: () => http(403, `<html>${FILLER}<b>This CLI session was signed out. Run darpan login to sign in again.</b></html>`) })
  assert.equal(gone.exitCode, EXIT.unauthenticated)
  assert.equal(loadConfig(dir).instances.prod!.token, undefined)
  signedIn(dir)
  const bare = await go(['call', AUDITS], dir, { [AUDITS]: () => http(403, '<html>Forbidden</html>') })
  assert.equal(bare.exitCode, EXIT.forbidden)
  assert.equal(loadConfig(dir).instances.prod!.token, 'KEY123')
  const server = await go(['call', AUDITS], dir, { [AUDITS]: () => http(500, '<html>oops</html>') })
  assert.equal(server.exitCode, EXIT.failed)
})

async function loginOpening(start: object, extra: string[] = []) {
  const dir = tmpDir()
  return go(['login', '--instance', 'https://api.drpn.ai', ...extra], dir, {
    [START]: () => ({ ok: true, deviceCode: 'D', userCode: 'BCDF-2345', expiresInSeconds: 600, intervalSeconds: 3, ...start }),
    [POLL]: () => ({ ok: true, status: 'APPROVED', authToken: 'K', authTokenExpiresInSeconds: 60 }),
  })
}

test('sign-in links: only same-site http(s) pages are opened', async () => {
  const file = await loginOpening({ verificationUrl: 'file:///etc/passwd', verificationPath: '/cli-login' })
  assert.deepEqual(file.opened, [])
  assert.match(file.stderr, /BCDF-2345/)
  const foreign = await loginOpening({ verificationUrl: 'https://evil.example/cli-login', verificationPath: '/cli-login' })
  assert.deepEqual(foreign.opened, [])
  const slashes = await loginOpening({ verificationUrl: 'https://api.drpn.ai/cli-login', verificationPath: '//evil.example/x' })
  assert.deepEqual(slashes.opened, [])
  const scheme = await loginOpening({ verificationUrl: 'https://api.drpn.ai/cli-login', verificationPath: 'javascript:alert(1)' })
  assert.deepEqual(scheme.opened, [])
  const sibling = await loginOpening({ verificationUrl: 'https://app.drpn.ai/cli-login', verificationPath: '/cli-login' })
  assert.deepEqual(sibling.opened, ['https://app.drpn.ai/cli-login'])
  const same = await loginOpening({ verificationUrl: 'https://api.drpn.ai/cli-login', verificationPath: '/cli-login' })
  assert.equal(same.opened.length, 1)
  const appUrl = await loginOpening({ verificationUrl: 'https://x.test/cli-login', verificationPath: '/cli-login' }, ['--app-url', 'http://localhost:5173'])
  assert.deepEqual(appUrl.opened, ['http://localhost:5173/cli-login'])
  const badApp = await loginOpening({ verificationPath: '/cli-login' }, ['--app-url', 'file:///tmp'])
  assert.deepEqual(badApp.opened, [])
  const hostile = await loginOpening({ verificationUrl: 'https://api.drpn.ai.evil.example/cli-login', verificationPath: '/cli-login' })
  assert.deepEqual(hostile.opened, [])
})

test('a redirect is a failure and the target never sees login_key', async () => {
  const dir = tmpDir()
  signedIn(dir)
  for (const argv of [['call', AUDITS], ['whoami']]) {
    const r = await go(argv, dir, { [AUDITS]: () => redirect('https://evil.example/steal'), [SESSION]: () => redirect('https://evil.example/steal') })
    assert.equal(r.exitCode, EXIT.unreachable)
    assert.match(JSON.parse(r.stderr).error, new RegExp(URL_.replace('.', '\\.')))
    assert.ok(r.requests.every((q) => q.method !== 'redirect-target'))
  }
})

async function loginOn(instance: string, start: object, extra: string[] = [], dir = tmpDir()) {
  return go(['login', '--instance', instance, ...extra], dir, {
    [START]: () => ({ ok: true, deviceCode: 'D', userCode: 'BCDF-2345', expiresInSeconds: 600, intervalSeconds: 3, verificationPath: '/cli-login', ...start }),
    [POLL]: () => ({ ok: true, status: 'APPROVED', authToken: 'K', authTokenExpiresInSeconds: 60 }),
  })
}

test('no generic sibling rule: public-suffix and IP lookalikes are not opened', async () => {
  assert.deepEqual((await loginOn('https://x.co.uk', { verificationUrl: 'https://evil.co.uk/cli-login' })).opened, [])
  assert.deepEqual((await loginOn('https://a.github.io', { verificationUrl: 'https://b.github.io/cli-login' })).opened, [])
  assert.deepEqual((await loginOn('http://127.0.0.1:8080', { verificationUrl: 'http://10.0.0.1/cli-login' })).opened, [])
  assert.deepEqual((await loginOn('https://api.drpn.ai', { verificationUrl: 'https://app.other.ai/cli-login' })).opened, [])
})

test('known Darpan instances open their own app host', async () => {
  const pairs: [string, string][] = [
    ['https://api.drpn.ai', 'https://app.drpn.ai'],
    ['https://api-next.drpn.ai', 'https://app.drpn.ai'],
    ['https://api-uat.drpn.ai', 'https://app-uat.drpn.ai'],
    ['https://sm-darpan-maarg.hotwax.io', 'https://sm-darpan.hotwax.io'],
  ]
  for (const [instance, app] of pairs) {
    const r = await loginOn(instance, { verificationUrl: `${app}/cli-login` })
    assert.deepEqual(r.opened, [`${app}/cli-login`], instance)
  }
  assert.deepEqual((await loginOn('http://localhost:8080', { verificationUrl: 'http://localhost:8080/cli-login' })).opened.length, 1)
})

test('--app-url is saved on the instance and reused on the next login', async () => {
  const dir = tmpDir()
  await loginOn('http://localhost:8080', { verificationUrl: 'http://localhost:8080/cli-login' }, ['--app-url', 'http://localhost:5173'], dir)
  assert.equal(loadConfig(dir).instances.prod!.appUrl, 'http://localhost:5173')
  const again = await loginOn('http://localhost:8080', { verificationUrl: 'http://localhost:8080/cli-login' }, [], dir)
  assert.deepEqual(again.opened, ['http://localhost:5173/cli-login'])
})

test('control characters in server text are stripped from what is printed', async () => {
  const r = await loginOn('https://x.co.uk', { verificationUrl: 'https://evil.co.uk/\u001b[2Jcli\u009b-login' })
  assert.deepEqual(r.opened, [])
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(r.stderr), 'no control characters')
  assert.match(r.stderr, /evil\.co\.uk/)
  const dir = tmpDir()
  signedIn(dir)
  const e = await go(['call', AUDITS], dir, { [AUDITS]: () => ({ ok: false, errors: ['bad \u001b]0;pwned\u0007 thing'] }) })
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(e.stderr))
})

// ---- final review fixes ------------------------------------------------------------------------------------------

test('final review Important 1: run starters wait past the 300 s load balancer; everything else keeps 120 s', async () => {
  const { requestTimeoutMs } = await import('../rpc.ts')
  for (const m of ['facade.ReconciliationFacadeServices.run#SavedRunDiff', 'facade.ReconciliationFacadeServices.run#Reconciliation', 'facade.ReconciliationFacadeServices.run#AutomationNow',
    'facade.AuditFacadeServices.run#Audit', 'facade.AuditFacadeServices.retry#AuditCheck', 'facade.TenantScriptFacadeServices.run#TenantScript',
    'facade.TenantScriptFacadeServices.run#TenantScriptDeployment']) {
    assert.ok(requestTimeoutMs(m) >= 300_000, m)
  }
  for (const m of ['facade.NetSuiteQueryFacadeServices.run#NsSuiteQlAgentQuery', 'facade.HotWaxOmsFacadeServices.run#OmsGraphqlAgentQuery',
    'facade.ShopifyFacadeServices.run#ShopifyGraphqlAgentQuery', SESSION]) {
    assert.equal(requestTimeoutMs(m), 120_000, m)
  }
})

test('final review Important 1: a timed-out request is exit 5 "may still be running", never unreachable', async () => {
  const RUN_DIFF = 'facade.ReconciliationFacadeServices.run#SavedRunDiff'
  for (const handler of [() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') }, () => http(504, '<html>504 Gateway Time-out</html>')]) {
    const dir = tmpDir()
    signedIn(dir)
    const r = await go(['run', 'start', 'R1'], dir, { [RUN_DIFF]: handler })
    assert.equal(r.exitCode, EXIT.failed, r.stderr)
    const err = JSON.parse(r.stderr.split('\n').pop()!)
    assert.match(err.error, /timed out/)
    assert.match(err.error, /may still be running/)
    assert.doesNotMatch(err.error, /unreachable/)
    assert.match(err.next, /darpan run status/)
    assert.equal(err.code, 'TIMEOUT')
    assert.equal(r.requests.filter((q) => q.method === RUN_DIFF).length, 1, 'never retried')
  }
})

test('final review Important 3a: the role comes from the tenant permission groups; Darpan staff is reported apart', async () => {
  const cases: [string[], string][] = [[['DARPAN_TENANT_ADMIN'], 'admin'], [['DARPAN_COMPANY_EDITOR'], 'editor'], [['DARPAN_TENANT_USER'], 'user'],
    [['DARPAN_COMPANY_VIEW_ONLY'], 'view'], [['DARPAN_COMPANY_VIEW_ONLY', 'DARPAN_COMPANY_EDITOR'], 'editor'], [[], 'none']]
  for (const [groups, expected] of cases) {
    const dir = tmpDir()
    signedIn(dir)
    const r = await go(['whoami'], dir, { [SESSION]: () => ({ ok: true, sessionInfo: { username: 'a', activeTenantUserGroupId: 'ACME', activeTenantPermissionGroupIds: groups,
      canManageDarpanCore: true, canEditActiveTenantData: true, canRunActiveTenantReconciliation: true, canViewActiveTenantData: true,
      availableTenants: [{ userGroupId: 'ACME', label: 'Acme' }] } }) })
    assert.equal(r.exitCode, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.role, expected, groups.join(','))
    assert.equal(out.darpanStaff, true)
  }
})

test('final review Important 3b: whoami --tenant B labels B and asks the server about B', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['whoami', '--tenant', 'GLBX'], dir, { [SESSION]: (_p: any, req: any) => ({ ok: true, sessionInfo: { username: 'a',
    activeTenantUserGroupId: req.headers['X-Darpan-Tenant'], activeTenantLabel: 'Globex', activeTenantPermissionGroupIds: ['DARPAN_COMPANY_VIEW_ONLY'],
    availableTenants: [{ userGroupId: 'ACME', label: 'Acme' }, { userGroupId: 'GLBX', label: 'Globex' }] } }) })
  assert.equal(r.exitCode, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.deepEqual(out.tenant, { id: 'GLBX', label: 'Globex' })
  assert.equal(out.role, 'view')
  assert.equal(out.darpanStaff, undefined)
  assert.equal(r.requests[0]!.headers['X-Darpan-Tenant'], 'GLBX')
  assert.equal(loadConfig(dir).instances.prod!.tenant, 'ACME', 'never saved')
})

test('final review minor: logout says revokedOnServer only when the server revoked it or the key was already dead', async () => {
  const cases: [any, boolean][] = [
    [() => ({ ok: true }), true],
    [() => http(403, 'This CLI session was signed out. Run darpan login to sign in again.'), true],
    [() => ({ ok: false, code: 'THROTTLED', retryAfterSeconds: 5, errors: ['slow'] }), false],
    [() => ({ ok: false, errors: ['boom'] }), false],
    [() => http(403, 'facade.CliAuthFacadeServices.logout#CliSession is not available to the Darpan CLI; use the app.'), false],
    [() => { throw new TypeError('fetch failed') }, false],
  ]
  for (const [handler, expected] of cases) {
    const dir = tmpDir()
    signedIn(dir)
    const r = await go(['logout'], dir, { [LOGOUT]: handler })
    assert.equal(r.exitCode, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).revokedOnServer, expected, String(handler))
    assert.equal(loadConfig(dir).instances.prod!.token, undefined)
  }
})

test('final review minor: a disabled account exits 3 and drops the key', async () => {
  const dir = tmpDir()
  signedIn(dir)
  const r = await go(['call', 'facade.AuditFacadeServices.get#Audits'], dir, { 'facade.AuditFacadeServices.get#Audits': () => http(403, 'This account can no longer sign in.') })
  assert.equal(r.exitCode, EXIT.unauthenticated, r.stderr)
  assert.equal(loadConfig(dir).instances.prod!.token, undefined)
})

test('final review Important 2: call never sends a CLI sign-in method, and the allowlist carries none', async () => {
  const { loadAllowedMethods } = await import('../commands.ts')
  assert.deepEqual(loadAllowedMethods().filter((m) => /CliLogin/.test(m.method)), [])
  for (const method of ['facade.CliAuthFacadeServices.start#CliLogin', 'facade.CliAuthFacadeServices.poll#CliLogin', 'facade.CliAuthFacadeServices.approve#CliLogin']) {
    const dir = tmpDir()
    signedIn(dir)
    const r = await go(['call', method, '--params', '{"deviceCode":"x"}'], dir, { [method]: () => ({ ok: true, authToken: 'MINTED' }) })
    assert.equal(r.exitCode, EXIT.forbidden, method)
    assert.equal(r.requests.length, 0, method)
    assert.ok(!r.stdout.includes('MINTED'))
  }
})
