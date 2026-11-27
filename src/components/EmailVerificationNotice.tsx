import { Loader2, Mail, RefreshCw } from 'lucide-react';

interface EmailVerificationNoticeProps {
  email: string;
  variant?: 'banner' | 'card';
  title?: string;
  description?: string;
  resending: boolean;
  checking: boolean;
  onResend: () => void;
  onCheckVerified: () => void;
}

export function EmailVerificationNotice({
  email,
  variant = 'banner',
  title,
  description,
  resending,
  checking,
  onResend,
  onCheckVerified,
}: EmailVerificationNoticeProps) {
  const heading = title || 'Verify your email address';
  const body =
    description ||
    `We sent a verification link to ${email || 'your email'}. While unverified, you can still browse donors and requests, but you cannot post requests, message donors, or appear as a donor.`;

  if (variant === 'card') {
    return (
      <div className="max-w-lg mx-auto py-4 sm:py-8">
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-red-50 border border-red-200 rounded-lg text-red-700 shrink-0">
              <Mail className="w-5 h-5" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-slate-900">{heading}</h2>
              <p className="text-sm text-slate-600 leading-relaxed">{body}</p>
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-xs text-slate-600 leading-relaxed">
            Open the verification link in your email inbox (check Spam if needed), then tap{' '}
            <span className="font-semibold text-slate-900">I have verified</span>.
          </div>

          <div className="flex flex-col sm:flex-row gap-2.5">
            <button
              type="button"
              disabled={checking || resending}
              onClick={onCheckVerified}
              className="flex-1 min-h-[44px] px-4 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors"
            >
              {checking ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              <span>I have verified</span>
            </button>

            <button
              type="button"
              disabled={resending || checking}
              onClick={onResend}
              className="flex-1 min-h-[44px] px-4 py-2.5 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-60 text-slate-900 text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors"
            >
              {resending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Mail className="w-4 h-4" />
              )}
              <span>Resend email</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Email verification notice"
      className="mb-6 bg-white border border-red-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
    >
      <div className="flex items-start gap-3 min-w-0">
        <div className="p-2 bg-red-50 border border-red-200 rounded-lg text-red-700 shrink-0 mt-0.5">
          <Mail className="w-4 h-4" />
        </div>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-semibold text-slate-900">{heading}</p>
          <p className="text-xs text-slate-600 leading-relaxed">{body}</p>
        </div>
      </div>

      <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 shrink-0">
        <button
          type="button"
          disabled={resending || checking}
          onClick={onResend}
          className="min-h-[40px] px-3.5 py-2 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-60 text-slate-900 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap"
        >
          {resending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          <span>Resend email</span>
        </button>

        <button
          type="button"
          disabled={checking || resending}
          onClick={onCheckVerified}
          className="min-h-[40px] px-3.5 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap"
        >
          {checking && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          <span>I have verified</span>
        </button>
      </div>
    </div>
  );
}
