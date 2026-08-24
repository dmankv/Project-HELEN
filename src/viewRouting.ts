export type AppView = 'chat' | 'login'

export function hashForView(view: AppView): string {
  return view === 'login' ? '#/login' : '#/'
}

export function viewFromHash(hash: string): AppView {
  return hash.toLowerCase().startsWith('#/login') ? 'login' : 'chat'
}
