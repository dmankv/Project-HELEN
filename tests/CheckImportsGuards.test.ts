import { describe, it, expect } from 'vitest'

import {
  classifyMigrationDiff,
  evaluateMigrationCatalog,
  evaluateMigrationHistoryChanges,
  findLegacyPrefixedIdViolations,
  findProviderKeyViolations,
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
        'const b = `interaction-${record.id}-${suffix}`',
      ].join('\n'),
    )

    expect(violations.sort()).toEqual([
      "src/components/Test.ts: 'mem-' +",
      'src/components/Test.ts: `interaction-${record.id}-${suffix}`',
    ].sort())
  })

  it('ignores prefixed-ID examples inside comments and sanctioned migration service', () => {
    expect(findLegacyPrefixedIdViolations('src/components/Test.ts', '// const old = `daemon-${legacy}`')).toEqual([])
    expect(findLegacyPrefixedIdViolations('src/services/daemonStorageMigration.ts', "const old = 'mem-' + value")).toEqual([])
  })

  it('detects concatenated legacy prefixed IDs wrapped in parentheses or as-expressions', () => {
    expect(findLegacyPrefixedIdViolations('src/components/Test.ts', "const id = ('mem-') + value")).toEqual([
      "src/components/Test.ts: ('mem-') +",
    ])
    expect(findLegacyPrefixedIdViolations('src/components/Test.ts', "const id = ('mem-' as const) + value")).toEqual([
      "src/components/Test.ts: ('mem-' as const) +",
    ])
  })

  it('detects concatenated legacy prefixed IDs wrapped in satisfies or non-null expressions', () => {
    expect(findLegacyPrefixedIdViolations('src/components/Test.ts', "const id = ('mem-' satisfies string) + value")).toEqual([
      "src/components/Test.ts: ('mem-' satisfies string) +",
    ])
    expect(findLegacyPrefixedIdViolations('src/components/Test.ts', "const id = ('mem-'!) + value")).toEqual([
      "src/components/Test.ts: ('mem-'!) +",
    ])
  })

  it('detects prefixed IDs in template tails that contain //', () => {
    expect(findLegacyPrefixedIdViolations('src/components/Test.ts', 'const id = `mem-${value}//suffix`')).toEqual([
      'src/components/Test.ts: `mem-${value}//suffix`',
    ])
  })

  it('detects escaped legacy prefixed IDs in template heads', () => {
    expect(findLegacyPrefixedIdViolations('src/components/Test.ts', 'const id = `mem\\u002d${value}`')).toEqual([
      'src/components/Test.ts: `mem\\u002d${value}`',
    ])
  })

  it('detects legacy prefixed IDs in no-substitution templates', () => {
    expect(findLegacyPrefixedIdViolations('src/components/Test.ts', 'const id = `mem-literal`')).toEqual([
      'src/components/Test.ts: `mem-literal`',
    ])
  })

  it('detects provider key names in executable code and ignores actual comments', () => {
    expect(findProviderKeyViolations('src/components/Test.ts', 'const key = OPENAI_API_KEY')).toEqual([
      'src/components/Test.ts: OPENAI_API_KEY',
    ])
    expect(findProviderKeyViolations('src/components/Test.ts', 'const sample = "/* OPENAI_API_KEY */"')).toEqual([
      'src/components/Test.ts: OPENAI_API_KEY',
    ])
    expect(findProviderKeyViolations('src/components/Test.ts', 'const value = 1 // OPENAI_API_KEY is server-side only')).toEqual([])
  })

  it('detects provider keys in template tails that include //', () => {
    expect(findProviderKeyViolations('src/components/Test.ts', 'const key = `cfg-${value}//OPENAI_API_KEY`')).toEqual([
      'src/components/Test.ts: OPENAI_API_KEY',
    ])
  })

  it('detects provider keys in regular expression literals', () => {
    expect(findProviderKeyViolations('src/components/Test.ts', 'const matches = /OPENAI_API_KEY/.test(name)')).toEqual([
      'src/components/Test.ts: OPENAI_API_KEY',
    ])
  })

  it('classifies migration renames by full path and sql status', () => {
    const result = classifyMigrationDiff([
      'R100\tsupabase/migrations/20260825090000_adaptive_profiles.sql\tsupabase/migrations/archive/20260825090000_adaptive_profiles.sql',
      'R100\tsupabase/migrations/readme.txt\tsupabase/migrations/20260826000000_add_example_table.sql',
    ].join('\n'))

    expect(result).toEqual({
      addedFiles: ['20260826000000_add_example_table.sql'],
      renamedFiles: [
        {
          from: '20260825090000_adaptive_profiles.sql',
          to: 'archive/20260825090000_adaptive_profiles.sql',
        },
      ],
      deletedFiles: [],
      modifiedFiles: [],
    })
  })

  it('classifies modified migrations into modifiedFiles', () => {
    const result = classifyMigrationDiff(
      'M\tsupabase/migrations/20260825090000_adaptive_profiles.sql',
    )
    expect(result.modifiedFiles).toEqual(['20260825090000_adaptive_profiles.sql'])
    expect(result.addedFiles).toEqual([])
    expect(result.deletedFiles).toEqual([])
  })

  it('classifies type-only (T) migration changes into modifiedFiles', () => {
    const result = classifyMigrationDiff(
      'T\tsupabase/migrations/20260825090000_adaptive_profiles.sql',
    )
    expect(result.modifiedFiles).toEqual(['20260825090000_adaptive_profiles.sql'])
    expect(result.addedFiles).toEqual([])
    expect(result.deletedFiles).toEqual([])
  })

  it('rejects modified migrations as immutable-history violations', () => {
    const errors = evaluateMigrationHistoryChanges({
      baseVersions: new Map([['20260825090000', '20260825090000_adaptive_profiles.sql']]),
      baseMaxVersion: '20260825090000',
      addedFiles: [],
      renamedFiles: [],
      deletedFiles: [],
      modifiedFiles: ['20260825090000_adaptive_profiles.sql'],
    })
    expect(errors).toEqual([
      'modifying an existing migration is not allowed: 20260825090000_adaptive_profiles.sql',
    ])
  })
})
