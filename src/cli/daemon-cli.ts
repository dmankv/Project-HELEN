#!/usr/bin/env node

import readline from 'node:readline'
import { detectIntent, detectMood, generateHumanLikeResponse, type MemorySnippet, type ResponseIntent } from '../services/daemonResponseBrain.js'
import type { UserMood } from '../services/daemonResponseBrain.js'

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
}

interface SessionData {
  messageCount: number
  startTime: Date
  memories: MemorySnippet[]
  interactions: SessionInteraction[]
  lastIntent?: ResponseIntent
}

type FeedbackRating = 'helpful' | 'neutral' | 'unhelpful'

interface SessionInteraction {
  input: string
  response: string
  intent: ResponseIntent
  mood: UserMood
  timestamp: string
  feedback?: {
    rating: FeedbackRating
    comment?: string
    timestamp: string
  }
}

const session: SessionData = {
  messageCount: 0,
  startTime: new Date(),
  memories: [],
  interactions: [],
}

function displayHeader(): void {
  console.log(colors.bright + colors.cyan)
  console.log('  ╔═══════════════════════════════════════════════════════════════════════════════╗')
  console.log('  ║                                                                               ║')
  console.log('  ║                  🤖  Daemon - Local CLI Assistant  🤖                          ║')
  console.log('  ║                                                                               ║')
  console.log('  ║                     Type "help" for commands                                  ║')
  console.log('  ║                                                                               ║')
  console.log('  ╚═══════════════════════════════════════════════════════════════════════════════╝')
  console.log(colors.reset)
}

function displayHelp(): void {
  console.log('\nCommands:')
  console.log('  help                    Show this help')
  console.log('  stats                   Show session statistics')
  console.log('  clear                   Clear terminal screen')
  console.log('  exit / quit             Exit CLI')
  console.log('  remember this: <text>   Save temporary in-session memory')
  console.log('  what do you remember?   List in-session memories')
  console.log('  feedback: <rating>      Rate the latest unrated response')
  console.log('  analytics               Show session learning analytics')
  console.log('  export [all|learning|memories]  Print session data as JSON')
}

function formatDuration(durationMs: number): string {
  const minutes = Math.floor(durationMs / 60000)
  const seconds = Math.floor((durationMs % 60000) / 1000)
  return `${minutes}m ${seconds}s`
}

function displayStats(): void {
  const uptimeMs = Date.now() - session.startTime.getTime()
  console.log(`\nMessages: ${session.messageCount}`)
  console.log(`Memories: ${session.memories.length}`)
  console.log(`Uptime: ${formatDuration(uptimeMs)}`)
}

interface CommandResult {
  handled: boolean
  output?: string
  rawOutput?: boolean
}

function isFeedbackRating(value: string): value is FeedbackRating {
  return value === 'helpful' || value === 'neutral' || value === 'unhelpful'
}

function getLatestPendingInteraction(): SessionInteraction | undefined {
  for (let index = session.interactions.length - 1; index >= 0; index--) {
    const interaction = session.interactions[index]
    if (!interaction.feedback) return interaction
  }
  return undefined
}

function displayAnalytics(): string {
  const rated = session.interactions.filter(interaction => interaction.feedback)
  const helpful = rated.filter(interaction => interaction.feedback?.rating === 'helpful').length
  const neutral = rated.filter(interaction => interaction.feedback?.rating === 'neutral').length
  const unhelpful = rated.filter(interaction => interaction.feedback?.rating === 'unhelpful').length
  const successRate = rated.length > 0 ? Math.round((helpful / rated.length) * 100) : null
  const intentCounts = session.interactions.reduce<Record<string, number>>((counts, interaction) => {
    counts[interaction.intent] = (counts[interaction.intent] ?? 0) + 1
    return counts
  }, {})
  const intentSummary = Object.entries(intentCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([intent, count]) => `${intent} (${count})`)
    .join(', ')

  return [
    'Analytics',
    `Messages: ${session.messageCount}`,
    `Interactions: ${session.interactions.length}`,
    `Pending feedback: ${session.interactions.length - rated.length}`,
    `Helpful ratings: ${helpful}`,
    `Neutral ratings: ${neutral}`,
    `Not helpful ratings: ${unhelpful}`,
    `Helpful rate: ${successRate === null ? 'No ratings yet' : `${successRate}%`}`,
    `Top intents: ${intentSummary || 'No interactions yet'}`,
    `Uptime: ${formatDuration(Date.now() - session.startTime.getTime())}`,
  ].join('\n')
}

function exportSessionData(scope: 'all' | 'learning' | 'memories'): string {
  const base = {
    exportedAt: new Date().toISOString(),
    session: {
      startedAt: session.startTime.toISOString(),
      durationMs: Date.now() - session.startTime.getTime(),
      messageCount: session.messageCount,
    },
  }
  const data = scope === 'learning'
    ? {
        ...base,
        interactions: session.interactions,
        analytics: displayAnalytics(),
      }
    : scope === 'memories'
      ? {
          ...base,
          memories: session.memories,
        }
      : {
          ...base,
          memories: session.memories,
          interactions: session.interactions,
          analytics: displayAnalytics(),
        }
  return JSON.stringify(data, null, 2)
}

function commandResponse(input: string): CommandResult {
  const normalized = input.trim()
  const lowered = normalized.toLowerCase()
  if (!normalized) return { handled: true }

  if (lowered === 'help') {
    displayHelp()
    return { handled: true }
  }
  if (lowered === 'stats') {
    displayStats()
    return { handled: true }
  }
  if (lowered === 'clear') {
    if (process.stdout.isTTY) console.clear()
    displayHeader()
    return { handled: true }
  }
  if (lowered === 'what do you remember?' || lowered === 'memories') {
    if (session.memories.length === 0) return { handled: true, output: 'No in-session memories yet.' }
    return { handled: true, output: session.memories.map((m, i) => `${i + 1}. ${m.text}`).join('\n') }
  }
  if (lowered.startsWith('remember this:')) {
    const memoryText = normalized.slice('remember this:'.length).trim()
    if (!memoryText) return { handled: true, output: 'Please provide text after "remember this:".' }
    session.memories.push({ text: memoryText, timestamp: new Date(), relevance: Date.now() })
    return { handled: true, output: `Got it. I will remember: "${memoryText}"` }
  }
  const feedbackMatch = /^feedback(?:\s*:\s*|\s+)(.*)$/i.exec(normalized)
  if (lowered === 'feedback' || feedbackMatch) {
    const [ratingValue = '', ...commentParts] = (feedbackMatch?.[1] ?? '').trim().split(/\s+/)
    const rating = ratingValue.toLowerCase()
    if (!isFeedbackRating(rating)) {
      return { handled: true, output: 'Usage: feedback: <helpful|neutral|unhelpful> [optional note]' }
    }
    const interaction = getLatestPendingInteraction()
    if (!interaction) {
      return { handled: true, output: 'No unrated responses yet. Ask me something first.' }
    }
    const comment = commentParts.join(' ').trim()
    interaction.feedback = {
      rating,
      comment: comment || undefined,
      timestamp: new Date().toISOString(),
    }
    return { handled: true, output: `Recorded ${rating} feedback for the latest response.` }
  }
  if (lowered === 'analytics') {
    return { handled: true, output: displayAnalytics() }
  }
  if (lowered === 'export' || lowered.startsWith('export ')) {
    const scopeValue = lowered.slice('export'.length).trim()
    const scope = scopeValue === '' || scopeValue === 'all'
      ? 'all'
      : scopeValue === 'learning' || scopeValue === 'memories'
        ? scopeValue
        : null
    if (!scope) {
      return { handled: true, output: 'Usage: export [all|learning|memories]' }
    }
    return { handled: true, output: exportSessionData(scope), rawOutput: true }
  }
  return { handled: false }
}

function generateLocalReply(input: string): SessionInteraction {
  const previousIntent = session.lastIntent
  const mood = detectMood(input)
  const intent = detectIntent(input, previousIntent)
  session.lastIntent = intent
  const response = generateHumanLikeResponse(input, {
    userMessage: input,
    mood,
    intent,
    memories: session.memories.slice(-5),
    lastIntent: previousIntent,
  })
  return {
    input,
    response,
    intent,
    mood,
    timestamp: new Date().toISOString(),
  }
}

interface InputResult {
  output: string
  rawOutput?: boolean
}

function handleInput(input: string | null): InputResult | null {
  if (input === null) return null
  const command = commandResponse(input)
  if (command.handled) {
    return command.output
      ? { output: command.output, rawOutput: command.rawOutput }
      : null
  }
  const interaction = generateLocalReply(input)
  session.messageCount += 1
  session.interactions.push(interaction)
  return { output: interaction.response }
}

async function runNonInteractive(message?: string): Promise<void> {
  if (message) {
    const result = handleInput(message)
    if (result) console.log(result.output)
    return
  }

  const chunks: string[] = []
  for await (const chunk of process.stdin) chunks.push(String(chunk))
  const lines = chunks.join('').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length === 0) {
    console.log('No input provided. Use --help or run interactively.')
    return
  }
  for (const line of lines) {
    const result = handleInput(line)
    if (result) console.log(result.output)
  }
}

function parseMessageArg(argv: string[]): string | undefined {
  let messageValue: string | undefined
  let i = 0

  while (i < argv.length) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      displayHeader()
      displayHelp()
      process.exit(0)
    }

    if (arg === '--message' || arg === '-m') {
      if (messageValue !== undefined) {
        console.error(`Duplicate option: ${arg}`)
        console.error('Run with --help for usage.')
        process.exit(1)
      }
      const value = argv[i + 1]
      if (value === undefined) {
        console.error('Missing value for --message/-m.')
        console.error('Run with --help for usage.')
        process.exit(1)
      }
      messageValue = value
      i += 2
      continue
    }

    // Reject any unrecognised flag (long or short).
    if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`)
      console.error('Run with --help for usage.')
      process.exit(1)
    }

    // Reject unexpected positional arguments.
    console.error(`Unexpected argument: ${arg}`)
    console.error('Run with --help for usage.')
    process.exit(1)
  }

  return messageValue
}

async function runInteractive(): Promise<void> {
  displayHeader()
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: colors.bright + colors.white + '> ' + colors.reset,
  })

  rl.prompt()
  rl.on('line', line => {
    const trimmed = line.trim()
    if (!trimmed) {
      rl.prompt()
      return
    }
    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      console.log(colors.cyan + '\nGoodbye!\n' + colors.reset)
      rl.close()
      return
    }
    const result = handleInput(trimmed)
    if (result) {
      console.log(colors.dim + colors.gray + 'YOU: ' + colors.reset + trimmed)
      if (result.rawOutput) {
        console.log(result.output)
      } else {
        console.log(colors.bright + colors.green + 'Daemon: ' + colors.reset + result.output)
      }
    }
    rl.prompt()
  })
  rl.on('close', () => process.exit(0))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const messageArg = parseMessageArg(argv)
  const shouldRunNonInteractive = !process.stdin.isTTY || Boolean(messageArg)
  if (shouldRunNonInteractive) {
    await runNonInteractive(messageArg)
    return
  }
  await runInteractive()
}

void main()
