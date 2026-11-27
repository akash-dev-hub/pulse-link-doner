import { useEffect, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import { Loader2 } from 'lucide-react';
import { isValidUsername, normalizeUsernameInput } from '../lib/eligibility.ts';

interface UsernameSetupViewProps {
  user: User;
  suggestedUsername: string;
  hasLegacyDonorProfile: boolean;
  onComplete: (username: string) => void;
  onNotify: (type: 'success' | 'error', message: string) => void;
}

export function UsernameSetupView({
  user,
  suggestedUsername,
  hasLegacyDonorProfile,
  onComplete,
  onNotify,
}: UsernameSetupViewProps) {
  const [username, setUsername] = useState(suggestedUsername);
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [availabilityMsg, setAvailabilityMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const normalized = normalizeUsernameInput(username);
  const validFormat = isValidUsername(normalized);

  useEffect(() => {
    if (!normalized) {
      setAvailable(null);
      setAvailabilityMsg('');
      return;
    }
    if (!validFormat) {
      setAvailable(false);
      setAvailabilityMsg('Use 3 to 24 lowercase letters, numbers, or underscores.');
      return;
    }

    let cancelled = false;
    setChecking(true);
    setAvailabilityMsg('');
    const timer = window.setTimeout(async () => {
      try {
        const token = await user.getIdToken();
        const res = await fetch(
          `/api/account/username-available?username=${encodeURIComponent(normalized)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        const body = (await res.json().catch(() => ({}))) as {
          available?: boolean;
          error?: string;
        };
        if (cancelled) return;
        if (res.ok && typeof body.available === 'boolean') {
          setAvailable(body.available);
          setAvailabilityMsg(
            body.available ? 'Username is available.' : 'That username is already taken.',
          );
        } else {
          setAvailable(null);
          setAvailabilityMsg('');
        }
      } catch {
        if (!cancelled) {
          setAvailable(null);
          setAvailabilityMsg('');
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [normalized, validFormat, user]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!validFormat) {
      const msg = 'Username must be 3 to 24 lowercase letters, numbers, or underscores.';
      setFormError(msg);
      onNotify('error', msg);
      return;
    }

    setSaving(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/account/username', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ username: normalized }),
      });

      const body = (await res.json().catch(() => ({}))) as {
        username?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || 'Could not save username. Please try another.');
      }

      onNotify('success', 'Username saved');
      onComplete(body.username || normalized);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : 'Could not save username. Please try again.';
      setFormError(msg);
      onNotify('error', msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto py-4 sm:py-8">
      <form
        onSubmit={handleSubmit}
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
      >
        <div className="space-y-2">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">
            Choose your username
          </h1>
          <p className="text-sm text-slate-600 leading-relaxed">
            Other users will only see your username, blood group, and general area—never your real name, phone number, or email.
          </p>
          {hasLegacyDonorProfile && (
            <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              Your existing donor profile will stay intact, and your real name, phone, and email will be moved to your private record.
            </p>
          )}
        </div>

        {formError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
            {formError}
          </div>
        )}

        <div>
          <label htmlFor="setup-username" className="block text-xs font-medium text-slate-700 mb-1.5">
            Unique Username<span className="text-red-600 ml-0.5">*</span>
          </label>
          <div className="relative flex items-center">
            <span className="absolute left-3 text-sm font-mono-tabular text-slate-500">@</span>
            <input
              id="setup-username"
              type="text"
              required
              maxLength={24}
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              placeholder="e.g. rahul_k24"
              className="w-full min-h-[44px] pl-7 pr-9 py-2 text-sm font-mono-tabular bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
            />
            {checking && (
              <Loader2 className="w-4 h-4 text-slate-400 animate-spin absolute right-3" />
            )}
          </div>
          {availabilityMsg && (
            <p
              className={`mt-1.5 text-xs ${
                available === false ? 'text-red-700' : 'text-slate-600'
              }`}
            >
              {availabilityMsg}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={saving || available === false || !validFormat}
          className="w-full min-h-[46px] px-5 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Save username
        </button>
      </form>
    </div>
  );
}
