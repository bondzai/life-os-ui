import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { ASSET_CLASSES, CRYPTO_CHAINS, isQuantityBased, type AssetClass } from './wealth-helpers'
import type { Entity } from '@/core/types'

const schema = z.object({
  title: z.string().min(1, 'Name is required'),
  assetClass: z.enum(['crypto', 'defi', 'stock', 'fund', 'gold', 'property', 'other']),
  symbol: z.string().optional(),
  quantity: z.string().optional(),
  costBasis: z.string().optional(),
  currentPrice: z.string().optional(),
  costValue: z.string().optional(),
  currentValue: z.string().optional(),
  chain: z.string().optional(),
  protocol: z.string().optional(),
  platform: z.string().optional(),
  walletId: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export interface AssetFormValues {
  title: string
  assetClass: AssetClass
  symbol?: string
  quantity?: number
  costBasis?: number
  currentPrice?: number
  costValue?: number
  currentValue?: number
  chain?: string
  protocol?: string
  platform?: string
  walletId?: string
}

interface AssetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultValues?: Partial<AssetFormValues>
  onSubmit: (values: AssetFormValues) => void
  title?: string
  wallets?: Entity[]
}

export function AssetDialog({
  open,
  onOpenChange,
  defaultValues,
  onSubmit,
  title = 'New Asset',
  wallets = [],
}: AssetDialogProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: defaultValues?.title ?? '',
      assetClass: defaultValues?.assetClass ?? 'crypto',
      symbol: defaultValues?.symbol ?? '',
      quantity: defaultValues?.quantity?.toString() ?? '',
      costBasis: defaultValues?.costBasis?.toString() ?? '',
      currentPrice: defaultValues?.currentPrice?.toString() ?? '',
      costValue: defaultValues?.costValue?.toString() ?? '',
      currentValue: defaultValues?.currentValue?.toString() ?? '',
      chain: defaultValues?.chain ?? '',
      protocol: defaultValues?.protocol ?? '',
      platform: defaultValues?.platform ?? '',
      walletId: defaultValues?.walletId ?? '',
    },
  })

  const assetClass = form.watch('assetClass') as AssetClass
  const quantityMode = isQuantityBased(assetClass)
  const showChain = assetClass === 'crypto' || assetClass === 'defi'
  const showProtocol = assetClass === 'defi'
  const showPlatform = assetClass === 'crypto' || assetClass === 'stock' || assetClass === 'fund'
  const showSymbol = assetClass === 'crypto' || assetClass === 'stock'
  const showWallet = assetClass === 'crypto' || assetClass === 'defi'

  useEffect(() => {
    if (defaultValues) {
      form.reset({
        title: defaultValues.title ?? '',
        assetClass: defaultValues.assetClass ?? 'crypto',
        symbol: defaultValues.symbol ?? '',
        quantity: defaultValues.quantity?.toString() ?? '',
        costBasis: defaultValues.costBasis?.toString() ?? '',
        currentPrice: defaultValues.currentPrice?.toString() ?? '',
        costValue: defaultValues.costValue?.toString() ?? '',
        currentValue: defaultValues.currentValue?.toString() ?? '',
        chain: defaultValues.chain ?? '',
        protocol: defaultValues.protocol ?? '',
        platform: defaultValues.platform ?? '',
        walletId: defaultValues.walletId ?? '',
      })
    }
  }, [defaultValues, form])

  const handleSubmit = (values: FormValues) => {
    const result: AssetFormValues = {
      title: values.title,
      assetClass: values.assetClass,
    }
    if (quantityMode) {
      if (values.symbol) result.symbol = values.symbol
      if (values.quantity) result.quantity = parseFloat(values.quantity)
      if (values.costBasis) result.costBasis = parseFloat(values.costBasis)
      if (values.currentPrice) result.currentPrice = parseFloat(values.currentPrice)
    } else {
      if (values.costValue) result.costValue = parseFloat(values.costValue)
      if (values.currentValue) result.currentValue = parseFloat(values.currentValue)
    }
    if (values.chain) result.chain = values.chain
    if (values.protocol) result.protocol = values.protocol
    if (values.platform) result.platform = values.platform
    if (values.walletId) result.walletId = values.walletId
    onSubmit(result)
    form.reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="assetClass"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Asset Class</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ASSET_CLASSES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c.charAt(0).toUpperCase() + c.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g. Bitcoin, Aave USDC, Gold 1 Baht" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {showSymbol && (
              <FormField
                control={form.control}
                name="symbol"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Symbol</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. BTC, AAPL" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {quantityMode && (
              <div className="grid grid-cols-3 gap-3">
                <FormField
                  control={form.control}
                  name="quantity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Quantity</FormLabel>
                      <FormControl>
                        <Input type="number" step="any" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="costBasis"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Cost/Unit (THB)</FormLabel>
                      <FormControl>
                        <Input type="number" step="any" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="currentPrice"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Price/Unit (THB)</FormLabel>
                      <FormControl>
                        <Input type="number" step="any" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            {!quantityMode && (
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="costValue"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Total Cost (THB)</FormLabel>
                      <FormControl>
                        <Input type="number" step="any" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="currentValue"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Current Value (THB)</FormLabel>
                      <FormControl>
                        <Input type="number" step="any" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            {showChain && (
              <FormField
                control={form.control}
                name="chain"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Chain</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select chain" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CRYPTO_CHAINS.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c.charAt(0).toUpperCase() + c.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {showProtocol && (
              <FormField
                control={form.control}
                name="protocol"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Protocol</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. Aave, Uniswap" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {showPlatform && (
              <FormField
                control={form.control}
                name="platform"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Platform</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. Binance, SCB Securities" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {showWallet && wallets.length > 0 && (
              <FormField
                control={form.control}
                name="walletId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Wallet</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select wallet" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="">None</SelectItem>
                        {wallets.map((w) => (
                          <SelectItem key={w.id} value={w.id}>
                            {w.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
