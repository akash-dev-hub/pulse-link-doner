import { useEffect } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

export interface ToastState {
  id: number;
  type: 'success' | 'error';
  message: string;
}

interface ToastPopupProps {
  toast: ToastState | null;
  onClose: () => void;
}

export function ToastPopup({ toast, onClose }: ToastPopupProps) {
  useEffect(() => {
    if (!toast || toast.type !== 'success') return;
    const timer = window.setTimeout(() => {
      onClose();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;

  const isSuccess = toast.type === 'success';

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 md:bottom-6 right-4 left-4 sm:left-auto sm:w-96 z-50"
    >
      <div
        className={`flex items-start gap-3 p-4 rounded-xl border ${
          isSuccess
            ? 'bg-white border-slate-300 text-slate-900'
            : 'bg-red-50 border-red-300 text-red-900'
        }`}
      >
        {isSuccess ? (
          <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
        ) : (
          <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
        )}

        <p className="flex-1 text-sm font-medium leading-snug pt-0.5">
          {toast.message}
        </p>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close popup"
          className={`p-1 -m-1 rounded-lg shrink-0 ${
            isSuccess
              ? 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
              : 'text-red-700 hover:text-red-900 hover:bg-red-100'
          }`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
