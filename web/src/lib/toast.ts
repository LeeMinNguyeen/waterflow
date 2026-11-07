import { createContext, useContext } from 'react'

export type ToastAction = { label: string; run: () => void }

export const ToastContext = createContext<(text: string, action?: ToastAction) => void>(() => {})

export const useToast = () => useContext(ToastContext)
