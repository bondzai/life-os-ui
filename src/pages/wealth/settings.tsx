/**
 * Wealth · Settings — what the book is made of.
 *
 * Wallets and off-chain assets: the two lists that decide every number on every other wealth
 * surface. Deliberately *not* the alert sweep, which lives on Wealth · Alerts — they were one
 * page called "Alerts", and nobody goes looking for "which wallets do I own" under a bell icon.
 */

import { OffChainAssets } from './off-chain'
import { WalletList } from './wallets'

export function WealthSettingsPage() {
  return (
    <div className="space-y-4">
      {/* Wallets first: it decides what every other number on every wealth page is counted from. */}
      <WalletList />
      <OffChainAssets />
    </div>
  )
}
