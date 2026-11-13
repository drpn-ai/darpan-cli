// Regenerates agent/allowed-methods.json from the backend's CliMethodAllowlist.ALLOWED (ruling R4), with each
// method's description taken from the contract's openapi.json where one exists.
//   node agent/scripts/sync-allowlist.ts <path-to-CliMethodAllowlist.groovy> [<path-to-openapi.json>]
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AllowedMethod {
  method: string
  description: string
}

/** The quoted method strings inside `ALLOWED = ( [ ... ]`, in source order, comments ignored. */
export function extractAllowed(source: string): string[] {
  const at = source.search(/\bALLOWED\s*=/)
  if (at < 0) throw new Error('No "ALLOWED =" found in the allowlist source.')
  const open = source.indexOf('[', at)
  const close = source.indexOf(']', open)
  if (open < 0 || close < 0) throw new Error('ALLOWED has no [ ... ] list.')
  const body = source
    .slice(open + 1, close)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  const methods = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
  if (methods.length === 0) throw new Error('ALLOWED is empty.')
  return [...new Set(methods)]
}

export function buildAllowedMethods(source: string, openapi?: any): AllowedMethod[] {
  return extractAllowed(source).map((method) => {
    const base = openapi?.['x-darpan-methods']?.[method]
    const schemas = openapi?.components?.schemas ?? {}
    const description = base ? (schemas[`${base}Params`]?.description ?? '') : ''
    return { method, description: String(description).replace(/\s+/g, ' ').trim() }
  })
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const [groovyPath, openapiPath] = process.argv.slice(2)
  if (!groovyPath) {
    process.stderr.write('usage: sync-allowlist.ts <CliMethodAllowlist.groovy> [<openapi.json>]\n')
    process.exit(2)
  }
  const openapi = openapiPath ? JSON.parse(readFileSync(openapiPath, 'utf8')) : undefined
  const methods = buildAllowedMethods(readFileSync(groovyPath, 'utf8'), openapi)
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'allowed-methods.json')
  writeFileSync(out, `${JSON.stringify(methods, null, 2)}\n`)
  process.stdout.write(`wrote ${methods.length} methods to ${out}\n`)
}
