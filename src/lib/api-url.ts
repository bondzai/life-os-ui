// Auto-resolve API URL: use the same hostname as the page so it works
// from both localhost and other devices on the network.
// VITE_API_URL can be a full URL or just a path (e.g. "/api" for Docker proxy).

const configured = import.meta.env.VITE_API_URL || 'http://localhost:3001/api'

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
