import { useState, type FormEvent } from 'react';
import {
  getAdditionalUserInfo,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { Loader2, Mail, ShieldAlert, X } from 'lucide-react';
import {
  postAuthAuditEvent,
  precheckDeviceSignup,
  signupWithServerGate,
} from '../lib/deviceIdentity.ts';
import { auth, googleProvider } from '../lib/firebase.ts';

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  onSignedIn: (emailVerified: boolean) => void;
  onNotify: (type: 'success' | 'error', message: string) => void;
}

function mapAuthError(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code || '')
      : '';

  switch (code) {
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Try signing in instead.';
    case 'auth/weak-password':
      return 'Please choose a password with at least 6 characters.';
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-credential':
      return 'Incorrect email or password. Please check and try again.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a minute and try again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Google sign-in was cancelled.';
    case 'auth/operation-not-allowed':
    case 'auth/admin-restricted-operation':
      return 'Email sign-in is not turned on in Firebase yet. Enable Email/Password in Firebase Authentication or continue with Google.';
    default:
      return 'Could not complete sign in. Please try again.';
  }
}

function PrivacyNoticeBox({
  consentAccepted,
  onToggle,
}: {
  consentAccepted: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-2.5">
      <div className="flex items-start gap-2">
        <ShieldAlert className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="text-xs font-semibold text-slate-900">Privacy &amp; Anti-Fraud Notice</p>
          <p className="text-[11px] text-slate-600 leading-relaxed">
            To prevent duplicate spam accounts and protect donors, we record your user ID, a random device ID stored on this browser, signup/login time, and a one-way keyed hash of your IP address (never your raw IP). Each device can create only 1 new account, and if more than 3 accounts are created from one IP in 24 hours they are flagged for admin review. Records are readable only by admins and deleted automatically after 30 days.
          </p>
        </div>
      </div>
      <label className="flex items-start gap-2 cursor-pointer pt-1">
        <input
          type="checkbox"
          checked={consentAccepted}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
        />
        <span className="text-xs font-medium text-slate-800">
          I understand what is recorded and why, and agree to create my account.
        </span>
      </label>
    </div>
  );
}

export function AuthModal({ open, onClose, onSignedIn, onNotify }: AuthModalProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [pendingGoogleUser, setPendingGoogleUser] = useState<User | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  if (!open) return null;

  const busy = googleBusy || emailBusy;

  const cancelPendingGoogleSignup = async () => {
    const pending = pendingGoogleUser;
    setPendingGoogleUser(null);
    if (!pending) return;
    try {
      await pending.delete();
    } catch {
      await signOut(auth).catch(() => undefined);
    }
  };

  const handleClose = () => {
    if (busy) return;
    if (pendingGoogleUser) {
      void cancelPendingGoogleSignup();
    }
    setErrorMsg('');
    onClose();
  };

  const finishGoogleSignupWithConsent = async () => {
    if (!pendingGoogleUser) return;
    if (!consentAccepted) {
      setErrorMsg('Please read the privacy notice and tick the consent box before creating your account.');
      return;
    }
    setErrorMsg('');
    setGoogleBusy(true);
    try {
      const audit = await postAuthAuditEvent(pendingGoogleUser, 'signup', true);
      if (!audit.ok) {
        await signOut(auth).catch(() => undefined);
        setPendingGoogleUser(null);
        const msg = audit.error || 'Could not complete registration on this device.';
        setErrorMsg(msg);
        onNotify('error', msg);
        return;
      }
      const verified = Boolean(pendingGoogleUser.emailVerified);
      setPendingGoogleUser(null);
      if (audit.ipFlagged) {
        onNotify('success', 'Account created. Signed in successfully.');
      }
      onSignedIn(verified);
      onClose();
    } finally {
      setGoogleBusy(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setErrorMsg('');
    if (mode === 'signup') {
      if (!consentAccepted) {
        setErrorMsg('Please read the privacy notice and tick the consent box before creating an account.');
        return;
      }
      setGoogleBusy(true);
      const check = await precheckDeviceSignup(true);
      if (!check.ok) {
        setGoogleBusy(false);
        const msg = check.error || 'This device already registered an account.';
        setErrorMsg(msg);
        onNotify('error', msg);
        return;
      }
    } else {
      setGoogleBusy(true);
    }

    try {
      const cred = await signInWithPopup(auth, googleProvider);
      const isNewUser = Boolean(getAdditionalUserInfo(cred)?.isNewUser);

      if (isNewUser && mode === 'signin') {
        setPendingGoogleUser(cred.user);
        setConsentAccepted(false);
        return;
      }

      const eventType = isNewUser ? 'signup' : 'login';
      const audit = await postAuthAuditEvent(
        cred.user,
        eventType,
        isNewUser ? consentAccepted : true,
      );

      if (!audit.ok) {
        await signOut(auth).catch(() => undefined);
        const msg = audit.error || 'Could not complete sign in on this device.';
        setErrorMsg(msg);
        onNotify('error', msg);
        return;
      }

      if (audit.moderationStatus === 'suspended') {
        onNotify('error', 'Your account is currently suspended pending admin review.');
      } else if (audit.moderationStatus === 'pending_review') {
        onNotify('error', 'Your account is currently flagged for admin review.');
      }
      onSignedIn(Boolean(cred.user.emailVerified));
      onClose();
    } catch (err) {
      const msg = mapAuthError(err);
      setErrorMsg(msg);
      onNotify('error', msg);
    } finally {
      setGoogleBusy(false);
    }
  };

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setErrorMsg('Please enter your email address.');
      return;
    }
    if (password.length < 6) {
      setErrorMsg('Password must be at least 6 characters.');
      return;
    }
    if (mode === 'signup' && !consentAccepted) {
      setErrorMsg('Please read the privacy notice and tick the consent box before creating an account.');
      return;
    }

    setEmailBusy(true);
    try {
      if (mode === 'signup') {
        const result = await signupWithServerGate(cleanEmail, password, consentAccepted);
        if (!result.ok) {
          const msg = result.error || 'Could not create your account right now.';
          setErrorMsg(msg);
          onNotify('error', msg);
          return;
        }

        const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
        if (result.verificationSent) {
          onNotify('success', 'Account created. Verification link sent to your email.');
        } else {
          onNotify(
            'error',
            'Account created, but we could not send the verification email yet. Tap Resend email below.',
          );
        }
        onSignedIn(Boolean(cred.user.emailVerified));
        onClose();
      } else {
        const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
        const audit = await postAuthAuditEvent(cred.user, 'login', true);
        if (!audit.ok) {
          await signOut(auth).catch(() => undefined);
          const msg = audit.error || 'Could not complete sign in.';
          setErrorMsg(msg);
          onNotify('error', msg);
          return;
        }
        if (audit.moderationStatus === 'suspended') {
          onNotify('error', 'Your account is currently suspended pending admin review.');
        } else if (audit.moderationStatus === 'pending_review') {
          onNotify('error', 'Your account is paused for admin review.');
        }
        onSignedIn(Boolean(cred.user.emailVerified));
        onClose();
      }
    } catch (err) {
      const msg = mapAuthError(err);
      setErrorMsg(msg);
      onNotify('error', msg);
    } finally {
      setEmailBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 overflow-y-auto"
    >
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 space-y-5 my-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="auth-modal-title" className="text-lg font-semibold text-slate-900">
              {pendingGoogleUser
                ? 'Confirm account privacy notice'
                : mode === 'signin'
                  ? 'Sign in to PulseLine'
                  : 'Create your account'}
            </h2>
            <p className="text-xs text-slate-600 mt-1">
              {pendingGoogleUser
                ? 'This is a new Google account. Review the notice below to finish signup.'
                : 'Sign in with Google to start right away, or use email and verify your address with a link.'}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={handleClose}
            aria-label="Close sign in dialog"
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {errorMsg && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5 text-xs text-red-800">
            {errorMsg}
          </div>
        )}

        {pendingGoogleUser ? (
          <div className="space-y-4">
            <PrivacyNoticeBox
              consentAccepted={consentAccepted}
              onToggle={(checked) => {
                setConsentAccepted(checked);
                if (checked) setErrorMsg('');
              }}
            />
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void cancelPendingGoogleSignup()}
                className="flex-1 min-h-[42px] px-4 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void finishGoogleSignupWithConsent()}
                className="flex-1 min-h-[42px] px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5"
              >
                {googleBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Agree &amp; create account</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setMode('signin');
                  setErrorMsg('');
                }}
                className={`min-h-[36px] text-xs font-medium rounded-md transition-colors ${
                  mode === 'signin'
                    ? 'bg-white text-slate-900 border border-slate-200'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sign in
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setMode('signup');
                  setErrorMsg('');
                }}
                className={`min-h-[36px] text-xs font-medium rounded-md transition-colors ${
                  mode === 'signup'
                    ? 'bg-white text-slate-900 border border-slate-200'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Create account
              </button>
            </div>

            {mode === 'signup' && (
              <PrivacyNoticeBox
                consentAccepted={consentAccepted}
                onToggle={(checked) => {
                  setConsentAccepted(checked);
                  if (checked) setErrorMsg('');
                }}
              />
            )}

            <button
              type="button"
              disabled={busy}
              onClick={() => void handleGoogleSignIn()}
              className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-60 text-slate-900 text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors"
            >
              {googleBusy && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Continue with Google</span>
            </button>

            <div className="relative flex items-center">
              <div className="flex-1 border-t border-slate-200" />
              <span className="px-3 text-xs text-slate-400">or with email</span>
              <div className="flex-1 border-t border-slate-200" />
            </div>

            <form onSubmit={handleEmailSubmit} className="space-y-3.5">
              <div>
                <label htmlFor="auth-email" className="block text-xs font-medium text-slate-700 mb-1">
                  Email address
                </label>
                <input
                  id="auth-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                />
              </div>

              <div>
                <label htmlFor="auth-password" className="block text-xs font-medium text-slate-700 mb-1">
                  Password
                </label>
                <input
                  id="auth-password"
                  type="password"
                  required
                  minLength={6}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full min-h-[44px] px-4 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors"
              >
                {emailBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                <span>{mode === 'signup' ? 'Create account & send link' : 'Sign in with email'}</span>
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
