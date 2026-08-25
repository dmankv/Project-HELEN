/**
 * Daemon Learning Integration
 * Bridges TypeScript implementation with Python learning algorithm
 */

import { LEGACY_STORAGE_KEYS, loadMigratedStorageItem, genUUID } from './daemonStorageMigration'

export interface LearningMetadata {
  intent: string
  confidence: number
  ambiguity: number
  memoryUsed: number
  planComplexity: 'simple' | 'moderate' | 'complex'
  timestamp: Date
  /**
   * Approved response strategy used for this turn (see daemonResponsePolicy).
   * Recorded so later thumbs-up/down feedback can be attributed to the
   * strategy that actually produced the response.
   */
  strategy?: string
  /** (intent, mood) context key the strategy was selected for. */
  contextKey?: string
  /** Where the turn was routed (see daemonCapabilityRouter). */
  routingMode?: string
  /** Why it was routed there. */
  routingReason?: string
}

export interface InteractionRecord {
  id: string
  input: string
  response: string
  metadata: LearningMetadata
  feedback?: {
    rating: 'helpful' | 'neutral' | 'unhelpful'
    comment?: string
    timestamp: Date
  }
}

// Stored shape for localStorage (timestamps as ISO strings)
interface StoredRecord {
  id: string
  input: string
  response: string
  metadata: Omit<LearningMetadata, 'timestamp'> & { timestamp: string }
  feedback?: {
    rating: 'helpful' | 'neutral' | 'unhelpful'
    comment?: string
    timestamp: string
  }
}

interface StoredStats {
  totalInteractions: number
  successfulResponses: number
  learningCycles: number
  policyVersion: number
}

const STORAGE_KEY = 'daemon_learning_data'
const MAX_HISTORY = 200 // bound history to keep UI responsive

function loadFromStorage(): { history: InteractionRecord[]; stats: StoredStats } {
  try {
    const raw = loadMigratedStorageItem(STORAGE_KEY, LEGACY_STORAGE_KEYS.learningData)
    if (!raw) return { history: [], stats: { totalInteractions: 0, successfulResponses: 0, learningCycles: 0, policyVersion: 1 } }
    const parsed = JSON.parse(raw) as { history: StoredRecord[]; stats: StoredStats }
    const history: InteractionRecord[] = (parsed.history || []).map(r => ({
      ...r,
      metadata: { ...r.metadata, timestamp: new Date(r.metadata.timestamp) },
      feedback: r.feedback ? { ...r.feedback, timestamp: new Date(r.feedback.timestamp) } : undefined
    }))
    return { history, stats: parsed.stats || { totalInteractions: 0, successfulResponses: 0, learningCycles: 0, policyVersion: 1 } }
  } catch {
    return { history: [], stats: { totalInteractions: 0, successfulResponses: 0, learningCycles: 0, policyVersion: 1 } }
  }
}

export class DaemonLearningSystem {
  private interactionHistory: InteractionRecord[]
  private agentStats: StoredStats

  constructor() {
    const loaded = loadFromStorage()
    this.interactionHistory = loaded.history
    this.agentStats = loaded.stats
  }

  private persist(): void {
    try {
      const trimmed = this.interactionHistory.slice(-MAX_HISTORY)
      this.interactionHistory = trimmed
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ history: trimmed, stats: this.agentStats }))
    } catch {
      // localStorage may be unavailable (e.g. private browsing quota exceeded)
    }
  }

  /**
   * Record an interaction with full metadata for learning
   */
  recordInteraction(
    input: string,
    response: string,
    metadata: LearningMetadata
  ): InteractionRecord {
    const record: InteractionRecord = {
      id: this.generateInteractionId(),
      input,
      response,
      metadata
    }

    this.interactionHistory.push(record)
    this.agentStats.totalInteractions++
    this.persist()

    return record
  }

  /**
   * Process feedback and immediately update interaction + success metrics
   */
  processFeedback(
    interactionId: string,
    rating: 'helpful' | 'neutral' | 'unhelpful',
    comment?: string
  ): void {
    const interaction = this.interactionHistory.find(i => i.id === interactionId)
    if (!interaction) return

    // Remove any existing feedback contribution before re-applying
    if (interaction.feedback?.rating === 'helpful') {
      this.agentStats.successfulResponses = Math.max(0, this.agentStats.successfulResponses - 1)
    }

    interaction.feedback = {
      rating,
      comment,
      timestamp: new Date()
    }

    if (rating === 'helpful') {
      this.agentStats.successfulResponses++
    }

    this.agentStats.learningCycles++
    this.agentStats.policyVersion++
    this.persist()
  }

  /**
   * Get learning insights — deterministic values derived from stored data
   */
  getLearningInsights() {
    const rated = this.interactionHistory.filter(i => i.feedback)
    const helpfulCount = rated.filter(i => i.feedback?.rating === 'helpful').length
    return {
      totalInteractions: this.interactionHistory.length,
      // Success rate based only on rated interactions; 0 until feedback exists
      successRate: rated.length > 0 ? helpfulCount / rated.length : 0,
      averageConfidence: this.calculateAverageConfidence(),
      commonIntents: this.getCommonIntents(),
      complexityDistribution: this.getComplexityDistribution(),
      learningCycles: this.agentStats.learningCycles,
      policyVersion: this.agentStats.policyVersion
    }
  }

  /**
   * Get pending interactions awaiting feedback.
   */
  getPendingLearning(): InteractionRecord[] {
    return this.interactionHistory.filter(i => !i.feedback)
  }

  /**
   * Calculate average confidence score
   */
  private calculateAverageConfidence(): number {
    if (this.interactionHistory.length === 0) return 0
    const sum = this.interactionHistory.reduce(
      (acc, i) => acc + i.metadata.confidence,
      0
    )
    return sum / this.interactionHistory.length
  }

  /**
   * Get most common intents
   */
  private getCommonIntents(): Record<string, number> {
    const intents: Record<string, number> = {}
    this.interactionHistory.forEach(i => {
      intents[i.metadata.intent] = (intents[i.metadata.intent] || 0) + 1
    })
    return intents
  }

  /**
   * Get distribution of task complexity
   */
  private getComplexityDistribution(): Record<string, number> {
    const complexity: Record<string, number> = { simple: 0, moderate: 0, complex: 0 }
    this.interactionHistory.forEach(i => {
      complexity[i.metadata.planComplexity]++
    })
    return complexity
  }

  /**
   * Export learning data for analysis.
   */
  exportLearningData(): string {
    return JSON.stringify({
      interactions: this.interactionHistory,
      stats: this.agentStats,
      insights: this.getLearningInsights()
    }, null, 2)
  }

  /**
   * Clear learning data
   */
  clearHistory(): void {
    this.interactionHistory = []
    this.agentStats = { totalInteractions: 0, successfulResponses: 0, learningCycles: 0, policyVersion: 1 }
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  }

  private generateInteractionId(): string {
    return genUUID()
  }
}

export default new DaemonLearningSystem()
