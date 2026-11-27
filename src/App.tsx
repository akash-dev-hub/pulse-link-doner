import { useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  Bell,
  Droplets,
  Hospital,
  LogIn,
  LogOut,
  Map as MapIcon,
  Search,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';
import { DonorProfileView } from './components/DonorProfileView.tsx';
import { DonorSearchView } from './components/DonorSearchView.tsx';
import { EmergencyBoardView } from './components/EmergencyBoardView.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { MapView } from './components/MapView.tsx';
import { NotificationsView } from './components/NotificationsView.tsx';
import { normalizeNotification } from './lib/eligibility.ts';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
} from './lib/firebase.ts';
import type { AppNotification } from './types.ts';

type ActiveTab = 'search' | 'emergency' | 'map' | 'alerts' | 'profile';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('search');

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!authReady || !user) {
      setNotifications([]);
      setNotifLoading(false);
      return;
    }

    setNotifLoading(true);
    const qNotif = query(
      collection(db, 'notifications'),
      where('recipientId', '==', user.uid),
    );
    const unsub = onSnapshot(
      qNotif,
      (snap) => {
        const list = snap.docs.map((d) =>
          normalizeNotification(d.data() as Record<string, unknown>, d.id),
        );
        setNotifications(list);
        setNotifLoading(false);
      },
      (err) => {
        setNotifLoading(false);
        handleFirestoreError(err, OperationType.LIST, 'notifications');
      },
    );

    return () => unsub();
  }, [authReady, user]);

  const handleSignIn = async () => {
    setSigningIn(true);
    setAuthError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Sign in failed. Please try again.',
      );
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setActiveTab('search');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign out failed.');
    }
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  const navItems: Array<{
    id: ActiveTab;
    label: string;
    shortLabel: string;
    icon: typeof Search;
    badge?: number;
  }> = [
    { id: 'search', label: 'Find Donors', shortLabel: 'Search', icon: Search },
    { id: 'emergency', label: 'Emergency Board', shortLabel: 'Emergency', icon: Hospital },
    { id: 'map', label: 'Map View', shortLabel: 'Map', icon: MapIcon },
    { id: 'alerts', label: 'Alerts', shortLabel: 'Alerts', icon: Bell, badge: unreadCount },
    { id: 'profile', label: 'My Profile', shortLabel: 'Profile', icon: UserIcon },
  ];

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
        {/* Top Bar Contract: 3 zones (wordmark — nav links — primary action) */}
        <header className="sticky top-0 z-30 h-14 bg-white/95 backdrop-blur-md border-b border-slate-200">
          <div className="max-w-6xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-8">
            <button
              type="button"
              onClick={() => setActiveTab('search')}
              className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 flex items-center gap-2"
            >
              <Droplets className="w-5 h-5 text-red-600 shrink-0" />
              <span>PulseLine</span>
            </button>

            {user && (
              <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
                {navItems.map((item) => {
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveTab(item.id)}
                      className={`py-1 whitespace-nowrap shrink-0 border-b-2 transition-colors flex items-center gap-1.5 ${
                        isActive
                          ? 'text-slate-900 border-red-600 font-semibold'
                          : 'text-slate-600 border-transparent hover:text-slate-900'
                      }`}
                    >
                      <span>{item.label}</span>
                      {typeof item.badge === 'number' && item.badge > 0 && (
                        <span className="font-mono-tabular text-xs font-bold text-red-700">
                          ({item.badge})
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>
            )}

            <div className="flex items-center gap-3 shrink-0">
              {!authReady ? (
                <span className="text-xs text-slate-500 whitespace-nowrap">Checking session...</span>
              ) : user ? (
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  className="min-h-[38px] px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-xl flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign out
                </button>
              ) : (
                <button
                  type="button"
                  disabled={signingIn}
                  onClick={() => void handleSignIn()}
                  className="min-h-[38px] px-4 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-xl flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  Sign in with Google
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-24 md:pb-10">
          {!authReady ? (
            <div className="py-16 text-center text-sm text-slate-500">
              Loading PulseLine...
            </div>
          ) : !user ? (
            <div className="max-w-3xl mx-auto py-8 sm:py-14 space-y-8">
              <section className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-10 space-y-6">
                <div className="space-y-3">
                  <p className="text-xs font-semibold text-red-700 tracking-wide">
                    Verified Blood Donor Network
                  </p>
                  <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
                    Connect hospitals with eligible blood donors in minutes
                  </h1>
                  <p className="text-base text-slate-600 leading-relaxed max-w-2xl">
                    Search eligible donors by blood group and location, post emergency hospital blood requests, inspect live approximate donor areas, and receive local alerts while keeping private contact details and exact addresses protected.
                  </p>
                </div>

                {authError && (
                  <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
                    {authError}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-4">
                  <button
                    type="button"
                    disabled={signingIn}
                    onClick={() => void handleSignIn()}
                    className="min-h-[48px] px-6 py-3 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl flex items-center gap-2 transition-colors"
                  >
                    <LogIn className="w-4 h-4" />
                    {signingIn ? 'Signing in...' : 'Sign in with Google to continue'}
                  </button>
                  <span className="text-xs text-slate-500 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                    Sign-in protects donor contact privacy and request ownership
                  </span>
                </div>
              </section>

              <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-1.5">
                  <h2 className="text-sm font-semibold text-slate-900">90-Day Eligibility</h2>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Donors who gave blood in the past 90 days are automatically excluded from search, maps, and alerts.
                  </p>
                </div>
                <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-1.5">
                  <h2 className="text-sm font-semibold text-slate-900">Locality-First Alerts</h2>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Emergency hospital posts notify matching eligible donors in the city, prioritizing same-locality donors first.
                  </p>
                </div>
                <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-1.5">
                  <h2 className="text-sm font-semibold text-slate-900">Privacy by Rules</h2>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Private contacts and exact coordinates are stored separately and enforced with Firestore rules and server checks.
                  </p>
                </div>
              </section>
            </div>
          ) : (
            <>
              {activeTab === 'search' && <DonorSearchView user={user} />}
              {activeTab === 'emergency' && <EmergencyBoardView user={user} />}
              {activeTab === 'map' && <MapView user={user} />}
              {activeTab === 'alerts' && (
                <NotificationsView notifications={notifications} loading={notifLoading} />
              )}
              {activeTab === 'profile' && <DonorProfileView user={user} />}
            </>
          )}
        </main>

        {/* Mobile Bottom Tab Bar (hidden on md+, combined height with top bar <= 15% of viewport) */}
        {user && (
          <nav
            aria-label="Primary mobile navigation"
            className="md:hidden fixed bottom-0 left-0 right-0 z-40 h-16 bg-white/95 backdrop-blur-md border-t border-slate-200 grid grid-cols-5 items-center"
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`relative h-full min-h-[44px] flex flex-col items-center justify-center gap-0.5 transition-colors ${
                    isActive ? 'text-red-600 font-semibold' : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  <div className="relative">
                    <Icon className="w-5 h-5" />
                    {typeof item.badge === 'number' && item.badge > 0 && (
                      <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white font-mono-tabular text-[10px] font-bold flex items-center justify-center">
                        {item.badge > 9 ? '9+' : item.badge}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] tracking-tight whitespace-nowrap">
                    {item.shortLabel}
                  </span>
                </button>
              );
            })}
          </nav>
        )}
      </div>
    </ErrorBoundary>
  );
}
