import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createGitHubIssue } = vi.hoisted(() => ({
  createGitHubIssue: vi.fn(),
}))

vi.mock('../src/services/githubWriteAccess', () => ({
  beginGitHubWriteAuthorization: vi.fn(),
  connectGitHubWriteRepository: vi.fn(),
  createGitHubIssue,
  disconnectGitHubWriteConnection: vi.fn(),
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
})
