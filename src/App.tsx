import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, sendEmailVerification, signOut, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  Bell,
  Building2,
  Droplets,
  Home,
  Hospital,
  LogIn,
  LogOut,
  Map as MapIcon,
  MessageSquare,
  Search,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';
import { AdminView } from './components/AdminView.tsx';
import { AuthModal } from './components/AuthModal.tsx';
import { ChatView } from './components/ChatView.tsx';
import { DonorProfileView } from './components/DonorProfileView.tsx';
import { DonorSearchView } from './components/DonorSearchView.tsx';
import { EmailVerificationNotice } from './components/EmailVerificationNotice.tsx';
import { EmergencyAlertModal } from './components/EmergencyAlertModal.tsx';
import { EmergencyBoardView } from './components/EmergencyBoardView.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { HomeView } from './components/HomeView.tsx';
import { HospitalsView } from './components/HospitalsView.tsx';
import { MapView } from './components/MapView.tsx';
import { NotificationsView } from './components/NotificationsView.tsx';
import { ReportModal, type ReportTargetDraft } from './components/ReportModal.tsx';
import { ToastPopup, type ToastState } from './components/ToastPopup.tsx';
import { UsernameSetupView } from './components/UsernameSetupView.tsx';
import {
  isValidUserRole,
  isValidUsername,
  makeChatId,
  makeRequestResponseId,
  normalizeChatThread,
  normalizeDonorPublic,
  normalizeNotification,
  normalizeUsernameInput,
} from './lib/eligibility.ts';
import {
  getBrowserNotificationPermission,
  showEmergencyBrowserNotification,
  startLoopingAlarm,
  stopLoopingAlarm,
  unlockEmergencyAudio,
  type BrowserNotificationPermission,
} from './lib/emergencyAlertAudio.ts';
import { auth, db } from './lib/firebase.ts';
import type {
  AccountModerationStatus,
  AppNotification,
  ChatThread,
  DonorPublic,
  HospitalApprovalStatus,
  UserRole,
} from './types.ts';

type ActiveTab = 'home' | 'search' | 'hospitals' | 'emergency' | 'map' | 'chat' | 'alerts' | 'profile' | 'admin';
const ALERTS_STORAGE_PREFIX = 'pulseline_emergency_alerts_';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [verificationRefreshKey, setVerificationRefreshKey] = useState(0);
  const [authReady, setAuthReady] = useState(false);

  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [pendingRedirect, setPendingRedirect] = useState<
    'profile' | 'search' | 'emergency' | 'hospitals' | null
  >(null);
  const [resendingVerification, setResendingVerification] = useState(false);
  const [checkingVerification, setCheckingVerification] = useState(false);

  const [activeTab, setActiveTab] = useState<ActiveTab>('home');
  const [openRequestForm, setOpenRequestForm] = useState(false);

  const [accountLoading, setAccountLoading] = useState(false);
  const [accountResolvedKey, setAccountResolvedKey] = useState<string | null>(null);
  const [myUsername, setMyUsername] = useState<string | null>(null);
  const [needsUsername, setNeedsUsername] = useState(false);
  const [suggestedUsername, setSuggestedUsername] = useState('');
  const [hasLegacyDonorProfile, setHasLegacyDonorProfile] = useState(false);
  const [userRole, setUserRole] = useState<UserRole>('requester');
  const [isAdmin, setIsAdmin] = useState(false);
  const [hospitalStatus, setHospitalStatus] = useState<HospitalApprovalStatus | null>(null);
  const [moderationStatus, setModerationStatus] = useState<AccountModerationStatus>('active');
  const [moderationNote, setModerationNote] = useState('');
  const [reportTarget, setReportTarget] = useState<ReportTargetDraft | null>(null);

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);

  const [chats, setChats] = useState<ChatThread[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

  const [toast, setToast] = useState<ToastState | null>(null);

  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<BrowserNotificationPermission>(() =>
    getBrowserNotificationPermission(),
  );
  const [donorPublicProfile, setDonorPublicProfile] = useState<DonorPublic | null>(null);
  const [activeEmergencyAlert, setActiveEmergencyAlert] = useState<AppNotification | null>(null);
  const [alertSecondsLeft, setAlertSecondsLeft] = useState(30);
  const [respondingAlert, setRespondingAlert] = useState(false);

  const alertsEnabledRef = useRef(alertsEnabled);
  const emailVerifiedRef = useRef(emailVerified);
  const userRoleRef = useRef(userRole);
  const donorPublicRef = useRef<DonorPublic | null>(donorPublicProfile);
  const notifInitializedUidRef = useRef<string | null>(null);
  const seenNotifIdsRef = useRef<Set<string>>(new Set());
  const alarmTimeoutRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const browserNotificationRef = useRef<Notification | null>(null);

  alertsEnabledRef.current = alertsEnabled;
  emailVerifiedRef.current = emailVerified;
  userRoleRef.current = userRole;
  donorPublicRef.current = donorPublicProfile;

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ id: Date.now() + Math.random(), type, message });
  }, []);

  const clearToast = useCallback(() => {
    setToast(null);
  }, []);

  const stopActiveEmergencyAlert = useCallback(() => {
    stopLoopingAlarm();
    if (alarmTimeoutRef.current !== null) {
      window.clearTimeout(alarmTimeoutRef.current);
      alarmTimeoutRef.current = null;
    }
    if (countdownIntervalRef.current !== null) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    if (browserNotificationRef.current) {
      try {
        browserNotificationRef.current.close();
      } catch {
        // ignore close error
      }
      browserNotificationRef.current = null;
    }
    setActiveEmergencyAlert(null);
    setAlertSecondsLeft(30);
  }, []);

  useEffect(() => {
    return () => {
      stopActiveEmergencyAlert();
    };
  }, [stopActiveEmergencyAlert]);

  useEffect(() => {
    const syncPerm = () => {
      setNotificationPermission(getBrowserNotificationPermission());
    };
    window.addEventListener('focus', syncPerm);
    return () => window.removeEventListener('focus', syncPerm);
  }, []);

  useEffect(() => {
    if (!user) {
      setAlertsEnabled(false);
      stopActiveEmergencyAlert();
      return;
    }
    try {
      const saved = window.localStorage.getItem(`${ALERTS_STORAGE_PREFIX}${user.uid}`);
      setAlertsEnabled(saved === 'true');
    } catch {
      setAlertsEnabled(false);
    }
  }, [user, stopActiveEmergencyAlert]);

  // If donor previously enabled alerts and reloaded the tab, silently re-unlock Web Audio on first user interaction
  useEffect(() => {
    if (!user || !alertsEnabled) return;
    const handleUnlock = () => {
      void unlockEmergencyAudio(false);
    };
    window.addEventListener('pointerdown', handleUnlock, { once: true, passive: true });
    window.addEventListener('keydown', handleUnlock, { once: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', handleUnlock);
      window.removeEventListener('keydown', handleUnlock);
    };
  }, [user, alertsEnabled]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setEmailVerified(Boolean(nextUser?.emailVerified));
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  const currentAccountKey = user ? `${user.uid}:${emailVerified ? '1' : '0'}:${verificationRefreshKey}` : null;

  // Load account status & trigger automatic legacy donor migration once verified
  useEffect(() => {
    if (!authReady || !user || !currentAccountKey) {
      setAccountLoading(false);
      setAccountResolvedKey(null);
      setMyUsername(null);
      setNeedsUsername(false);
      setSuggestedUsername('');
      setHasLegacyDonorProfile(false);
      setUserRole('requester');
      setIsAdmin(false);
      setHospitalStatus(null);
      setModerationStatus('active');
      setModerationNote('');
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
          emailVerified?: boolean;
          needsUsername: boolean;
          suggestedUsername?: string;
          hasLegacyDonorProfile?: boolean;
          role?: UserRole;
          isAdmin?: boolean;
          hospitalStatus?: HospitalApprovalStatus | null;
          moderationStatus?: AccountModerationStatus;
          moderationNote?: string;
        };
        if (cancelled) return;
        const verifiedFromServer = Boolean(data.emailVerified ?? user.emailVerified);
        if (verifiedFromServer !== emailVerified) {
          setEmailVerified(verifiedFromServer);
        }
        setMyUsername(data.username || null);
        setNeedsUsername(verifiedFromServer ? Boolean(data.needsUsername || !data.username) : false);
        setSuggestedUsername(data.suggestedUsername || '');
        setHasLegacyDonorProfile(Boolean(data.hasLegacyDonorProfile));
        const resolvedRole = isValidUserRole(data.role) ? data.role : 'requester';
        setUserRole(resolvedRole);
        setIsAdmin(Boolean(verifiedFromServer && (data.isAdmin || resolvedRole === 'admin')));
        setHospitalStatus(data.hospitalStatus || null);
        setModerationStatus(
          data.moderationStatus === 'pending_review' || data.moderationStatus === 'suspended'
            ? data.moderationStatus
            : 'active',
        );
        setModerationNote(data.moderationNote || '');
      } catch (err) {
        console.error('Failed to bootstrap account:', err);
        if (!cancelled) {
          setMyUsername(null);
          setNeedsUsername(emailVerified);
          setUserRole('requester');
          setIsAdmin(false);
          setHospitalStatus(null);
          setModerationStatus('active');
          setModerationNote('');
        }
      } finally {
        if (!cancelled) {
          setAccountResolvedKey(currentAccountKey);
          setAccountLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authReady, user, emailVerified, verificationRefreshKey, currentAccountKey]);

  // Listen to own donors_public record for donor-capable accounts
  useEffect(() => {
    if (!authReady || !user || !emailVerified || (userRole !== 'donor' && userRole !== 'admin')) {
      setDonorPublicProfile(null);
      return;
    }
    const unsub = onSnapshot(
      doc(db, 'donors_public', user.uid),
      (snap) => {
        if (snap.exists()) {
          setDonorPublicProfile(normalizeDonorPublic(snap.data() as Record<string, unknown>, snap.id));
        } else {
          setDonorPublicProfile(null);
        }
      },
      () => {
        setDonorPublicProfile(null);
      },
    );
    return () => unsub();
  }, [authReady, user, emailVerified, userRole]);

  const triggerIncomingEmergencyAlert = useCallback(
    async (notif: AppNotification) => {
      if (!user) return;
      try {
        const existingResp = await getDoc(
          doc(db, 'request_responses', makeRequestResponseId(notif.requestId, user.uid)),
        );
        if (existingResp.exists()) {
          return;
        }
      } catch {
        // Proceed with alert if pre-check fails transiently
      }

      if (!alertsEnabledRef.current) return;

      stopActiveEmergencyAlert();
      setActiveEmergencyAlert(notif);
      setAlertSecondsLeft(30);

      startLoopingAlarm();
      browserNotificationRef.current = showEmergencyBrowserNotification(notif, () => {
        setActiveTab('alerts');
      });

      countdownIntervalRef.current = window.setInterval(() => {
        setAlertSecondsLeft((prev) => (prev > 1 ? prev - 1 : 0));
      }, 1000);

      alarmTimeoutRef.current = window.setTimeout(() => {
        stopActiveEmergencyAlert();
      }, 30_000);
    },
    [user, stopActiveEmergencyAlert],
  );

  // Listen to notifications for signed-in user
  useEffect(() => {
    if (!authReady || !user) {
      setNotifications([]);
      setNotifLoading(false);
      notifInitializedUidRef.current = null;
      seenNotifIdsRef.current = new Set();
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

        if (notifInitializedUidRef.current !== user.uid) {
          seenNotifIdsRef.current = new Set(list.map((n) => n.id));
          notifInitializedUidRef.current = user.uid;
          return;
        }

        const newlyArrived = list.filter((n) => !seenNotifIdsRef.current.has(n.id));
        for (const n of newlyArrived) {
          seenNotifIdsRef.current.add(n.id);
        }

        if (
          newlyArrived.length === 0 ||
          !alertsEnabledRef.current ||
          !emailVerifiedRef.current ||
          (userRoleRef.current !== 'donor' && userRoleRef.current !== 'admin')
        ) {
          return;
        }

        const donor = donorPublicRef.current;
        const nowMs = Date.now();
        if (!donor || !donor.visibleInSearch || donor.eligibleAfterMs > nowMs) {
          return;
        }

        const matching = newlyArrived
          .filter(
            (n) =>
              !n.read &&
              n.bloodGroup === donor.bloodGroup,
          )
          .sort((a, b) => {
            const weight = (u: AppNotification['urgency']) =>
              u === 'critical' ? 0 : u === 'urgent' ? 1 : 2;
            const dw = weight(a.urgency) - weight(b.urgency);
            if (dw !== 0) return dw;
            if (a.sameLocality !== b.sameLocality) return Number(b.sameLocality) - Number(a.sameLocality);
            return b.createdAtMs - a.createdAtMs;
          });

        if (matching.length > 0) {
          void triggerIncomingEmergencyAlert(matching[0]);
        }
      },
      (err) => {
        console.error('Failed to listen to notifications:', err);
        setNotifLoading(false);
      },
    );

    return () => unsub();
  }, [authReady, user, triggerIncomingEmergencyAlert]);

  // Listen to 1-to-1 chats only when user is email-verified and has a username
  useEffect(() => {
    if (!authReady || !user || !emailVerified || !myUsername || needsUsername) {
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
  }, [authReady, user, emailVerified, myUsername, needsUsername]);

  const handleOpenSignIn = (
    redirectTarget?: 'profile' | 'search' | 'emergency' | 'hospitals',
  ) => {
    setPendingRedirect(redirectTarget || null);
    setAuthModalOpen(true);
  };

  const handleAuthSuccess = (verifiedNow: boolean) => {
    setEmailVerified(verifiedNow);
    const target = pendingRedirect;
    setPendingRedirect(null);
    if (target) {
      if (target === 'emergency') {
        setOpenRequestForm(true);
      }
      setActiveTab(target);
    }
  };

  const handleHomeAction = (target: 'profile' | 'search' | 'emergency' | 'hospitals') => {
    if (user) {
      if (target === 'emergency') {
        setOpenRequestForm(true);
      }
      setActiveTab(target);
      return;
    }
    handleOpenSignIn(target);
  };

  const handleSignOut = async () => {
    try {
      stopActiveEmergencyAlert();
      await signOut(auth);
      setOpenRequestForm(false);
      setSelectedChatId(null);
      setPendingRedirect(null);
      setUserRole('requester');
      setIsAdmin(false);
      setHospitalStatus(null);
      setModerationStatus('active');
      setModerationNote('');
      setReportTarget(null);
      setActiveTab('home');
    } catch {
      showToast('error', 'Could not sign out right now. Please try again.');
    }
  };

  const handleEnableEmergencyAlerts = useCallback(async () => {
    if (!user) return;
    await unlockEmergencyAudio(true);

    let perm = getBrowserNotificationPermission();
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      try {
        perm = await Notification.requestPermission();
      } catch {
        perm = getBrowserNotificationPermission();
      }
    }
    setNotificationPermission(perm);
    setAlertsEnabled(true);
    try {
      window.localStorage.setItem(`${ALERTS_STORAGE_PREFIX}${user.uid}`, 'true');
    } catch {
      // ignore storage failure
    }

    if (perm === 'denied') {
      showToast(
        'success',
        'Emergency alerts enabled for sound and popups (desktop notifications are blocked in browser settings).',
      );
    } else {
      showToast('success', 'Emergency alerts enabled');
    }
  }, [user, showToast]);

  const handleDisableEmergencyAlerts = useCallback(() => {
    stopActiveEmergencyAlert();
    setAlertsEnabled(false);
    if (user) {
      try {
        window.localStorage.setItem(`${ALERTS_STORAGE_PREFIX}${user.uid}`, 'false');
      } catch {
        // ignore storage failure
      }
    }
    showToast('success', 'Emergency alerts turned off');
  }, [user, stopActiveEmergencyAlert, showToast]);

  const handleEmergencyAlertDecision = useCallback(
    async (decision: 'accept' | 'decline') => {
      const currentAlert = activeEmergencyAlert;
      if (!user || !currentAlert) return;

      stopActiveEmergencyAlert();
      setRespondingAlert(true);
      try {
        const token = await user.getIdToken();
        const res = await fetch(`/api/requests/${currentAlert.requestId}/respond`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ decision }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          throw new Error(data.error || 'Could not save your response. Please try again.');
        }

        if (!currentAlert.read) {
          void updateDoc(doc(db, 'notifications', currentAlert.id), { read: true }).catch(() => undefined);
        }

        showToast(
          'success',
          decision === 'accept'
            ? 'Request accepted. Waiting for hospital verification.'
            : 'Request declined',
        );
      } catch (err) {
        const msg =
          err instanceof Error && err.message
            ? err.message
            : 'Could not save your response. Please try again.';
        showToast('error', msg);
      } finally {
        setRespondingAlert(false);
      }
    },
    [user, activeEmergencyAlert, stopActiveEmergencyAlert, showToast],
  );

  const handleResendVerification = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) return;
    setResendingVerification(true);
    try {
      await sendEmailVerification(current);
      showToast('success', 'Verification email sent');
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code || '')
          : '';
      if (code === 'auth/too-many-requests') {
        showToast('error', 'Verification email already sent recently. Please check your inbox.');
      } else {
        showToast('error', 'Could not send verification email right now. Please try again.');
      }
    } finally {
      setResendingVerification(false);
    }
  }, [showToast]);

  const handleCheckVerified = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) return;
    setCheckingVerification(true);
    try {
      await current.reload();
      await current.getIdToken(true);
      if (current.emailVerified) {
        setEmailVerified(true);
        setVerificationRefreshKey((k) => k + 1);
        showToast('success', 'Email verified');
      } else {
        showToast(
          'error',
          'Email is not verified yet. Open the link in your inbox, then tap I have verified.',
        );
      }
    } catch {
      showToast('error', 'Could not check verification status. Please try again.');
    } finally {
      setCheckingVerification(false);
    }
  }, [showToast]);

  const handleStartChat = useCallback(
    async (targetUid: string, targetUsername: string) => {
      if (!user) return;
      if (moderationStatus !== 'active') {
        showToast(
          'error',
          moderationStatus === 'suspended'
            ? 'Your account has been suspended. Messaging is disabled.'
            : 'Your account is pending admin review before you can start new chats.',
        );
        return;
      }
      if (!emailVerified) {
        showToast('error', 'Please verify your email first before messaging donors.');
        return;
      }
      if (!myUsername) {
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
    [user, emailVerified, myUsername, moderationStatus, chats, showToast],
  );

  const unreadAlertCount = notifications.filter((n) => !n.read).length;
  const unreadChatCount =
    user && emailVerified
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
    { id: 'hospitals', label: 'Hospitals', shortLabel: 'Banks', icon: Building2 },
    { id: 'emergency', label: 'Emergency', shortLabel: 'Urgent', icon: Hospital },
    { id: 'map', label: 'Map', shortLabel: 'Map', icon: MapIcon },
    { id: 'chat', label: 'Messages', shortLabel: 'Chat', icon: MessageSquare, badge: unreadChatCount },
    { id: 'alerts', label: 'Alerts', shortLabel: 'Alerts', icon: Bell, badge: unreadAlertCount },
    { id: 'profile', label: 'Profile', shortLabel: 'Profile', icon: UserIcon },
  ];

  const effectiveTab: ActiveTab = !user ? 'home' : activeTab;
  const accountPending = Boolean(
    user && currentAccountKey && (accountLoading || accountResolvedKey !== currentAccountKey),
  );
  const requiresUsernameGate = Boolean(
    user && emailVerified && effectiveTab !== 'home' && !accountPending && needsUsername,
  );
  const isUnverifiedSignedIn = Boolean(user && !emailVerified);
  const isRestrictedUnverifiedTab =
    isUnverifiedSignedIn &&
    (effectiveTab === 'chat' || effectiveTab === 'profile' || effectiveTab === 'admin');

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
              {user && emailVerified && isAdmin && (
                <button
                  type="button"
                  onClick={() => setActiveTab('admin')}
                  className={`min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg border flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                    effectiveTab === 'admin'
                      ? 'bg-red-600 border-red-600 text-white'
                      : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-50'
                  }`}
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Admin
                </button>
              )}
              {user && emailVerified && myUsername && (
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
                  onClick={() => handleOpenSignIn()}
                  className="min-h-[38px] px-4 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  Sign in
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-24 md:pb-10">
          {user && moderationStatus !== 'active' && effectiveTab !== 'home' && (
            <div
              className={`mb-5 rounded-xl border p-4 text-sm ${
                moderationStatus === 'suspended'
                  ? 'bg-red-50 border-red-200 text-red-900'
                  : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}
            >
              <p className="font-semibold">
                {moderationStatus === 'suspended'
                  ? 'Account suspended'
                  : 'Account flagged for admin review'}
              </p>
              <p className="text-xs mt-1 leading-relaxed">
                {moderationStatus === 'suspended'
                  ? 'An admin has suspended this account. Posting requests, sending messages, reporting, and donor listings are disabled until an admin restores your account.'
                  : 'Multiple new accounts were created from this device within 24 hours. An admin must review and approve your account before you can post requests, message donors, or register as a donor.'}
                {moderationNote ? ` Note: ${moderationNote}` : ''}
              </p>
            </div>
          )}

          {user && isUnverifiedSignedIn && effectiveTab !== 'home' && !isRestrictedUnverifiedTab && (
            <EmailVerificationNotice
              email={user.email || ''}
              variant="banner"
              resending={resendingVerification}
              checking={checkingVerification}
              onResend={() => void handleResendVerification()}
              onCheckVerified={() => void handleCheckVerified()}
            />
          )}

          {effectiveTab === 'home' && (
            <HomeView
              isSignedIn={Boolean(user)}
              signingIn={false}
              onAction={handleHomeAction}
            />
          )}

          {user && effectiveTab !== 'home' && isUnverifiedSignedIn && effectiveTab === 'chat' && (
            <EmailVerificationNotice
              email={user.email || ''}
              variant="card"
              title="Verify your email to message donors"
              description="Unverified accounts can browse donors and emergency requests, but email verification is required before starting or reading chats."
              resending={resendingVerification}
              checking={checkingVerification}
              onResend={() => void handleResendVerification()}
              onCheckVerified={() => void handleCheckVerified()}
            />
          )}

          {user && effectiveTab !== 'home' && isUnverifiedSignedIn && effectiveTab === 'profile' && (
            <EmailVerificationNotice
              email={user.email || ''}
              variant="card"
              title="Verify your email to register as a donor"
              description="Unverified accounts can browse donors and emergency requests, but only verified accounts can register or appear in donor search."
              resending={resendingVerification}
              checking={checkingVerification}
              onResend={() => void handleResendVerification()}
              onCheckVerified={() => void handleCheckVerified()}
            />
          )}

          {user && effectiveTab !== 'home' && !isRestrictedUnverifiedTab && accountPending && (
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

          {user &&
            !accountPending &&
            !requiresUsernameGate &&
            effectiveTab === 'search' && (
              <DonorSearchView
                user={user}
                onStartChat={(uid, username) => void handleStartChat(uid, username)}
                onReport={emailVerified && moderationStatus === 'active' ? setReportTarget : undefined}
                onNotify={showToast}
              />
            )}

          {user &&
            !accountPending &&
            !requiresUsernameGate &&
            effectiveTab === 'hospitals' && (
              <HospitalsView
                user={user}
                emailVerified={emailVerified}
                userRole={userRole}
                resendingVerification={resendingVerification}
                checkingVerification={checkingVerification}
                onResendVerification={() => void handleResendVerification()}
                onCheckVerified={() => void handleCheckVerified()}
                onHospitalStatusUpdated={setHospitalStatus}
                onNotify={showToast}
              />
            )}

          {user &&
            !accountPending &&
            !requiresUsernameGate &&
            effectiveTab === 'emergency' && (
              <EmergencyBoardView
                user={user}
                emailVerified={emailVerified}
                userRole={userRole}
                hospitalStatus={hospitalStatus}
                alertsEnabled={alertsEnabled}
                onEnableAlerts={() => void handleEnableEmergencyAlerts()}
                resendingVerification={resendingVerification}
                checkingVerification={checkingVerification}
                onResendVerification={() => void handleResendVerification()}
                onCheckVerified={() => void handleCheckVerified()}
                onReport={emailVerified && moderationStatus === 'active' ? setReportTarget : undefined}
                onNotify={showToast}
                initialOpenForm={openRequestForm}
                onFormOpened={() => setOpenRequestForm(false)}
              />
            )}

          {user &&
            !accountPending &&
            !requiresUsernameGate &&
            effectiveTab === 'map' && (
              <MapView
                user={user}
                onStartChat={(uid, username) => void handleStartChat(uid, username)}
                onReport={emailVerified && moderationStatus === 'active' ? setReportTarget : undefined}
                onNotify={showToast}
              />
            )}

          {user &&
            emailVerified &&
            !accountPending &&
            !requiresUsernameGate &&
            myUsername &&
            effectiveTab === 'chat' && (
              <ChatView
                user={user}
                myUsername={myUsername}
                chats={chats}
                chatsLoading={chatsLoading}
                selectedChatId={selectedChatId}
                onSelectChat={setSelectedChatId}
                onReport={moderationStatus === 'active' ? setReportTarget : undefined}
                accountBlocked={moderationStatus !== 'active'}
                onNotify={showToast}
              />
            )}

          {user &&
            !accountPending &&
            !requiresUsernameGate &&
            effectiveTab === 'alerts' && (
              <NotificationsView
                notifications={notifications}
                loading={notifLoading}
                canUseEmergencyAlerts={Boolean(emailVerified && (userRole === 'donor' || userRole === 'admin'))}
                alertsEnabled={alertsEnabled}
                notificationPermission={notificationPermission}
                onEnableAlerts={() => void handleEnableEmergencyAlerts()}
                onDisableAlerts={handleDisableEmergencyAlerts}
                onNotify={showToast}
                onOpenEmergency={() => setActiveTab('emergency')}
              />
            )}

          {user &&
            emailVerified &&
            !accountPending &&
            !requiresUsernameGate &&
            myUsername &&
            effectiveTab === 'profile' && (
              <DonorProfileView
                user={user}
                myUsername={myUsername}
                userRole={userRole}
                alertsEnabled={alertsEnabled}
                notificationPermission={notificationPermission}
                onEnableAlerts={() => void handleEnableEmergencyAlerts()}
                onDisableAlerts={handleDisableEmergencyAlerts}
                onUsernameUpdated={(nextUsername) => setMyUsername(nextUsername)}
                onRoleUpdated={(nextRole) => setUserRole(nextRole)}
                onOpenHospitals={() => setActiveTab('hospitals')}
                onNotify={showToast}
              />
            )}

          {user &&
            emailVerified &&
            !accountPending &&
            !requiresUsernameGate &&
            effectiveTab === 'admin' &&
            (isAdmin ? (
              <AdminView user={user} onNotify={showToast} />
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
                <h2 className="text-base font-semibold text-slate-900">Admin access required</h2>
                <p className="text-sm text-slate-600">
                  Only admin accounts can view hospital approvals and assign user roles.
                </p>
              </div>
            ))}
        </main>

        {user && (
          <nav
            aria-label="Primary mobile navigation"
            className="md:hidden fixed bottom-0 left-0 right-0 z-40 h-16 bg-white border-t border-slate-200 grid grid-cols-8 items-center"
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

        <AuthModal
          open={authModalOpen}
          onClose={() => {
            setAuthModalOpen(false);
            setPendingRedirect(null);
          }}
          onSignedIn={handleAuthSuccess}
          onNotify={showToast}
        />

        <EmergencyAlertModal
          alert={activeEmergencyAlert}
          secondsLeft={alertSecondsLeft}
          submitting={respondingAlert}
          onAccept={() => void handleEmergencyAlertDecision('accept')}
          onDecline={() => void handleEmergencyAlertDecision('decline')}
          onDismiss={stopActiveEmergencyAlert}
        />

        <ReportModal
          user={user}
          target={reportTarget}
          onClose={() => setReportTarget(null)}
          onNotify={showToast}
        />

        <ToastPopup toast={toast} onClose={clearToast} />
      </div>
    </ErrorBoundary>
  );
}
