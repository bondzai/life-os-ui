// Auto-resolve API URL: use the same hostname as the page so it works
// from both localhost and other devices on the network.
// VITE_API_URL can be a full URL or just a path (e.g. "/api" for Docker proxy).

// `/api` in both dev and production, which is why it is the default.
//
// In production one binary serves the UI and the API from one port, so the API is same-origin at
// `/api`. In dev the Vite proxy puts it at the same place. The old default was
// `http://localhost:3001/api`, which was right for exactly one case — the dev server without a
// proxy — and wrong for the one that matters: a production bundle built without `VITE_API_URL`
// set pointed every request at a port with nothing on it, and every page rendered its error state
// against a perfectly healthy server. See the `VITE_*` invariant in CLAUDE.md.
//
// Still overridable for the case it exists for: pointing a dev UI at an API on another host.
const configured = import.meta.env.VITE_API_URL || '/api'

function resolveApiUrl(): string {
  // If it's a relative path (e.g. "/api"), return as-is
  if (configured.startsWith('/')) return configured

  try {
    const url = new URL(configured)
    // Replace hostname with current page hostname so mobile devices work
    if (typeof window !== 'undefined' && url.hostname === 'localhost') {
      url.hostname = window.location.hostname
    }
    return url.origin + url.pathname.replace(/\/$/, '')
  } catch {
    return configured
  }
}

export const API_URL = resolveApiUrl()
