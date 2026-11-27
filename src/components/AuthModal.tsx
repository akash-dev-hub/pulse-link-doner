import { useState, type FormEvent } from 'react';
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
} from 'firebase/auth';
import { Loader2, Mail, X } from 'lucide-react';
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

export function AuthModal({ open, onClose, onSignedIn, onNotify }: AuthModalProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [googleBusy, setGoogleBusy] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  if (!open) return null;

  const busy = googleBusy || emailBusy;

  const handleGoogleSignIn = async () => {
    setErrorMsg('');
    setGoogleBusy(true);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
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

    setEmailBusy(true);
    try {
      if (mode === 'signup') {
        const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
        try {
          await sendEmailVerification(cred.user);
          onNotify('success', 'Account created. Verification link sent to your email.');
        } catch {
          onNotify(
            'error',
            'Account created, but we could not send the verification email yet. Tap Resend email below.',
          );
        }
        onSignedIn(Boolean(cred.user.emailVerified));
        onClose();
      } else {
        const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40"
    >
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="auth-modal-title" className="text-lg font-semibold text-slate-900">
              {mode === 'signin' ? 'Sign in to PulseLine' : 'Create your account'}
            </h2>
            <p className="text-xs text-slate-600 mt-1">
              Sign in with Google to start right away, or use email and verify your address with a link.
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
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
      </div>
    </div>
  );
}
