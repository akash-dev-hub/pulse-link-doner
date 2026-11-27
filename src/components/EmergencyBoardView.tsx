import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import { collection, doc, getDoc, onSnapshot, query, where } from 'firebase/firestore';
import {
  Award,
  BellRing,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Eye,
  Flag,
  Loader2,
  MapPin,
  Phone,
  Plus,
  ShieldCheck,
  UserCheck,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { ConfirmModal } from './ConfirmModal.tsx';
import { EmailVerificationNotice } from './EmailVerificationNotice.tsx';
import type { ReportTargetDraft } from './ReportModal.tsx';
import { ThankYouCardPreviewModal } from './ThankYouCardSection.tsx';
import {
  buildGoogleMapsDirectionsUrl,
  getEffectiveUrgency,
  getUrgencyBadgeClass,
  isCompletedRequestStatus,
  isOpenRequestStatus,
  isValidUrgencyLevel,
  makeRequestResponseId,
  normalizeDonorPrivate,
  normalizeDonorPublic,
  normalizeEmergencyRequest,
  normalizeRequestResponse,
  normalizeRequestSharedContact,
  normalizeThankYouCard,
  sortRequestsByUrgencyAndAge,
  URGENCY_DESCRIPTIONS,
  URGENCY_LABELS,
} from '../lib/eligibility.ts';
import { db } from '../lib/firebase.ts';
import { downloadThankYouCardPng } from '../lib/thankYouCardPng.ts';
import {
  BLOOD_GROUPS,
  URGENCY_LEVELS,
  type BloodGroup,
  type DonorPublic,
  type EmergencyRequest,
  type HospitalApprovalStatus,
  type RankedHospital,
  type RequestResponse,
  type RequestResponseStatus,
  type RequestSharedContact,
  type RequestWorkflowStatus,
  type ThankYouCard,
  type UrgencyLevel,
  type UserRole,
} from '../types.ts';

interface EmergencyBoardViewProps {
  user: User;
  emailVerified: boolean;
  userRole: UserRole;
  hospitalStatus: HospitalApprovalStatus | null;
  alertsEnabled?: boolean;
  onEnableAlerts?: () => void;
  resendingVerification: boolean;
  checkingVerification: boolean;
  onResendVerification: () => void;
  onCheckVerified: () => void;
  onReport?: (target: ReportTargetDraft) => void;
  onNotify: (type: 'success' | 'error', message: string) => void;
  initialOpenForm?: boolean;
  onFormOpened?: () => void;
}

const WORKFLOW_STEPS: Array<{ key: RequestWorkflowStatus; label: string }> = [
  { key: 'submitted', label: 'Submitted' },
  { key: 'hospital_verified', label: 'Hospital verified' },
  { key: 'donors_notified', label: 'Donors notified' },
  { key: 'donor_accepted', label: 'Donor accepted' },
  { key: 'donor_verified', label: 'Donor verified' },
  { key: 'contacts_shared', label: 'Contacts shared' },
  { key: 'donation_completed', label: 'Completed' },
];

const WORKFLOW_STEP_INDEX: Record<RequestWorkflowStatus, number> = {
  submitted: 0,
  hospital_verified: 1,
  donors_notified: 2,
  donor_accepted: 3,
  donor_verified: 4,
  contacts_shared: 5,
  donation_completed: 6,
  cancelled: -1,
  active: 2,
  fulfilled: 6,
};

const WORKFLOW_STATUS_LABELS: Record<RequestWorkflowStatus, string> = {
  submitted: 'Awaiting hospital check',
  hospital_verified: 'Hospital verified',
  donors_notified: 'Donors notified',
  donor_accepted: 'Donor accepted',
  donor_verified: 'Donor verified',
  contacts_shared: 'Contacts shared',
  donation_completed: 'Donation completed',
  cancelled: 'Cancelled',
  active: 'Active',
  fulfilled: 'Fulfilled',
};

const RESPONSE_STATUS_LABELS: Record<RequestResponseStatus, string> = {
  donor_accepted: 'Accepted — waiting for hospital verification',
  donor_declined: 'Declined',
  donor_verified: 'Verified by hospital',
  contacts_shared: 'Verified & contacts shared',
  donation_completed: 'Donation completed',
  cancelled: 'Cancelled',
};



type ConfirmActionState =
  | { kind: 'cancel'; request: EmergencyRequest }
  | { kind: 'fulfill_legacy'; request: EmergencyRequest }
  | { kind: 'complete_donation'; request: EmergencyRequest; response: RequestResponse }
  | null;

export function EmergencyBoardView({
  user,
  emailVerified,
  userRole,
  hospitalStatus,
  alertsEnabled = false,
  onEnableAlerts,
  resendingVerification,
  checkingVerification,
  onResendVerification,
  onCheckVerified,
  onReport,
  onNotify,
  initialOpenForm = false,
  onFormOpened,
}: EmergencyBoardViewProps) {
  const [openBoardRequests, setOpenBoardRequests] = useState<EmergencyRequest[]>([]);
  const [myCreatedRequests, setMyCreatedRequests] = useState<EmergencyRequest[]>([]);
  const [myHospitalRequests, setMyHospitalRequests] = useState<EmergencyRequest[]>([]);

  const [myDonorResponses, setMyDonorResponses] = useState<RequestResponse[]>([]);
  const [requesterResponses, setRequesterResponses] = useState<RequestResponse[]>([]);
  const [hospitalResponses, setHospitalResponses] = useState<RequestResponse[]>([]);

  const [donorSharedContacts, setDonorSharedContacts] = useState<RequestSharedContact[]>([]);
  const [requesterSharedContacts, setRequesterSharedContacts] = useState<RequestSharedContact[]>([]);
  const [hospitalSharedContacts, setHospitalSharedContacts] = useState<RequestSharedContact[]>([]);

  const [myDonorProfile, setMyDonorProfile] = useState<DonorPublic | null>(null);
  const [approvedHospitals, setApprovedHospitals] = useState<RankedHospital[]>([]);
  const [hospitalsLoading, setHospitalsLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'open' | 'pending' | 'closed'>('open');
  const [urgencyFilter, setUrgencyFilter] = useState<'all' | UrgencyLevel>('all');
  const [boardError, setBoardError] = useState('');

  // Create request form
  const [showForm, setShowForm] = useState(initialOpenForm);
  const [bloodGroup, setBloodGroup] = useState<BloodGroup>('O+');
  const [units, setUnits] = useState<string>('1');
  const [urgency, setUrgency] = useState<UrgencyLevel | ''>('');
  const [hospitalId, setHospitalId] = useState<string>('');
  const [contact, setContact] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Per-request interactive state
  const [verifyUrgencyByReq, setVerifyUrgencyByReq] = useState<Record<string, UrgencyLevel>>({});
  const [donorNoteByReq, setDonorNoteByReq] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmActionState>(null);

  const [myThankYouCards, setMyThankYouCards] = useState<ThankYouCard[]>([]);
  const [myPrivateFullName, setMyPrivateFullName] = useState<string>(user.displayName || '');
  const [previewThankYouCard, setPreviewThankYouCard] = useState<ThankYouCard | null>(null);
  const [downloadingCardId, setDownloadingCardId] = useState<string | null>(null);

  useEffect(() => {
    if (initialOpenForm) {
      setShowForm(true);
      onFormOpened?.();
    }
  }, [initialOpenForm, onFormOpened]);

  const loadApprovedHospitals = useCallback(async () => {
    setHospitalsLoading(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/hospitals/ranked', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Could not load approved hospitals.');
      const data = (await res.json()) as { hospitals?: RankedHospital[] };
      const list = Array.isArray(data.hospitals) ? data.hospitals : [];
      setApprovedHospitals(list);
      setHospitalId((prev) => {
        if (prev && list.some((h) => h.uid === prev)) return prev;
        if (userRole === 'hospital' && hospitalStatus === 'approved') {
          const own = list.find((h) => h.uid === user.uid);
          if (own) return own.uid;
        }
        return list[0]?.uid || '';
      });
    } catch (err) {
      console.error('Failed to load approved hospitals:', err);
    } finally {
      setHospitalsLoading(false);
    }
  }, [user, userRole, hospitalStatus]);

  useEffect(() => {
    void loadApprovedHospitals();
  }, [loadApprovedHospitals]);

  // Listen to requests
  useEffect(() => {
    const qOpen = query(
      collection(db, 'emergency_requests'),
      where('status', 'in', [
        'hospital_verified',
        'donors_notified',
        'donor_accepted',
        'donor_verified',
        'contacts_shared',
        'active',
      ]),
    );
    const unsubOpen = onSnapshot(
      qOpen,
      (snap) => {
        const list = snap.docs.map((d) =>
          normalizeEmergencyRequest(d.data() as Record<string, unknown>, d.id),
        );
        setOpenBoardRequests(list);
        setLoading(false);
      },
      (err) => {
        console.error('Failed to load open requests:', err);
        setLoading(false);
        setBoardError('Could not load blood requests right now. Please refresh.');
      },
    );

    const qCreated = query(
      collection(db, 'emergency_requests'),
      where('createdBy', '==', user.uid),
    );
    const unsubCreated = onSnapshot(
      qCreated,
      (snap) => {
        setMyCreatedRequests(
          snap.docs.map((d) => normalizeEmergencyRequest(d.data() as Record<string, unknown>, d.id)),
        );
      },
      (err) => {
        console.error('Failed to load my created requests:', err);
      },
    );

    const qHospital = query(
      collection(db, 'emergency_requests'),
      where('hospitalId', '==', user.uid),
    );
    const unsubHospital = onSnapshot(
      qHospital,
      (snap) => {
        setMyHospitalRequests(
          snap.docs.map((d) => normalizeEmergencyRequest(d.data() as Record<string, unknown>, d.id)),
        );
      },
      (err) => {
        console.error('Failed to load hospital assigned requests:', err);
      },
    );

    const unsubDonorPub = onSnapshot(
      doc(db, 'donors_public', user.uid),
      (snap) => {
        if (snap.exists()) {
          setMyDonorProfile(normalizeDonorPublic(snap.data() as Record<string, unknown>, snap.id));
        } else {
          setMyDonorProfile(null);
        }
      },
      () => {
        setMyDonorProfile(null);
      },
    );

    return () => {
      unsubOpen();
      unsubCreated();
      unsubHospital();
      unsubDonorPub();
    };
  }, [user.uid]);

  // Listen to verified-user responses and scoped shared contacts
  useEffect(() => {
    if (!emailVerified) {
      setMyDonorResponses([]);
      setRequesterResponses([]);
      setHospitalResponses([]);
      setDonorSharedContacts([]);
      setRequesterSharedContacts([]);
      setHospitalSharedContacts([]);
      return;
    }

    const unsubs: Array<() => void> = [];

    unsubs.push(
      onSnapshot(
        query(collection(db, 'request_responses'), where('donorUid', '==', user.uid)),
        (snap) => {
          setMyDonorResponses(
            snap.docs.map((d) => normalizeRequestResponse(d.data() as Record<string, unknown>, d.id)),
          );
        },
        (err) => console.error('Failed to listen to donor responses:', err),
      ),
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'request_responses'), where('requesterUid', '==', user.uid)),
        (snap) => {
          setRequesterResponses(
            snap.docs.map((d) => normalizeRequestResponse(d.data() as Record<string, unknown>, d.id)),
          );
        },
        (err) => console.error('Failed to listen to requester responses:', err),
      ),
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'request_shared_contacts'), where('donorUid', '==', user.uid)),
        (snap) => {
          setDonorSharedContacts(
            snap.docs.map((d) =>
              normalizeRequestSharedContact(d.data() as Record<string, unknown>, d.id),
            ),
          );
        },
        (err) => console.error('Failed to listen to donor shared contacts:', err),
      ),
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'thank_you_cards'), where('donorUid', '==', user.uid)),
        (snap) => {
          setMyThankYouCards(
            snap.docs.map((d) => normalizeThankYouCard(d.data() as Record<string, unknown>, d.id)),
          );
        },
        (err) => console.error('Failed to listen to Thank You cards:', err),
      ),
    );

    let cancelled = false;
    void getDoc(doc(db, 'donors_private', user.uid))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) {
          const priv = normalizeDonorPrivate(snap.data() as Record<string, unknown>, snap.id);
          setMyPrivateFullName(priv.fullName || user.displayName || '');
        } else {
          setMyPrivateFullName(user.displayName || '');
        }
      })
      .catch(() => {
        if (!cancelled) setMyPrivateFullName(user.displayName || '');
      });

    unsubs.push(() => {
      cancelled = true;
    });

    unsubs.push(
      onSnapshot(
        query(collection(db, 'request_shared_contacts'), where('requesterUid', '==', user.uid)),
        (snap) => {
          setRequesterSharedContacts(
            snap.docs.map((d) =>
              normalizeRequestSharedContact(d.data() as Record<string, unknown>, d.id),
            ),
          );
        },
        (err) => console.error('Failed to listen to requester shared contacts:', err),
      ),
    );

    if (userRole === 'hospital' || hospitalStatus === 'approved') {
      unsubs.push(
        onSnapshot(
          query(collection(db, 'request_responses'), where('hospitalId', '==', user.uid)),
          (snap) => {
            setHospitalResponses(
              snap.docs.map((d) => normalizeRequestResponse(d.data() as Record<string, unknown>, d.id)),
            );
          },
          (err) => console.error('Failed to listen to hospital responses:', err),
        ),
      );

      unsubs.push(
        onSnapshot(
          query(collection(db, 'request_shared_contacts'), where('hospitalId', '==', user.uid)),
          (snap) => {
            setHospitalSharedContacts(
              snap.docs.map((d) =>
                normalizeRequestSharedContact(d.data() as Record<string, unknown>, d.id),
              ),
            );
          },
          (err) => console.error('Failed to listen to hospital shared contacts:', err),
        ),
      );
    }

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [emailVerified, user.uid, userRole, hospitalStatus]);

  // Merge all request lists cleanly by ID
  const allKnownRequestsMap = useMemo(() => {
    const map = new Map<string, EmergencyRequest>();
    for (const r of openBoardRequests) map.set(r.id, r);
    for (const r of myCreatedRequests) map.set(r.id, r);
    for (const r of myHospitalRequests) map.set(r.id, r);
    return map;
  }, [openBoardRequests, myCreatedRequests, myHospitalRequests]);

  // Verified open requests (sorted by urgency first, then oldest first)
  const verifiedOpenRequests = useMemo(() => {
    const list: EmergencyRequest[] = [];
    for (const r of allKnownRequestsMap.values()) {
      if (r.status !== 'submitted' && isOpenRequestStatus(r.status)) {
        list.push(r);
      }
    }
    return sortRequestsByUrgencyAndAge(list);
  }, [allKnownRequestsMap]);

  // Requests awaiting hospital verification (visible to requester and assigned hospital)
  const pendingReviewRequests = useMemo(() => {
    const list: EmergencyRequest[] = [];
    for (const r of allKnownRequestsMap.values()) {
      if (r.status === 'submitted' && (r.createdBy === user.uid || r.hospitalId === user.uid)) {
        list.push(r);
      }
    }
    return sortRequestsByUrgencyAndAge(list);
  }, [allKnownRequestsMap, user.uid]);

  // Completed / fulfilled / cancelled requests involving this user
  const closedRequests = useMemo(() => {
    const list: EmergencyRequest[] = [];
    for (const r of allKnownRequestsMap.values()) {
      if (!isOpenRequestStatus(r.status)) {
        list.push(r);
      }
    }
    return list.sort((a, b) => (b.fulfilledAtMs || b.cancelledAtMs || b.updatedAtMs) - (a.fulfilledAtMs || a.cancelledAtMs || a.updatedAtMs));
  }, [allKnownRequestsMap]);

  // Responses grouped by requestId
  const responsesByRequestId = useMemo(() => {
    const byReq = new Map<string, Map<string, RequestResponse>>();
    const ingest = (items: RequestResponse[]) => {
      for (const item of items) {
        if (!byReq.has(item.requestId)) byReq.set(item.requestId, new Map());
        byReq.get(item.requestId)!.set(item.id, item);
      }
    };
    ingest(myDonorResponses);
    ingest(requesterResponses);
    ingest(hospitalResponses);

    const out = new Map<string, RequestResponse[]>();
    for (const [reqId, respMap] of byReq.entries()) {
      out.set(
        reqId,
        Array.from(respMap.values()).sort((a, b) => a.createdAtMs - b.createdAtMs),
      );
    }
    return out;
  }, [myDonorResponses, requesterResponses, hospitalResponses]);

  // Shared contacts grouped by requestId
  const sharedContactsByRequestId = useMemo(() => {
    const byReq = new Map<string, Map<string, RequestSharedContact>>();
    const ingest = (items: RequestSharedContact[]) => {
      for (const item of items) {
        if (!byReq.has(item.requestId)) byReq.set(item.requestId, new Map());
        byReq.get(item.requestId)!.set(item.id, item);
      }
    };
    ingest(donorSharedContacts);
    ingest(requesterSharedContacts);
    ingest(hospitalSharedContacts);

    const out = new Map<string, RequestSharedContact[]>();
    for (const [reqId, scMap] of byReq.entries()) {
      out.set(
        reqId,
        Array.from(scMap.values()).sort((a, b) => (a.sharedAtMs || 0) - (b.sharedAtMs || 0)),
      );
    }
    return out;
  }, [donorSharedContacts, requesterSharedContacts, hospitalSharedContacts]);

  const selectedHospital = useMemo(
    () => approvedHospitals.find((h) => h.uid === hospitalId) || null,
    [approvedHospitals, hospitalId],
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!emailVerified) {
      const msg = 'Please verify your email address before submitting a blood request.';
      setFormError(msg);
      onNotify('error', msg);
      return;
    }

    const parsedUnits = Number(units);
    if (!Number.isInteger(parsedUnits) || parsedUnits < 1 || parsedUnits > 100) {
      const msg = 'Please enter at least 1 unit of blood.';
      setFormError(msg);
      onNotify('error', msg);
      return;
    }
    if (!isValidUrgencyLevel(urgency)) {
      const msg = 'Please select an urgency level (Critical, Urgent, or Planned).';
      setFormError(msg);
      onNotify('error', msg);
      return;
    }
    if (!hospitalId) {
      const msg = 'Please select an approved hospital or blood bank.';
      setFormError(msg);
      onNotify('error', msg);
      return;
    }
    if (contact.trim().length < 3) {
      const msg = 'Please provide your phone number or email (kept private until a donor is verified).';
      setFormError(msg);
      onNotify('error', msg);
      return;
    }

    setSubmitting(true);
    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          hospitalId,
          bloodGroup,
          units: parsedUnits,
          urgency,
          contact: contact.trim(),
          notes: notes.trim(),
        }),
      });

      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || 'Could not submit your request. Please try again.');
      }

      onNotify('success', 'Request submitted to hospital for verification');
      setUnits('1');
      setUrgency('');
      setContact('');
      setNotes('');
      setShowForm(false);
      setTab('pending');
    } catch (err) {
      const msg =
        err instanceof Error && err.message && !err.message.startsWith('Firestore')
          ? err.message
          : 'Could not submit your request. Please try again.';
      setFormError(msg);
      onNotify('error', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyRequest = async (req: EmergencyRequest) => {
    const confirmedUrgency = verifyUrgencyByReq[req.id] || getEffectiveUrgency(req);
    setBusyKey(`verify:${req.id}`);
    try {
      const token = await user.getIdToken();
      const response = await fetch(`/api/requests/${encodeURIComponent(req.id)}/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ confirmedUrgency }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        notifiedCount?: number;
      };
      if (!response.ok) {
        throw new Error(body.error || 'Could not verify this request right now.');
      }
      const count = body.notifiedCount || 0;
      onNotify(
        'success',
        count > 0
          ? `Request verified. Notified ${count} eligible ${req.bloodGroup} ${count === 1 ? 'donor' : 'donors'}.`
          : 'Request verified and opened on the board.',
      );
      setTab('open');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not verify this request.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRenotifyDonors = async (req: EmergencyRequest) => {
    setBusyKey(`notify:${req.id}`);
    try {
      const token = await user.getIdToken();
      const response = await fetch(`/api/requests/${encodeURIComponent(req.id)}/notify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        notifiedCount?: number;
      };
      if (!response.ok) {
        throw new Error(body.error || 'Could not notify donors right now.');
      }
      const count = body.notifiedCount || 0;
      onNotify(
        'success',
        count > 0 ? `Notified ${count} more nearby donors.` : 'No additional eligible donors found nearby right now.',
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not notify donors.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleDonorRespond = async (req: EmergencyRequest, decision: 'accept' | 'decline') => {
    setBusyKey(`respond:${req.id}:${decision}`);
    try {
      const token = await user.getIdToken();
      const response = await fetch(`/api/requests/${encodeURIComponent(req.id)}/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          decision,
          decisionNote: (donorNoteByReq[req.id] || '').trim(),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || 'Could not save your response.');
      }
      onNotify(
        'success',
        decision === 'accept'
          ? 'Accepted. The hospital will verify you before sharing contacts.'
          : 'Response recorded as declined.',
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not save your response.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleVerifyDonor = async (req: EmergencyRequest, donorUid: string) => {
    setBusyKey(`verifyDonor:${req.id}:${donorUid}`);
    try {
      const token = await user.getIdToken();
      const response = await fetch(
        `/api/requests/${encodeURIComponent(req.id)}/responses/${encodeURIComponent(donorUid)}/verify`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || 'Could not verify this donor right now.');
      }
      onNotify('success', 'Donor verified and contacts shared between requester and donor.');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not verify donor.');
    } finally {
      setBusyKey(null);
    }
  };

  const executeConfirmedAction = async () => {
    if (!confirmAction) return;

    if (confirmAction.kind === 'cancel') {
      const req = confirmAction.request;
      setBusyKey(`cancel:${req.id}`);
      try {
        const token = await user.getIdToken();
        const response = await fetch(`/api/requests/${encodeURIComponent(req.id)}/cancel`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          throw new Error(body.error || 'Could not cancel this request.');
        }
        setConfirmAction(null);
        onNotify('success', 'Request cancelled');
      } catch (err) {
        setConfirmAction(null);
        onNotify('error', err instanceof Error ? err.message : 'Could not cancel request.');
      } finally {
        setBusyKey(null);
      }
      return;
    }

    if (confirmAction.kind === 'fulfill_legacy') {
      const req = confirmAction.request;
      setBusyKey(`fulfill:${req.id}`);
      try {
        const token = await user.getIdToken();
        const response = await fetch(`/api/requests/${encodeURIComponent(req.id)}/fulfill`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          throw new Error(body.error || 'Could not close this request.');
        }
        setConfirmAction(null);
        onNotify('success', 'Request marked fulfilled');
      } catch (err) {
        setConfirmAction(null);
        onNotify('error', err instanceof Error ? err.message : 'Could not close request.');
      } finally {
        setBusyKey(null);
      }
      return;
    }

    if (confirmAction.kind === 'complete_donation') {
      const { request: req, response: resp } = confirmAction;
      setBusyKey(`complete:${req.id}:${resp.donorUid}`);
      try {
        const token = await user.getIdToken();
        const res = await fetch(
          `/api/requests/${encodeURIComponent(req.id)}/responses/${encodeURIComponent(resp.donorUid)}/complete`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          allMet?: boolean;
        };
        if (!res.ok) {
          throw new Error(body.error || 'Could not complete donation.');
        }
        setConfirmAction(null);
        onNotify(
          'success',
          body.allMet
            ? 'Donation completed, Thank You card created, and request closed.'
            : 'Donation recorded, Thank You card created, and donor last donation date updated.',
        );
      } catch (err) {
        setConfirmAction(null);
        onNotify('error', err instanceof Error ? err.message : 'Could not complete donation.');
      } finally {
        setBusyKey(null);
      }
    }
  };

  const tabBaseRequests =
    tab === 'open'
      ? verifiedOpenRequests
      : tab === 'pending'
        ? pendingReviewRequests
        : closedRequests;

  const urgencyCounts = useMemo(() => {
    const counts: Record<'all' | UrgencyLevel, number> = {
      all: tabBaseRequests.length,
      critical: 0,
      urgent: 0,
      planned: 0,
    };
    for (const r of tabBaseRequests) {
      counts[getEffectiveUrgency(r)] += 1;
    }
    return counts;
  }, [tabBaseRequests]);

  const displayedRequests = useMemo(() => {
    if (urgencyFilter === 'all') return tabBaseRequests;
    return tabBaseRequests.filter((r) => getEffectiveUrgency(r) === urgencyFilter);
  }, [tabBaseRequests, urgencyFilter]);

  const isMyDonorEligibleNow = Boolean(
    myDonorProfile &&
      myDonorProfile.visibleInSearch &&
      myDonorProfile.eligibleAfterMs <= Date.now(),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Emergency Requests
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Requests go to the selected hospital for verification before nearby donors are alerted. Sorted by urgency, then oldest first.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {emailVerified &&
            (userRole === 'donor' || userRole === 'admin') &&
            !alertsEnabled &&
            onEnableAlerts && (
              <button
                type="button"
                onClick={onEnableAlerts}
                className="min-h-[44px] px-4 py-2.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-900 text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                <BellRing className="w-4 h-4 text-red-600" />
                Enable emergency alerts
              </button>
            )}
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="min-h-[44px] px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {showForm ? 'Close form' : 'Post emergency request'}
          </button>
        </div>
      </div>

      {showForm && !emailVerified && (
        <EmailVerificationNotice
          email={user.email || ''}
          variant="card"
          title="Verify your email to submit a request"
          description="Anyone signed in can browse verified requests, but only verified accounts can submit a request or respond as a donor."
          resending={resendingVerification}
          checking={checkingVerification}
          onResend={onResendVerification}
          onCheckVerified={onCheckVerified}
        />
      )}

      {showForm && emailVerified && userRole === 'hospital' && hospitalStatus !== 'approved' && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 space-y-1.5 text-sm text-amber-900">
          <p className="font-semibold">Hospital approval required</p>
          <p className="text-xs leading-relaxed">
            {hospitalStatus === 'rejected'
              ? 'Your hospital or blood bank registration was rejected. Update your facility details on the Hospitals tab and ask an admin to review it again.'
              : 'Your hospital or blood bank must be approved by an admin before submitting requests as a facility. Open the Hospitals tab to check your status.'}
          </p>
        </div>
      )}

      {showForm && emailVerified && !(userRole === 'hospital' && hospitalStatus !== 'approved') && (
        <form
          onSubmit={handleSubmit}
          className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5"
        >
          <div className="border-b border-slate-100 pb-3">
            <h2 className="text-lg font-semibold text-slate-900">Submit a Blood Request</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Choose an approved hospital or blood bank. That hospital reviews your request and notifies nearby matching donors. Your contact stays private until the hospital verifies an accepting donor.
            </p>
          </div>

          {formError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="req-blood-group" className="block text-xs font-medium text-slate-700 mb-1.5">
                Blood Group<span className="text-red-600 ml-0.5">*</span>
              </label>
              <select
                id="req-blood-group"
                value={bloodGroup}
                onChange={(e) => setBloodGroup(e.target.value as BloodGroup)}
                className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              >
                {BLOOD_GROUPS.map((bg) => (
                  <option key={bg} value={bg}>
                    {bg}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="req-units" className="block text-xs font-medium text-slate-700 mb-1.5">
                Units Needed (at least 1)<span className="text-red-600 ml-0.5">*</span>
              </label>
              <input
                id="req-units"
                type="number"
                min={1}
                max={100}
                step={1}
                required
                value={units}
                onChange={(e) => setUnits(e.target.value)}
                className="w-full min-h-[44px] px-3 py-2 text-sm font-mono-tabular bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="block text-xs font-medium text-slate-700">
              Urgency Level<span className="text-red-600 ml-0.5">*</span>
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {URGENCY_LEVELS.map((lvl) => {
                const selected = urgency === lvl;
                return (
                  <label
                    key={lvl}
                    className={`cursor-pointer rounded-lg border p-3 flex items-start gap-2.5 transition-colors ${
                      selected
                        ? lvl === 'critical'
                          ? 'border-red-600 bg-red-50/70'
                          : lvl === 'urgent'
                            ? 'border-amber-500 bg-amber-50/70'
                            : 'border-sky-600 bg-sky-50/70'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="req-urgency"
                      value={lvl}
                      required
                      checked={selected}
                      onChange={() => setUrgency(lvl)}
                      className="mt-1 accent-red-600 shrink-0"
                    />
                    <div className="min-w-0 space-y-1">
                      <span
                        className={`inline-block px-2 py-0.5 rounded border text-xs font-semibold ${getUrgencyBadgeClass(lvl)}`}
                      >
                        {URGENCY_LABELS[lvl]}
                      </span>
                      <p className="text-xs text-slate-600 leading-snug">
                        {URGENCY_DESCRIPTIONS[lvl]}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div>
            <label htmlFor="req-hospital-id" className="block text-xs font-medium text-slate-700 mb-1.5">
              Approved Hospital or Blood Bank<span className="text-red-600 ml-0.5">*</span>
            </label>
            {hospitalsLoading ? (
              <div className="min-h-[44px] px-3 py-2 text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-lg flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading approved hospitals...
              </div>
            ) : approvedHospitals.length === 0 ? (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-900">
                No approved hospitals or blood banks are registered yet. A hospital must register on the Hospitals tab and be approved by an admin before verified requests can be assigned to it.
              </div>
            ) : (
              <select
                id="req-hospital-id"
                value={hospitalId}
                onChange={(e) => setHospitalId(e.target.value)}
                required
                className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              >
                <option value="">Select an approved hospital...</option>
                {approvedHospitals.map((h) => {
                  const unitsInStock = h.inventory[bloodGroup] || 0;
                  const area = [h.locality, h.city].filter(Boolean).join(', ');
                  return (
                    <option key={h.uid} value={h.uid}>
                      {h.name} — {area} ({unitsInStock} {bloodGroup} units in stock)
                    </option>
                  );
                })}
              </select>
            )}
            {selectedHospital && (
              <p className="mt-1.5 text-xs text-slate-600">
                Location: {[selectedHospital.locality, selectedHospital.city, selectedHospital.stateName, selectedHospital.countryName].filter(Boolean).join(', ')}
                {selectedHospital.pincode ? ` (${selectedHospital.pincode})` : ''}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="req-contact" className="block text-xs font-medium text-slate-700 mb-1.5">
              Your Private Phone or Email<span className="text-red-600 ml-0.5">*</span>
            </label>
            <input
              id="req-contact"
              type="text"
              required
              maxLength={150}
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="Phone number or email for verified coordination"
              className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
            />
            <p className="mt-1 text-xs text-slate-600">
              Private: Never shown publicly on the board. Shared only with {selectedHospital ? selectedHospital.name : 'the selected hospital'} and any accepting donor after the hospital verifies them.
            </p>
          </div>

          <div>
            <label htmlFor="req-notes" className="block text-xs font-medium text-slate-700 mb-1.5">
              Helpful notes (optional)
            </label>
            <textarea
              id="req-notes"
              rows={2}
              maxLength={300}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ward name, blood bank counter, or timing notes (do not write personal phone numbers here)..."
              className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="min-h-[44px] px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 bg-slate-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || approvedHospitals.length === 0}
              className="min-h-[44px] px-5 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-lg flex items-center gap-2 transition-colors"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Submit Request to Hospital
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          <button
            type="button"
            onClick={() => setTab('open')}
            className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'open'
                ? 'bg-white text-slate-900 border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Verified Board ({verifiedOpenRequests.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('pending')}
            className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'pending'
                ? 'bg-white text-slate-900 border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Awaiting Hospital Check ({pendingReviewRequests.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('closed')}
            className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'closed'
                ? 'bg-white text-slate-900 border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Completed / Cancelled ({closedRequests.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter requests by urgency">
          <span className="text-xs font-medium text-slate-600 mr-1">Urgency:</span>
          {(['all', ...URGENCY_LEVELS] as const).map((option) => {
            const active = urgencyFilter === option;
            const label = option === 'all' ? 'All' : URGENCY_LABELS[option];
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                onClick={() => setUrgencyFilter(option)}
                className={`min-h-[34px] px-3 py-1 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap ${
                  active
                    ? option === 'all'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : getUrgencyBadgeClass(option)
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {label} ({urgencyCounts[option]})
              </button>
            );
          })}
        </div>
      </div>

      {boardError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
          {boardError}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <div key={i} className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="h-5 w-2/3 bg-slate-200 rounded" />
              <div className="h-4 w-1/2 bg-slate-100 rounded" />
              <div className="h-10 w-full bg-slate-100 rounded-lg" />
            </div>
          ))}
        </div>
      ) : displayedRequests.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
          <h3 className="text-base font-semibold text-slate-900">
            {urgencyFilter !== 'all'
              ? `No ${URGENCY_LABELS[urgencyFilter]} requests in this view`
              : tab === 'open'
                ? 'No hospital-verified requests right now'
                : tab === 'pending'
                  ? 'No requests waiting for hospital check'
                  : 'No completed or cancelled requests yet'}
          </h3>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            {urgencyFilter !== 'all'
              ? 'Try switching the urgency filter back to All to see requests of every priority.'
              : tab === 'open'
                ? 'Requests appear here as soon as the assigned hospital confirms the urgency and alerts nearby donors.'
                : tab === 'pending'
                  ? 'Newly submitted requests wait here until the selected hospital reviews and verifies them.'
                  : 'Completed donations and cancelled requests appear here.'}
          </p>
          {urgencyFilter !== 'all' && (
            <button
              type="button"
              onClick={() => setUrgencyFilter('all')}
              className="min-h-[38px] px-4 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
            >
              Show all urgencies
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {displayedRequests.map((req) => {
            const isCreator = req.createdBy === user.uid;
            const isAssignedHospital = Boolean(req.hospitalId && req.hospitalId === user.uid);
            const isLegacy = !req.hospitalId;
            const isOpen = isOpenRequestStatus(req.status);
            const effectiveUrgency = getEffectiveUrgency(req);
            const stepIndex = WORKFLOW_STEP_INDEX[req.status] ?? 0;

            const responses = responsesByRequestId.get(req.id) || [];
            const myResponse =
              responses.find((r) => r.id === makeRequestResponseId(req.id, user.uid)) || null;
            const myThankYouCard =
              myThankYouCards.find((c) => c.id === makeRequestResponseId(req.id, user.uid)) || null;
            const sharedContacts = sharedContactsByRequestId.get(req.id) || [];

            const mapsUrl = buildGoogleMapsDirectionsUrl({
              lat: req.hospitalLat,
              lng: req.hospitalLng,
              hospitalName: req.hospitalName,
              locality: req.locality,
              city: req.city,
              stateName: req.stateName,
              countryName: req.countryName,
            });
            const locParts = [req.locality, req.city, req.stateName, req.countryName].filter(Boolean);
            const postedLabel = req.createdAtMs
              ? new Date(req.createdAtMs).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : 'Recently';

            const canDonorRespond =
              !isLegacy &&
              isOpen &&
              Boolean(req.hospitalVerifiedAtMs) &&
              !isCreator &&
              !isAssignedHospital;

            const bloodMatchesDonor = Boolean(
              myDonorProfile && myDonorProfile.bloodGroup === req.bloodGroup,
            );
            const donorCanSwitchDecision =
              !myResponse ||
              myResponse.status === 'donor_accepted' ||
              myResponse.status === 'donor_declined';

            return (
              <article
                key={req.id}
                className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span
                          className={`px-2 py-0.5 rounded border font-semibold ${getUrgencyBadgeClass(effectiveUrgency)}`}
                        >
                          {URGENCY_LABELS[effectiveUrgency]}
                          {req.confirmedUrgency ? ' (Confirmed)' : ''}
                        </span>
                        <span
                          className={`font-semibold ${
                            req.status === 'cancelled'
                              ? 'text-slate-500'
                              : isCompletedRequestStatus(req.status)
                                ? 'text-emerald-700'
                                : 'text-red-700'
                          }`}
                        >
                          {WORKFLOW_STATUS_LABELS[req.status]}
                        </span>
                      </div>

                      <h3 className="text-lg font-semibold text-slate-900 break-words">
                        {req.hospitalName}
                      </h3>

                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-500">
                        <span className="font-mono-tabular text-slate-800 font-medium">
                          {req.unitsCompleted} / {req.units} {req.units === 1 ? 'unit' : 'units'} donated
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>@{req.createdByName}</span>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {postedLabel}
                        </span>
                      </div>
                    </div>

                    <span className="font-mono-tabular text-base font-bold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5 shrink-0">
                      {req.bloodGroup}
                    </span>
                  </div>

                  {/* Location & Notified count */}
                  <div className="space-y-1.5 text-xs text-slate-600">
                    <div className="flex items-start gap-2">
                      <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                      <span>
                        {locParts.join(' · ')}
                        {req.pincode ? ` (${req.pincode})` : ''}
                      </span>
                    </div>
                    {!isLegacy && req.hospitalVerifiedAtMs && (
                      <div className="flex items-center gap-2 text-slate-600">
                        <Users className="w-4 h-4 text-slate-400 shrink-0" />
                        <span>
                          {req.notifiedDonorCount}{' '}
                          {req.notifiedDonorCount === 1 ? 'nearby donor' : 'nearby donors'} notified
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Stepper for new workflow requests */}
                  {!isLegacy && (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between text-[11px] font-medium text-slate-600">
                        <span>Request progress</span>
                        <span className={req.status === 'cancelled' ? 'text-slate-500' : 'text-slate-900'}>
                          {WORKFLOW_STATUS_LABELS[req.status]}
                        </span>
                      </div>
                      {req.status === 'cancelled' ? (
                        <div className="text-xs text-slate-600 flex items-center gap-1.5">
                          <XCircle className="w-4 h-4 text-slate-500 shrink-0" />
                          Cancelled by{' '}
                          {req.cancelledBy === req.hospitalId ? 'assigned hospital' : 'requester'}.
                        </div>
                      ) : (
                        <div className="grid grid-cols-7 gap-1">
                          {WORKFLOW_STEPS.map((st, idx) => {
                            const done = idx <= stepIndex;
                            return (
                              <div key={st.key} className="space-y-1">
                                <div
                                  className={`h-1.5 rounded-full ${
                                    done
                                      ? isCompletedRequestStatus(req.status)
                                        ? 'bg-emerald-600'
                                        : 'bg-red-600'
                                      : 'bg-slate-200'
                                  }`}
                                />
                                <p className="text-[10px] leading-tight text-slate-500 truncate" title={st.label}>
                                  {st.label}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {req.notes && (
                    <p className="text-xs text-slate-600 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                      {req.notes}
                    </p>
                  )}

                  {/* Assigned Hospital Control Panel */}
                  {isAssignedHospital && !isLegacy && isOpen && (
                    <div className="border border-slate-200 rounded-lg p-3.5 space-y-3 bg-slate-50/70">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                          <Building2 className="w-4 h-4 text-red-600" />
                          Hospital Actions
                        </span>
                      </div>

                      {req.status === 'submitted' ? (
                        <div className="space-y-2.5">
                          <p className="text-xs text-slate-600">
                            Confirm the urgency level and verify this request to alert matching nearby donors.
                          </p>
                          <div className="flex flex-col sm:flex-row gap-2">
                            <select
                              aria-label="Confirm urgency"
                              value={verifyUrgencyByReq[req.id] || effectiveUrgency}
                              onChange={(e) =>
                                setVerifyUrgencyByReq((prev) => ({
                                  ...prev,
                                  [req.id]: e.target.value as UrgencyLevel,
                                }))
                              }
                              className="min-h-[40px] px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-900 outline-none focus:border-red-500"
                            >
                              {URGENCY_LEVELS.map((lvl) => (
                                <option key={lvl} value={lvl}>
                                  Urgency: {URGENCY_LABELS[lvl]}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              disabled={busyKey === `verify:${req.id}` || !emailVerified}
                              onClick={() => void handleVerifyRequest(req)}
                              className="flex-1 min-h-[40px] px-3.5 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors"
                            >
                              {busyKey === `verify:${req.id}` ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <ShieldCheck className="w-3.5 h-3.5" />
                              )}
                              Verify &amp; Notify Donors
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-slate-700">
                              Donor Responses ({responses.length})
                            </span>
                            <button
                              type="button"
                              disabled={busyKey === `notify:${req.id}` || !emailVerified}
                              onClick={() => void handleRenotifyDonors(req)}
                              className="text-xs font-semibold text-red-700 hover:text-red-800 underline disabled:opacity-50"
                            >
                              {busyKey === `notify:${req.id}` ? 'Notifying...' : 'Alert more nearby donors'}
                            </button>
                          </div>

                          {responses.length === 0 ? (
                            <p className="text-xs text-slate-500">
                              No donors have accepted or declined yet.
                            </p>
                          ) : (
                            <div className="space-y-2">
                              {responses.map((resp) => (
                                <div
                                  key={resp.id}
                                  className="bg-white border border-slate-200 rounded-lg p-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                                >
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2 text-xs">
                                      <span className="font-mono-tabular font-semibold text-slate-900">
                                        @{resp.donorUsername}
                                      </span>
                                      <span className="text-slate-500">· {resp.bloodGroup}</span>
                                    </div>
                                    <p className="text-[11px] text-slate-600">
                                      {RESPONSE_STATUS_LABELS[resp.status]}
                                    </p>
                                    {resp.decisionNote && (
                                      <p className="text-[11px] text-slate-500 italic mt-0.5">
                                        &ldquo;{resp.decisionNote}&rdquo;
                                      </p>
                                    )}
                                  </div>

                                  {resp.status === 'donor_accepted' && (
                                    <button
                                      type="button"
                                      disabled={busyKey === `verifyDonor:${req.id}:${resp.donorUid}`}
                                      onClick={() => void handleVerifyDonor(req, resp.donorUid)}
                                      className="min-h-[36px] px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold rounded-md flex items-center justify-center gap-1.5 shrink-0"
                                    >
                                      {busyKey === `verifyDonor:${req.id}:${resp.donorUid}` ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      ) : (
                                        <UserCheck className="w-3.5 h-3.5" />
                                      )}
                                      Verify Donor &amp; Share Contacts
                                    </button>
                                  )}

                                  {(resp.status === 'contacts_shared' || resp.status === 'donor_verified') && (
                                    <button
                                      type="button"
                                      disabled={busyKey === `complete:${req.id}:${resp.donorUid}`}
                                      onClick={() =>
                                        setConfirmAction({
                                          kind: 'complete_donation',
                                          request: req,
                                          response: resp,
                                        })
                                      }
                                      className="min-h-[36px] px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white text-xs font-semibold rounded-md flex items-center justify-center gap-1.5 shrink-0"
                                    >
                                      <CheckCircle2 className="w-3.5 h-3.5" />
                                      Mark Donation Completed
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Donor Response Panel */}
                  {canDonorRespond && (
                    <div className="border border-slate-200 rounded-lg p-3.5 space-y-2.5 bg-slate-50/70">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-900">Your Donor Response</span>
                        {myResponse && (
                          <span className="text-[11px] font-medium text-slate-700">
                            {RESPONSE_STATUS_LABELS[myResponse.status]}
                          </span>
                        )}
                      </div>

                      {!emailVerified ? (
                        <p className="text-xs text-slate-600">
                          Verify your email address to accept or decline this request.
                        </p>
                      ) : !myDonorProfile ? (
                        <p className="text-xs text-slate-600">
                          Register your donor profile on the Profile tab to respond to requests.
                        </p>
                      ) : !isMyDonorEligibleNow ? (
                        <p className="text-xs text-slate-600">
                          Only visible donors outside the 90-day donation waiting window can respond.
                        </p>
                      ) : !bloodMatchesDonor ? (
                        <p className="text-xs text-slate-600">
                          This request needs {req.bloodGroup} blood (your profile is {myDonorProfile.bloodGroup}).
                        </p>
                      ) : donorCanSwitchDecision ? (
                        <div className="space-y-2">
                          <input
                            type="text"
                            maxLength={200}
                            value={donorNoteByReq[req.id] || ''}
                            onChange={(e) =>
                              setDonorNoteByReq((prev) => ({ ...prev, [req.id]: e.target.value }))
                            }
                            placeholder="Optional note for hospital (e.g. arrival time)"
                            className="w-full min-h-[38px] px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-900 outline-none focus:border-red-500"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={busyKey === `respond:${req.id}:accept`}
                              onClick={() => void handleDonorRespond(req, 'accept')}
                              className={`flex-1 min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors ${
                                myResponse?.status === 'donor_accepted'
                                  ? 'bg-emerald-700 text-white'
                                  : 'bg-red-600 hover:bg-red-700 text-white'
                              }`}
                            >
                              {busyKey === `respond:${req.id}:accept` ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Check className="w-3.5 h-3.5" />
                              )}
                              {myResponse?.status === 'donor_accepted' ? 'Accepted' : 'Accept Request'}
                            </button>
                            <button
                              type="button"
                              disabled={busyKey === `respond:${req.id}:decline`}
                              onClick={() => void handleDonorRespond(req, 'decline')}
                              className={`flex-1 min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg border flex items-center justify-center gap-1.5 transition-colors ${
                                myResponse?.status === 'donor_declined'
                                  ? 'bg-slate-200 border-slate-300 text-slate-900'
                                  : 'bg-white border-slate-200 hover:bg-slate-100 text-slate-700'
                              }`}
                            >
                              {busyKey === `respond:${req.id}:decline` ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <X className="w-3.5 h-3.5" />
                              )}
                              {myResponse?.status === 'donor_declined' ? 'Declined' : 'Decline'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-slate-600">
                          {RESPONSE_STATUS_LABELS[myResponse!.status]}.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Requester summary of accepting/verified donors */}
                  {isCreator && !isAssignedHospital && !isLegacy && responses.length > 0 && (
                    <div className="border border-slate-200 rounded-lg p-3 space-y-1.5 bg-slate-50/70">
                      <p className="text-xs font-semibold text-slate-900">Donor Updates</p>
                      <div className="space-y-1">
                        {responses.map((resp) => (
                          <div key={resp.id} className="flex items-center justify-between text-xs">
                            <span className="font-mono-tabular font-medium text-slate-800">
                              @{resp.donorUsername}
                            </span>
                            <span className="text-slate-600">{RESPONSE_STATUS_LABELS[resp.status]}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Scoped Shared Contacts: strictly readable ONLY by requester, that donor, and assigned hospital */}
                  {sharedContacts.length > 0 && (
                    <div className="border border-emerald-200 bg-emerald-50/60 rounded-lg p-3.5 space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-900">
                        <Phone className="w-3.5 h-3.5 text-emerald-700" />
                        Verified Private Contacts
                      </div>
                      <p className="text-[11px] text-emerald-800">
                        Visible only to the requester, verified donor, and verifying hospital.
                      </p>
                      <div className="space-y-2">
                        {sharedContacts.map((sc) => (
                          <div
                            key={sc.id}
                            className="bg-white border border-emerald-200 rounded-md p-2.5 text-xs space-y-1"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-slate-600">
                                Requester (<span className="font-mono-tabular">@{sc.requesterUsername}</span>)
                              </span>
                              <span className="font-mono-tabular font-semibold text-slate-900">
                                {sc.requesterContact}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-slate-600">
                                Donor (<span className="font-mono-tabular">@{sc.donorUsername}</span>)
                              </span>
                              <span className="font-mono-tabular font-semibold text-slate-900">
                                {sc.donorContact}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {myThankYouCard && (
                    <div className="border border-red-200 bg-red-50/50 rounded-lg p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="space-y-0.5 min-w-0">
                        <p className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                          <Award className="w-4 h-4 text-red-600 shrink-0" />
                          Thank You Card Ready
                        </p>
                        <p className="text-[11px] text-slate-600">
                          Issued by {myThankYouCard.hospitalName} on {myThankYouCard.donationDate}. Visible only to you, with no patient details.
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => setPreviewThankYouCard(myThankYouCard)}
                          className="min-h-[36px] px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-100 text-slate-800 text-xs font-semibold rounded-lg flex items-center gap-1.5"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          View Card
                        </button>
                        <button
                          type="button"
                          disabled={downloadingCardId === myThankYouCard.id}
                          onClick={() => {
                            setDownloadingCardId(myThankYouCard.id);
                            void downloadThankYouCardPng({
                              card: myThankYouCard,
                              donorDisplayName:
                                myPrivateFullName.trim() || `@${myThankYouCard.donorUsername}`,
                            })
                              .then(() => {
                                onNotify('success', 'Thank You card downloaded as PNG.');
                              })
                              .catch((err) => {
                                console.error('Failed to download PNG:', err);
                                onNotify('error', 'Could not download Thank You card PNG.');
                              })
                              .finally(() => setDownloadingCardId(null));
                          }}
                          className="min-h-[36px] px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5"
                        >
                          {downloadingCardId === myThankYouCard.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Download className="w-3.5 h-3.5" />
                          )}
                          Download PNG
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Card footer */}
                <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2.5">
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 min-w-[160px] min-h-[42px] px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-900 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                    Open in Google Maps
                  </a>

                  {!isLegacy && isOpen && (isCreator || isAssignedHospital) && (
                    <button
                      type="button"
                      disabled={busyKey === `cancel:${req.id}`}
                      onClick={() => setConfirmAction({ kind: 'cancel', request: req })}
                      className="min-h-[42px] px-3.5 py-2 bg-white border border-slate-300 hover:bg-slate-100 disabled:opacity-60 text-slate-800 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      Cancel Request
                    </button>
                  )}

                  {isLegacy && isCreator && req.status === 'active' && (
                    <button
                      type="button"
                      disabled={busyKey === `fulfill:${req.id}`}
                      onClick={() => setConfirmAction({ kind: 'fulfill_legacy', request: req })}
                      className="flex-1 min-w-[150px] min-h-[42px] px-3.5 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      Mark as Fulfilled
                    </button>
                  )}

                  {!isCreator && onReport && (
                    <button
                      type="button"
                      onClick={() =>
                        onReport({
                          targetType: 'request',
                          targetId: req.id,
                          targetUid: req.createdBy,
                          targetUsername: req.createdByName,
                          contextId: req.id,
                          targetPreview: `${req.bloodGroup} (${req.units}u) at ${req.hospitalName} by @${req.createdByName}`,
                        })
                      }
                      className="min-h-[42px] px-3.5 py-2 bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <Flag className="w-3.5 h-3.5 text-slate-500" />
                      Report
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={Boolean(confirmAction)}
        title={
          confirmAction?.kind === 'complete_donation'
            ? 'Mark donation completed?'
            : confirmAction?.kind === 'cancel'
              ? 'Cancel this blood request?'
              : 'Close this request?'
        }
        message={
          confirmAction?.kind === 'complete_donation'
            ? `Confirm that @${confirmAction.response.donorUsername} completed a ${confirmAction.request.bloodGroup} blood donation? Their last donation date will be set to today and their 90-day rest period will start.`
            : confirmAction?.kind === 'cancel'
              ? `Cancel the ${confirmAction.request.bloodGroup} request at ${confirmAction.request.hospitalName}? All pending donor responses for this request will be closed.`
              : confirmAction
                ? `Mark the ${confirmAction.request.bloodGroup} request at ${confirmAction.request.hospitalName} as fulfilled?`
                : ''
        }
        confirmLabel={
          confirmAction?.kind === 'complete_donation'
            ? 'Yes, mark completed'
            : confirmAction?.kind === 'cancel'
              ? 'Yes, cancel request'
              : 'Yes, mark fulfilled'
        }
        cancelLabel="Go back"
        loading={Boolean(busyKey)}
        onConfirm={() => void executeConfirmedAction()}
        onCancel={() => {
          if (!busyKey) setConfirmAction(null);
        }}
      />

      <ThankYouCardPreviewModal
        card={previewThankYouCard}
        donorDisplayName={myPrivateFullName}
        downloading={Boolean(previewThankYouCard && downloadingCardId === previewThankYouCard.id)}
        onDownload={(card) => {
          setDownloadingCardId(card.id);
          void downloadThankYouCardPng({
            card,
            donorDisplayName: myPrivateFullName.trim() || `@${card.donorUsername}`,
          })
            .then(() => {
              onNotify('success', 'Thank You card downloaded as PNG.');
            })
            .catch((err) => {
              console.error('Failed to download PNG:', err);
              onNotify('error', 'Could not download Thank You card PNG.');
            })
            .finally(() => setDownloadingCardId(null));
        }}
        onClose={() => setPreviewThankYouCard(null)}
      />
    </div>
  );
}
