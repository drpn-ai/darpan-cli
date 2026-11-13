// A fake Darpan for node:test: JSON-RPC handlers by method name, an optional GraphQL handler, and a log
// of every request so a test can assert on headers and on what was NOT called.
import type { FetchLike } from '../rpc.ts'

export interface Recorded {
  url: string
  path: string
  method: string
  headers: Record<string, string>
  params: any
  body: any
}

export interface HttpReply {
  __http: true
  status: number
  body: string
}

/** Reply with a raw HTTP status and body (a 403 fence refusal, a 401). */
export function http(status: number, body: unknown): HttpReply {
  return { __http: true, status, body: typeof body === 'string' ? body : JSON.stringify(body) }
}

/** Handlers may return { rpcError: 'message' } for a top-level JSON-RPC error. */
type Handler = (params: any, request: Recorded) => unknown

/** Reply with a 302 to another URL; a client that follows it re-sends its headers there (as Node does). */
export function redirect(to: string): HttpReply & { __redirect: string } {
  return { __http: true, status: 302, body: '', __redirect: to }
}

/** The variables a GraphQL document declares, and the ones its selection uses. */
export function graphqlVariables(document: string): { declared: string[]; used: string[] } {
  const header = /^\s*(?:query|mutation|subscription)\b[^({]*\(([^)]*)\)/.exec(document)
  const declared = header ? [...header[1]!.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]!) : []
  const body = header ? document.slice(header.index + header[0].length) : document
  const used = [...new Set([...body.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))]
  return { declared, used }
}

/** moqui-gql runs graphql-java with default validation: a declared-but-unused or used-but-undeclared variable fails
 *  the whole document with data null. The fake does the same, so a document that real servers refuse cannot pass. */
function graphqlValidationErrors(document: string): string[] {
  const { declared, used } = graphqlVariables(document)
  return [
    ...declared.filter((v) => !used.includes(v)).map((v) => `Validation error (UnusedVariable) : Unused variable '${v}'`),
    ...used.filter((v) => !declared.includes(v)).map((v) => `Validation error (UndefinedVariable) : Undefined variable '${v}'`),
  ]
}

export function fakeBackend(handlers: Record<string, Handler>): { fetchImpl: FetchLike; requests: Recorded[] } {
  const requests: Recorded[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body)
    const path = new URL(url).pathname
    const method = path === '/rpc/json' ? String(body.method) : 'graphql'
    const record: Recorded = { url, path, method, headers: init.headers, params: body.params ?? body.variables, body }
    requests.push(record)
    if (path === '/rest/s1/graphql') {
      const invalid = graphqlValidationErrors(String(body.query ?? ''))
      if (invalid.length) return { status: 200, ok: true, text: async () => JSON.stringify({ data: null, errors: invalid.map((message) => ({ message })) }) }
    }
    const handler = handlers[method]
    const reply = handler ? handler(record.params, record) : { ok: false, errors: [`fake: no handler for ${method}`] }
    const to = (reply as { __redirect?: string } | null)?.__redirect
    if (to) {
      if (init.redirect === 'error') throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
      requests.push({ url: to, path: new URL(to).pathname, method: 'redirect-target', headers: init.headers, params: null, body: null })
      return { status: 200, ok: true, text: async () => '{}' }
    }
    if (reply && typeof reply === 'object' && (reply as HttpReply).__http) {
      const raw = reply as HttpReply
      return { status: raw.status, ok: raw.status < 400, text: async () => raw.body }
    }
    const rpcError = (reply as { rpcError?: string } | null)?.rpcError
    const envelope =
      path !== '/rpc/json' ? reply : rpcError ? { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: rpcError } } : { jsonrpc: '2.0', id: body.id, result: reply }
    return { status: 200, ok: true, text: async () => JSON.stringify(envelope) }
  }
  return { fetchImpl, requests }
}
