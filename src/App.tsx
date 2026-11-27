import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  Bell,
  Droplets,
  Home,
  Hospital,
  LogIn,
  LogOut,
  Map as MapIcon,
  Search,
  User as UserIcon,
} from 'lucide-react';
import { DonorProfileView } from './components/DonorProfileView.tsx';
import { DonorSearchView } from './components/DonorSearchView.tsx';
import { EmergencyBoardView } from './components/EmergencyBoardView.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { HomeView } from './components/HomeView.tsx';
import { MapView } from './components/MapView.tsx';
import { NotificationsView } from './components/NotificationsView.tsx';
import { ToastPopup, type ToastState } from './components/ToastPopup.tsx';
import { normalizeNotification } from './lib/eligibility.ts';
import { auth, db, googleProvider } from './lib/firebase.ts';
import type { AppNotification } from './types.ts';

type ActiveTab = 'home' | 'search' | 'emergency' | 'map' | 'alerts' | 'profile';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('home');
  const [openRequestForm, setOpenRequestForm] = useState(false);

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ id: Date.now() + Math.random(), type, message });
  }, []);

  const clearToast = useCallback(() => {
    setToast(null);
  }, []);

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
        console.error('Failed to listen to notifications:', err);
        setNotifLoading(false);
      },
    );

    return () => unsub();
  }, [authReady, user]);

  const handleSignIn = async (redirectTarget?: 'profile' | 'search' | 'emergency') => {
    setSigningIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
      if (redirectTarget) {
        if (redirectTarget === 'emergency') {
          setOpenRequestForm(true);
        }
        setActiveTab(redirectTarget);
      }
    } catch {
      showToast('error', 'Could not complete sign in. Please try again.');
    } finally {
      setSigningIn(false);
    }
  };

  const handleHomeAction = (target: 'profile' | 'search' | 'emergency') => {
    if (user) {
      if (target === 'emergency') {
        setOpenRequestForm(true);
      }
      setActiveTab(target);
      return;
    }
    void handleSignIn(target);
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setOpenRequestForm(false);
      setActiveTab('home');
    } catch {
      showToast('error', 'Could not sign out right now. Please try again.');
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
    { id: 'home', label: 'Home', shortLabel: 'Home', icon: Home },
    { id: 'search', label: 'Find Donors', shortLabel: 'Donors', icon: Search },
    { id: 'emergency', label: 'Emergency Board', shortLabel: 'Requests', icon: Hospital },
    { id: 'map', label: 'Map View', shortLabel: 'Map', icon: MapIcon },
    { id: 'alerts', label: 'Alerts', shortLabel: 'Alerts', icon: Bell, badge: unreadCount },
    { id: 'profile', label: 'My Profile', shortLabel: 'Profile', icon: UserIcon },
  ];

  const effectiveTab: ActiveTab = !user ? 'home' : activeTab;

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
        <header className="sticky top-0 z-30 h-14 bg-white border-b border-slate-200">
          <div className="max-w-6xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-6">
            <button
              type="button"
              onClick={() => setActiveTab('home')}
              className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 flex items-center gap-2"
            >
              <Droplets className="w-5 h-5 text-red-600 shrink-0" />
              <span>PulseLine</span>
            </button>

            {user && (
              <nav className="hidden md:flex items-center gap-5 text-sm font-medium text-slate-600">
                {navItems.map((item) => {
                  const isActive = effectiveTab === item.id;
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
                <span className="text-xs text-slate-500 whitespace-nowrap">Loading...</span>
              ) : user ? (
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  className="min-h-[38px] px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign out
                </button>
              ) : (
                <button
                  type="button"
                  disabled={signingIn}
                  onClick={() => void handleSignIn()}
                  className="min-h-[38px] px-4 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  {signingIn ? 'Signing in...' : 'Sign in with Google'}
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-24 md:pb-10">
          {effectiveTab === 'home' && (
            <HomeView
              isSignedIn={Boolean(user)}
              signingIn={signingIn}
              onAction={handleHomeAction}
            />
          )}

          {user && effectiveTab === 'search' && (
            <DonorSearchView user={user} onNotify={showToast} />
          )}

          {user && effectiveTab === 'emergency' && (
            <EmergencyBoardView
              user={user}
              onNotify={showToast}
              initialOpenForm={openRequestForm}
              onFormOpened={() => setOpenRequestForm(false)}
            />
          )}

          {user && effectiveTab === 'map' && (
            <MapView user={user} onNotify={showToast} />
          )}

          {user && effectiveTab === 'alerts' && (
            <NotificationsView
              notifications={notifications}
              loading={notifLoading}
              onNotify={showToast}
            />
          )}

          {user && effectiveTab === 'profile' && (
            <DonorProfileView user={user} onNotify={showToast} />
          )}
        </main>

        {user && (
          <nav
            aria-label="Primary mobile navigation"
            className="md:hidden fixed bottom-0 left-0 right-0 z-40 h-16 bg-white border-t border-slate-200 grid grid-cols-6 items-center"
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = effectiveTab === item.id;
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

        <ToastPopup toast={toast} onClose={clearToast} />
      </div>
    </ErrorBoundary>
  );
}
