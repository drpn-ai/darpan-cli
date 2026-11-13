// A Node session against one Darpan: JSON-RPC at /rpc/json and read-only GraphQL at /rest/s1/graphql,
// both carrying the CLI's login_key and the per-call X-Darpan-Tenant. No cookies are kept between calls.
import type { Instance } from './config.ts'

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal; redirect?: 'error' | 'follow' | 'manual' },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>

/** Exit codes: 0 ok, 1 unreachable, 2 usage, 3 unauthenticated, 4 throttled, 5 failed, 7 forbidden. */
export const EXIT = { ok: 0, unreachable: 1, usage: 2, unauthenticated: 3, throttled: 4, failed: 5, forbidden: 7 } as const

/** Remove C0/C1 control characters (ESC included) from text that came from a server, before it reaches a terminal. */
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
}

export class CliError extends Error {
  exitCode: number
  next?: string
  /** The stored sign-in key is dead (signed out or expired): the caller removes it from the config. */
  dropToken: boolean
  /** Structured fields for the error JSON (for example retryAfterSeconds on a throttled answer). */
  details?: Record<string, unknown>
  constructor(message: string, exitCode: number, next?: string, dropToken = false, details?: Record<string, unknown>) {
    super(stripControl(message))
    this.exitCode = exitCode
    this.next = next === undefined ? undefined : stripControl(next)
    this.dropToken = dropToken
    this.details = details
  }
}

export const LOGIN_HINT = 'run `darpan login`'
const REQUEST_TIMEOUT_MS = 120_000
/** Final review Important 1: a run starter holds the request while it works (run#SavedRunDiff is synchronous), and the
 *  AWS load balancer's idle timeout is 300 s, so these wait past it; everything else (the fresh queries too) keeps 120 s. */
export const RUN_REQUEST_TIMEOUT_MS = 330_000
const RUN_STARTERS = new Set(['run#SavedRunDiff', 'run#Reconciliation', 'run#AutomationNow', 'run#Audit', 'retry#AuditCheck', 'run#TenantScript',
  // a send that timed out on our side may already have posted; waiting longer keeps an agent from posting twice
  'run#TenantScriptDeployment'])

/** How long the CLI waits for one method's answer. */
export function requestTimeoutMs(method: string): number {
  return RUN_STARTERS.has(method.slice(method.lastIndexOf('.') + 1)) ? RUN_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS
}

/** A request that timed out may still be running on the server: never "unreachable", and never a cue to retry blind. */
function timedOut(label: string, seconds: number | null): CliError {
  return new CliError(
    `${label}: the request timed out${seconds ? ` after ${seconds} seconds` : ''}; it may still be running on the server.`,
    EXIT.failed,
    'check `darpan run status <runId>` or `darpan result <savedRunId>` before starting it again',
    false,
    { code: 'TIMEOUT' },
  )
}
const AUTH_MESSAGES = ['user must be logged in', 'authentication required', 'login key not valid', 'login key expired', 'no active authenticated session']

export interface Session {
  call<T = Record<string, unknown>>(method: string, params?: object, opts?: { tenant?: string; anonymous?: boolean }): Promise<T>
  /** Returns `data`; with `raw: true` the whole response document ({data, errors, ...}) untouched. */
  gql<T = unknown>(document: string, variables?: object, opts?: { tenant?: string; raw?: boolean }): Promise<T>
}

/** Page text from an HTML or plain body: tags stripped, whitespace collapsed. */
function plainText(body: string): string {
  return body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** A refusal that did not come back as JSON: match on the whole body, show a short piece, and read a bare 403 as forbidden. */
function failureFromBody(label: string, body: string, status: number, authed: boolean): CliError {
  const text = plainText(body)
  const shown = text.length > 300 ? `${text.slice(0, 300)}...` : text
  const error = failure(label, text || `HTTP ${status}, not JSON`, status, authed)
  const known = error.exitCode !== EXIT.failed
  const out = new CliError(`${label}: ${shown || `HTTP ${status}, not JSON`}`, known || status !== 403 ? error.exitCode : EXIT.forbidden, error.next ?? (status === 403 && !known ? 'This is done in the Darpan app.' : undefined), error.dropToken)
  return out
}

function failure(label: string, message: string, status: number, authed: boolean): CliError {
  const lower = message.toLowerCase()
  if (lower.includes('is not available to the darpan cli')) {
    return new CliError(`${label}: ${message}`, EXIT.forbidden, 'This is done in the Darpan app.')
  }
  if (/is not one of your tenants/i.test(message)) {
    return new CliError(`${label}: ${message}`, EXIT.forbidden, 'run `darpan tenants`, then `darpan tenant use <id>`')
  }
  const sessionGone =
    lower.includes('this cli session was signed out') || lower.includes('this cli session has expired') || lower.includes('this account can no longer sign in')
  if (sessionGone || status === 401 || AUTH_MESSAGES.some((needle) => lower.includes(needle))) {
    return new CliError(`${label}: ${message}`, EXIT.unauthenticated, LOGIN_HINT, authed)
  }
  return new CliError(`${label}: ${message}`, EXIT.failed)
}

export function createSession(instance: Instance, fetchImpl: FetchLike = fetch as unknown as FetchLike): Session {
  const base = instance.url.replace(/\/+$/, '')
  let nextId = 1

  function headers(tenant: string | undefined, anonymous: boolean): Record<string, string> {
    const out: Record<string, string> = { 'Content-Type': 'application/json' }
    if (anonymous) return out
    if (instance.token) out.login_key = instance.token
    const chosen = tenant ?? instance.tenant
    if (chosen) out['X-Darpan-Tenant'] = chosen
    return out
  }

  async function post(url: string, body: unknown, hdrs: Record<string, string>, label: string, timeoutMs: number): Promise<{ status: number; ok: boolean; text: string; json: any }> {
    let response: Awaited<ReturnType<FetchLike>>
    try {
      // redirect 'error': a redirect must never carry login_key to another origin.
      response = await fetchImpl(url, { method: 'POST', headers: hdrs, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
    } catch (error) {
      const name = (error as Error).name
      if (name === 'TimeoutError' || name === 'AbortError') throw timedOut(label, Math.round(timeoutMs / 1000))
      const reason = `${(error as Error).message} ${((error as Error).cause as Error | undefined)?.message ?? ''}`
      if (/redirect/i.test(reason)) {
        throw new CliError(`${url} answered with a redirect, which the CLI will not follow (it would send your sign-in key elsewhere).`, EXIT.unreachable, 'set the instance URL that serves Darpan directly: `darpan login --instance <url>`')
      }
      throw new CliError(`${url} is unreachable: ${(error as Error).message}`, EXIT.unreachable, 'check the instance URL and your network')
    }
    // A gateway that gave up waiting (the load balancer's idle timeout) is a timeout too, not a refusal.
    if (response.status === 504 || response.status === 408) throw timedOut(label, null)
    const text = await response.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { status: response.status, ok: response.ok, text, json }
  }

  async function call<T>(method: string, params: object = {}, opts: { tenant?: string; anonymous?: boolean } = {}): Promise<T> {
    const anonymous = opts.anonymous === true
    const res = await post(`${base}/rpc/json`, { jsonrpc: '2.0', id: nextId++, method, params }, headers(opts.tenant, anonymous), method, requestTimeoutMs(method))
    if (res.json === null || typeof res.json !== 'object') {
      // A fence refusal can arrive as plain text or an HTML page on a 403.
      throw failureFromBody(method, res.text, res.status, !anonymous)
    }
    const result = res.json.result as Record<string, any> | undefined
    if (result && result.code === 'THROTTLED') {
      const wait = Number(result.retryAfterSeconds) || 10
      throw new CliError(`${method}: ${String(result.error ?? 'Too many requests in flight.')}`, EXIT.throttled, `retry in ${wait} seconds`, false, { code: 'THROTTLED', retryAfterSeconds: wait })
    }
    const message: string | null =
      res.json.error?.message ??
      (result && Array.isArray(result.errors) && result.errors.length > 0 ? String(result.errors[0]) : null) ??
      (result?.ok === false ? String(result.error ?? result.message ?? 'Darpan could not complete the request.') : null) ??
      (!res.ok ? `HTTP ${res.status}` : null)
    if (message !== null) throw failure(method, message, res.status, !anonymous)
    return (result ?? {}) as T
  }

  async function gql<T>(document: string, variables: object = {}, opts: { tenant?: string; raw?: boolean } = {}): Promise<T> {
    const res = await post(`${base}/rest/s1/graphql`, { query: document, variables }, headers(opts.tenant, false), 'graphql', REQUEST_TIMEOUT_MS)
    if (res.json === null || typeof res.json !== 'object') {
      throw failureFromBody('graphql', res.text, res.status, true)
    }
    const errors = res.json.errors
    const message: string | null =
      Array.isArray(errors) && errors.length > 0
        ? typeof errors[0] === 'string'
          ? errors[0]
          : String(errors[0]?.message ?? 'GraphQL error')
        : typeof errors === 'string' && errors
          ? errors
          : !res.ok
            ? `HTTP ${res.status}`
            : null
    if (message !== null) throw failure('graphql', message, res.status, true)
    return (opts.raw ? res.json : res.json.data) as T
  }

  return { call, gql }
}
