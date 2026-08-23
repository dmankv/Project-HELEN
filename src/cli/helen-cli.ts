#!/usr/bin/env node

"""Text-based CLI Interface for HELEN
A terminal-based conversational interface with dark theme.
"""

import * as readline from 'readline'
import HELEN from '../services/helen.js'
import HelenLearningSystem from '../services/helen_learning_integration.js'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> '
})

// ANSI Color codes for dark theme
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgBlack: '\x1b[40m',
  bgBlue: '\x1b[44m'
}

const SEPARATOR = colors.gray + '─'.repeat(80) + colors.reset
const DOUBLE_SEPARATOR = colors.gray + '═'.repeat(80) + colors.reset

interface SessionData {
  messageCount: number
  startTime: Date
  lastFeedbackId?: string
}

const session: SessionData = {
  messageCount: 0,
  startTime: new Date()
}

/**
 * Clear the screen and display header
 */
function clearScreen(): void {
  console.clear()
  displayHeader()
}

/**
 * Display the HELEN header
 */
function displayHeader(): void {
  console.log(colors.bright + colors.cyan)
  console.log('  ╔═══════════════════════════════════════════════════════════════════════════════╗')
  console.log('  ║                                                                               ║')
  console.log('  ║                  🤖  HELEN - Adaptive AI Assistant  🤖                        ║')
  console.log('  ║                                                                               ║')
  console.log('  ║              Your smart, learning AI with memory and planning                 ║')
  console.log('  ║                                                                               ║')
  console.log('  ╚═══════════════════════════════════════════════════════════════════════════════╝')
  console.log(colors.reset)
  console.log(colors.dim + colors.gray + '  Type your message and press Enter. Type "help" for commands.\n' + colors.reset)
}

/**
 * Display help information
 */
function displayHelp(): void {
  console.log('\n' + SEPARATOR)
  console.log(colors.bright + colors.yellow + '  AVAILABLE COMMANDS:' + colors.reset)
  console.log(SEPARATOR)
  console.log(colors.cyan + '  help' + colors.reset + '          - Show this help message')
  console.log(colors.cyan + '  stats' + colors.reset + '         - Show conversation statistics')
  console.log(colors.cyan + '  clear' + colors.reset + '         - Clear the screen')
  console.log(colors.cyan + '  memory' + colors.reset + '        - Show memory statistics')
  console.log(colors.cyan + '  feedback' + colors.reset + '      - Rate the last response (helpful/neutral/unhelpful)')
  console.log(colors.cyan + '  export' + colors.reset + '        - Export learning data')
  console.log(colors.cyan + '  exit' + colors.reset + '          - Exit HELEN')
  console.log(SEPARATOR + '\n')
}

/**
 * Display conversation statistics
 */
function displayStats(): void {
  const uptime = new Date().getTime() - session.startTime.getTime()
  const minutes = Math.floor(uptime / 60000)
  const seconds = Math.floor((uptime % 60000) / 1000)

  console.log('\n' + SEPARATOR)
  console.log(colors.bright + colors.blue + '  SESSION STATISTICS:' + colors.reset)
  console.log(SEPARATOR)
  console.log(colors.green + '  Messages processed:' + colors.reset + colors.bright + ` ${session.messageCount}` + colors.reset)
  console.log(colors.green + '  Session duration:' + colors.reset + colors.bright + ` ${minutes}m ${seconds}s` + colors.reset)
  console.log(colors.green + '  Start time:' + colors.reset + colors.bright + ` ${session.startTime.toLocaleString()}` + colors.reset)
  console.log(SEPARATOR + '\n')
}

/**
 * Display memory statistics
 */
function displayMemoryStats(): void {
  const stats = HELEN.getMemoryStats()
  const insights = HelenLearningSystem.getLearningInsights()

  console.log('\n' + SEPARATOR)
  console.log(colors.bright + colors.magenta + '  MEMORY & LEARNING STATISTICS:' + colors.reset)
  console.log(SEPARATOR)
  
  console.log(colors.cyan + '  Memory Store:' + colors.reset)
  Object.entries(stats).forEach(([key, value]) => {
    console.log(colors.dim + `    • ${key}: ${value}` + colors.reset)
  })

  console.log('\n' + colors.cyan + '  Learning Progress:' + colors.reset)
  console.log(colors.dim + `    • Total Interactions: ${insights.totalInteractions}` + colors.reset)
  console.log(colors.dim + `    • Success Rate: ${(insights.successRate * 100).toFixed(1)}%` + colors.reset)
  console.log(colors.dim + `    • Avg Confidence: ${(insights.averageConfidence * 100).toFixed(1)}%` + colors.reset)
  console.log(colors.dim + `    • Learning Cycles: ${insights.learningCycles}` + colors.reset)
  console.log(colors.dim + `    • Policy Version: ${insights.policyVersion}` + colors.reset)

  console.log('\n' + colors.cyan + '  Intent Distribution:' + colors.reset)
  Object.entries(insights.commonIntents).forEach(([intent, count]) => {
    console.log(colors.dim + `    • ${intent}: ${count}` + colors.reset)
  })
  
  console.log(SEPARATOR + '\n')
}

/**
 * Display user message
 */
function displayUserMessage(message: string): void {
  console.log('\n' + colors.bright + colors.white + '  YOU:' + colors.reset)
  console.log(colors.dim + colors.gray + `  "${message}"` + colors.reset)
}

/**
 * Display HELEN's response
 */
function displayHelenResponse(response: string, metadata: Record<string, any>): void {
  console.log('\n' + colors.bright + colors.cyan + '  HELEN:' + colors.reset)
  console.log(colors.green + `  ${response}` + colors.reset)
  
  if (metadata && Object.keys(metadata).length > 0) {
    console.log('\n' + colors.dim + colors.gray + '  [Processing Details]' + colors.reset)
    if (metadata.intent) {
      console.log(colors.dim + `  • Intent: ${metadata.intent}` + colors.reset)
    }
    if (metadata.confidence !== undefined) {
      console.log(colors.dim + `  • Confidence: ${(metadata.confidence * 100).toFixed(0)}%` + colors.reset)
    }
    if (metadata.ambiguity !== undefined) {
      console.log(colors.dim + `  • Ambiguity Level: ${(metadata.ambiguity * 100).toFixed(0)}%` + colors.reset)
    }
    if (metadata.memoryUsed) {
      console.log(colors.dim + `  • Memory Items Used: ${metadata.memoryUsed}` + colors.reset)
    }
  }
}

/**
 * Process feedback command
 */
function processFeedback(): void {
  if (!session.lastFeedbackId) {
    console.log('\n' + colors.yellow + '  ⚠️  No message to provide feedback for yet.' + colors.reset + '\n')
    return
  }

  const feedbackRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  console.log('\n' + colors.bright + colors.yellow + '  RATE THE LAST RESPONSE:' + colors.reset)
  console.log(colors.cyan + '  [1] 👍 Helpful' + colors.reset)
  console.log(colors.cyan + '  [2] ➖ Neutral' + colors.reset)
  console.log(colors.cyan + '  [3] 👎 Unhelpful' + colors.reset)

  feedbackRl.question(colors.bright + '  Your choice (1-3): ' + colors.reset, (choice) => {
    const ratingMap: Record<string, 'helpful' | 'neutral' | 'unhelpful'> = {
      '1': 'helpful',
      '2': 'neutral',
      '3': 'unhelpful'
    }

    if (ratingMap[choice]) {
      feedbackRl.question(colors.cyan + '  Add a comment (optional, press Enter to skip): ' + colors.reset, (comment) => {
        HELEN.recordFeedback(session.lastFeedbackId!, ratingMap[choice], comment || undefined)
        HelenLearningSystem.processFeedback(session.lastFeedbackId!, ratingMap[choice], comment || undefined)
        console.log('\n' + colors.green + '  ✓ Feedback recorded! HELEN learns from this.' + colors.reset + '\n')
        feedbackRl.close()
        rl.prompt()
      })
    } else {
      console.log('\n' + colors.yellow + '  ⚠️  Invalid choice. Please try again.' + colors.reset + '\n')
      feedbackRl.close()
      rl.prompt()
    }
  })
}

/**
 * Process user input
 */
async function processInput(input: string): Promise<void> {
  const trimmedInput = input.trim().toLowerCase()

  if (!trimmedInput) {
    rl.prompt()
    return
  }

  // Handle special commands
  switch (trimmedInput) {
    case 'help':
      displayHelp()
      rl.prompt()
      return
    case 'stats':
      displayStats()
      rl.prompt()
      return
    case 'memory':
      displayMemoryStats()
      rl.prompt()
      return
    case 'clear':
      clearScreen()
      rl.prompt()
      return
    case 'feedback':
      processFeedback()
      return
    case 'export':
      const exportData = HelenLearningSystem.exportLearningData()
      console.log('\n' + colors.green + '  Learning data exported:' + colors.reset)
      console.log(colors.dim + exportData + colors.reset + '\n')
      rl.prompt()
      return
    case 'exit':
    case 'quit':
      console.log('\n' + colors.bright + colors.cyan + '  Goodbye! HELEN will continue learning from our conversations.' + colors.reset + '\n')
      rl.close()
      process.exit(0)
  }

  // Regular user message
  session.messageCount++
  displayUserMessage(input)

  console.log(colors.dim + '  [HELEN is thinking...]' + colors.reset)

  try {
    const response = await HELEN.generateResponse(input)
    const metadata = {
      type: 'response',
      messageCount: session.messageCount
    }

    // Record interaction
    const record = HelenLearningSystem.recordInteraction(input, response, {
      intent: 'user-query',
      confidence: 0.8,
      ambiguity: 0.2,
      memoryUsed: 0,
      planComplexity: 'simple',
      timestamp: new Date()
    })
    session.lastFeedbackId = record.id

    displayHelenResponse(response, metadata)
    console.log(colors.dim + colors.gray + '\n  [Type "feedback" to rate this response]' + colors.reset)
  } catch (error) {
    console.log('\n' + colors.yellow + '  ⚠️  Error processing your message. Please try again.' + colors.reset)
    console.log(colors.dim + `  Error: ${error}` + colors.reset)
  }

  rl.prompt()
}

/**
 * Main initialization
 */
function initialize(): void {
  clearScreen()
  console.log(colors.dim + colors.gray + '\n  💡 Tip: Type "help" for available commands\n' + colors.reset)
  rl.prompt()
}

// Set up readline event handlers
rl.on('line', processInput)

rl.on('close', () => {
  console.log('\n' + colors.gray + '  Exiting HELEN...' + colors.reset + '\n')
  process.exit(0)
})

rl.on('SIGINT', () => {
  console.log('\n' + colors.bright + colors.cyan + '  Goodbye! HELEN will continue learning.' + colors.reset + '\n')
  process.exit(0)
})

// Start the application
initialize()
