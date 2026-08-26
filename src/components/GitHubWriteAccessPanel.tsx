import { useEffect, useRef, useState } from 'react'
import {
  beginGitHubWriteAuthorization,
  connectGitHubWriteRepository,
  createGitHubIssue,
  disconnectGitHubWriteConnection,
  getEligibleGitHubRepositories,
  getGitHubWriteConnections,
  isGitHubWriteAccessConfigured,
} from '../services/githubWriteAccess'
import type {
  GitHubEligibleRepository,
  GitHubWriteConnectionSummary,
  GitHubWriteFailureCode,
  GitHubWriteResult,
} from '../services/githubWriteAccess'

function safeFailureMessage(code: GitHubWriteFailureCode): string {
  switch (code) {
    case 'not-configured':
      return 'Supabase is not configured in this build.'
    case 'not-signed-in':
    case 'AUTH_REQUIRED':
    case 'INVALID_TOKEN':
      return 'Sign in again before connecting GitHub.'
    case 'RATE_LIMITED':
      return 'GitHub issue access is rate-limited. Try again shortly.'
    case 'OAUTH_DENIED':
      return 'GitHub authorization was denied or expired. Authorize again to continue.'
    case 'CONNECTION_NOT_FOUND':
      return 'That GitHub repository connection is no longer available.'
    case 'REPOSITORY_NOT_ELIGIBLE':
      return 'That repository is not eligible for this GitHub App installation.'
    case 'REPOSITORY_AUTHORIZATION_EXPIRED':
      return 'GitHub authorization expired. Authorize GitHub and reconnect this repository.'
    case 'WRITE_NOT_CONFIRMED':
      return 'Review and explicitly confirm the selected GitHub write first.'
    case 'IDEMPOTENCY_CONFLICT':
      return 'This issue request was already attempted. Review it before making a new request.'
    case 'GITHUB_ACCESS_DENIED':
      return 'GitHub denied access to that repository. Reconnect after checking App permissions.'
    case 'ISSUE_REJECTED':
      return 'GitHub rejected the issue request. Review the title and body.'
    case 'BAD_REQUEST':
      return 'Check the selected repository and issue details.'
    case 'unavailable':
    default:
      return 'GitHub issue access is temporarily unavailable.'
  }
}

function newIdempotencyKey(): string | null {
  const randomUUID = globalThis.crypto?.randomUUID
  return typeof randomUUID === 'function' ? randomUUID.call(globalThis.crypto) : null
}

const MAX_ISSUE_TITLE_BYTES = 256
const MAX_ISSUE_BODY_BYTES = 16_384
const UTF8_ENCODER = new TextEncoder()

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength
}

export default function GitHubWriteAccessPanel() {
  const [connections, setConnections] = useState<GitHubWriteConnectionSummary[]>([])
  const [eligibleRepositories, setEligibleRepositories] = useState<GitHubEligibleRepository[]>([])
  const [selectedConnectionId, setSelectedConnectionId] = useState('')
  const [selectedRepositoryId, setSelectedRepositoryId] = useState('')
  const [authorizationConsent, setAuthorizationConsent] = useState(false)
  const [connectionConsent, setConnectionConsent] = useState(false)
  const [issueTitle, setIssueTitle] = useState('')
  const [issueBody, setIssueBody] = useState('')
  const [issueConfirmed, setIssueConfirmed] = useState(false)
  const [createdIssue, setCreatedIssue] = useState<{ number: number; url: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const issueAttemptKeyRef = useRef<string | null>(null)

  const selectedConnection = connections.find(connection => connection.id === selectedConnectionId)
    ?? connections[0]
    ?? null
  const selectedRepository = eligibleRepositories.find(repository => repository.repositoryId === selectedRepositoryId)
    ?? eligibleRepositories[0]
    ?? null
  const trimmedIssueTitle = issueTitle.trim()
  const issueTitleBytes = utf8ByteLength(trimmedIssueTitle)
  const issueBodyBytes = utf8ByteLength(issueBody)
  const issueTitleWithinLimit = (
    issueTitleBytes > 0
    && issueTitleBytes <= MAX_ISSUE_TITLE_BYTES
    && !/[\u0000-\u001F\u007F]/.test(trimmedIssueTitle)
  )
  const issueBodyWithinLimit = issueBodyBytes <= MAX_ISSUE_BODY_BYTES

  const refreshConnections = async (): Promise<GitHubWriteResult<{
    connections: GitHubWriteConnectionSummary[]
  }>> => {
    const result = await getGitHubWriteConnections()
    if (result.ok) setConnections(result.data.connections)
    return result
  }

  const refreshEligibleRepositories = async (): Promise<GitHubWriteResult<{
    repositories: GitHubEligibleRepository[]
  }>> => {
    const result = await getEligibleGitHubRepositories()
    if (result.ok) setEligibleRepositories(result.data.repositories)
    return result
  }

  const refresh = async () => {
    const [connectionResult, eligibleResult] = await Promise.all([
      refreshConnections(),
      refreshEligibleRepositories(),
    ])
    if (!connectionResult.ok) {
      setStatus(safeFailureMessage(connectionResult.code))
      return
    }
    if (!eligibleResult.ok) setStatus(safeFailureMessage(eligibleResult.code))
  }

  useEffect(() => {
    if (!isGitHubWriteAccessConfigured()) return
    void refresh()
  }, [])

  useEffect(() => {
    if (!connections.some(connection => connection.id === selectedConnectionId)) {
      setSelectedConnectionId(connections[0]?.id ?? '')
    }
  }, [connections, selectedConnectionId])

  useEffect(() => {
    if (!eligibleRepositories.some(repository => repository.repositoryId === selectedRepositoryId)) {
      setSelectedRepositoryId(eligibleRepositories[0]?.repositoryId ?? '')
    }
  }, [eligibleRepositories, selectedRepositoryId])

  const handleAuthorize = async () => {
    setStatus('')
    setLoading(true)
    const result = await beginGitHubWriteAuthorization(authorizationConsent)
    setLoading(false)
    if (!result.ok) {
      setStatus(safeFailureMessage(result.code))
      return
    }
    // The one-time OAuth URL is never stored in React state, browser storage,
    // history helpers, or Daemon conversation data. Replace avoids retaining
    // the state-bearing authorization URL as an application history entry.
    window.location.replace(result.data.authorizationUrl)
  }

  const handleConnect = async () => {
    if (!selectedRepository) return
    setStatus('')
    setLoading(true)
    const result = await connectGitHubWriteRepository(
      selectedRepository.repositoryId,
      connectionConsent,
    )
    setLoading(false)
    if (!result.ok) {
      setStatus(safeFailureMessage(result.code))
      return
    }
    setSelectedConnectionId(result.data.connection.id)
    setConnectionConsent(false)
    setIssueConfirmed(false)
    resetIssueAttempt()
    setStatus(`Connected ${result.data.connection.repositoryFullName} for issue creation only.`)
    await refresh()
  }

  const handleDisconnect = async () => {
    if (!selectedConnection) return
    setStatus('')
    setLoading(true)
    const result = await disconnectGitHubWriteConnection(selectedConnection.id)
    setLoading(false)
    if (!result.ok) {
      setStatus(safeFailureMessage(result.code))
      return
    }
    resetIssueAttempt()
    setIssueConfirmed(false)
    setStatus('GitHub repository access was disconnected locally.')
    await refresh()
  }

  const resetIssueAttempt = () => {
    issueAttemptKeyRef.current = null
    setCreatedIssue(null)
  }

  const handleCreateIssue = async () => {
    if (!selectedConnection) return
    const idempotencyKey = issueAttemptKeyRef.current ?? newIdempotencyKey()
    if (!idempotencyKey) {
      setStatus('This browser cannot create a secure idempotency key.')
      return
    }
    issueAttemptKeyRef.current = idempotencyKey
    setStatus('')
    setLoading(true)
    const result = await createGitHubIssue({
      connectionId: selectedConnection.id,
      idempotencyKey,
      title: trimmedIssueTitle,
      body: issueBody,
      confirmRepository: selectedConnection.repositoryFullName,
      confirmed: issueConfirmed,
    })
    setLoading(false)
    if (!result.ok) {
      setStatus(safeFailureMessage(result.code))
      return
    }
    issueAttemptKeyRef.current = null
    setCreatedIssue({ number: result.data.issueNumber, url: result.data.issueUrl })
    setIssueTitle('')
    setIssueBody('')
    setIssueConfirmed(false)
    setStatus(`Created GitHub issue #${result.data.issueNumber}.`)
    await refreshConnections()
  }

  if (!isGitHubWriteAccessConfigured()) return null

  return (
    <details className="github-write-access-panel" aria-label="GitHub issue access">
      <summary>GitHub issue access</summary>
      <p className="github-write-access-description">
        Connect a GitHub App installation to create issues only. This panel cannot edit files,
        pull requests, workflows, secrets, or repository settings.
      </p>

      <div className="github-write-access-connect">
        <label className="github-write-access-consent">
          <input
            type="checkbox"
            checked={authorizationConsent}
            onChange={event => setAuthorizationConsent(event.target.checked)}
          />
          I consent to GitHub App authorization so I can choose an eligible repository.
        </label>
        <button type="button" onClick={() => void handleAuthorize()} disabled={loading || !authorizationConsent}>
          Authorize GitHub App
        </button>
      </div>

      {eligibleRepositories.length > 0 && (
        <div className="github-write-access-connect">
          <label htmlFor="github-write-eligible-repository">Eligible GitHub repository</label>
          <select
            id="github-write-eligible-repository"
            value={selectedRepository?.repositoryId ?? ''}
            onChange={event => {
              setSelectedRepositoryId(event.target.value)
              setConnectionConsent(false)
            }}
          >
            {eligibleRepositories.map(repository => (
              <option key={repository.repositoryId} value={repository.repositoryId}>
                {repository.repositoryFullName}
              </option>
            ))}
          </select>
          <label className="github-write-access-consent">
            <input
              type="checkbox"
              checked={connectionConsent}
              onChange={event => setConnectionConsent(event.target.checked)}
            />
            I authorize issue creation only for {selectedRepository?.repositoryFullName ?? 'this repository'}.
          </label>
          <button type="button" onClick={() => void handleConnect()} disabled={loading || !connectionConsent}>
            Connect repository
          </button>
        </div>
      )}

      {selectedConnection && (
        <div className="github-write-access-connected">
          <label htmlFor="github-write-connection">Connected repository</label>
          <select
            id="github-write-connection"
            value={selectedConnection.id}
            onChange={event => {
              setSelectedConnectionId(event.target.value)
              setIssueConfirmed(false)
              resetIssueAttempt()
            }}
          >
            {connections.map(connection => (
              <option key={connection.id} value={connection.id}>{connection.repositoryFullName}</option>
            ))}
          </select>
          <p>
            Allowed action: <code>{selectedConnection.allowedActions[0]}</code>
          </p>
          <p>
            GitHub authorization refresh: <time dateTime={selectedConnection.authorizationExpiresAt}>
              {new Date(selectedConnection.authorizationExpiresAt).toLocaleString()}
            </time>
          </p>
          <button type="button" onClick={() => void handleDisconnect()} disabled={loading}>
            Disconnect
          </button>

          <div className="github-write-access-issue">
            <label htmlFor="github-write-issue-title">Issue title</label>
            <input
              id="github-write-issue-title"
              value={issueTitle}
              onChange={event => {
                setIssueTitle(event.target.value)
                setIssueConfirmed(false)
                resetIssueAttempt()
              }}
              autoComplete="off"
            />
            <label htmlFor="github-write-issue-body">Issue body (optional)</label>
            <textarea
              id="github-write-issue-body"
              value={issueBody}
              onChange={event => {
                setIssueBody(event.target.value)
                setIssueConfirmed(false)
                resetIssueAttempt()
              }}
              rows={5}
            />
            <p className="github-write-access-preview">
              Title bytes: {issueTitleBytes}/{MAX_ISSUE_TITLE_BYTES} · Body bytes: {issueBodyBytes}/{MAX_ISSUE_BODY_BYTES}
            </p>
            <p className="github-write-access-preview">
              Preview: create an issue in <code>{selectedConnection.repositoryFullName}</code>. Daemon
              content is never submitted automatically; review or enter the text yourself.
            </p>
            <label className="github-write-access-consent">
              <input
                type="checkbox"
                checked={issueConfirmed}
                onChange={event => {
                  if (!event.target.checked) resetIssueAttempt()
                  setIssueConfirmed(event.target.checked)
                }}
              />
              I reviewed this issue and confirm creation in {selectedConnection.repositoryFullName}.
            </label>
            <button
              type="button"
              onClick={() => void handleCreateIssue()}
              disabled={loading || !issueConfirmed || !issueTitleWithinLimit || !issueBodyWithinLimit}
            >
              Create GitHub issue
            </button>
          </div>
        </div>
      )}

      {createdIssue && (
        <p className="github-write-access-status">
          Created issue #{createdIssue.number}:{' '}
          <a href={createdIssue.url} target="_blank" rel="noreferrer">open on GitHub</a>
        </p>
      )}
      <p className="github-write-access-status" aria-live="polite">{status}</p>
    </details>
  )
}
