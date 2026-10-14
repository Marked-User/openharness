/** Core's declaration of the launch evidence models may classify. No keys cross this port. */
import { ENGINES, type AgentEngine } from '../engines/types.js'

export interface GridAssignment { baseUrl: string; model: string | null }
export interface GridAssignmentProcess { key: string; engine: AgentEngine; env: Record<string, string>; args: string }
export interface GridAssignmentAnswer { key: string; assignment: GridAssignment | null }

export const GRID_ENDPOINT_VARS: Partial<Record<AgentEngine, string>> = {
  claude: 'ANTHROPIC_BASE_URL', hermes: 'OPENAI_BASE_URL', grok: 'GROK_MODELS_BASE_URL', copilot: 'COPILOT_PROVIDER_BASE_URL',
}
export const GRID_MODEL_VARS: Partial<Record<AgentEngine, string>> = {
  claude: 'ANTHROPIC_MODEL', hermes: 'HERMES_INFERENCE_MODEL', copilot: 'COPILOT_MODEL',
}
export const GRID_CODEX_ENDPOINT = /model_providers\.[A-Za-z0-9_-]+\.base_url=(?:"([^"]+)"|(\S+))/
export const GRID_ARGV_MODEL = /(?:^|\s)-m\s+(\S+)/
export const GRID_PI_MODEL = /(?:^|\s)--model\s+([A-Za-z0-9_-]+)\/(\S+)/
/** `-e <dir>/grid-provider.ts`, the extension a grid launch hands Pi (lib/gridLaunch.ts `piProviderExtension`). */
export const GRID_PI_EXTENSION = /(?:^|\s)-e\s+(\S*\/grid-provider\.ts)(?=\s|$)/

/** The provider id and block a grid-provider extension registers; null for any other source. */
export function piProviderExtensionIn(source: string): { id: string; provider: Record<string, unknown> } | null {
  const block = /pi\.registerProvider\(("[^"]+"), (\{[\s\S]*\})\)\s*\}\s*$/.exec(source)
  if (!block) return null
  try {
    const id: unknown = JSON.parse(block[1]), provider: unknown = JSON.parse(block[2])
    return typeof id === 'string' && !!provider && typeof provider === 'object' ? { id, provider: provider as Record<string, unknown> } : null
  } catch { return null }
}

/** Null is positive evidence of no launch markers. An unreadable environment is handled by the caller. */
export function gridAssignmentProcess(key: string, engine: AgentEngine, env: Record<string, string>, args: string): GridAssignmentProcess | null {
  const endpoint = GRID_ENDPOINT_VARS[engine]
  // A Pi launched before its provider extension was pointed at a whole config directory instead, and is read that way
  // until it is relaunched.
  const marker = engine === 'pi' ? 'PI_CODING_AGENT_DIR' : engine === 'opencode' ? 'OPENCODE_CONFIG' : endpoint
  const extension = engine === 'pi' ? GRID_PI_EXTENSION.exec(args) : null
  const provider = marker ? null : GRID_CODEX_ENDPOINT.exec(args)
  if (!(extension || (marker ? env[marker]?.trim() : provider))) return null
  const picked: Record<string, string> = {}
  for (const name of [marker, GRID_MODEL_VARS[engine]]) if (name && env[name] !== undefined) picked[name] = env[name]
  // Never forward the command line: it may carry a prompt, token or unrelated tool arguments.
  const model = engine === 'pi' ? GRID_PI_MODEL.exec(args)?.[0].trim()
    : engine === 'codex' || engine === 'grok' ? GRID_ARGV_MODEL.exec(args)?.[0] : undefined
  return { key, engine, env: picked, args: [provider?.[0], extension?.[0].trim(), model].filter(Boolean).join(' ') }
}

/**
 * [gridAssignmentProcess] over what a process gave: its environment, or null when that could not be read. Without
 * one, only a launch command naming its grid counts (Pi's `-e` extension); a command naming none is not known, never
 * "on its own login", since the unread environment may hold the grid.
 */
export function gridAssignmentEvidence(key: string, engine: AgentEngine, env: Record<string, string> | null, args: string): GridAssignmentProcess | null | undefined {
  return env ? gridAssignmentProcess(key, engine, env, args) : gridAssignmentProcess(key, engine, {}, args) ?? undefined
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function gridAssignmentProcessesIn(value: unknown): GridAssignmentProcess[] | null {
  if (!Array.isArray(value) || value.length > 4096) return null
  const out: GridAssignmentProcess[] = []
  for (const row of value) {
    if (!record(row) || typeof row.key !== 'string' || typeof row.engine !== 'string' || !ENGINES.includes(row.engine as AgentEngine)
      || typeof row.args !== 'string' || !record(row.env) || !Object.values(row.env).every(v => typeof v === 'string')) return null
    const process = gridAssignmentProcess(row.key, row.engine as AgentEngine, row.env as Record<string, string>, row.args)
    if (!process || out.some(previous => previous.key === row.key)) return null
    out.push(process)
  }
  return out
}

export function gridAssignmentAnswersIn(value: unknown, processes: readonly GridAssignmentProcess[]): GridAssignmentAnswer[] | null {
  if (!Array.isArray(value) || value.length !== processes.length) return null
  const keys = new Set(processes.map(process => process.key))
  const out: GridAssignmentAnswer[] = []
  for (const row of value) {
    if (!record(row) || typeof row.key !== 'string' || !keys.delete(row.key)) return null
    const a = row.assignment
    if (a !== null && (!record(a) || typeof a.baseUrl !== 'string' || !(a.model === null || typeof a.model === 'string'))) return null
    out.push({ key: row.key, assignment: a === null ? null : { baseUrl: a.baseUrl as string, model: a.model as string | null } })
  }
  return out
}

export function sameGridAssignment(a: GridAssignment | null, b: GridAssignment | null): boolean {
  if (a === null || b === null) return a === b
  return a.baseUrl === b.baseUrl && (a.model ?? null) === (b.model ?? null)
}
