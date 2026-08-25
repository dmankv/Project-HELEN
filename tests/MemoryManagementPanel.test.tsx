import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MemoryManagementPanel from '../src/components/MemoryManagementPanel'

const memory = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  text: 'I prefer concise answers.',
  createdAt: '2026-08-25T00:00:00.000Z',
  tags: ['preferences'],
}

describe('MemoryManagementPanel', () => {
  it('renders durable memories and deletes the selected memory by id', () => {
    const onDelete = vi.fn()
    render(<MemoryManagementPanel memories={[memory]} onDelete={onDelete} />)

    expect(screen.getByText(memory.text)).toBeInTheDocument()
    expect(screen.getByText(/preferences/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Forget memory: I prefer concise answers\./i }))

    expect(onDelete).toHaveBeenCalledWith(memory.id)
  })

  it('shows an empty state when no durable memories exist', () => {
    render(<MemoryManagementPanel memories={[]} onDelete={vi.fn()} />)

    expect(screen.getByText(/No durable memories saved/i)).toBeInTheDocument()
  })
})
