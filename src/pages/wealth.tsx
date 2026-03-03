import { useState, useMemo } from 'react'
import { Plus, Wallet, TrendingUp, TrendingDown, Landmark, PieChart as PieChartIcon, Briefcase, HardDrive, ArrowLeftRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import {
  formatTHB,
  getCurrentMonthRange,
  computeSpentByCategory,
  INCOME_CATEGORIES,
  EXPENSE_CATEGORIES,
  ASSET_CLASSES,
  CRYPTO_TX_ACTIONS,
  getAssetValue,
  getAssetCost,
  formatGain,
  type AssetClass,
  type CryptoTxAction,
} from './wealth/wealth-helpers'
import { TransactionDialog, type TransactionFormValues } from './wealth/transaction-dialog'
import { BudgetDialog, type BudgetFormValues } from './wealth/budget-dialog'
import { AccountDialog, type AccountFormValues } from './wealth/account-dialog'
import { AssetDialog, type AssetFormValues } from './wealth/asset-dialog'
import { WalletDialog, type WalletFormValues } from './wealth/wallet-dialog'
import { CryptoTxDialog, type CryptoTxFormValues } from './wealth/crypto-tx-dialog'
import { TransactionTable } from './wealth/transaction-table'
import { BudgetCard } from './wealth/budget-card'
import { AccountCard } from './wealth/account-card'
import { AssetCard } from './wealth/asset-card'
import { WalletCard } from './wealth/wallet-card'
import { CryptoTxTable } from './wealth/crypto-tx-table'
import { SpendingChart } from './wealth/spending-chart'
import { AllocationChart } from './wealth/allocation-chart'
import type { Entity } from '@/core/types'

export function WealthPage() {
  const { items: transactions, create, update, remove } = useEntities('transaction')
  const { items: budgets, create: createBudget, update: updateBudget, remove: removeBudget } = useEntities('budget')
  const { items: accounts, create: createAccount, update: updateAccount, remove: removeAccount } = useEntities('account')
  const { items: assets, create: createAsset, update: updateAsset, remove: removeAsset } = useEntities('asset')
  const { items: wallets, create: createWallet, update: updateWallet, remove: removeWallet } = useEntities('wallet')
  const { items: cryptoTxs, create: createCryptoTx, update: updateCryptoTx, remove: removeCryptoTx } = useEntities('crypto-tx')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [tab, setTab] = useState('transactions')
  const [txTypeFilter, setTxTypeFilter] = useState<'all' | 'income' | 'expense'>('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [assetClassFilter, setAssetClassFilter] = useState('all')
  const [chainFilter, setChainFilter] = useState('all')
  const [protocolFilter, setProtocolFilter] = useState('all')
  const [cryptoTxActionFilter, setCryptoTxActionFilter] = useState('all')
  const [cryptoTxSymbolFilter, setCryptoTxSymbolFilter] = useState('all')

  // Dialogs
  const [txDialogOpen, setTxDialogOpen] = useState(false)
  const [budgetDialogOpen, setBudgetDialogOpen] = useState(false)
  const [accountDialogOpen, setAccountDialogOpen] = useState(false)
  const [assetDialogOpen, setAssetDialogOpen] = useState(false)
  const [walletDialogOpen, setWalletDialogOpen] = useState(false)
  const [cryptoTxDialogOpen, setCryptoTxDialogOpen] = useState(false)
  const [editingTx, setEditingTx] = useState<Entity | null>(null)
  const [editingBudget, setEditingBudget] = useState<Entity | null>(null)
  const [editingAccount, setEditingAccount] = useState<Entity | null>(null)
  const [editingAsset, setEditingAsset] = useState<Entity | null>(null)
  const [editingWallet, setEditingWallet] = useState<Entity | null>(null)
  const [editingCryptoTx, setEditingCryptoTx] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ entity: Entity; type: 'transaction' | 'budget' | 'account' | 'asset' | 'wallet' | 'crypto-tx' } | null>(null)

  // Summary stats
  const { start, end } = useMemo(() => getCurrentMonthRange(), [])

  const totalBalance = useMemo(
    () => accounts.reduce((sum, a) => sum + (a.metadata.balance as number), 0),
    [accounts],
  )

  const totalPortfolio = useMemo(
    () => assets.reduce((sum, a) => sum + getAssetValue(a), 0),
    [assets],
  )

  const netWorth = totalBalance + totalPortfolio

  const monthlyIncome = useMemo(
    () =>
      transactions
        .filter((tx) => {
          const date = (tx.metadata.date as string) || tx.dueDate || ''
          return tx.metadata.txType === 'income' && date >= start && date <= end
        })
        .reduce((sum, tx) => sum + (tx.metadata.amount as number), 0),
    [transactions, start, end],
  )

  const monthlyExpenses = useMemo(
    () =>
      transactions
        .filter((tx) => {
          const date = (tx.metadata.date as string) || tx.dueDate || ''
          return tx.metadata.txType === 'expense' && date >= start && date <= end
        })
        .reduce((sum, tx) => sum + (tx.metadata.amount as number), 0),
    [transactions, start, end],
  )

  // Filtered transactions
  const filteredTx = useMemo(() => {
    let result = transactions
    if (txTypeFilter !== 'all') {
      result = result.filter((tx) => tx.metadata.txType === txTypeFilter)
    }
    if (categoryFilter !== 'all') {
      result = result.filter((tx) => tx.metadata.category === categoryFilter)
    }
    return result.sort((a, b) => {
      const da = (a.metadata.date as string) || a.dueDate || ''
      const db = (b.metadata.date as string) || b.dueDate || ''
      return db.localeCompare(da)
    })
  }, [transactions, txTypeFilter, categoryFilter])

  // Derived chain/protocol lists for portfolio filters
  const uniqueChains = useMemo(
    () => [...new Set(assets.map((a) => a.metadata.chain as string).filter(Boolean))],
    [assets],
  )
  const uniqueProtocols = useMemo(
    () => [...new Set(assets.map((a) => a.metadata.protocol as string).filter(Boolean))],
    [assets],
  )

  // Filtered assets (class + chain + protocol)
  const filteredAssets = useMemo(() => {
    let result = assets
    if (assetClassFilter !== 'all') {
      result = result.filter((a) => a.metadata.assetClass === assetClassFilter)
    }
    if (chainFilter !== 'all') {
      result = result.filter((a) => a.metadata.chain === chainFilter)
    }
    if (protocolFilter !== 'all') {
      result = result.filter((a) => a.metadata.protocol === protocolFilter)
    }
    return result
  }, [assets, assetClassFilter, chainFilter, protocolFilter])

  // Filtered crypto txs
  const uniqueCryptoTxSymbols = useMemo(
    () => [...new Set(cryptoTxs.map((t) => t.metadata.symbol as string).filter(Boolean))],
    [cryptoTxs],
  )

  const filteredCryptoTxs = useMemo(() => {
    let result = cryptoTxs
    if (cryptoTxActionFilter !== 'all') {
      result = result.filter((t) => t.metadata.txAction === cryptoTxActionFilter)
    }
    if (cryptoTxSymbolFilter !== 'all') {
      result = result.filter((t) => t.metadata.symbol === cryptoTxSymbolFilter)
    }
    return result.sort((a, b) => {
      const da = (a.metadata.date as string) || ''
      const db = (b.metadata.date as string) || ''
      return db.localeCompare(da)
    })
  }, [cryptoTxs, cryptoTxActionFilter, cryptoTxSymbolFilter])

  // Portfolio allocation data
  const allocationData = useMemo(() => {
    const byClass: Record<string, number> = {}
    for (const asset of assets) {
      const cls = (asset.metadata.assetClass as string) || 'other'
      byClass[cls] = (byClass[cls] || 0) + getAssetValue(asset)
    }
    return Object.entries(byClass)
      .map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value)
  }, [assets])

  // Total unrealized gain
  const totalGain = useMemo(() => {
    const totalCost = assets.reduce((sum, a) => sum + getAssetCost(a), 0)
    return formatGain(totalCost, totalPortfolio)
  }, [assets, totalPortfolio])

  // Budget spending
  const spentByCategory = useMemo(() => computeSpentByCategory(transactions), [transactions])

  const chartData = useMemo(
    () =>
      Object.entries(spentByCategory)
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount),
    [spentByCategory],
  )

  // All categories for filter
  const allCategories = useMemo(() => {
    const cats = [...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES]
    return [...new Set(cats)]
  }, [])

  // Wallet map for resolving names
  const walletMap = useMemo(() => new Map(wallets.map((w) => [w.id, w.title])), [wallets])

  // CRUD handlers
  const handleCreateTx = (values: TransactionFormValues) => {
    create.mutate({
      id: crypto.randomUUID(),
      type: 'transaction',
      title: values.title,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        amount: values.amount,
        txType: values.txType,
        category: values.category,
        date: values.date,
        currency: 'THB',
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'shared',
      dueDate: values.date,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Transaction created', type: 'success' })
  }

  const handleEditTx = (values: TransactionFormValues) => {
    if (!editingTx) return
    update.mutate({
      id: editingTx.id,
      updates: {
        title: values.title,
        metadata: {
          ...editingTx.metadata,
          amount: values.amount,
          txType: values.txType,
          category: values.category,
          date: values.date,
        },
        dueDate: values.date,
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Transaction updated', type: 'success' })
    setEditingTx(null)
  }

  const handleCreateBudget = (values: BudgetFormValues) => {
    createBudget.mutate({
      id: crypto.randomUUID(),
      type: 'budget',
      title: values.title,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        amount: values.amount,
        category: values.category,
        period: 'monthly',
        currency: 'THB',
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'shared',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Budget created', type: 'success' })
  }

  const handleEditBudget = (values: BudgetFormValues) => {
    if (!editingBudget) return
    updateBudget.mutate({
      id: editingBudget.id,
      updates: {
        title: values.title,
        metadata: {
          ...editingBudget.metadata,
          amount: values.amount,
          category: values.category,
        },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Budget updated', type: 'success' })
    setEditingBudget(null)
  }

  const handleCreateAccount = (values: AccountFormValues) => {
    createAccount.mutate({
      id: crypto.randomUUID(),
      type: 'account',
      title: values.title,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        balance: values.balance,
        accountType: values.accountType,
        currency: 'THB',
        institution: values.institution || undefined,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Account created', type: 'success' })
  }

  const handleEditAccount = (values: AccountFormValues) => {
    if (!editingAccount) return
    updateAccount.mutate({
      id: editingAccount.id,
      updates: {
        title: values.title,
        metadata: {
          ...editingAccount.metadata,
          balance: values.balance,
          accountType: values.accountType,
          institution: values.institution || undefined,
        },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Account updated', type: 'success' })
    setEditingAccount(null)
  }

  const handleCreateAsset = (values: AssetFormValues) => {
    createAsset.mutate({
      id: crypto.randomUUID(),
      type: 'asset',
      title: values.title,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        assetClass: values.assetClass,
        symbol: values.symbol,
        quantity: values.quantity,
        costBasis: values.costBasis,
        currentPrice: values.currentPrice,
        costValue: values.costValue,
        currentValue: values.currentValue,
        chain: values.chain,
        protocol: values.protocol,
        platform: values.platform,
        walletId: values.walletId,
        currency: 'THB',
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Asset created', type: 'success' })
  }

  const handleEditAsset = (values: AssetFormValues) => {
    if (!editingAsset) return
    updateAsset.mutate({
      id: editingAsset.id,
      updates: {
        title: values.title,
        metadata: {
          ...editingAsset.metadata,
          assetClass: values.assetClass,
          symbol: values.symbol,
          quantity: values.quantity,
          costBasis: values.costBasis,
          currentPrice: values.currentPrice,
          costValue: values.costValue,
          currentValue: values.currentValue,
          chain: values.chain,
          protocol: values.protocol,
          platform: values.platform,
          walletId: values.walletId,
        },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Asset updated', type: 'success' })
    setEditingAsset(null)
  }

  const handleCreateWallet = (values: WalletFormValues) => {
    createWallet.mutate({
      id: crypto.randomUUID(),
      type: 'wallet',
      title: values.title,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        walletType: values.walletType,
        chain: values.chain,
        address: values.address,
        platform: values.platform,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Wallet created', type: 'success' })
  }

  const handleEditWallet = (values: WalletFormValues) => {
    if (!editingWallet) return
    updateWallet.mutate({
      id: editingWallet.id,
      updates: {
        title: values.title,
        metadata: {
          ...editingWallet.metadata,
          walletType: values.walletType,
          chain: values.chain,
          address: values.address,
          platform: values.platform,
        },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Wallet updated', type: 'success' })
    setEditingWallet(null)
  }

  const handleCreateCryptoTx = (values: CryptoTxFormValues) => {
    const qty = values.quantity
    const price = values.pricePerUnit
    createCryptoTx.mutate({
      id: crypto.randomUUID(),
      type: 'crypto-tx',
      title: `${values.txAction.toUpperCase()} ${values.symbol || ''}`.trim(),
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        txAction: values.txAction,
        symbol: values.symbol,
        quantity: qty,
        pricePerUnit: price,
        totalValue: qty && price ? qty * price : undefined,
        fee: values.fee,
        walletId: values.walletId,
        toWalletId: values.toWalletId,
        date: values.date,
        note: values.note,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Crypto transaction created', type: 'success' })
  }

  const handleEditCryptoTx = (values: CryptoTxFormValues) => {
    if (!editingCryptoTx) return
    const qty = values.quantity
    const price = values.pricePerUnit
    updateCryptoTx.mutate({
      id: editingCryptoTx.id,
      updates: {
        title: `${values.txAction.toUpperCase()} ${values.symbol || ''}`.trim(),
        metadata: {
          ...editingCryptoTx.metadata,
          txAction: values.txAction,
          symbol: values.symbol,
          quantity: qty,
          pricePerUnit: price,
          totalValue: qty && price ? qty * price : undefined,
          fee: values.fee,
          walletId: values.walletId,
          toWalletId: values.toWalletId,
          date: values.date,
          note: values.note,
        },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Crypto transaction updated', type: 'success' })
    setEditingCryptoTx(null)
  }

  const handleDelete = () => {
    if (!deleteTarget) return
    const { entity, type } = deleteTarget
    if (type === 'transaction') remove.mutate(entity.id)
    else if (type === 'budget') removeBudget.mutate(entity.id)
    else if (type === 'account') removeAccount.mutate(entity.id)
    else if (type === 'asset') removeAsset.mutate(entity.id)
    else if (type === 'wallet') removeWallet.mutate(entity.id)
    else if (type === 'crypto-tx') removeCryptoTx.mutate(entity.id)
    const label = type === 'crypto-tx' ? 'Crypto transaction' : type.charAt(0).toUpperCase() + type.slice(1)
    notify({ title: `${label} deleted`, type: 'success' })
    setDeleteTarget(null)
  }

  const addButton = (
    <Button
      size="sm"
      onClick={() => {
        if (tab === 'transactions') setTxDialogOpen(true)
        else if (tab === 'budgets') setBudgetDialogOpen(true)
        else if (tab === 'accounts') setAccountDialogOpen(true)
        else if (tab === 'portfolio') setAssetDialogOpen(true)
        else if (tab === 'wallets') setWalletDialogOpen(true)
        else if (tab === 'crypto-txs') setCryptoTxDialogOpen(true)
      }}
    >
      <Plus className="h-4 w-4 mr-1" /> Add
    </Button>
  )

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Net Worth</CardTitle>
            <Landmark className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatTHB(netWorth)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Cash</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatTHB(totalBalance)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Portfolio</CardTitle>
            <Briefcase className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatTHB(totalPortfolio)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Monthly P&L</CardTitle>
            {monthlyIncome - monthlyExpenses >= 0 ? (
              <TrendingUp className="h-4 w-4 text-green-500" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-500" />
            )}
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${monthlyIncome - monthlyExpenses >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {monthlyIncome - monthlyExpenses >= 0 ? '+' : ''}{formatTHB(monthlyIncome - monthlyExpenses)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <TabsList>
            <TabsTrigger value="transactions">Transactions</TabsTrigger>
            <TabsTrigger value="budgets">Budgets</TabsTrigger>
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
            <TabsTrigger value="portfolio">Portfolio</TabsTrigger>
            <TabsTrigger value="wallets">Wallets</TabsTrigger>
            <TabsTrigger value="crypto-txs">Crypto Txs</TabsTrigger>
          </TabsList>
          {addButton}
        </div>

        {/* Transactions Tab */}
        <TabsContent value="transactions" className="space-y-4">
          <div className="flex gap-3 flex-wrap">
            <Select value={txTypeFilter} onValueChange={(v) => setTxTypeFilter(v as 'all' | 'income' | 'expense')}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="income">Income</SelectItem>
                <SelectItem value="expense">Expense</SelectItem>
              </SelectContent>
            </Select>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {allCategories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat.charAt(0).toUpperCase() + cat.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {filteredTx.length === 0 ? (
            <EmptyState
              icon={Wallet}
              title="No transactions yet"
              description="Add your first transaction to start tracking."
              actionLabel="New Transaction"
              onAction={() => setTxDialogOpen(true)}
            />
          ) : (
            <TransactionTable
              transactions={filteredTx}
              onEdit={setEditingTx}
              onDelete={(tx) => setDeleteTarget({ entity: tx, type: 'transaction' })}
            />
          )}
        </TabsContent>

        {/* Budgets Tab */}
        <TabsContent value="budgets" className="space-y-4">
          {budgets.length === 0 ? (
            <EmptyState
              icon={Wallet}
              title="No budgets yet"
              description="Create a budget to track your spending."
              actionLabel="New Budget"
              onAction={() => setBudgetDialogOpen(true)}
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {budgets.map((budget) => (
                  <BudgetCard
                    key={budget.id}
                    budget={budget}
                    spent={spentByCategory[budget.metadata.category as string] || 0}
                    onEdit={setEditingBudget}
                    onDelete={(b) => setDeleteTarget({ entity: b, type: 'budget' })}
                  />
                ))}
              </div>
              <SpendingChart data={chartData} />
            </>
          )}
        </TabsContent>

        {/* Accounts Tab */}
        <TabsContent value="accounts" className="space-y-4">
          {accounts.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Total Cash: <span className="font-semibold text-foreground">{formatTHB(totalBalance)}</span>
            </p>
          )}
          {accounts.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title="No accounts yet"
              description="Add your bank accounts to track balances."
              actionLabel="New Account"
              onAction={() => setAccountDialogOpen(true)}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {accounts.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  onEdit={setEditingAccount}
                  onDelete={(a) => setDeleteTarget({ entity: a, type: 'account' })}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* Portfolio Tab */}
        <TabsContent value="portfolio" className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Select value={assetClassFilter} onValueChange={setAssetClassFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Asset Class" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Classes</SelectItem>
                {ASSET_CLASSES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {uniqueChains.length > 0 && (
              <Select value={chainFilter} onValueChange={setChainFilter}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Chain" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Chains</SelectItem>
                  {uniqueChains.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c.charAt(0).toUpperCase() + c.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {uniqueProtocols.length > 0 && (
              <Select value={protocolFilter} onValueChange={setProtocolFilter}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Protocol" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Protocols</SelectItem>
                  {uniqueProtocols.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {assets.length > 0 && (
              <p className={`text-sm font-medium ${totalGain.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                Unrealized: {totalGain.amount >= 0 ? '+' : ''}{formatTHB(totalGain.amount)} ({totalGain.pct >= 0 ? '+' : ''}{totalGain.pct.toFixed(1)}%)
              </p>
            )}
          </div>
          {filteredAssets.length === 0 ? (
            <EmptyState
              icon={PieChartIcon}
              title="No assets yet"
              description="Add your investments to track your portfolio."
              actionLabel="New Asset"
              onAction={() => setAssetDialogOpen(true)}
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filteredAssets.map((asset) => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    walletName={asset.metadata.walletId ? walletMap.get(asset.metadata.walletId as string) : undefined}
                    onEdit={setEditingAsset}
                    onDelete={(a) => setDeleteTarget({ entity: a, type: 'asset' })}
                  />
                ))}
              </div>
              <AllocationChart data={allocationData} />
            </>
          )}
        </TabsContent>

        {/* Wallets Tab */}
        <TabsContent value="wallets" className="space-y-4">
          {wallets.length === 0 ? (
            <EmptyState
              icon={HardDrive}
              title="No wallets yet"
              description="Add your crypto wallets and exchange accounts."
              actionLabel="New Wallet"
              onAction={() => setWalletDialogOpen(true)}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {wallets.map((wallet) => (
                <WalletCard
                  key={wallet.id}
                  wallet={wallet}
                  onEdit={setEditingWallet}
                  onDelete={(w) => setDeleteTarget({ entity: w, type: 'wallet' })}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* Crypto Txs Tab */}
        <TabsContent value="crypto-txs" className="space-y-4">
          <div className="flex gap-3 flex-wrap">
            <Select value={cryptoTxActionFilter} onValueChange={setCryptoTxActionFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Action" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Actions</SelectItem>
                {CRYPTO_TX_ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a === 'transfer-in' ? 'Transfer In' : a === 'transfer-out' ? 'Transfer Out' : a.charAt(0).toUpperCase() + a.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {uniqueCryptoTxSymbols.length > 0 && (
              <Select value={cryptoTxSymbolFilter} onValueChange={setCryptoTxSymbolFilter}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue placeholder="Symbol" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Symbols</SelectItem>
                  {uniqueCryptoTxSymbols.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {filteredCryptoTxs.length === 0 ? (
            <EmptyState
              icon={ArrowLeftRight}
              title="No crypto transactions yet"
              description="Record your crypto buys, sells, swaps, and transfers."
              actionLabel="New Crypto Tx"
              onAction={() => setCryptoTxDialogOpen(true)}
            />
          ) : (
            <CryptoTxTable
              transactions={filteredCryptoTxs}
              wallets={wallets}
              onEdit={setEditingCryptoTx}
              onDelete={(tx) => setDeleteTarget({ entity: tx, type: 'crypto-tx' })}
            />
          )}
        </TabsContent>
      </Tabs>

      {/* Create dialogs */}
      <TransactionDialog
        open={txDialogOpen}
        onOpenChange={setTxDialogOpen}
        onSubmit={handleCreateTx}
      />
      <BudgetDialog
        open={budgetDialogOpen}
        onOpenChange={setBudgetDialogOpen}
        onSubmit={handleCreateBudget}
      />
      <AccountDialog
        open={accountDialogOpen}
        onOpenChange={setAccountDialogOpen}
        onSubmit={handleCreateAccount}
      />
      <AssetDialog
        open={assetDialogOpen}
        onOpenChange={setAssetDialogOpen}
        onSubmit={handleCreateAsset}
        wallets={wallets}
      />
      <WalletDialog
        open={walletDialogOpen}
        onOpenChange={setWalletDialogOpen}
        onSubmit={handleCreateWallet}
      />
      <CryptoTxDialog
        open={cryptoTxDialogOpen}
        onOpenChange={setCryptoTxDialogOpen}
        onSubmit={handleCreateCryptoTx}
        wallets={wallets}
      />

      {/* Edit dialogs */}
      <TransactionDialog
        open={!!editingTx}
        onOpenChange={(open) => !open && setEditingTx(null)}
        title="Edit Transaction"
        defaultValues={
          editingTx
            ? {
                title: editingTx.title,
                amount: editingTx.metadata.amount as number,
                txType: editingTx.metadata.txType as 'income' | 'expense',
                category: editingTx.metadata.category as string,
                date: (editingTx.metadata.date as string) || editingTx.dueDate || '',
              }
            : undefined
        }
        onSubmit={handleEditTx}
      />
      <BudgetDialog
        open={!!editingBudget}
        onOpenChange={(open) => !open && setEditingBudget(null)}
        title="Edit Budget"
        defaultValues={
          editingBudget
            ? {
                title: editingBudget.title,
                amount: editingBudget.metadata.amount as number,
                category: editingBudget.metadata.category as string,
              }
            : undefined
        }
        onSubmit={handleEditBudget}
      />
      <AccountDialog
        open={!!editingAccount}
        onOpenChange={(open) => !open && setEditingAccount(null)}
        title="Edit Account"
        defaultValues={
          editingAccount
            ? {
                title: editingAccount.title,
                balance: editingAccount.metadata.balance as number,
                accountType: editingAccount.metadata.accountType as AccountFormValues['accountType'],
                institution: (editingAccount.metadata.institution as string) || '',
              }
            : undefined
        }
        onSubmit={handleEditAccount}
      />
      <AssetDialog
        open={!!editingAsset}
        onOpenChange={(open) => !open && setEditingAsset(null)}
        title="Edit Asset"
        defaultValues={
          editingAsset
            ? {
                title: editingAsset.title,
                assetClass: editingAsset.metadata.assetClass as AssetClass,
                symbol: (editingAsset.metadata.symbol as string) || '',
                quantity: editingAsset.metadata.quantity as number | undefined,
                costBasis: editingAsset.metadata.costBasis as number | undefined,
                currentPrice: editingAsset.metadata.currentPrice as number | undefined,
                costValue: editingAsset.metadata.costValue as number | undefined,
                currentValue: editingAsset.metadata.currentValue as number | undefined,
                chain: (editingAsset.metadata.chain as string) || '',
                protocol: (editingAsset.metadata.protocol as string) || '',
                platform: (editingAsset.metadata.platform as string) || '',
                walletId: (editingAsset.metadata.walletId as string) || '',
              }
            : undefined
        }
        onSubmit={handleEditAsset}
        wallets={wallets}
      />
      <WalletDialog
        open={!!editingWallet}
        onOpenChange={(open) => !open && setEditingWallet(null)}
        title="Edit Wallet"
        defaultValues={
          editingWallet
            ? {
                title: editingWallet.title,
                walletType: editingWallet.metadata.walletType as WalletFormValues['walletType'],
                chain: (editingWallet.metadata.chain as string) || '',
                address: (editingWallet.metadata.address as string) || '',
                platform: (editingWallet.metadata.platform as string) || '',
              }
            : undefined
        }
        onSubmit={handleEditWallet}
      />
      <CryptoTxDialog
        open={!!editingCryptoTx}
        onOpenChange={(open) => !open && setEditingCryptoTx(null)}
        title="Edit Crypto Transaction"
        defaultValues={
          editingCryptoTx
            ? {
                txAction: editingCryptoTx.metadata.txAction as CryptoTxAction,
                symbol: (editingCryptoTx.metadata.symbol as string) || '',
                quantity: editingCryptoTx.metadata.quantity as number,
                pricePerUnit: editingCryptoTx.metadata.pricePerUnit as number | undefined,
                fee: editingCryptoTx.metadata.fee as number | undefined,
                walletId: (editingCryptoTx.metadata.walletId as string) || '',
                toWalletId: (editingCryptoTx.metadata.toWalletId as string) || '',
                date: (editingCryptoTx.metadata.date as string) || '',
                note: (editingCryptoTx.metadata.note as string) || '',
              }
            : undefined
        }
        onSubmit={handleEditCryptoTx}
        wallets={wallets}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.type === 'crypto-tx' ? 'crypto transaction' : deleteTarget?.type || ''}`}
        description={`Are you sure you want to delete "${deleteTarget?.entity.title}"?`}
        onConfirm={handleDelete}
      />
    </div>
  )
}
