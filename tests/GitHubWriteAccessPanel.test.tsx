import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createGitHubIssue, disconnectGitHubWriteConnection } = vi.hoisted(() => ({
  createGitHubIssue: vi.fn(),
  disconnectGitHubWriteConnection: vi.fn(),
}))

vi.mock('../src/services/githubWriteAccess', () => ({
  beginGitHubWriteAuthorization: vi.fn(),
  connectGitHubWriteRepository: vi.fn(),
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
  getGitHubWriteConnections: vi.fn().mockResolvedValue({
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
  }),
  isGitHubWriteAccessConfigured: () => true,
}))

import GitHubWriteAccessPanel from '../src/components/GitHubWriteAccessPanel'

describe('GitHubWriteAccessPanel', () => {
  beforeEach(() => {
    createGitHubIssue.mockReset()
    createGitHubIssue.mockResolvedValue({ ok: false, code: 'GITHUB_UNAVAILABLE' })
    disconnectGitHubWriteConnection.mockReset()
    disconnectGitHubWriteConnection.mockResolvedValue({ ok: true, data: { disconnected: true } })
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
})
