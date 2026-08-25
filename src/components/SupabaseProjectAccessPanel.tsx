import { useEffect, useState } from 'react'
import {
  beginProjectAccessConnection,
  disconnectProjectAccess,
  formatLogsForDaemon,
  getProjectAccessConnections,
  getProjectLogs,
  getProjectSecretHealth,
  isProjectAccessConfigured,
} from '../services/supabaseProjectAccess'
import type {
  ProjectAccessFailureCode,
  ProjectConnectionSummary,
  ProjectLogService,
  ProjectLogs,
  ProjectSecretHealth,
} from '../services/supabaseProjectAccess'

interface SupabaseProjectAccessPanelProps {
  onUseWithDaemon: (context: string) => void
  hasQueuedContext: boolean
}

const LOG_SERVICES: Array<{ value: ProjectLogService; label: string }> = [
  { value: 'edge-function-runtime', label: 'Edge Function runtime' },
  { value: 'edge-function', label: 'Edge Function requests' },
  { value: 'postgres', label: 'Postgres' },
  { value: 'auth', label: 'Auth' },
  { value: 'api', label: 'API' },
  { value: 'storage', label: 'Storage' },
  { value: 'realtime', label: 'Realtime' },
  { value: 'branch-action', label: 'Branch actions' },
]

function safeFailureMessage(code: ProjectAccessFailureCode): string {
  switch (code) {
    case 'not-configured':
      return 'Supabase is not configured in this build.'
    case 'not-signed-in':
    case 'AUTH_REQUIRED':
    case 'INVALID_TOKEN':
      return 'Sign in again before accessing a project.'
    case 'RATE_LIMITED':
      return 'Project log access is rate-limited. Try again shortly.'
    case 'CONNECTION_NOT_FOUND':
      return 'That connection is no longer available.'
    case 'PROJECT_ACCESS_DENIED':
    case 'OAUTH_DENIED':
      return 'Supabase denied access to that project. Reconnect and approve the requested scope.'
    case 'BAD_REQUEST':
      return 'Check the project reference and request details.'
    case 'SECRET_WRITE_DISABLED':
      return 'Secret writes require a separately confirmed connection.'
    case 'unavailable':
    default:
      return 'Project access is temporarily unavailable.'
  }
}

export default function SupabaseProjectAccessPanel({
  onUseWithDaemon,
  hasQueuedContext,
}: SupabaseProjectAccessPanelProps) {
  const [connections, setConnections] = useState<ProjectConnectionSummary[]>([])
  const [projectRef, setProjectRef] = useState('')
  const [consent, setConsent] = useState(false)
  const [service, setService] = useState<ProjectLogService>('edge-function-runtime')
  const [selectedConnectionId, setSelectedConnectionId] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [logs, setLogs] = useState<ProjectLogs | null>(null)
  const [health, setHealth] = useState<ProjectSecretHealth | null>(null)

  const readConnections = connections.filter(connection => connection.access_mode === 'read_logs')
  const selectedConnection = readConnections.find(connection => connection.id === selectedConnectionId)
    ?? readConnections[0]
    ?? null

  const refreshConnections = async () => {
    const result = await getProjectAccessConnections()
    if (!result.ok) {
      setStatus(safeFailureMessage(result.code))
      return
    }
    setConnections(result.data.connections)
  }

  useEffect(() => {
    if (!isProjectAccessConfigured()) return
    void refreshConnections()
  }, [])

  useEffect(() => {
    if (!logs) return
    const timer = window.setTimeout(() => {
      setLogs(null)
      setHealth(null)
      setStatus('Loaded log data was cleared from this browser session.')
    }, 5 * 60 * 1000)
    return () => window.clearTimeout(timer)
  }, [logs])

  const handleConnect = async () => {
    setStatus('')
    setLoading(true)
    const result = await beginProjectAccessConnection(projectRef.trim(), consent)
    setLoading(false)
    if (!result.ok) {
      setStatus(safeFailureMessage(result.code))
      return
    }
    // The OAuth authorization URL contains the one-time state. Do not retain
    // it in component state, localStorage, history helpers, or chat messages.
    window.location.assign(result.data.authorizationUrl)
  }

  const handleLoadLogs = async () => {
    if (!selectedConnection) return
    setStatus('')
    setLoading(true)
    const result = await getProjectLogs(selectedConnection.id, { service, limit: 50 })
    setLoading(false)
    if (!result.ok) {
      setStatus(safeFailureMessage(result.code))
      return
    }
    setLogs(result.data.logs)
    setHealth(null)
    setStatus(`Loaded ${result.data.logs.entries.length} redacted log entries. They remain untrusted data.`)
  }

  const handleLoadHealth = async () => {
    if (!selectedConnection) return
    setStatus('')
    setLoading(true)
    const result = await getProjectSecretHealth(selectedConnection.id)
    setLoading(false)
    if (!result.ok) {
      setStatus(safeFailureMessage(result.code))
      return
    }
    setHealth(result.data.health)
  }

  const handleDisconnect = async () => {
    if (!selectedConnection) return
    setStatus('')
    setLoading(true)
    const result = await disconnectProjectAccess(selectedConnection.id)
    setLoading(false)
    if (!result.ok) {
      setStatus(safeFailureMessage(result.code))
      return
    }
    setLogs(null)
    setHealth(null)
    setStatus('Project access was disconnected and local OAuth access was revoked.')
    await refreshConnections()
  }

  if (!isProjectAccessConfigured()) return null

  return (
    <details className="project-access-panel" aria-label="Supabase project access">
      <summary>Supabase project access</summary>
      <p className="project-access-description">
        Connect one project at a time for read-only, on-demand log diagnostics. OAuth tokens and
        secret values never enter this browser.
      </p>

      {!selectedConnection && (
        <div className="project-access-connect">
          <label htmlFor="supabase-project-ref">Project reference</label>
          <input
            id="supabase-project-ref"
            value={projectRef}
            onChange={event => setProjectRef(event.target.value.toLowerCase())}
            autoComplete="off"
            maxLength={64}
            pattern="[a-z0-9]+"
            placeholder="abcdefghijklmnopqrst"
          />
          <label className="project-access-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={event => setConsent(event.target.checked)}
            />
            I consent to read-only, project-scoped Supabase log access.
          </label>
          <button type="button" onClick={() => void handleConnect()} disabled={loading || !consent}>
            Connect read-only project
          </button>
        </div>
      )}

      {selectedConnection && (
        <div className="project-access-connected">
          <p>
            Connected project: <code>{selectedConnection.project_ref}</code>
          </p>
          {readConnections.length > 1 && (
            <>
              <label htmlFor="supabase-project-connection">Connected project</label>
              <select
                id="supabase-project-connection"
                value={selectedConnection.id}
                onChange={event => setSelectedConnectionId(event.target.value)}
              >
                {readConnections.map(connection => (
                  <option key={connection.id} value={connection.id}>{connection.project_ref}</option>
                ))}
              </select>
            </>
          )}
          <label htmlFor="supabase-log-service">Log service</label>
          <select
            id="supabase-log-service"
            value={service}
            onChange={event => setService(event.target.value as ProjectLogService)}
          >
            {LOG_SERVICES.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <div className="project-access-actions">
            <button type="button" onClick={() => void handleLoadLogs()} disabled={loading}>
              Load recent logs
            </button>
            <button type="button" onClick={() => void handleLoadHealth()} disabled={loading}>
              Check secret health
            </button>
            <button type="button" onClick={() => void handleDisconnect()} disabled={loading}>
              Disconnect
            </button>
          </div>
        </div>
      )}

      {logs && (
        <div className="project-access-logs">
          <p>
            {logs.entries.length} redacted entries from {logs.startAt} to {logs.endAt}.
          </p>
          <button
            type="button"
            onClick={() => {
              onUseWithDaemon(formatLogsForDaemon(logs))
              setStatus('Redacted, untrusted logs will be used only in Daemon’s next cloud request.')
            }}
            disabled={hasQueuedContext}
          >
            {hasQueuedContext ? 'Logs queued for Daemon' : 'Use with next Daemon response'}
          </button>
          <pre className="project-access-log-output">{JSON.stringify(logs.entries, null, 2)}</pre>
        </div>
      )}

      {health && (
        <div className="project-access-health">
          <p>
            {health.scope === 'gateway-project'
              ? 'Configured/missing status is available for this gateway project only.'
              : 'Read-only MCP does not expose another project’s secret inventory. No secret values were requested.'}
          </p>
          <ul>
            {health.secrets.map(secret => (
              <li key={secret.name}>
                <code>{secret.name}</code>: {secret.status}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="project-access-status" aria-live="polite">{status}</p>
    </details>
  )
}
