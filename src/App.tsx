import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import {
  Bell,
  Droplets,
  Home,
  Hospital,
  LogIn,
  LogOut,
  Map as MapIcon,
  MessageSquare,
  Search,
  User as UserIcon,
} from 'lucide-react';
import { ChatView } from './components/ChatView.tsx';
import { DonorProfileView } from './components/DonorProfileView.tsx';
import { DonorSearchView } from './components/DonorSearchView.tsx';
import { EmergencyBoardView } from './components/EmergencyBoardView.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { HomeView } from './components/HomeView.tsx';
import { MapView } from './components/MapView.tsx';
import { NotificationsView } from './components/NotificationsView.tsx';
import { ToastPopup, type ToastState } from './components/ToastPopup.tsx';
import { UsernameSetupView } from './components/UsernameSetupView.tsx';
import {
  isValidUsername,
  makeChatId,
  normalizeChatThread,
  normalizeNotification,
  normalizeUsernameInput,
} from './lib/eligibility.ts';
import { auth, db, googleProvider } from './lib/firebase.ts';
import type { AppNotification, ChatThread } from './types.ts';

type ActiveTab = 'home' | 'search' | 'emergency' | 'map' | 'chat' | 'alerts' | 'profile';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('home');
  const [openRequestForm, setOpenRequestForm] = useState(false);

  const [accountLoading, setAccountLoading] = useState(false);
  const [accountResolvedUid, setAccountResolvedUid] = useState<string | null>(null);
  const [myUsername, setMyUsername] = useState<string | null>(null);
  const [needsUsername, setNeedsUsername] = useState(false);
  const [suggestedUsername, setSuggestedUsername] = useState('');
  const [hasLegacyDonorProfile, setHasLegacyDonorProfile] = useState(false);

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);

  const [chats, setChats] = useState<ChatThread[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

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

  // Load account username & trigger automatic legacy donor migration if username exists
  useEffect(() => {
    if (!authReady || !user) {
      setAccountLoading(false);
      setAccountResolvedUid(null);
      setMyUsername(null);
      setNeedsUsername(false);
      setSuggestedUsername('');
      setHasLegacyDonorProfile(false);
      return;
    }

    let cancelled = false;
    setAccountLoading(true);
    (async () => {
      try {
        const token = await user.getIdToken();
        const res = await fetch('/api/account/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          throw new Error('Could not load account profile.');
        }
        const data = (await res.json()) as {
          username: string | null;
          needsUsername: boolean;
          suggestedUsername?: string;
          hasLegacyDonorProfile?: boolean;
        };
        if (cancelled) return;
        setMyUsername(data.username || null);
        setNeedsUsername(Boolean(data.needsUsername || !data.username));
        setSuggestedUsername(data.suggestedUsername || '');
        setHasLegacyDonorProfile(Boolean(data.hasLegacyDonorProfile));
      } catch (err) {
        console.error('Failed to bootstrap account:', err);
        if (!cancelled) {
          setMyUsername(null);
          setNeedsUsername(true);
        }
      } finally {
        if (!cancelled) {
          setAccountResolvedUid(user.uid);
          setAccountLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authReady, user]);

  // Listen to notifications for signed-in user
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

  // Listen to 1-to-1 chats for signed-in user once username is set
  useEffect(() => {
    if (!authReady || !user || !myUsername || needsUsername) {
      setChats([]);
      setChatsLoading(false);
      setSelectedChatId(null);
      return;
    }

    setChatsLoading(true);
    const qChats = query(
      collection(db, 'chats'),
      where('participantIds', 'array-contains', user.uid),
    );
    const unsub = onSnapshot(
      qChats,
      (snap) => {
        const list = snap.docs.map((d) =>
          normalizeChatThread(d.data() as Record<string, unknown>, d.id),
        );
        setChats(list);
        setChatsLoading(false);
      },
      (err) => {
        console.error('Failed to listen to chats:', err);
        setChatsLoading(false);
      },
    );

    return () => unsub();
  }, [authReady, user, myUsername, needsUsername]);

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
      setSelectedChatId(null);
      setActiveTab('home');
    } catch {
      showToast('error', 'Could not sign out right now. Please try again.');
    }
  };

  const handleStartChat = useCallback(
    async (targetUid: string, targetUsername: string) => {
      if (!user || !myUsername) {
        showToast('error', 'Choose your username first before sending messages.');
        return;
      }
      if (!targetUid || targetUid === user.uid) {
        return;
      }

      const cleanTargetUsername = normalizeUsernameInput(targetUsername);
      if (!isValidUsername(cleanTargetUsername)) {
        showToast('error', 'This donor must finish setting up a username before messaging.');
        return;
      }

      const chatId = makeChatId(user.uid, targetUid);
      try {
        const existing = chats.find((c) => c.id === chatId);
        if (!existing) {
          const chatRef = doc(db, 'chats', chatId);
          const snap = await getDoc(chatRef);
          if (!snap.exists()) {
            const [p1Uid, p2Uid] = [user.uid, targetUid].sort();
            const p1Username = p1Uid === user.uid ? myUsername : cleanTargetUsername;
            const p2Username = p2Uid === user.uid ? myUsername : cleanTargetUsername;

            await setDoc(chatRef, {
              participantIds: [p1Uid, p2Uid],
              p1Uid,
              p2Uid,
              p1Username,
              p2Username,
              p1Unread: 0,
              p2Unread: 0,
              blockedByP1: false,
              blockedByP2: false,
              lastMessageText: '',
              lastMessageSenderId: '',
              lastMessageAt: null,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
        }
        setSelectedChatId(chatId);
        setActiveTab('chat');
      } catch (err) {
        console.error('Failed to open chat:', err);
        showToast('error', 'Could not open chat. Please try again.');
      }
    },
    [user, myUsername, chats, showToast],
  );

  const unreadAlertCount = notifications.filter((n) => !n.read).length;
  const unreadChatCount = user
    ? chats.reduce(
        (sum, c) => sum + (c.p1Uid === user.uid ? c.p1Unread : c.p2Unread),
        0,
      )
    : 0;

  const navItems: Array<{
    id: ActiveTab;
    label: string;
    shortLabel: string;
    icon: typeof Search;
    badge?: number;
  }> = [
    { id: 'home', label: 'Home', shortLabel: 'Home', icon: Home },
    { id: 'search', label: 'Find Donors', shortLabel: 'Donors', icon: Search },
    { id: 'emergency', label: 'Emergency Board', shortLabel: 'Urgent', icon: Hospital },
    { id: 'map', label: 'Map View', shortLabel: 'Map', icon: MapIcon },
    { id: 'chat', label: 'Messages', shortLabel: 'Chat', icon: MessageSquare, badge: unreadChatCount },
    { id: 'alerts', label: 'Alerts', shortLabel: 'Alerts', icon: Bell, badge: unreadAlertCount },
    { id: 'profile', label: 'My Profile', shortLabel: 'Profile', icon: UserIcon },
  ];

  const effectiveTab: ActiveTab = !user ? 'home' : activeTab;
  const accountPending = Boolean(user && (accountLoading || accountResolvedUid !== user.uid));
  const requiresUsernameGate = Boolean(user && effectiveTab !== 'home' && !accountPending && needsUsername);

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
        <header className="sticky top-0 z-30 h-14 bg-white border-b border-slate-200">
          <div className="max-w-6xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-4">
            <button
              type="button"
              onClick={() => setActiveTab('home')}
              className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 flex items-center gap-2"
            >
              <Droplets className="w-5 h-5 text-red-600 shrink-0" />
              <span>PulseLine</span>
            </button>

            {user && (
              <nav className="hidden md:flex items-center gap-4 lg:gap-5 text-sm font-medium text-slate-600">
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

            <div className="flex items-center gap-2.5 shrink-0">
              {user && myUsername && (
                <span className="hidden lg:inline font-mono-tabular text-xs font-medium text-slate-600 whitespace-nowrap">
                  @{myUsername}
                </span>
              )}
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

          {user && effectiveTab !== 'home' && accountPending && (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-600">
              Loading your account...
            </div>
          )}

          {user && requiresUsernameGate && (
            <UsernameSetupView
              user={user}
              suggestedUsername={suggestedUsername}
              hasLegacyDonorProfile={hasLegacyDonorProfile}
              onComplete={(nextUsername) => {
                setMyUsername(nextUsername);
                setNeedsUsername(false);
                setHasLegacyDonorProfile(false);
              }}
              onNotify={showToast}
            />
          )}

          {user && !accountPending && !requiresUsernameGate && effectiveTab === 'search' && (
            <DonorSearchView
              user={user}
              onStartChat={(uid, username) => void handleStartChat(uid, username)}
              onNotify={showToast}
            />
          )}

          {user && !accountPending && !requiresUsernameGate && effectiveTab === 'emergency' && (
            <EmergencyBoardView
              user={user}
              onNotify={showToast}
              initialOpenForm={openRequestForm}
              onFormOpened={() => setOpenRequestForm(false)}
            />
          )}

          {user && !accountPending && !requiresUsernameGate && effectiveTab === 'map' && (
            <MapView
              user={user}
              onStartChat={(uid, username) => void handleStartChat(uid, username)}
              onNotify={showToast}
            />
          )}

          {user && !accountPending && !requiresUsernameGate && myUsername && effectiveTab === 'chat' && (
            <ChatView
              user={user}
              myUsername={myUsername}
              chats={chats}
              chatsLoading={chatsLoading}
              selectedChatId={selectedChatId}
              onSelectChat={setSelectedChatId}
              onNotify={showToast}
            />
          )}

          {user && !accountPending && !requiresUsernameGate && effectiveTab === 'alerts' && (
            <NotificationsView
              notifications={notifications}
              loading={notifLoading}
              onNotify={showToast}
            />
          )}

          {user && !accountPending && !requiresUsernameGate && myUsername && effectiveTab === 'profile' && (
            <DonorProfileView
              user={user}
              myUsername={myUsername}
              onUsernameUpdated={(nextUsername) => setMyUsername(nextUsername)}
              onNotify={showToast}
            />
          )}
        </main>

        {user && (
          <nav
            aria-label="Primary mobile navigation"
            className="md:hidden fixed bottom-0 left-0 right-0 z-40 h-16 bg-white border-t border-slate-200 grid grid-cols-7 items-center"
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
