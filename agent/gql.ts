// Audit findings over GraphQL, ported from bin/darpan (DAR-CLI-001/002): findings list, month export and the --all
// cursor walk. report and findings show read the JSON documents over JSON-RPC instead (DAR-CLI-004, commands.ts). Every value written into a document is held to its shape first; search terms travel as
// the $q variable so a `>=` never sits in the document (Moqui's HTML sanitizer refuses `<` and `>` there).
import { CliError, EXIT, type Session } from './rpc.ts'

/** A period: a year, a quarter, a month or a day (findings list and report alike). */
export const PERIOD_RE = /^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?|-Q[1-4])?$/

export const LIST_FIELDS = `edges { cursor node { id audit statement category period headline state firstFound lastSeen ageDays next
      records { system recordType id internalId status } difference { amount currency } } }
    pageInfo { hasNextPage endCursor }`

export const LIST_MAX_PAGES = 1000

const usage = (message: string, next = 'run `darpan --help`') => new CliError(message, EXIT.usage, next)

function mustMatch(value: string, re: RegExp, message: string): void {
  if (!re.test(value)) throw usage(message)
}

const str = (value: unknown): string => (value === undefined || value === null || value === true || value === false ? '' : String(value))

export interface FindingsListArgs {
  audit?: unknown
  statement?: unknown
  category?: unknown
  state?: unknown
  period?: unknown
  since?: unknown
  sort?: unknown
  reverse?: unknown
  first?: unknown
  after?: unknown
  all?: unknown
}

export interface FindingsQuery {
  terms: string
  sortKey: string
  reverse: boolean
  all: boolean
  after: string
  /** The `findings(...)` arguments without `after`. */
  baseArgs: string
  variables: Record<string, string>
}

export function buildFindingsQuery(args: FindingsListArgs): FindingsQuery {
  const audit = str(args.audit)
  const statement = str(args.statement)
  const category = str(args.category)
  const state = str(args.state)
  const period = str(args.period)
  const since = str(args.since)
  const sortFlag = str(args.sort) || 'first-found'
  const first = args.first === undefined ? '50' : str(args.first)
  const after = str(args.after)
  const reverse = args.reverse === true || args.reverse === 'true'
  const all = args.all === true || args.all === 'true'

  if (audit) mustMatch(audit, /^[a-z0-9-]+$/, '--audit is an audit code such as month-close')
  if (statement) mustMatch(statement, /^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$/, '--statement is a statement id or a list, e.g. R2,R8')
  if (category) mustMatch(category, /^[A-Za-z]+(,[A-Za-z]+)*$/, '--category is a category id such as returns or refundsAndCredits')
  if (state) mustMatch(state, /^(open|fixed)(,(open|fixed))*$/, '--state is open or fixed, or a list')
  if (period) mustMatch(period, PERIOD_RE, '--period is a period such as 2026-10 or 2026-Q4')
  if (since) mustMatch(since, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, '--since is YYYY-MM-DD')
  let sortKey = 'FIRST_FOUND'
  if (sortFlag === 'statement') sortKey = 'STATEMENT'
  else if (sortFlag !== 'first-found') throw usage('--sort is first-found or statement')
  // No leading zero: GraphQL refuses 050 as an Int.
  mustMatch(first, /^[1-9][0-9]*$/, '--first is a number from 1 to 100')
  if (Number(first) > 100) throw usage('--first is a number from 1 to 100')
  if (after) mustMatch(after, /^[A-Za-z0-9_-]+$/, '--after is a cursor from pageInfo.endCursor')

  const parts: string[] = []
  if (audit) parts.push(`audit:${audit}`)
  if (statement) parts.push(`statement:${statement}`)
  if (category) parts.push(`category:${category}`)
  if (state) parts.push(`state:${state}`)
  if (period) parts.push(`period:${period}`)
  if (since) parts.push(`firstFound:>=${since}`)
  const terms = parts.join(' ')

  let baseArgs = `first: ${first}`
  const variables: Record<string, string> = {}
  if (terms) {
    baseArgs += ', query: $q'
    variables.q = terms
  }
  if (sortKey !== 'FIRST_FOUND') baseArgs += `, sortKey: ${sortKey}`
  if (reverse) baseArgs += ', reverse: true'
  return { terms, sortKey, reverse, all, after, baseArgs, variables }
}

/** One findings page. Declares only the variables the arguments use: moqui-gql (graphql-java, default validation)
 *  refuses the whole document for a declared-but-unused variable (UnusedVariable), so a first page never declares
 *  $after and an unfiltered list never declares $q. */
export function pageDocument(args: string): string {
  const declared = [/\$q\b/.test(args) ? '$q: String' : '', /\$after\b/.test(args) ? '$after: String' : ''].filter(Boolean)
  return `query${declared.length ? `(${declared.join(', ')})` : ''} { findings(${args}) { ${LIST_FIELDS} } }`
}

interface FindingsResponse {
  data?: { findings?: { edges?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } | null
}

/** One page prints as the sh did: the whole {data, errors} response untouched. --all prints {query, sortKey, reverse, edges}.
 *  Cursors (the person's --after and the server's endCursor) travel as the $after variable, never in the document. */
export async function listFindings(session: Session, query: FindingsQuery): Promise<unknown> {
  const fetchPage = (after: string) =>
    session.gql<FindingsResponse>(
      pageDocument(after ? `${query.baseArgs}, after: $after` : query.baseArgs),
      after ? { ...query.variables, after } : query.variables,
      { raw: true },
    )

  if (!query.all) return fetchPage(query.after)
  const edges: unknown[] = []
  let after = query.after
  for (let pages = 1; ; pages += 1) {
    const findings = (await fetchPage(after)).data?.findings
    if (!findings) throw new CliError('findings: the answer had no findings', EXIT.failed, 'retry, or narrow the query')
    edges.push(...(findings.edges ?? []))
    if (!findings.pageInfo?.hasNextPage) break
    const next = findings.pageInfo.endCursor
    if (!next) throw new CliError('findings: a next page was announced without a cursor', EXIT.failed, 'narrow the query and retry')
    if (!/^[A-Za-z0-9_-]+$/.test(next)) throw new CliError('findings: the server returned a malformed cursor; stopping', EXIT.failed, 'narrow the query and retry')
    if (next === after) throw new CliError(`findings: the cursor did not move (${next}); stopping`, EXIT.failed, 'narrow the query and retry')
    if (pages >= LIST_MAX_PAGES) throw new CliError(`findings: stopped after ${LIST_MAX_PAGES} pages; narrow the query`, EXIT.failed, 'add --state, --period or --statement')
    after = next
  }
  return { query: query.terms, sortKey: query.sortKey, reverse: query.reverse, edges }
}

export function monthExportQuery(args: { month?: unknown; audit?: unknown; state?: unknown }): FindingsQuery {
  const month = str(args.month)
  if (!month) throw usage('usage: darpan month export --month YYYY-MM [--audit <code>] [--state open]')
  mustMatch(month, /^[0-9]{4}-(0[1-9]|1[0-2])$/, '--month is YYYY-MM')
  return buildFindingsQuery({ all: true, first: '100', audit: args.audit, period: month, state: str(args.state) || 'open' })
}
