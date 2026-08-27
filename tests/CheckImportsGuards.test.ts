import { describe, it, expect } from 'vitest'

import {
  evaluateMigrationCatalog,
  evaluateMigrationHistoryChanges,
  findLegacyPrefixedIdViolations,
} from './check-imports.mjs'

describe('check-imports guard helpers', () => {
  it('rejects invalid UTC migration timestamps', () => {
    const result = evaluateMigrationCatalog(['20260230010101_bad_day.sql'])
    expect(result.errors).toEqual([
      '20260230010101_bad_day.sql: contains invalid UTC timestamp prefix "20260230010101"',
    ])
  })

  it('rejects duplicate migration versions', () => {
    const result = evaluateMigrationCatalog([
      '20260825090000_adaptive_profiles.sql',
      '20260825090000_duplicate.sql',
    ])
    expect(result.errors).toEqual([
      'duplicate migration version 20260825090000: 20260825090000_adaptive_profiles.sql and 20260825090000_duplicate.sql',
    ])
  })

  it('rejects newly added migrations older than merge-base max', () => {
    const errors = evaluateMigrationHistoryChanges({
      baseVersions: new Map([
        ['20260825090000', '20260825090000_adaptive_profiles.sql'],
      ]),
      baseMaxVersion: '20260825090000',
      addedFiles: ['20260824000000_old.sql'],
      renamedFiles: [],
      deletedFiles: [],
    })

    expect(errors).toEqual([
      'migration 20260824000000_old.sql must be newer than current max 20260825090000',
    ])
  })

  it('rejects renamed existing migration files', () => {
    const errors = evaluateMigrationHistoryChanges({
      baseVersions: new Map(),
      baseMaxVersion: '20260825090000',
      addedFiles: [],
      renamedFiles: [
        {
          from: '20260825090000_adaptive_profiles.sql',
          to: '20260826000000_adaptive_profiles.sql',
        },
      ],
      deletedFiles: [],
    })

    expect(errors).toEqual([
      'renaming existing migration is not allowed: 20260825090000_adaptive_profiles.sql -> 20260826000000_adaptive_profiles.sql',
    ])
  })

  it('detects concatenated/template legacy prefixed IDs in executable source', () => {
    const violations = findLegacyPrefixedIdViolations(
      'src/components/Test.ts',
      [
        "const a = 'mem-' + value",
        'const b = `interaction-${record.id}`',
      ].join('\n'),
    )

    expect(violations.sort()).toEqual([
      "src/components/Test.ts: 'mem-' +",
      'src/components/Test.ts: `interaction-${record.id}`',
    ].sort())
  })

  it('ignores prefixed-ID examples inside comments and sanctioned migration service', () => {
    expect(findLegacyPrefixedIdViolations('src/components/Test.ts', '// const old = `daemon-${legacy}`')).toEqual([])
    expect(findLegacyPrefixedIdViolations('src/services/daemonStorageMigration.ts', "const old = 'mem-' + value")).toEqual([])
  })
})
