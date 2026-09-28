export const DURABLE_LEARNING_SOURCES = Object.freeze([
  'user-confirmed',
  'all-father-approved',
  'sandbox-success',
  'validated-insight',
] as const)

export type DurableLearningSource = typeof DURABLE_LEARNING_SOURCES[number]

export interface LearningItemInput {
  text: string
  source: DurableLearningSource | string
  confidence: number
  createdAt: string
}

export type LearningDecisionCode =
  | 'accepted'
  | 'rejected-empty'
  | 'rejected-source'
  | 'rejected-confidence'
  | 'rejected-too-long'
  | 'rejected-secret'
  | 'rejected-sensitive'

export interface LearningDecision {
  accepted: boolean
  code: LearningDecisionCode
  reason: string
  source?: DurableLearningSource
}

export const VALIDATED_LEARNING_MAX_TEXT_LENGTH = 600
export const VALIDATED_LEARNING_MIN_CONFIDENCE = 0.45

const SECRET_PATTERNS = [
  /\b(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret(?:_key)?)\b\s*(?:is|=|:)\s*['"]?[^\s'"]{4,}/i,
  /\b(?:ghp_|github_pat_|sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
] as const

const SENSITIVE_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b(?:passport|passport number|passport no\.?)\b/i,
  /\b(?:medical record|mrn)\b/i,
] as const

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '')
}

function isLikelyCardNumber(text: string): boolean {
  const candidates = text.match(/\b(?:\d[ -]*?){13,19}\b/g) ?? []
  return candidates.some(candidate => {
    const digits = digitsOnly(candidate)
    return digits.length >= 13 && digits.length <= 19
  })
}

export function isLikelySecretLearningText(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text))
}

export function isLikelySensitiveLearningText(text: string): boolean {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(text)) || isLikelyCardNumber(text)
}

function isDurableLearningSource(value: string): value is DurableLearningSource {
  return (DURABLE_LEARNING_SOURCES as readonly string[]).includes(value)
}

export function acceptLearningItem(input: LearningItemInput): LearningDecision {
  const normalized = input.text.trim()
  if (!normalized) {
    return { accepted: false, code: 'rejected-empty', reason: 'Learning text must not be empty.' }
  }
  if (!isDurableLearningSource(input.source)) {
    return { accepted: false, code: 'rejected-source', reason: 'Learning source is not in the validated allowlist.' }
  }
  if (!Number.isFinite(input.confidence) || input.confidence < VALIDATED_LEARNING_MIN_CONFIDENCE) {
    return { accepted: false, code: 'rejected-confidence', reason: 'Learning confidence did not meet the minimum threshold.' }
  }
  if (normalized.length > VALIDATED_LEARNING_MAX_TEXT_LENGTH) {
    return { accepted: false, code: 'rejected-too-long', reason: 'Learning text exceeds the bounded length limit.' }
  }
  if (isLikelySecretLearningText(normalized)) {
    return { accepted: false, code: 'rejected-secret', reason: 'Learning text appears to contain secret material.' }
  }
  if (isLikelySensitiveLearningText(normalized)) {
    return { accepted: false, code: 'rejected-sensitive', reason: 'Learning text appears to contain sensitive personal identifiers.' }
  }
  return {
    accepted: true,
    code: 'accepted',
    reason: 'Learning text accepted for validated durable-learning persistence.',
    source: input.source,
  }
}
