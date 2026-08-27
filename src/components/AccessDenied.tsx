/**
 * Access denied page — shown for #/admin-daemon when the user is:
 *   - anonymous (not signed in), or
 *   - authenticated but not an admin.
 *
 * Does not disclose whether an admin section exists or what it does.
 */

import type { AuthUser } from '../services/daemonAuthAPI'

interface AccessDeniedProps {
  currentUser: AuthUser | null
  onLoginClick: () => void
  onBackToPublic: () => void
}

export default function AccessDenied({
  currentUser,
  onLoginClick,
  onBackToPublic,
}: AccessDeniedProps): JSX.Element {
  const isAnonymous = currentUser === null

  return (
    <main
      role="main"
      aria-labelledby="access-denied-heading"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '2rem',
        fontFamily: 'inherit',
        textAlign: 'center',
        gap: '1rem',
      }}
    >
      <h1
        id="access-denied-heading"
        style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}
      >
        {isAnonymous ? 'Sign in required' : 'Access denied'}
      </h1>

      {isAnonymous ? (
        <p style={{ color: '#666', maxWidth: 360 }}>
          Please sign in to continue.
        </p>
      ) : (
        <p style={{ color: '#666', maxWidth: 360 }}>
          You do not have permission to access this page.
        </p>
      )}

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        {isAnonymous && (
          <button
            type="button"
            onClick={onLoginClick}
            style={{
              padding: '0.6rem 1.4rem',
              borderRadius: '6px',
              border: '1px solid #333',
              background: '#333',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '0.95rem',
            }}
          >
            Sign in
          </button>
        )}
        <button
          type="button"
          onClick={onBackToPublic}
          style={{
            padding: '0.6rem 1.4rem',
            borderRadius: '6px',
            border: '1px solid #ccc',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: '0.95rem',
          }}
        >
          Back to Daemon
        </button>
      </div>
    </main>
  )
}
