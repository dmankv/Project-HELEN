import type { RoutingMode } from './daemonCapabilityRouter'

export interface ResearchIntentMetadata {
  eligibleExplicitUrl: string | null
  source: 'current-user-message'
  authoritative: false
  searchDiscoveryEnabled: false
  shouldRequest: boolean
}

export function findExplicitResearchUrl(currentUserMessage: string): string | null {
  for (const match of currentUserMessage.matchAll(/https:\/\/[^\s<>"'`]+/gi)) {
    const candidate = match[0].replace(/[),.;!?]+$/, '')
    if (candidate.length > 2_048) continue
    try {
      const url = new URL(candidate)
      if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) continue
      if (url.port && url.port !== '443') continue
      return url.toString()
    } catch {
      continue
    }
  }
  return null
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
