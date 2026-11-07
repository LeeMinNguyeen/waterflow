import { useTranslation } from 'react-i18next'
import { send } from '../lib/api'
import { useInvalidateBook } from '../lib/queries'
import { useToast } from '../lib/toast'
import { useErrorText } from './errors'

// Callable after the dialog that offered it has closed: Undo lives in the message, not the dialog.
export function useRestoreTxn(bookId: string) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const invalidate = useInvalidateBook()
  return async (id: string) => {
    try {
      await send('POST', `/v1/books/${bookId}/transactions/${id}/restore`)
      toast(t('toast.txnRestored'))
    } catch (err) {
      toast(errorText(err))
    } finally {
      await invalidate(bookId)
    }
  }
}
