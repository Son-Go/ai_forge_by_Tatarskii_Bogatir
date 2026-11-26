import { useEffect, useState } from 'react'

export type AppRoute = { section: 'chat' | 'manager'; caseId: string | null }
export function parseAppRoute(hash: string): AppRoute {
  const match = /^#\/manager(?:\/(DEMO-[A-Z0-9-]+))?$/.exec(hash)
  return match ? { section: 'manager', caseId: match[1] || null } : { section: 'chat', caseId: null }
}

// Hash navigation works with the existing static hosting, without new dependencies.
// Once opened, the client workspace stays mounted to preserve drafts and active SSE.
export function useAppRoute() {
  const [state, setState] = useState(() => {
    const route = parseAppRoute(window.location.hash)
    return { route, chatVisited: route.section === 'chat' }
  })
  useEffect(() => {
    const navigate = () => {
      const route = parseAppRoute(window.location.hash)
      // A skip-link fragment changes focus, not the selected application section.
      if (['#manager-workspace', '#consultant-workspace'].includes(window.location.hash)) return
      setState((previous) => ({ route, chatVisited: previous.chatVisited || route.section === 'chat' }))
    }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])
  return state
}
