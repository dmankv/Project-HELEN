import type { DurableMemory } from '../services/daemonMemory'

interface MemoryManagementPanelProps {
  memories: DurableMemory[]
  onDelete: (id: string) => void
}

function formatCreatedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleDateString()
}

export default function MemoryManagementPanel({
  memories,
  onDelete,
}: MemoryManagementPanelProps) {
  return (
    <section className="memory-management-panel" aria-label="Manage durable memories">
      <div className="data-panel-heading">
        <div>
          <h2>Durable memories</h2>
          <p>Delete individual memories here, or use “forget all memories” in chat.</p>
        </div>
        <span className="memory-count" aria-label={`${memories.length} durable memories`}>
          {memories.length}
        </span>
      </div>
      {memories.length === 0 ? (
        <p className="data-panel-empty">No durable memories saved.</p>
      ) : (
        <ul className="memory-management-list">
          {memories.map(memory => (
            <li key={memory.id} className="memory-management-item">
              <div>
                <p className="memory-management-text">{memory.text}</p>
                <p className="memory-management-meta">
                  Saved {formatCreatedAt(memory.createdAt)}
                  {memory.tags?.length ? ` · ${memory.tags.join(', ')}` : ''}
                </p>
              </div>
              <button
                type="button"
                className="memory-delete-btn"
                onClick={() => onDelete(memory.id)}
                aria-label={`Forget memory: ${memory.text} (saved ${formatCreatedAt(memory.createdAt)})`}
                title="Forget this memory"
              >
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
