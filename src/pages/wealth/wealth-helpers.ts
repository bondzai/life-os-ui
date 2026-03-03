import type { Entity } from '@/core/types'

export const INCOME_CATEGORIES = ['salary', 'freelance', 'investment', 'other'] as const
export const EXPENSE_CATEGORIES = [
  'food',
  'transport',
  'utilities',
  'entertainment',
  'shopping',
  'health',
  'education',
  'other',
] as const
export const ACCOUNT_TYPES = ['checking', 'savings', 'credit', 'investment', 'cash'] as const

export const ASSET_CLASSES = ['crypto', 'defi', 'stock', 'fund', 'gold', 'property', 'other'] as const
export type AssetClass = (typeof ASSET_CLASSES)[number]

export const CRYPTO_CHAINS = ['bitcoin', 'ethereum', 'solana', 'bsc', 'polygon', 'other'] as const

export const WALLET_TYPES = ['cex', 'cold', 'hot', 'hardware'] as const
export type WalletType = (typeof WALLET_TYPES)[number]

export const CRYPTO_TX_ACTIONS = ['buy', 'sell', 'swap', 'transfer-in', 'transfer-out'] as const
export type CryptoTxAction = (typeof CRYPTO_TX_ACTIONS)[number]

const QUANTITY_CLASSES: AssetClass[] = ['crypto', 'stock', 'gold']

export function isQuantityBased(assetClass: AssetClass): boolean {
  return QUANTITY_CLASSES.includes(assetClass)
}

export function getAssetValue(asset: Entity): number {
  const cls = asset.metadata.assetClass as AssetClass
  if (isQuantityBased(cls)) {
    return ((asset.metadata.quantity as number) || 0) * ((asset.metadata.currentPrice as number) || 0)
  }
  return (asset.metadata.currentValue as number) || 0
}

export function getAssetCost(asset: Entity): number {
  const cls = asset.metadata.assetClass as AssetClass
  if (isQuantityBased(cls)) {
    return ((asset.metadata.quantity as number) || 0) * ((asset.metadata.costBasis as number) || 0)
  }
  return (asset.metadata.costValue as number) || 0
}

export function formatGain(cost: number, current: number): { amount: number; pct: number } {
  const amount = current - cost
  const pct = cost > 0 ? (amount / cost) * 100 : 0
  return { amount, pct }
}

const thbFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

export function formatTHB(amount: number): string {
  return `฿${thbFormatter.format(amount)}`
}

export function getCurrentMonthRange(): { start: string; end: string } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
  }
}

export function computeSpentByCategory(transactions: Entity[]): Record<string, number> {
  const { start, end } = getCurrentMonthRange()
  const result: Record<string, number> = {}
  for (const tx of transactions) {
    if (tx.metadata.txType !== 'expense') continue
    const date = (tx.metadata.date as string) || tx.dueDate || ''
    if (date < start || date > end) continue
    const cat = (tx.metadata.category as string) || 'other'
    result[cat] = (result[cat] || 0) + (tx.metadata.amount as number)
  }
  return result
}
