import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  completeGitHubWriteAuthorization,
  connectGitHubWriteRepository,
  createGitHubIssue,
  disconnectGitHubWriteConnection,
  getGitHubWriteConnections,
} = vi.hoisted(() => ({
  completeGitHubWriteAuthorization: vi.fn(),
  connectGitHubWriteRepository: vi.fn(),
  createGitHubIssue: vi.fn(),
  disconnectGitHubWriteConnection: vi.fn(),
  getGitHubWriteConnections: vi.fn(),
}))

vi.mock('../src/services/githubWriteAccess', () => ({
  beginGitHubWriteAuthorization: vi.fn(),
  completeGitHubWriteAuthorization,
  connectGitHubWriteRepository,
  createGitHubIssue,
  disconnectGitHubWriteConnection,
  getEligibleGitHubRepositories: vi.fn().mockResolvedValue({
    ok: true,
    data: {
      repositories: [
        { repositoryId: '1', repositoryFullName: 'owner/repository-a', expiresAt: '2026-08-26T00:00:00.000Z' },
        { repositoryId: '2', repositoryFullName: 'owner/repository-b', expiresAt: '2026-08-26T00:00:00.000Z' },
      ],
    },
  }),
  getGitHubWriteConnections,
  isGitHubWriteAccessConfigured: () => true,
}))

import GitHubWriteAccessPanel from '../src/components/GitHubWriteAccessPanel'

describe('GitHubWriteAccessPanel', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/')
    completeGitHubWriteAuthorization.mockReset()
    completeGitHubWriteAuthorization.mockResolvedValue({ ok: true, data: { authorized: true } })
    connectGitHubWriteRepository.mockReset()
    connectGitHubWriteRepository.mockResolvedValue({ ok: false, code: 'unavailable' })
    createGitHubIssue.mockReset()
    createGitHubIssue.mockResolvedValue({ ok: false, code: 'GITHUB_UNAVAILABLE' })
    disconnectGitHubWriteConnection.mockReset()
    disconnectGitHubWriteConnection.mockResolvedValue({ ok: true, data: { disconnected: true } })
    getGitHubWriteConnections.mockReset()
    getGitHubWriteConnections.mockResolvedValue({
      ok: true,
      data: {
        connections: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            repositoryFullName: 'owner/repository-a',
            allowedActions: ['create_issue'],
            authorizationExpiresAt: '2026-08-26T00:00:00.000Z',
            connectedAt: '2026-08-25T00:00:00.000Z',
            lastUsedAt: null,
          },
          {
            id: '00000000-0000-4000-8000-000000000002',
            repositoryFullName: 'owner/repository-b',
            allowedActions: ['create_issue'],
            authorizationExpiresAt: '2026-08-26T00:00:00.000Z',
            connectedAt: '2026-08-25T00:00:00.000Z',
            lastUsedAt: null,
          },
        ],
      },
    })
  })

  it('disables mutable repository and issue controls while issue creation is in flight', async () => {
    let resolveIssue: ((value: { ok: false; code: string }) => void) | null = null
    createGitHubIssue.mockReturnValue(new Promise(resolve => {
      resolveIssue = resolve
    }))
    render(<GitHubWriteAccessPanel />)
    const repository = await screen.findByLabelText('Eligible GitHub repository')
    const repositoryConsent = screen.getByLabelText(/I authorize issue creation only for owner\/repository-a/)
    const connection = screen.getByLabelText('Connected repository')
    const title = screen.getByLabelText('Issue title')
    const body = screen.getByLabelText('Issue body (optional)')
    const confirmation = screen.getByLabelText(/I reviewed this issue and confirm creation in owner\/repository-a/)

    fireEvent.change(title, { target: { value: 'Issue title' } })
    fireEvent.click(confirmation)
    fireEvent.click(screen.getByRole('button', { name: 'Create GitHub issue' }))

    await waitFor(() => expect(createGitHubIssue).toHaveBeenCalledTimes(1))
    expect(repository).toBeDisabled()
    expect(repositoryConsent).toBeDisabled()
    expect(connection).toBeDisabled()
    expect(title).toBeDisabled()
    expect(body).toBeDisabled()
    expect(confirmation).toBeDisabled()

    resolveIssue?.({ ok: false, code: 'GITHUB_UNAVAILABLE' })
    await waitFor(() => expect(title).not.toBeDisabled())
  })

  it('completes a callback from a scrubbed URL fragment', async () => {
    const state = 'oauth-state-token-for-browser-binding-123456'
    const code = 'github-authorization-code-123456'
    window.location.hash = `/?github_write=complete&github_write_state=${state}&github_write_code=${code}`

    render(<GitHubWriteAccessPanel />)

    await waitFor(() => {
      expect(completeGitHubWriteAuthorization).toHaveBeenCalledWith(state, code)
    })
    expect(window.location.hash).toBe('')
  })

  it('resets repository authorization consent when its target changes', async () => {
    render(<GitHubWriteAccessPanel />)
    const repository = await screen.findByLabelText('Eligible GitHub repository')
    const consent = screen.getByLabelText(/I authorize issue creation only for owner\/repository-a/)

    fireEvent.click(consent)
    fireEvent.change(repository, { target: { value: '2' } })

    expect(screen.getByLabelText(/I authorize issue creation only for owner\/repository-b/)).not.toBeChecked()
  })

  it('resets issue confirmation and idempotency key when its target changes', async () => {
    render(<GitHubWriteAccessPanel />)
    const connection = await screen.findByLabelText('Connected repository')
    const title = screen.getByLabelText('Issue title')
    const confirmation = screen.getByLabelText(/I reviewed this issue and confirm creation in owner\/repository-a/)

    fireEvent.change(title, { target: { value: 'Issue title' } })
    fireEvent.click(confirmation)
    fireEvent.click(screen.getByRole('button', { name: 'Create GitHub issue' }))
    await waitFor(() => expect(createGitHubIssue).toHaveBeenCalledTimes(1))
    const firstKey = createGitHubIssue.mock.calls[0][0].idempotencyKey

    fireEvent.change(connection, { target: { value: '00000000-0000-4000-8000-000000000002' } })
    expect(screen.getByLabelText(/I reviewed this issue and confirm creation in owner\/repository-b/)).not.toBeChecked()

    fireEvent.click(screen.getByLabelText(/I reviewed this issue and confirm creation in owner\/repository-b/))
    fireEvent.click(screen.getByRole('button', { name: 'Create GitHub issue' }))
    await waitFor(() => expect(createGitHubIssue).toHaveBeenCalledTimes(2))
    expect(createGitHubIssue.mock.calls[1][0]).toMatchObject({
      connectionId: '00000000-0000-4000-8000-000000000002',
      confirmRepository: 'owner/repository-b',
    })
    expect(createGitHubIssue.mock.calls[1][0].idempotencyKey).not.toBe(firstKey)
  })

  it('resets issue confirmation when issue content changes', async () => {
    render(<GitHubWriteAccessPanel />)
    const title = await screen.findByLabelText('Issue title')
    const body = screen.getByLabelText('Issue body (optional)')
    const confirmation = screen.getByLabelText(/I reviewed this issue and confirm creation in owner\/repository-a/)

    fireEvent.change(title, { target: { value: 'Initial title' } })
    fireEvent.click(confirmation)
    expect(confirmation).toBeChecked()

    fireEvent.change(title, { target: { value: 'Updated title' } })
    expect(confirmation).not.toBeChecked()

    fireEvent.click(confirmation)
    expect(confirmation).toBeChecked()

    fireEvent.change(body, { target: { value: 'Updated body' } })
    expect(confirmation).not.toBeChecked()
  })

  it('disables issue creation when title or body exceed UTF-8 byte limits', async () => {
    render(<GitHubWriteAccessPanel />)
    const title = await screen.findByLabelText('Issue title')
    const body = screen.getByLabelText('Issue body (optional)')
    const confirmation = screen.getByLabelText(/I reviewed this issue and confirm creation in owner\/repository-a/)
    const createButton = screen.getByRole('button', { name: 'Create GitHub issue' })

    fireEvent.change(title, { target: { value: 'a' } })
    fireEvent.click(confirmation)
    expect(createButton).toBeEnabled()

    fireEvent.change(title, { target: { value: '🙂'.repeat(70) } })
    expect(createButton).toBeDisabled()

    fireEvent.change(title, { target: { value: 'Valid title' } })
    fireEvent.click(confirmation)
    fireEvent.change(body, { target: { value: '€'.repeat(6000) } })
    expect(createButton).toBeDisabled()
  })

  it('disables issue creation for a whitespace-only title', async () => {
    render(<GitHubWriteAccessPanel />)
    const title = await screen.findByLabelText('Issue title')
    const confirmation = screen.getByLabelText(/I reviewed this issue and confirm creation in owner\/repository-a/)
    const createButton = screen.getByRole('button', { name: 'Create GitHub issue' })

    fireEvent.change(title, { target: { value: '   ' } })
    fireEvent.click(confirmation)

    expect(createButton).toBeDisabled()
  })

  it('clears issue confirmation after disconnecting the selected connection', async () => {
    render(<GitHubWriteAccessPanel />)
    const title = await screen.findByLabelText('Issue title')
    const confirmation = screen.getByLabelText(/I reviewed this issue and confirm creation in owner\/repository-a/)

    fireEvent.change(title, { target: { value: 'Issue title' } })
    fireEvent.click(confirmation)
    expect(confirmation).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))

    await waitFor(() => {
      expect(disconnectGitHubWriteConnection).toHaveBeenCalledTimes(1)
      expect(screen.getByLabelText(/I reviewed this issue and confirm creation in owner\/repository-a/)).not.toBeChecked()
    })
  })

  it('selects a newly connected repository after its refresh completes', async () => {
    const existingConnection = {
      id: '00000000-0000-4000-8000-000000000001',
      repositoryFullName: 'owner/repository-a',
      allowedActions: ['create_issue'] as ['create_issue'],
      authorizationExpiresAt: '2026-08-26T00:00:00.000Z',
      connectedAt: '2026-08-25T00:00:00.000Z',
      lastUsedAt: null,
    }
    const newConnection = {
      id: '00000000-0000-4000-8000-000000000003',
      repositoryFullName: 'owner/repository-b',
      allowedActions: ['create_issue'] as ['create_issue'],
      authorizationExpiresAt: '2026-08-26T00:00:00.000Z',
      connectedAt: '2026-08-26T00:00:00.000Z',
      lastUsedAt: null,
    }
    type Connection = typeof existingConnection
    let resolveRefresh: ((value: { ok: true; data: { connections: Connection[] } }) => void) | null = null
    getGitHubWriteConnections
      .mockResolvedValueOnce({ ok: true, data: { connections: [existingConnection] } })
      .mockReturnValueOnce(new Promise<{ ok: true; data: { connections: Connection[] } }>(resolve => {
        resolveRefresh = resolve
      }))
    connectGitHubWriteRepository.mockResolvedValue({ ok: true, data: { connection: newConnection } })

    render(<GitHubWriteAccessPanel />)
    const repository = await screen.findByLabelText('Eligible GitHub repository')
    fireEvent.change(repository, { target: { value: '2' } })
    fireEvent.click(screen.getByLabelText(/I authorize issue creation only for owner\/repository-b/))
    fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }))

    await waitFor(() => expect(connectGitHubWriteRepository).toHaveBeenCalledTimes(1))
    resolveRefresh?.({ ok: true, data: { connections: [newConnection, existingConnection] } })

    await waitFor(() => {
      expect(screen.getByLabelText('Connected repository')).toHaveValue(newConnection.id)
    })
  })

  it('clears attempt key and confirmation after IDEMPOTENCY_CONFLICT so reconfirmation creates a fresh key', async () => {
    createGitHubIssue
      .mockResolvedValueOnce({ ok: false, code: 'IDEMPOTENCY_CONFLICT' })
      .mockResolvedValue({ ok: true, data: { issueNumber: 1, issueUrl: 'https://github.com/owner/repository-a/issues/1' } })

    render(<GitHubWriteAccessPanel />)
    const title = await screen.findByLabelText('Issue title')
    const confirmation = screen.getByLabelText(/I reviewed this issue and confirm creation in owner\/repository-a/)

    fireEvent.change(title, { target: { value: 'Issue title' } })
    fireEvent.click(confirmation)
    fireEvent.click(screen.getByRole('button', { name: 'Create GitHub issue' }))
    await waitFor(() => expect(createGitHubIssue).toHaveBeenCalledTimes(1))
    const firstKey = createGitHubIssue.mock.calls[0][0].idempotencyKey

    // After IDEMPOTENCY_CONFLICT, confirmation is cleared so the user must re-confirm
    await waitFor(() => expect(confirmation).not.toBeChecked())

    // Re-confirm to enable the button
    fireEvent.click(confirmation)
    fireEvent.click(screen.getByRole('button', { name: 'Create GitHub issue' }))
    await waitFor(() => expect(createGitHubIssue).toHaveBeenCalledTimes(2))

    // A fresh idempotency key must be used on the retry
    expect(createGitHubIssue.mock.calls[1][0].idempotencyKey).not.toBe(firstKey)
  })

  it('refreshes connections and resets attempt on WRITE_NOT_CONFIRMED so stale repository name is not resubmitted', async () => {
    const updatedConnection = {
      id: '00000000-0000-4000-8000-000000000001',
      repositoryFullName: 'owner/repository-a-renamed',
      allowedActions: ['create_issue'] as ['create_issue'],
      authorizationExpiresAt: '2026-08-26T00:00:00.000Z',
      connectedAt: '2026-08-25T00:00:00.000Z',
      lastUsedAt: null,
    }
    createGitHubIssue.mockResolvedValueOnce({ ok: false, code: 'WRITE_NOT_CONFIRMED' })
    getGitHubWriteConnections
      .mockResolvedValueOnce({ ok: true, data: { connections: [{
        id: '00000000-0000-4000-8000-000000000001',
        repositoryFullName: 'owner/repository-a',
        allowedActions: ['create_issue'],
        authorizationExpiresAt: '2026-08-26T00:00:00.000Z',
        connectedAt: '2026-08-25T00:00:00.000Z',
        lastUsedAt: null,
      }] } })
      .mockResolvedValue({ ok: true, data: { connections: [updatedConnection] } })

    render(<GitHubWriteAccessPanel />)
    const title = await screen.findByLabelText('Issue title')
    const confirmation = screen.getByLabelText(/I reviewed this issue and confirm creation in owner\/repository-a/)

    fireEvent.change(title, { target: { value: 'Test issue' } })
    fireEvent.click(confirmation)
    fireEvent.click(screen.getByRole('button', { name: 'Create GitHub issue' }))
    await waitFor(() => expect(createGitHubIssue).toHaveBeenCalledTimes(1))
    const firstKey = createGitHubIssue.mock.calls[0][0].idempotencyKey

    // Confirmation is cleared and connections are refreshed with the renamed repo
    await waitFor(() => expect(confirmation).not.toBeChecked())
    await waitFor(() => expect(getGitHubWriteConnections).toHaveBeenCalledTimes(2))

    // Re-confirm and submit — a fresh key must be used, not the stale one
    fireEvent.click(screen.getByLabelText(/I reviewed this issue and confirm creation in owner\/repository-a-renamed/))
    fireEvent.click(screen.getByRole('button', { name: 'Create GitHub issue' }))
    await waitFor(() => expect(createGitHubIssue).toHaveBeenCalledTimes(2))
    expect(createGitHubIssue.mock.calls[1][0].idempotencyKey).not.toBe(firstKey)
  })
})
