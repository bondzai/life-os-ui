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
import { ACCOUNT_TYPES } from './wealth-helpers'

const schema = z.object({
  title: z.string().min(1, 'Account name is required'),
  balance: z.string().min(1, 'Balance is required'),
  accountType: z.enum(['checking', 'savings', 'credit', 'investment', 'cash']),
  institution: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export interface AccountFormValues {
  title: string
  balance: number
  accountType: 'checking' | 'savings' | 'credit' | 'investment' | 'cash'
  institution?: string
}

interface AccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultValues?: Partial<AccountFormValues>
  onSubmit: (values: AccountFormValues) => void
  title?: string
}

export function AccountDialog({
  open,
  onOpenChange,
  defaultValues,
  onSubmit,
  title = 'New Account',
}: AccountDialogProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: defaultValues?.title ?? '',
      balance: defaultValues?.balance?.toString() ?? '0',
      accountType: defaultValues?.accountType ?? 'checking',
      institution: defaultValues?.institution ?? '',
    },
  })

  const handleSubmit = (values: FormValues) => {
    onSubmit({
      title: values.title,
      balance: parseFloat(values.balance),
      accountType: values.accountType,
      institution: values.institution || undefined,
    })
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
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="balance"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Balance (THB)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="accountType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Account Type</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ACCOUNT_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t.charAt(0).toUpperCase() + t.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="institution"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Institution (optional)</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g. Bangkok Bank" />
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
