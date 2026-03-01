import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { FileQuestion } from 'lucide-react'

export function NotFoundPage() {
  const navigate = useNavigate()

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <FileQuestion className="h-16 w-16 text-muted-foreground/50 mb-4" />
      <h1 className="text-2xl font-bold">Page Not Found</h1>
      <p className="text-sm text-muted-foreground mt-1">
        The page you're looking for doesn't exist.
      </p>
      <Button onClick={() => navigate('/')} className="mt-4">
        Back to Dashboard
      </Button>
    </div>
  )
}
