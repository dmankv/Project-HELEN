/**
 * HELEN Learning Integration
 * Bridges TypeScript implementation with Python learning algorithm
 */

import { Message } from '../components/HelenInterface'

export interface LearningMetadata {
  intent: string
  confidence: number
  ambiguity: number
  memoryUsed: number
  planComplexity: 'simple' | 'moderate' | 'complex'
  timestamp: Date
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

export class HelenLearningSystem {
  private interactionHistory: InteractionRecord[] = []
  private learningQueue: InteractionRecord[] = []
  private agentStats = {
    totalInteractions: 0,
    successfulResponses: 0,
    learningCycles: 0,
    policyVersion: 1
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
      metadata,
      timestamp: new Date()
    } as InteractionRecord

    this.interactionHistory.push(record)
    this.learningQueue.push(record)
    this.agentStats.totalInteractions++

    return record
  }

  /**
   * Process feedback and trigger learning
   */
  processFeedback(
    interactionId: string,
    rating: 'helpful' | 'neutral' | 'unhelpful',
    comment?: string
  ): void {
    const interaction = this.interactionHistory.find(i => i.id === interactionId)
    if (!interaction) return

    interaction.feedback = {
      rating,
      comment,
      timestamp: new Date()
    }

    // Trigger learning update
    this.updatePolicy(interaction)

    // Mark as processed
    this.learningQueue = this.learningQueue.filter(i => i.id !== interactionId)
  }

  /**
   * Update policy based on feedback outcome
   */
  private updatePolicy(interaction: InteractionRecord): void {
    if (!interaction.feedback) return

    const { rating } = interaction.feedback
    const { confidence, intent, planComplexity } = interaction.metadata

    // Update success metrics
    if (rating === 'helpful') {
      this.agentStats.successfulResponses++
    }

    // Calculate effectiveness score
    const effectivenessMap = {
      'helpful': 1.0,
      'neutral': 0.5,
      'unhelpful': 0.0
    }
    const effectiveness = effectivenessMap[rating]

    // Adjust confidence threshold if needed
    if (rating === 'unhelpful' && confidence > 0.6) {
      // Increase threshold to be more conservative
    } else if (rating === 'helpful' && confidence < 0.8) {
      // Decrease threshold to accept more responses
    }

    this.agentStats.learningCycles++
    this.agentStats.policyVersion++
  }

  /**
   * Get learning insights from interaction history
   */
  getLearningInsights() {
    const insights = {
      totalInteractions: this.interactionHistory.length,
      successRate: this.agentStats.totalInteractions > 0
        ? this.agentStats.successfulResponses / this.agentStats.totalInteractions
        : 0,
      averageConfidence: this.calculateAverageConfidence(),
      commonIntents: this.getCommonIntents(),
      complexityDistribution: this.getComplexityDistribution(),
      learningCycles: this.agentStats.learningCycles,
      policyVersion: this.agentStats.policyVersion
    }
    return insights
  }

  /**
   * Get pending interactions awaiting feedback
   */
  getPendingLearning(): InteractionRecord[] {
    return this.learningQueue
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
    const complexity: Record<string, number> = {
      simple: 0,
      moderate: 0,
      complex: 0
    }
    this.interactionHistory.forEach(i => {
      complexity[i.metadata.planComplexity]++
    })
    return complexity
  }

  /**
   * Export learning data for analysis
   */
  exportLearningData(): string {
    return JSON.stringify({
      interactions: this.interactionHistory,
      learningQueue: this.learningQueue,
      stats: this.agentStats,
      insights: this.getLearningInsights()
    }, null, 2)
  }

  /**
   * Clear learning data (for testing)
   */
  clearHistory(): void {
    this.interactionHistory = []
    this.learningQueue = []
  }

  private generateInteractionId(): string {
    return `interaction-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }
}

export default new HelenLearningSystem()
