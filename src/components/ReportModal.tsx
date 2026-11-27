import { useEffect, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import { Flag, Loader2, X } from 'lucide-react';
import type { ReportReason, ReportTargetType } from '../types.ts';

export interface ReportTargetDraft {
  targetType: ReportTargetType;
  targetId: string;
  targetUid: string;
  targetUsername: string;
  contextId?: string;
  targetPreview: string;
}

interface ReportModalProps {
  user: User | null;
  target: ReportTargetDraft | null;
  onClose: () => void;
  onNotify: (type: 'success' | 'error', message: string) => void;
}

const REASON_OPTIONS: Array<{ value: ReportReason; label: string }> = [
  { value: 'fake_request', label: 'Fake or misleading request' },
  { value: 'spam', label: 'Spam or unwanted contact' },
  { value: 'harassment', label: 'Harassment or abusive language' },
  { value: 'suspicious_activity', label: 'Suspicious or duplicate account' },
  { value: 'other', label: 'Other safety concern' },
];

export function ReportModal({ user, target, onClose, onNotify }: ReportModalProps) {
  const [reason, setReason] = useState<ReportReason>('spam');
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (target) {
      setReason(target.targetType === 'request' ? 'fake_request' : 'spam');
      setDetails('');
    }
  }, [target]);

  if (!target || !user) return null;

  const targetLabel =
    target.targetType === 'request'
      ? 'blood request'
      : target.targetType === 'message'
        ? 'chat message'
        : 'user account';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          targetType: target.targetType,
          targetId: target.targetId,
          targetUid: target.targetUid,
          targetUsername: target.targetUsername,
          contextId: target.contextId || '',
          targetPreview: target.targetPreview.slice(0, 300),
          reason,
          details: details.trim().slice(0, 500),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Could not submit report right now.');
      }
      onNotify('success', 'Report submitted. An admin will review it.');
      onClose();
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error && err.message ? err.message : 'Could not submit report right now.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40"
    >
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="report-modal-title" className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Flag className="w-4 h-4 text-red-600" />
              Report {targetLabel}
            </h2>
            <p className="text-xs text-slate-600 mt-1">
              {target.targetUsername ? `@${target.targetUsername}` : 'Selected entry'} — sent privately to admins for review.
            </p>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            aria-label="Close report dialog"
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {target.targetPreview && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700 break-words">
            {target.targetPreview}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="report-reason" className="block text-xs font-medium text-slate-700 mb-1.5">
              Reason
            </label>
            <select
              id="report-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as ReportReason)}
              className="w-full min-h-[42px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
            >
              {REASON_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="report-details" className="block text-xs font-medium text-slate-700 mb-1.5">
              What happened? (optional)
            </label>
            <textarea
              id="report-details"
              rows={3}
              maxLength={500}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Share brief context to help an admin review this..."
              className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
            />
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="min-h-[42px] px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="min-h-[42px] px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5"
            >
              {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Submit Report
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
