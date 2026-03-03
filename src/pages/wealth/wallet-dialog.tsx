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
import { WALLET_TYPES, CRYPTO_CHAINS } from './wealth-helpers'

const schema = z.object({
  title: z.string().min(1, 'Name is required'),
  walletType: z.enum(['cex', 'cold', 'hot', 'hardware']),
  chain: z.string().optional(),
  address: z.string().optional(),
  platform: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export interface WalletFormValues {
  title: string
  walletType: 'cex' | 'cold' | 'hot' | 'hardware'
  chain?: string
  address?: string
  platform?: string
}

interface WalletDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultValues?: Partial<WalletFormValues>
  onSubmit: (values: WalletFormValues) => void
  title?: string
}

export function WalletDialog({
  open,
  onOpenChange,
  defaultValues,
  onSubmit,
  title = 'New Wallet',
}: WalletDialogProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: defaultValues?.title ?? '',
      walletType: defaultValues?.walletType ?? 'cex',
      chain: defaultValues?.chain ?? '',
      address: defaultValues?.address ?? '',
      platform: defaultValues?.platform ?? '',
    },
  })

  const walletType = form.watch('walletType')
  const isCex = walletType === 'cex'
  const showChainAddress = !isCex

  useEffect(() => {
    if (defaultValues) {
      form.reset({
        title: defaultValues.title ?? '',
        walletType: defaultValues.walletType ?? 'cex',
        chain: defaultValues.chain ?? '',
        address: defaultValues.address ?? '',
        platform: defaultValues.platform ?? '',
      })
    }
  }, [defaultValues, form])

  const handleSubmit = (values: FormValues) => {
    const result: WalletFormValues = {
      title: values.title,
      walletType: values.walletType,
    }
    if (isCex && values.platform) result.platform = values.platform
    if (!isCex) {
      if (values.chain) result.chain = values.chain
      if (values.address) result.address = values.address
    }
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
              name="walletType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Wallet Type</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {WALLET_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t === 'cex' ? 'CEX' : t.charAt(0).toUpperCase() + t.slice(1)}
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
                    <Input {...field} placeholder="e.g. Binance, Ledger Nano" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {isCex && (
              <FormField
                control={form.control}
                name="platform"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Platform</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. Binance, Bitkub" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {showChainAddress && (
              <>
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
                          <SelectItem value="multi">Multi-chain</SelectItem>
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
                <FormField
                  control={form.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Address</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="On-chain address" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
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
