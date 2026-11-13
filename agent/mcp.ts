// `darpan mcp`: the command table as MCP tools over stdio. Newline-delimited JSON-RPC 2.0, no SDK.
// stdout carries protocol JSON only; diagnostics go to stderr; the sign-in key is never written anywhere.
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { COMMANDS, type Command, type Ctx } from './commands.ts'
import { dropToken, saveConfig } from './config.ts'
import { CliError, EXIT, stripControl } from './rpc.ts'
import { GUIDE } from './guide.ts'

export const SERVER_VERSION = '1.0.0'
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
/** Terminal-only: sign-in, sign-out and the saved tenant choice change local config, so they stay out of MCP. */
const EXCLUDED = new Set(['login', 'logout', 'tenant use'])

export const toolName = (command: Command) => `darpan_${command.name.replace(/ /g, '_')}`
const mcpCommands = () => COMMANDS.filter((c) => !EXCLUDED.has(c.name))

/** The command's input schema without its path-typed (cliOnly) properties: MCP callers use the inline forms. */
export function inputSchemaFor(command: Command) {
  const hidden = new Set(command.cliOnly ?? [])
  const properties: Record<string, { type: string; description?: string; default?: unknown }> = Object.fromEntries(Object.entries(command.input.properties).filter(([key]) => !hidden.has(key)))
  const required = (command.input.required ?? []).filter((key) => !hidden.has(key))
  if (command.tenant !== 'none') properties.tenant = { type: 'string', description: 'Tenant id for this call only (ids from darpan_tenants); never saved. Defaults to the tenant chosen in the terminal.' }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

function listTools() {
  return mcpCommands().map((command) => ({ name: toolName(command), description: command.description, inputSchema: inputSchemaFor(command) }))
}

export type CtxFactory = (command: Command, tenant?: string) => Ctx

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: any }

function errorResult(message: string, next: string | null | undefined, details?: Record<string, unknown>) {
  const body = { error: stripControl(message), next: next == null ? null : stripControl(next), ...details }
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body, isError: true }
}

function checkArgs(command: Command, args: unknown): string | null {
  if (args === undefined) return null
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'arguments must be an object'
  const hidden = new Set(command.cliOnly ?? [])
  const schema = command.input.properties
  for (const [key, value] of Object.entries(args)) {
    if (key === 'tenant' && command.tenant !== 'none') {
      if (typeof value !== 'string' || !value) return 'argument "tenant" must be a non-empty string'
      continue
    }
    if (hidden.has(key)) return `"${key}" names a local file and is not available over MCP; pass the text inline instead`
    const spec = Object.hasOwn(schema, key) ? schema[key] : undefined
    if (!spec) return `unknown argument "${key}"`
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    if (spec.type === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) return `argument "${key}" must be an integer`
      continue
    }
    if (actual !== spec.type) return `argument "${key}" must be ${spec.type === 'object' || spec.type === 'array' ? `an ${spec.type}` : `a ${spec.type}`}`
  }
  for (const key of command.input.required ?? []) {
    if (!hidden.has(key) && (args as Record<string, unknown>)[key] === undefined) return `missing required argument "${key}"`
  }
  return null
}

async function callTool(name: unknown, rawArgs: unknown, ctxFactory: CtxFactory) {
  const command = mcpCommands().find((c) => toolName(c) === name)
  if (!command) return undefined
  const problem = checkArgs(command, rawArgs)
  if (problem) return errorResult(problem, `see the input schema of ${toolName(command)}`)
  let ctx: Ctx | undefined
  try {
    const { tenant, ...commandArgs } = (rawArgs ?? {}) as Record<string, unknown>
    ctx = ctxFactory(command, typeof tenant === 'string' ? tenant : undefined) // fresh each call: a `darpan login` elsewhere takes effect at once
    // Standard input is the protocol channel, so a `-` value can never read from it.
    ctx = { ...ctx, stdin: () => { throw new CliError('`-` (standard input) is not available over MCP.', EXIT.usage, 'pass the text inline') } }
    const result = await command.run(ctx, commandArgs)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) ?? 'null' }], isError: false }
  } catch (error) {
    if (error instanceof CliError) {
      if (error.dropToken && ctx) {
        const current = ctx.config.current
        if (current) {
          dropToken(ctx.config, current)
          saveConfig(ctx.dir, ctx.config)
        }
      }
      const next =
        error.exitCode === EXIT.unauthenticated
          ? 'run `darpan login` in a terminal'
          : error.message === 'No tenant chosen.'
            ? 'call darpan_tenants, then pass its id as the tenant argument (or run `darpan tenant use <id>` in a terminal)'
            : error.next
      return errorResult(error.message, next, error.details)
    }
    process.stderr.write(`darpan mcp: ${(error as Error).message}\n`)
    return errorResult((error as Error).message, null)
  }
}

export async function runMcp(stdin: Readable, stdout: Writable, ctxFactory: CtxFactory): Promise<void> {
  const send = (message: object) => stdout.write(`${JSON.stringify(message)}\n`)
  const reply = (id: Rpc['id'], result: unknown) => send({ jsonrpc: '2.0', id, result })
  const fail = (id: Rpc['id'], code: number, message: string) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  const pending = new Set<Promise<void>>()

  async function handle(message: Rpc): Promise<void> {
    const isRequest = message.id !== undefined && message.id !== null
    const method = message.method
    if (typeof method !== 'string') {
      if (isRequest) fail(message.id, -32600, 'Invalid Request')
      return
    }
    if (!isRequest) return // notifications (initialized, cancelled, ...) never get a reply
    switch (method) {
      case 'initialize': {
        const asked = message.params?.protocolVersion
        const protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0]
        return reply(message.id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'darpan', version: SERVER_VERSION }, instructions: GUIDE })
      }
      case 'ping':
        return reply(message.id, {})
      case 'tools/list':
        return reply(message.id, { tools: listTools() })
      case 'tools/call': {
        const result = await callTool(message.params?.name, message.params?.arguments, ctxFactory)
        if (!result) return fail(message.id, -32602, `Unknown tool: ${String(message.params?.name).slice(0, 80)}`)
        return reply(message.id, result)
      }
      default:
        return fail(message.id, -32601, `Method not found: ${method.slice(0, 80)}`)
    }
  }

  const lines = createInterface({ input: stdin, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (!line.trim()) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return fail(null, -32700, 'Parse error')
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return fail(null, -32600, 'Invalid Request')
    const task: Promise<void> = handle(message as Rpc)
      .catch((error: Error) => {
        process.stderr.write(`darpan mcp: ${error.message}\n`)
        fail((message as Rpc).id, -32603, 'Internal error')
      })
      .finally(() => pending.delete(task))
    pending.add(task)
  })
  await new Promise<void>((resolve) => lines.once('close', resolve))
  await Promise.all(pending)
}
