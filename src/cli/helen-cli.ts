#!/usr/bin/env node

import readline from 'node:readline'
import { detectIntent, detectMood, generateHumanLikeResponse, type MemorySnippet, type ResponseIntent } from '../services/helenResponseBrain.js'

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
  lastIntent?: ResponseIntent
}

const session: SessionData = {
  messageCount: 0,
  startTime: new Date(),
  memories: [],
}

function displayHeader(): void {
  console.log(colors.bright + colors.cyan)
  console.log('  ╔═══════════════════════════════════════════════════════════════════════════════╗')
  console.log('  ║                                                                               ║')
  console.log('  ║                  🤖  HELEN - Local CLI Assistant  🤖                          ║')
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
}

function displayStats(): void {
  const uptimeMs = Date.now() - session.startTime.getTime()
  const minutes = Math.floor(uptimeMs / 60000)
  const seconds = Math.floor((uptimeMs % 60000) / 1000)
  console.log(`\nMessages: ${session.messageCount}`)
  console.log(`Memories: ${session.memories.length}`)
  console.log(`Uptime: ${minutes}m ${seconds}s`)
}

interface CommandResult {
  handled: boolean
  output?: string
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
  return { handled: false }
}

function generateLocalReply(input: string): string {
  const previousIntent = session.lastIntent
  const mood = detectMood(input)
  const intent = detectIntent(input, previousIntent)
  session.lastIntent = intent
  return generateHumanLikeResponse(input, {
    userMessage: input,
    mood,
    intent,
    memories: session.memories.slice(-5),
    lastIntent: previousIntent,
  })
}

function handleInput(input: string | null): string | null {
  if (input === null) return null
  const command = commandResponse(input)
  if (command.handled) return command.output ?? null
  session.messageCount += 1
  return generateLocalReply(input)
}

async function runNonInteractive(message?: string): Promise<void> {
  if (message) {
    const response = handleInput(message)
    if (response) console.log(response)
    return
  }

  const chunks: string[] = []
  for await (const chunk of process.stdin) chunks.push(String(chunk))
  const input = chunks.join('').trim()
  if (!input) {
    console.log('No input provided. Use --help or run interactively.')
    return
  }
  const response = handleInput(input)
  if (response) console.log(response)
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
    const response = handleInput(trimmed)
    if (response) {
      console.log(colors.dim + colors.gray + 'YOU: ' + colors.reset + trimmed)
      console.log(colors.bright + colors.green + 'HELEN: ' + colors.reset + response)
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
