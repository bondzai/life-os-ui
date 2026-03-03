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
import { CRYPTO_TX_ACTIONS } from './wealth-helpers'
import type { Entity } from '@/core/types'

const schema = z.object({
  txAction: z.enum(['buy', 'sell', 'swap', 'transfer-in', 'transfer-out']),
  symbol: z.string().optional(),
  quantity: z.string().min(1, 'Quantity is required'),
  pricePerUnit: z.string().optional(),
  fee: z.string().optional(),
  walletId: z.string().optional(),
  toWalletId: z.string().optional(),
  date: z.string().min(1, 'Date is required'),
  note: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export interface CryptoTxFormValues {
  txAction: 'buy' | 'sell' | 'swap' | 'transfer-in' | 'transfer-out'
  symbol?: string
  quantity: number
  pricePerUnit?: number
  fee?: number
  walletId?: string
  toWalletId?: string
  date: string
  note?: string
}

interface CryptoTxDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultValues?: Partial<CryptoTxFormValues>
  onSubmit: (values: CryptoTxFormValues) => void
  title?: string
  wallets: Entity[]
}

const ACTION_LABELS: Record<string, string> = {
  buy: 'Buy',
  sell: 'Sell',
  swap: 'Swap',
  'transfer-in': 'Transfer In',
  'transfer-out': 'Transfer Out',
}

export function CryptoTxDialog({
  open,
  onOpenChange,
  defaultValues,
  onSubmit,
  title = 'New Crypto Transaction',
  wallets,
}: CryptoTxDialogProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      txAction: defaultValues?.txAction ?? 'buy',
      symbol: defaultValues?.symbol ?? '',
      quantity: defaultValues?.quantity?.toString() ?? '',
      pricePerUnit: defaultValues?.pricePerUnit?.toString() ?? '',
      fee: defaultValues?.fee?.toString() ?? '',
      walletId: defaultValues?.walletId ?? '',
      toWalletId: defaultValues?.toWalletId ?? '',
      date: defaultValues?.date ?? new Date().toISOString().split('T')[0],
      note: defaultValues?.note ?? '',
    },
  })

  const txAction = form.watch('txAction')
  const isTransfer = txAction === 'transfer-in' || txAction === 'transfer-out'
  const showPrice = !isTransfer

  useEffect(() => {
    if (defaultValues) {
      form.reset({
        txAction: defaultValues.txAction ?? 'buy',
        symbol: defaultValues.symbol ?? '',
        quantity: defaultValues.quantity?.toString() ?? '',
        pricePerUnit: defaultValues.pricePerUnit?.toString() ?? '',
        fee: defaultValues.fee?.toString() ?? '',
        walletId: defaultValues.walletId ?? '',
        toWalletId: defaultValues.toWalletId ?? '',
        date: defaultValues.date ?? new Date().toISOString().split('T')[0],
        note: defaultValues.note ?? '',
      })
    }
  }, [defaultValues, form])

  const handleSubmit = (values: FormValues) => {
    const result: CryptoTxFormValues = {
      txAction: values.txAction,
      quantity: parseFloat(values.quantity),
      date: values.date,
    }
    if (values.symbol) result.symbol = values.symbol
    if (values.pricePerUnit) result.pricePerUnit = parseFloat(values.pricePerUnit)
    if (values.fee) result.fee = parseFloat(values.fee)
    if (values.walletId) result.walletId = values.walletId
    if (values.toWalletId) result.toWalletId = values.toWalletId
    if (values.note) result.note = values.note
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
              name="txAction"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Action</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CRYPTO_TX_ACTIONS.map((a) => (
                        <SelectItem key={a} value={a}>
                          {ACTION_LABELS[a]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="symbol"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Symbol</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. BTC, ETH" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
            </div>

            {showPrice && (
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="pricePerUnit"
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
                <FormField
                  control={form.control}
                  name="fee"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Fee (THB)</FormLabel>
                      <FormControl>
                        <Input type="number" step="any" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            {isTransfer && (
              <FormField
                control={form.control}
                name="fee"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Fee (THB)</FormLabel>
                    <FormControl>
                      <Input type="number" step="any" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="walletId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{isTransfer ? 'From Wallet' : 'Wallet'}</FormLabel>
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

            {isTransfer && (
              <FormField
                control={form.control}
                name="toWalletId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>To Wallet</FormLabel>
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

            <FormField
              control={form.control}
              name="date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Optional note" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

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
