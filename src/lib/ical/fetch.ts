const DEFAULT_PROXY = 'https://api.allorigins.win/raw?url='
const PROXY_KEY = 'life-os:cors-proxy'

function getProxyUrl(): string {
  return localStorage.getItem(PROXY_KEY) || DEFAULT_PROXY
}

export async function fetchICalText(url: string): Promise<string> {
  const proxy = getProxyUrl()
  const fetchUrl = `${proxy}${encodeURIComponent(url)}`
  const response = await fetch(fetchUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch iCal feed: ${response.status}`)
  }
  return response.text()
}
