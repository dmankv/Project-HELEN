import type { RoutingMode } from './daemonCapabilityRouter'

export interface ResearchIntentMetadata {
  eligibleExplicitUrl: string | null
  source: 'current-user-message'
  authoritative: false
  searchDiscoveryEnabled: false
  shouldRequest: boolean
}

export function findExplicitResearchUrl(currentUserMessage: string): string | null {
  const match = currentUserMessage.match(/https:\/\/[^\s<>"'`]+/i)
  if (!match) return null
  const candidate = match[0].replace(/[),.;!?]+$/, '')
  if (candidate.length > 2_048) return null
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null
    if (url.port && url.port !== '443') return null
    return url.toString()
  } catch {
    return null
  }
}

export function buildResearchIntent(
  currentUserMessage: string,
  cognitiveMode: RoutingMode,
): ResearchIntentMetadata {
  const eligibleExplicitUrl = findExplicitResearchUrl(currentUserMessage)
  return {
    eligibleExplicitUrl,
    source: 'current-user-message',
    authoritative: false,
    searchDiscoveryEnabled: false,
    shouldRequest: cognitiveMode === 'research' && eligibleExplicitUrl !== null,
  }
}
