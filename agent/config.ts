// Where the CLI remembers which Darpan it talks to and the sign-in key. One JSON file, 0600, in a 0700 dir.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Instance {
  url: string
  token?: string
  tokenExpiresAt?: string
  tenant?: string
  /** App base URL for the sign-in page (local dev), remembered from `login --app-url`. */
  appUrl?: string
}

export interface Config {
  current: string
  instances: Record<string, Instance>
}

export function configDir(env: Record<string, string | undefined>): string {
  return env.DARPAN_CONFIG_DIR || join(env.HOME || homedir(), '.config', 'darpan')
}

export function loadConfig(dir: string): Config {
  const file = join(dir, 'config.json')
  if (!existsSync(file)) return { current: '', instances: {} }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>
  return { current: typeof parsed.current === 'string' ? parsed.current : '', instances: parsed.instances ?? {} }
}

export function saveConfig(dir: string, cfg: Config): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const file = join(dir, 'config.json')
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/** The instance the commands act on, or null when nobody has signed in yet. */
export function currentInstance(cfg: Config): { name: string; instance: Instance } | null {
  const instance = cfg.instances[cfg.current]
  return instance ? { name: cfg.current, instance } : null
}

/** Forget the sign-in key (keeps the URL and tenant choice). */
export function dropToken(cfg: Config, name: string): void {
  const instance = cfg.instances[name]
  if (!instance) return
  delete instance.token
  delete instance.tokenExpiresAt
}
