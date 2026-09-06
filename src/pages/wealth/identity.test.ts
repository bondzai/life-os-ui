import { describe, expect, it } from 'vitest'
import { chainAccent, chainLabel, chainMono, readableInk, tokenAccent, tokenMono } from './identity'

describe('chainLabel', () => {
  it('names the chains people actually name, not the API slug', () => {
    expect(chainLabel('bnb')).toBe('BNB Chain')
    expect(chainLabel('kucoin')).toBe('KuCoin')
    expect(chainLabel('hyperevm')).toBe('HyperEVM')
    expect(chainLabel('hyperliquid')).toBe('Hyperliquid')
    expect(chainLabel('off-chain')).toBe('Off-chain')
  })

  it('keeps the plain ones plain', () => {
    expect(chainLabel('ethereum')).toBe('Ethereum')
    expect(chainLabel('base')).toBe('Base')
    expect(chainLabel('bitcoin')).toBe('Bitcoin')
  })

  it('title-cases an unknown slug word by word rather than dropping it', () => {
    // A chain added to the Rust table before it is added here must still render as *something*.
    expect(chainLabel('zk_sync_era')).toBe('Zk Sync Era')
    expect(chainLabel('')).toBe('—')
  })

  it('is case-insensitive, because group keys are not always lowercased', () => {
    expect(chainLabel('BNB')).toBe('BNB Chain')
  })
})

describe('accents', () => {
  it('gives every chain and token a colour, known or not', () => {
    for (const chain of ['ethereum', 'bnb', 'off-chain', 'newchain']) {
      expect(chainAccent(chain)).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
    for (const symbol of ['BTC', 'USDC', 'SHIBGROK']) {
      expect(tokenAccent(symbol)).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  it('hashes an unknown symbol to a stable colour', () => {
    expect(tokenAccent('SHIBGROK')).toBe(tokenAccent('SHIBGROK'))
    expect(tokenAccent('shibgrok')).toBe(tokenAccent('SHIBGROK'))
  })

  it('reads a wrapper as the thing it wraps', () => {
    expect(tokenAccent('WBTC')).toBe(tokenAccent('BTC'))
    expect(tokenAccent('WETH')).toBe(tokenAccent('ETH'))
  })
})

describe('monograms', () => {
  it('collapses stablecoins to a dollar sign', () => {
    // USDC and USDT both truncate to "US", so initials would tell the reader nothing.
    expect(tokenMono('USDC')).toBe('$')
    expect(tokenMono('USDT')).toBe('$')
    expect(tokenMono('DAI')).toBe('$')
  })

  it('takes two letters otherwise', () => {
    expect(tokenMono('AERO')).toBe('AE')
    expect(tokenMono('hype')).toBe('HY')
  })

  it('falls back to two letters for an unlisted chain', () => {
    expect(chainMono('optimism')).toBe('OP')
    expect(chainMono('newchain')).toBe('NE')
  })
})

describe('readableInk', () => {
  it('keeps the brand-canonical white wherever it is still legible', () => {
    expect(readableInk('#FF0420')).toBe('#FFFFFF') // Optimism red
    expect(readableInk('#0052FF')).toBe('#FFFFFF') // Base blue
    expect(readableInk('#627EEA')).toBe('#FFFFFF') // Ethereum periwinkle
    expect(readableInk('#9945FF')).toBe('#FFFFFF') // Solana purple
  })

  it('flips to dark type on brands too light to carry it', () => {
    expect(readableInk('#F0B90B')).toBe('#18181B') // BNB yellow
    expect(readableInk('#97FCE4')).toBe('#18181B') // Hyperliquid mint
  })

  it('clears 3:1 against every accent it is asked about', () => {
    // Marks always sit beside the name in text, so they are decoration — but decoration that
    // renders as a smudge is still a bug.
    const contrast = (a: string, b: string) => {
      const lum = (hex: string) => {
        const channels = [1, 3, 5].map((i) => {
          const v = parseInt(hex.slice(i, i + 2), 16) / 255
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
      }
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    const accents = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche', 'hyperevm', 'hyperliquid', 'bitcoin', 'solana', 'kucoin', 'off-chain'].map(chainAccent)
    for (const accent of accents) {
      expect(contrast(accent, readableInk(accent))).toBeGreaterThanOrEqual(3)
    }
  })
})
