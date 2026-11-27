import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  Ban,
  Building2,
  Check,
  FileWarning,
  Loader2,
  MapPin,
  Phone,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Smartphone,
  Users,
  X,
} from 'lucide-react';
import { ConfirmModal } from './ConfirmModal.tsx';
import {
  USER_ROLES,
  type AbuseReport,
  type AccountModerationRecord,
  type AuthEventLog,
  type DeviceRegistrationRecord,
  type HospitalApprovalStatus,
  type HospitalProfile,
  type ReportStatus,
  type UserRole,
  type UserRoleRecord,
} from '../types.ts';

interface AdminViewProps {
  user: User;
  onNotify: (type: 'success' | 'error', message: string) => void;
}

type AdminSectionTab = 'hospitals' | 'flagged' | 'devices' | 'reports' | 'logs' | 'roles';

const ROLE_LABELS: Record<UserRole, string> = {
  donor: 'Donor',
  requester: 'Requester',
  hospital: 'Hospital / Blood Bank',
  admin: 'Admin',
};

const FLAG_REASON_LABELS: Record<string, string> = {
  device_limit_24h: '>3 signups on same device (24h)',
  device_signup_limit: 'Multiple signups on same device',
  ip_shared_24h: 'Shared IP (>3 signups in 24h)',
  shared_ip: 'Shared IP (>3 signups in 24h)',
  reported: 'Reported by user',
  admin_action: 'Admin moderation',
};

const REPORT_REASON_LABELS: Record<string, string> = {
  fake_request: 'Fake / misleading request',
  spam: 'Spam / unwanted contact',
  harassment: 'Harassment / abuse',
  suspicious_activity: 'Suspicious / duplicate account',
  other: 'Other safety concern',
};

const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  open: 'Open',
  approved_dismissed: 'Reviewed & Dismissed',
  suspended: 'User Suspended',
  restored: 'User Restored',
};

export function AdminView({ user, onNotify }: AdminViewProps) {
  const [sectionTab, setSectionTab] = useState<AdminSectionTab>('flagged');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [hospitals, setHospitals] = useState<HospitalProfile[]>([]);
  const [users, setUsers] = useState<UserRoleRecord[]>([]);
  const [flaggedAccounts, setFlaggedAccounts] = useState<AccountModerationRecord[]>([]);
  const [reports, setReports] = useState<AbuseReport[]>([]);
  const [authLogs, setAuthLogs] = useState<AuthEventLog[]>([]);
  const [deviceRegistrations, setDeviceRegistrations] = useState<DeviceRegistrationRecord[]>([]);
  const [purgedExpiredLogs, setPurgedExpiredLogs] = useState(0);

  const [hospitalFilter, setHospitalFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>(
    'pending',
  );
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [pendingReviewAction, setPendingReviewAction] = useState<{
    hospital: HospitalProfile;
    status: HospitalApprovalStatus;
  } | null>(null);

  const [accountFilter, setAccountFilter] = useState<'flagged' | 'pending_review' | 'suspended' | 'all'>('flagged');
  const [accountNotes, setAccountNotes] = useState<Record<string, string>>({});
  const [moderatingUid, setModeratingUid] = useState<string | null>(null);
  const [pendingSuspendAccount, setPendingSuspendAccount] = useState<AccountModerationRecord | null>(null);

  const [deviceSearch, setDeviceSearch] = useState('');
  const [manualResetDeviceId, setManualResetDeviceId] = useState('');
  const [resettingDeviceKey, setResettingDeviceKey] = useState<string | null>(null);
  const [pendingResetDevice, setPendingResetDevice] = useState<{
    deviceHash?: string;
    deviceId: string;
    label?: string;
  } | null>(null);

  const [reportFilter, setReportFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [reportNotes, setReportNotes] = useState<Record<string, string>>({});
  const [reviewingReportId, setReviewingReportId] = useState<string | null>(null);

  const [logSearch, setLogSearch] = useState('');

  const [userSearch, setUserSearch] = useState('');
  const [roleDrafts, setRoleDrafts] = useState<Record<string, UserRole>>({});
  const [savingRoleUid, setSavingRoleUid] = useState<string | null>(null);

  const [manualUid, setManualUid] = useState('');
  const [manualRole, setManualRole] = useState<UserRole>('admin');
  const [savingManualRole, setSavingManualRole] = useState(false);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/overview', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as {
        hospitals?: HospitalProfile[];
        users?: UserRoleRecord[];
        flaggedAccounts?: AccountModerationRecord[];
        reports?: AbuseReport[];
        authLogs?: AuthEventLog[];
        deviceRegistrations?: DeviceRegistrationRecord[];
        purgedExpiredLogs?: number;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Could not load admin dashboard.');
      }
      const nextHospitals = Array.isArray(data.hospitals) ? data.hospitals : [];
      const nextUsers = Array.isArray(data.users) ? data.users : [];
      const nextFlagged = Array.isArray(data.flaggedAccounts) ? data.flaggedAccounts : [];
      const nextReports = Array.isArray(data.reports) ? data.reports : [];
      const nextLogs = Array.isArray(data.authLogs) ? data.authLogs : [];
      const nextDevices = Array.isArray(data.deviceRegistrations) ? data.deviceRegistrations : [];

      setHospitals(nextHospitals);
      setUsers(nextUsers);
      setFlaggedAccounts(nextFlagged);
      setReports(nextReports);
      setAuthLogs(nextLogs);
      setDeviceRegistrations(nextDevices);
      setPurgedExpiredLogs(Number(data.purgedExpiredLogs || 0));

      const notesMap: Record<string, string> = {};
      for (const h of nextHospitals) {
        notesMap[h.uid] = h.reviewNote || '';
      }
      setReviewNotes(notesMap);

      const accNotesMap: Record<string, string> = {};
      for (const acc of nextFlagged) {
        accNotesMap[acc.uid] = acc.reviewNote || '';
      }
      setAccountNotes(accNotesMap);

      const repNotesMap: Record<string, string> = {};
      for (const rep of nextReports) {
        repNotesMap[rep.id] = rep.reviewNote || '';
      }
      setReportNotes(repNotesMap);

      const roleMap: Record<string, UserRole> = {};
      for (const u of nextUsers) {
        roleMap[u.uid] = u.role;
      }
      setRoleDrafts(roleMap);
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Could not load admin dashboard.';
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const counts = useMemo(() => {
    let pending = 0;
    let approved = 0;
    let rejected = 0;
    for (const h of hospitals) {
      if (h.status === 'pending') pending += 1;
      else if (h.status === 'approved') approved += 1;
      else if (h.status === 'rejected') rejected += 1;
    }
    const pendingReviewAcc = flaggedAccounts.filter(
      (a) => a.requiresAdminReview || a.status === 'pending_review',
    ).length;
    const suspendedAcc = flaggedAccounts.filter((a) => a.status === 'suspended').length;
    const flaggedOrActionedAcc = flaggedAccounts.filter(
      (a) =>
        a.status !== 'active' ||
        a.requiresAdminReview ||
        a.deviceFlagged ||
        a.ipFlagged ||
        a.reportedFlagged ||
        a.flagReasons.length > 0,
    ).length;
    const openReports = reports.filter((r) => r.status === 'open').length;

    return {
      pending,
      approved,
      rejected,
      allHospitals: hospitals.length,
      pendingReviewAcc,
      suspendedAcc,
      flaggedOrActionedAcc,
      allAccounts: flaggedAccounts.length,
      openReports,
      allReports: reports.length,
    };
  }, [hospitals, flaggedAccounts, reports]);

  const filteredHospitals = useMemo(() => {
    if (hospitalFilter === 'all') return hospitals;
    return hospitals.filter((h) => h.status === hospitalFilter);
  }, [hospitals, hospitalFilter]);

  const filteredAccounts = useMemo(() => {
    if (accountFilter === 'all') return flaggedAccounts;
    if (accountFilter === 'pending_review') {
      return flaggedAccounts.filter((a) => a.requiresAdminReview || a.status === 'pending_review');
    }
    if (accountFilter === 'suspended') {
      return flaggedAccounts.filter((a) => a.status === 'suspended');
    }
    return flaggedAccounts.filter(
      (a) =>
        a.status !== 'active' ||
        a.requiresAdminReview ||
        a.deviceFlagged ||
        a.ipFlagged ||
        a.reportedFlagged ||
        a.flagReasons.length > 0,
    );
  }, [flaggedAccounts, accountFilter]);

  const filteredReports = useMemo(() => {
    if (reportFilter === 'open') return reports.filter((r) => r.status === 'open');
    if (reportFilter === 'resolved') return reports.filter((r) => r.status !== 'open');
    return reports;
  }, [reports, reportFilter]);

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    if (!q) return authLogs;
    return authLogs.filter(
      (l) =>
        l.username.toLowerCase().includes(q) ||
        l.email.toLowerCase().includes(q) ||
        l.uid.toLowerCase().includes(q) ||
        l.deviceId.toLowerCase().includes(q) ||
        l.ipHash.toLowerCase().includes(q) ||
        l.eventType.toLowerCase().includes(q),
    );
  }, [authLogs, logSearch]);

  const filteredDevices = useMemo(() => {
    const q = deviceSearch.trim().toLowerCase();
    if (!q) return deviceRegistrations;
    return deviceRegistrations.filter(
      (d) =>
        d.deviceId.toLowerCase().includes(q) ||
        d.deviceHash.toLowerCase().includes(q) ||
        d.registeredUid.toLowerCase().includes(q) ||
        d.registeredEmail.toLowerCase().includes(q) ||
        d.registeredUsername.toLowerCase().includes(q) ||
        d.ipHash.toLowerCase().includes(q),
    );
  }, [deviceRegistrations, deviceSearch]);

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q) ||
        u.uid.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q),
    );
  }, [users, userSearch]);

  const executeHospitalReview = async (
    hospital: HospitalProfile,
    status: HospitalApprovalStatus,
  ) => {
    setReviewingId(hospital.uid);
    try {
      const token = await user.getIdToken();
      const reviewNote = (reviewNotes[hospital.uid] || '').trim();
      const res = await fetch(`/api/admin/hospitals/${encodeURIComponent(hospital.uid)}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status, reviewNote }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Could not update hospital approval status.');
      }

      setHospitals((prev) =>
        prev.map((h) =>
          h.uid === hospital.uid ? { ...h, status, reviewNote, reviewedBy: user.uid } : h,
        ),
      );
      setPendingReviewAction(null);
      onNotify(
        'success',
        status === 'approved'
          ? `${hospital.name} approved`
          : status === 'rejected'
            ? `${hospital.name} rejected`
            : `${hospital.name} moved to pending`,
      );
    } catch (err) {
      const msg =
        err instanceof Error && err.message ? err.message : 'Could not update approval status.';
      onNotify('error', msg);
      setPendingReviewAction(null);
    } finally {
      setReviewingId(null);
    }
  };

  const executeAccountModerate = async (
    targetUid: string,
    action: 'approve' | 'suspend' | 'restore',
  ) => {
    setModeratingUid(targetUid);
    try {
      const token = await user.getIdToken();
      const reviewNote = (accountNotes[targetUid] || '').trim();
      const res = await fetch(`/api/admin/accounts/${encodeURIComponent(targetUid)}/moderate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action, reviewNote }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Could not update account status.');
      }
      setPendingSuspendAccount(null);
      onNotify(
        'success',
        action === 'approve'
          ? 'Account approved'
          : action === 'suspend'
            ? 'Account suspended'
            : 'Account restored',
      );
      await loadOverview();
    } catch (err) {
      setPendingSuspendAccount(null);
      onNotify('error', err instanceof Error ? err.message : 'Could not update account status.');
    } finally {
      setModeratingUid(null);
    }
  };

  const handleReviewReport = async (
    report: AbuseReport,
    action: 'approve_dismiss' | 'suspend_user' | 'restore_user',
  ) => {
    setReviewingReportId(report.id);
    try {
      const token = await user.getIdToken();
      const reviewNote = (reportNotes[report.id] || '').trim();
      const res = await fetch(`/api/admin/reports/${encodeURIComponent(report.id)}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action, reviewNote }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Could not update report.');
      }
      onNotify(
        'success',
        action === 'suspend_user'
          ? 'User suspended and report updated'
          : action === 'restore_user'
            ? 'User restored and report updated'
            : 'Report approved and closed',
      );
      await loadOverview();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not update report.');
    } finally {
      setReviewingReportId(null);
    }
  };

  const handleAssignUserRole = async (targetUid: string, nextRole: UserRole) => {
    setSavingRoleUid(targetUid);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/users/${encodeURIComponent(targetUid)}/role`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ role: nextRole }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Could not assign role.');
      }

      onNotify('success', `Role updated to ${ROLE_LABELS[nextRole]}`);
      await loadOverview();
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Could not assign role.';
      onNotify('error', msg);
    } finally {
      setSavingRoleUid(null);
    }
  };

  const handleManualAssignSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const uid = manualUid.trim();
    if (!uid) {
      onNotify('error', 'Enter a user ID to assign a role.');
      return;
    }
    setSavingManualRole(true);
    try {
      await handleAssignUserRole(uid, manualRole);
      setManualUid('');
    } finally {
      setSavingManualRole(false);
    }
  };

  const executeDeviceReset = async (target: { deviceHash?: string; deviceId: string }) => {
    const busyKey = target.deviceHash || target.deviceId;
    setResettingDeviceKey(busyKey);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/devices/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          deviceHash: target.deviceHash || undefined,
          deviceId: target.deviceId || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Could not reset device.');
      }
      setPendingResetDevice(null);
      setManualResetDeviceId('');
      onNotify('success', 'Device lock reset. A genuine user on this device can register again.');
      await loadOverview();
    } catch (err) {
      setPendingResetDevice(null);
      onNotify('error', err instanceof Error ? err.message : 'Could not reset device.');
    } finally {
      setResettingDeviceKey(null);
    }
  };

  const handleManualResetDeviceSubmit = (e: FormEvent) => {
    e.preventDefault();
    const cleaned = manualResetDeviceId.trim();
    if (!/^[a-zA-Z0-9_\-]{12,64}$/.test(cleaned)) {
      onNotify('error', 'Enter a valid Device ID (12–64 characters).');
      return;
    }
    setPendingResetDevice({ deviceId: cleaned, label: cleaned });
  };

  const adminTabs: Array<{ id: AdminSectionTab; label: string; count?: number }> = [
    { id: 'flagged', label: 'Flagged Accounts', count: counts.flaggedOrActionedAcc },
    { id: 'devices', label: 'Devices', count: deviceRegistrations.length },
    { id: 'reports', label: 'Reports', count: counts.openReports },
    { id: 'hospitals', label: 'Hospitals', count: counts.pending },
    { id: 'logs', label: 'Security Logs', count: authLogs.length },
    { id: 'roles', label: 'User Roles', count: users.length },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Admin Panel
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Review flagged accounts, reset device locks, handle reports, inspect 30-day security logs, approve hospitals, and manage roles.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadOverview()}
          disabled={loading}
          className="min-h-[42px] px-4 py-2 text-xs font-semibold text-slate-700 hover:text-slate-900 bg-white border border-slate-200 rounded-lg self-start sm:self-auto"
        >
          {loading ? 'Refreshing...' : 'Refresh all'}
        </button>
      </div>

      {/* Section tabs */}
      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
        {adminTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSectionTab(t.id)}
            className={`min-h-[38px] px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap flex items-center gap-1.5 ${
              sectionTab === t.id
                ? 'bg-white text-slate-900 border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span>{t.label}</span>
            {typeof t.count === 'number' && t.count > 0 && (
              <span className="font-mono-tabular text-[11px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
          {loadError}
        </div>
      )}

      {/* Flagged Accounts */}
      {sectionTab === 'flagged' && (
        <section className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-600" />
              <h2 className="text-lg font-semibold text-slate-900">
                Flagged &amp; Moderated Accounts
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(
                [
                  { id: 'flagged', label: `Flagged (${counts.flaggedOrActionedAcc})` },
                  { id: 'pending_review', label: `Needs Review (${counts.pendingReviewAcc})` },
                  { id: 'suspended', label: `Suspended (${counts.suspendedAcc})` },
                  { id: 'all', label: `All (${counts.allAccounts})` },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setAccountFilter(f.id)}
                  className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    accountFilter === f.id
                      ? 'bg-white text-slate-900 border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500">
              Loading account moderation records...
            </div>
          ) : filteredAccounts.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-sm text-slate-600">
              No accounts match this filter right now.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {filteredAccounts.map((acc) => {
                const isBusy = moderatingUid === acc.uid;
                const isSelf = acc.uid === user.uid;
                return (
                  <article
                    key={acc.uid}
                    className="bg-white border border-slate-200 rounded-xl p-5 space-y-3.5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900 break-all">
                          {acc.username ? `@${acc.username}` : acc.email || acc.uid}
                        </p>
                        {acc.email && (
                          <p className="text-xs text-slate-600 break-all">{acc.email}</p>
                        )}
                        <p className="font-mono-tabular text-[11px] text-slate-500 mt-0.5 break-all">
                          UID: {acc.uid}
                        </p>
                      </div>
                      <span
                        className={`text-xs font-semibold px-2.5 py-1 rounded-md border shrink-0 ${
                          acc.status === 'suspended'
                            ? 'bg-red-50 border-red-200 text-red-800'
                            : acc.status === 'pending_review'
                              ? 'bg-amber-50 border-amber-200 text-amber-800'
                              : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        }`}
                      >
                        {acc.status === 'suspended'
                          ? 'Suspended'
                          : acc.status === 'pending_review'
                            ? 'Pending review'
                            : 'Active'}
                      </span>
                    </div>

                    <div className="space-y-1 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">
                      <div className="flex flex-wrap gap-1.5">
                        {acc.flagReasons.length === 0 ? (
                          <span>No active flags</span>
                        ) : (
                          acc.flagReasons.map((reason) => (
                            <span
                              key={reason}
                              className="px-2 py-0.5 bg-white border border-slate-200 rounded text-[11px] font-medium text-slate-800"
                            >
                              {FLAG_REASON_LABELS[reason] || reason}
                            </span>
                          ))
                        )}
                      </div>
                      <p className="font-mono-tabular text-[11px] text-slate-500 pt-1">
                        24h IP signups: {acc.ipSignupCount24h}
                        {acc.ipFlagged && acc.status === 'active'
                          ? ' · Flagged for review (not blocked by IP alone)'
                          : ''}
                        {acc.lastDeviceId ? ` · Device: ${acc.lastDeviceId}` : ''}
                      </p>
                    </div>

                    <div>
                      <label htmlFor={`acc-note-${acc.uid}`} className="block text-xs font-medium text-slate-700 mb-1">
                        Moderation note (optional)
                      </label>
                      <input
                        id={`acc-note-${acc.uid}`}
                        type="text"
                        maxLength={300}
                        value={accountNotes[acc.uid] || ''}
                        onChange={(e) =>
                          setAccountNotes((prev) => ({ ...prev, [acc.uid]: e.target.value }))
                        }
                        placeholder="Decision notes for audit trail"
                        className="w-full min-h-[38px] px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                      {(acc.requiresAdminReview ||
                        acc.status === 'pending_review' ||
                        acc.ipFlagged ||
                        acc.deviceFlagged ||
                        acc.reportedFlagged) &&
                        acc.status !== 'suspended' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void executeAccountModerate(acc.uid, 'approve')}
                            className="flex-1 min-h-[40px] px-3 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5"
                          >
                            {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                            Approve
                          </button>
                        )}

                      {acc.status === 'suspended' ? (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void executeAccountModerate(acc.uid, 'restore')}
                          className="flex-1 min-h-[40px] px-3 py-2 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5"
                        >
                          {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                          Restore account
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isBusy || isSelf}
                          onClick={() => setPendingSuspendAccount(acc)}
                          className="flex-1 min-h-[40px] px-3 py-2 bg-white border border-red-300 hover:bg-red-50 disabled:opacity-40 text-red-700 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5"
                        >
                          <Ban className="w-3.5 h-3.5" />
                          Suspend
                        </button>
                      )}

                      {acc.lastDeviceId && (
                        <button
                          type="button"
                          disabled={resettingDeviceKey === acc.lastDeviceId}
                          onClick={() =>
                            setPendingResetDevice({
                              deviceId: acc.lastDeviceId,
                              label: acc.username ? `@${acc.username}'s device` : acc.lastDeviceId,
                            })
                          }
                          className="min-h-[40px] px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-60 text-slate-700 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5"
                        >
                          <Smartphone className="w-3.5 h-3.5" />
                          Reset device
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Registered Devices & Device Reset */}
      {sectionTab === 'devices' && (
        <section className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-red-600" />
              <h2 className="text-lg font-semibold text-slate-900">
                Registered Devices (1 Signup Limit)
              </h2>
            </div>

            <input
              type="text"
              value={deviceSearch}
              onChange={(e) => setDeviceSearch(e.target.value)}
              placeholder="Filter by device ID, UID, email, or IP hash..."
              className="w-full sm:w-80 min-h-[40px] px-3 py-1.5 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
            />
          </div>

          <form
            onSubmit={handleManualResetDeviceSubmit}
            className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row items-stretch sm:items-end gap-3"
          >
            <div className="flex-1">
              <label htmlFor="manual-device-id" className="block text-xs font-medium text-slate-700 mb-1">
                Reset a device lock by Device ID
              </label>
              <input
                id="manual-device-id"
                type="text"
                value={manualResetDeviceId}
                onChange={(e) => setManualResetDeviceId(e.target.value)}
                placeholder="Paste browser device ID (e.g. dev_...)"
                className="w-full min-h-[42px] px-3 py-1.5 text-xs font-mono-tabular bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
            </div>
            <button
              type="submit"
              disabled={Boolean(resettingDeviceKey)}
              className="min-h-[42px] px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset device
            </button>
          </form>

          {loading ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500">
              Loading device registrations...
            </div>
          ) : filteredDevices.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-sm text-slate-600">
              No locked devices found. Each device is limited to 1 new account signup unless reset here.
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
              {filteredDevices.map((reg) => {
                const daysLeft = reg.expiresAtMs
                  ? Math.max(0, Math.ceil((reg.expiresAtMs - Date.now()) / (24 * 60 * 60 * 1000)))
                  : 30;
                const matchedUser = users.find((u) => u.uid === reg.registeredUid);
                const displayName =
                  matchedUser?.username || reg.registeredUsername
                    ? `@${matchedUser?.username || reg.registeredUsername}`
                    : reg.registeredEmail || reg.registeredUid;
                const isBusy = resettingDeviceKey === reg.deviceHash;

                return (
                  <div
                    key={reg.deviceHash}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-900">{displayName}</span>
                        <span className="font-mono-tabular text-slate-500">
                          {reg.createdAtMs ? new Date(reg.createdAtMs).toLocaleString() : 'Active lock'}
                        </span>
                      </div>
                      <div className="font-mono-tabular text-[11px] text-slate-600 flex flex-wrap gap-x-4 gap-y-1">
                        <span>Device: {reg.deviceId}</span>
                        <span>UID: {reg.registeredUid}</span>
                        <span>IP Hash: {reg.ipHash.slice(0, 16)}...</span>
                        <span>Expires in ~{daysLeft}d</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        setPendingResetDevice({
                          deviceHash: reg.deviceHash,
                          deviceId: reg.deviceId,
                          label: displayName,
                        })
                      }
                      className="min-h-[38px] px-3.5 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-60 text-slate-800 text-xs font-semibold rounded-lg flex items-center gap-1.5 whitespace-nowrap self-start sm:self-auto"
                    >
                      {isBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="w-3.5 h-3.5" />
                      )}
                      Reset device
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* User Reports */}
      {sectionTab === 'reports' && (
        <section className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileWarning className="w-5 h-5 text-red-600" />
              <h2 className="text-lg font-semibold text-slate-900">
                User, Request &amp; Message Reports
              </h2>
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(
                [
                  { id: 'open', label: `Open (${counts.openReports})` },
                  { id: 'resolved', label: `Reviewed (${counts.allReports - counts.openReports})` },
                  { id: 'all', label: `All (${counts.allReports})` },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setReportFilter(f.id)}
                  className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    reportFilter === f.id
                      ? 'bg-white text-slate-900 border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500">
              Loading reports...
            </div>
          ) : filteredReports.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-sm text-slate-600">
              No {reportFilter === 'all' ? '' : reportFilter} reports right now.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {filteredReports.map((rep) => {
                const isBusy = reviewingReportId === rep.id;
                const targetIsSelf = rep.targetUid === user.uid;
                return (
                  <article
                    key={rep.id}
                    className="bg-white border border-slate-200 rounded-xl p-5 space-y-3.5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          {rep.targetType} report · {REPORT_REASON_LABELS[rep.reason] || rep.reason}
                        </p>
                        <p className="text-sm font-semibold text-slate-900 mt-0.5">
                          Target: {rep.targetUsername ? `@${rep.targetUsername}` : rep.targetUid || rep.targetId}
                        </p>
                        <p className="text-xs text-slate-500">
                          Reported by {rep.reporterUsername ? `@${rep.reporterUsername}` : rep.reporterUid}
                          {rep.createdAtMs ? ` · ${new Date(rep.createdAtMs).toLocaleString()}` : ''}
                        </p>
                      </div>
                      <span
                        className={`text-xs font-semibold px-2.5 py-1 rounded-md border shrink-0 ${
                          rep.status === 'open'
                            ? 'bg-amber-50 border-amber-200 text-amber-800'
                            : rep.status === 'suspended'
                              ? 'bg-red-50 border-red-200 text-red-800'
                              : 'bg-slate-100 border-slate-200 text-slate-700'
                        }`}
                      >
                        {REPORT_STATUS_LABELS[rep.status]}
                      </span>
                    </div>

                    {rep.targetPreview && (
                      <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700 break-words">
                        {rep.targetPreview}
                      </div>
                    )}

                    {rep.details && (
                      <p className="text-xs text-slate-700">
                        Reporter note: {rep.details}
                      </p>
                    )}

                    <div>
                      <label htmlFor={`rep-note-${rep.id}`} className="block text-xs font-medium text-slate-700 mb-1">
                        Admin note (optional)
                      </label>
                      <input
                        id={`rep-note-${rep.id}`}
                        type="text"
                        maxLength={300}
                        value={reportNotes[rep.id] || ''}
                        onChange={(e) =>
                          setReportNotes((prev) => ({ ...prev, [rep.id]: e.target.value }))
                        }
                        placeholder="Action summary"
                        className="w-full min-h-[38px] px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleReviewReport(rep, 'approve_dismiss')}
                        className="min-h-[38px] px-3 py-1.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5"
                      >
                        <Check className="w-3.5 h-3.5" />
                        Approve / Dismiss
                      </button>

                      {rep.targetUid && (
                        <>
                          <button
                            type="button"
                            disabled={isBusy || targetIsSelf}
                            onClick={() => void handleReviewReport(rep, 'suspend_user')}
                            className="min-h-[38px] px-3 py-1.5 bg-white border border-red-300 hover:bg-red-50 disabled:opacity-40 text-red-700 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5"
                          >
                            <Ban className="w-3.5 h-3.5" />
                            Suspend user
                          </button>

                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleReviewReport(rep, 'restore_user')}
                            className="min-h-[38px] px-3 py-1.5 bg-white border border-emerald-300 hover:bg-emerald-50 disabled:opacity-60 text-emerald-800 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Restore user
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Hospital & Blood Bank Approvals */}
      {sectionTab === 'hospitals' && (
        <section className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-2">
              <Building2 className="w-5 h-5 text-red-600" />
              <h2 className="text-lg font-semibold text-slate-900">
                Hospital &amp; Blood Bank Approvals
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(
                [
                  { id: 'pending', label: `Pending (${counts.pending})` },
                  { id: 'approved', label: `Approved (${counts.approved})` },
                  { id: 'rejected', label: `Rejected (${counts.rejected})` },
                  { id: 'all', label: `All (${counts.allHospitals})` },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setHospitalFilter(t.id)}
                  className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    hospitalFilter === t.id
                      ? 'bg-white text-slate-900 border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500">
              Loading hospital registrations...
            </div>
          ) : filteredHospitals.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-sm text-slate-600">
              No {hospitalFilter === 'all' ? '' : hospitalFilter} hospital or blood bank registrations right now.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {filteredHospitals.map((h) => {
                const locParts = [h.locality, h.city, h.stateName, h.countryName].filter(Boolean);
                const isBusy = reviewingId === h.uid;
                return (
                  <article
                    key={h.uid}
                    className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span>{h.facilityType === 'blood_bank' ? 'Blood Bank' : 'Hospital'}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono-tabular">@{h.ownerUsername}</span>
                        </div>
                        <h3 className="text-base font-semibold text-slate-900 mt-0.5 break-words">
                          {h.name}
                        </h3>
                      </div>

                      <span
                        className={`text-xs font-semibold px-2.5 py-1 rounded-md border shrink-0 ${
                          h.status === 'approved'
                            ? 'bg-green-50 border-green-200 text-green-800'
                            : h.status === 'rejected'
                              ? 'bg-red-50 border-red-200 text-red-800'
                              : 'bg-amber-50 border-amber-200 text-amber-800'
                        }`}
                      >
                        {h.status === 'approved'
                          ? 'Approved'
                          : h.status === 'rejected'
                            ? 'Rejected'
                            : 'Pending'}
                      </span>
                    </div>

                    <div className="space-y-1.5 text-xs text-slate-600">
                      <div className="flex items-start gap-2">
                        <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                        <span>
                          {locParts.join(' · ')}
                          {h.pincode ? ` (${h.pincode})` : ''}
                        </span>
                      </div>
                      {h.contact && (
                        <div className="flex items-center gap-2">
                          <Phone className="w-4 h-4 text-slate-400 shrink-0" />
                          <span className="font-mono-tabular text-slate-800">{h.contact}</span>
                        </div>
                      )}
                      {h.licenseNumber && (
                        <div className="font-mono-tabular text-slate-700">
                          License: {h.licenseNumber}
                        </div>
                      )}
                    </div>

                    <div>
                      <label
                        htmlFor={`note-${h.uid}`}
                        className="block text-xs font-medium text-slate-700 mb-1"
                      >
                        Review note (optional)
                      </label>
                      <input
                        id={`note-${h.uid}`}
                        type="text"
                        maxLength={300}
                        value={reviewNotes[h.uid] || ''}
                        onChange={(e) =>
                          setReviewNotes((prev) => ({ ...prev, [h.uid]: e.target.value }))
                        }
                        placeholder="Verification details or reason for rejection"
                        className="w-full min-h-[40px] px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                      {h.status !== 'approved' && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void executeHospitalReview(h, 'approved')}
                          className="flex-1 min-h-[42px] px-3 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5"
                        >
                          {isBusy ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Check className="w-3.5 h-3.5" />
                          )}
                          Approve
                        </button>
                      )}

                      {h.status !== 'rejected' && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => setPendingReviewAction({ hospital: h, status: 'rejected' })}
                          className="flex-1 min-h-[42px] px-3 py-2 bg-white border border-red-300 hover:bg-red-50 disabled:opacity-60 text-red-700 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5"
                        >
                          <X className="w-3.5 h-3.5" />
                          Reject
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Security Logs (Admin-Only, Keyed Hash IP, 30-Day Retention) */}
      {sectionTab === 'logs' && (
        <section className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-2">
              <ScrollText className="w-5 h-5 text-red-600" />
              <h2 className="text-lg font-semibold text-slate-900">
                Signup &amp; Login Security Logs
              </h2>
            </div>

            <input
              type="text"
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              placeholder="Filter by UID, @username, device ID, or hash..."
              className="w-full sm:w-80 min-h-[40px] px-3 py-1.5 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
            />
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-700 space-y-1">
            <p className="font-semibold text-slate-900">Admin-only retention policy</p>
            <p>
              Security logs are readable only by admin accounts, store a one-way keyed hash of the server-observed IP address (never raw IP addresses), and are deleted automatically after 30 days.
              {purgedExpiredLogs > 0 ? ` Cleaned up ${purgedExpiredLogs} expired log entries on this load.` : ''}
            </p>
          </div>

          {loading ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500">
              Loading security logs...
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-sm text-slate-600">
              No security logs recorded yet.
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
              {filteredLogs.map((log) => {
                const daysLeft = log.expiresAtMs
                  ? Math.max(0, Math.ceil((log.expiresAtMs - Date.now()) / (24 * 60 * 60 * 1000)))
                  : 30;
                return (
                  <div key={log.id} className="p-4 space-y-1.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`px-2 py-0.5 rounded font-semibold uppercase ${
                            log.eventType === 'signup'
                              ? 'bg-red-50 text-red-700 border border-red-200'
                              : 'bg-slate-100 text-slate-800 border border-slate-200'
                          }`}
                        >
                          {log.eventType}
                        </span>
                        <span className="font-semibold text-slate-900">
                          {log.username ? `@${log.username}` : log.email || log.uid}
                        </span>
                        {log.deviceFlagged && (
                          <span className="px-1.5 py-0.5 bg-amber-50 border border-amber-200 text-amber-800 rounded font-medium">
                            Device flagged
                          </span>
                        )}
                        {log.ipFlagged && (
                          <span className="px-1.5 py-0.5 bg-slate-100 border border-slate-200 text-slate-700 rounded font-medium">
                            Shared IP flag
                          </span>
                        )}
                      </div>
                      <span className="font-mono-tabular text-slate-500">
                        {log.createdAtMs ? new Date(log.createdAtMs).toLocaleString() : 'Just now'}
                      </span>
                    </div>

                    <div className="font-mono-tabular text-[11px] text-slate-600 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span>UID: {log.uid}</span>
                        <span>Device: {log.deviceId}</span>
                        <span>IP Hash: {log.ipHash.slice(0, 16)}...</span>
                        <span>Consent: {log.consentAccepted ? 'Yes' : 'Existing/N/A'}</span>
                        <span>Deletes in ~{daysLeft}d</span>
                      </div>
                      {log.deviceId && (
                        <button
                          type="button"
                          disabled={resettingDeviceKey === log.deviceId}
                          onClick={() =>
                            setPendingResetDevice({
                              deviceId: log.deviceId,
                              label: log.username ? `@${log.username}'s device` : log.deviceId,
                            })
                          }
                          className="px-2.5 py-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-sans text-[11px] font-semibold rounded-md flex items-center gap-1"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Reset device
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* User Role Management */}
      {sectionTab === 'roles' && (
        <section className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-red-600" />
              <h2 className="text-lg font-semibold text-slate-900">User Role Management</h2>
            </div>

            <input
              type="text"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Filter by email, @username, or UID..."
              className="w-full sm:w-72 min-h-[40px] px-3 py-1.5 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
            />
          </div>

          <form
            onSubmit={handleManualAssignSubmit}
            className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row items-stretch sm:items-end gap-3"
          >
            <div className="flex-1">
              <label htmlFor="manual-uid" className="block text-xs font-medium text-slate-700 mb-1">
                Assign role by User ID (UID)
              </label>
              <input
                id="manual-uid"
                type="text"
                value={manualUid}
                onChange={(e) => setManualUid(e.target.value)}
                placeholder="Paste Firebase user UID"
                className="w-full min-h-[42px] px-3 py-1.5 text-xs font-mono-tabular bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
            </div>

            <div className="sm:w-48">
              <label htmlFor="manual-role" className="block text-xs font-medium text-slate-700 mb-1">
                Role
              </label>
              <select
                id="manual-role"
                value={manualRole}
                onChange={(e) => setManualRole(e.target.value as UserRole)}
                className="w-full min-h-[42px] px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              >
                {USER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              disabled={savingManualRole}
              className="min-h-[42px] px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 whitespace-nowrap"
            >
              {savingManualRole ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="w-3.5 h-3.5" />
              )}
              Assign Role
            </button>
          </form>

          {loading ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500">
              Loading accounts...
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-sm text-slate-600">
              No user role records found.
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
              {filteredUsers.map((u) => {
                const draftRole = roleDrafts[u.uid] || u.role;
                const isSelf = u.uid === user.uid;
                const isDirty = draftRole !== u.role;
                const isBusy = savingRoleUid === u.uid;

                return (
                  <div
                    key={u.uid}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900 break-all">
                          {u.email || 'No email recorded'}
                        </span>
                        {u.username && (
                          <span className="font-mono-tabular text-xs text-slate-600">
                            @{u.username}
                          </span>
                        )}
                        {isSelf && (
                          <span className="text-[11px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">
                            You
                          </span>
                        )}
                      </div>
                      <p className="font-mono-tabular text-xs text-slate-500 break-all">
                        UID: {u.uid} · Current: {ROLE_LABELS[u.role]}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <select
                        aria-label={`Select role for ${u.email || u.uid}`}
                        disabled={isBusy}
                        value={draftRole}
                        onChange={(e) =>
                          setRoleDrafts((prev) => ({
                            ...prev,
                            [u.uid]: e.target.value as UserRole,
                          }))
                        }
                        className="min-h-[40px] px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                      >
                        {USER_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        disabled={isBusy || !isDirty || (isSelf && draftRole !== 'admin')}
                        onClick={() => void handleAssignUserRole(u.uid, draftRole)}
                        className="min-h-[40px] px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 whitespace-nowrap"
                      >
                        {isBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        Save Role
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <ConfirmModal
        open={Boolean(pendingReviewAction)}
        title="Reject facility registration?"
        message={
          pendingReviewAction
            ? `Reject ${pendingReviewAction.hospital.name}? They will not appear in the approved hospitals list or be able to update stock until approved.`
            : ''
        }
        confirmLabel="Yes, reject"
        cancelLabel="Cancel"
        loading={Boolean(reviewingId)}
        onConfirm={() => {
          if (pendingReviewAction) {
            void executeHospitalReview(pendingReviewAction.hospital, pendingReviewAction.status);
          }
        }}
        onCancel={() => {
          if (!reviewingId) setPendingReviewAction(null);
        }}
      />

      <ConfirmModal
        open={Boolean(pendingSuspendAccount)}
        title="Suspend this account?"
        message={
          pendingSuspendAccount
            ? `Suspend ${pendingSuspendAccount.username ? `@${pendingSuspendAccount.username}` : pendingSuspendAccount.uid}? They will be blocked from posting requests, sending messages, or appearing in donor search until restored.`
            : ''
        }
        confirmLabel="Yes, suspend"
        cancelLabel="Cancel"
        loading={Boolean(moderatingUid)}
        onConfirm={() => {
          if (pendingSuspendAccount) {
            void executeAccountModerate(pendingSuspendAccount.uid, 'suspend');
          }
        }}
        onCancel={() => {
          if (!moderatingUid) setPendingSuspendAccount(null);
        }}
      />

      <ConfirmModal
        open={Boolean(pendingResetDevice)}
        title="Reset device registration limit?"
        message={
          pendingResetDevice
            ? `Reset the device lock for ${pendingResetDevice.label || pendingResetDevice.deviceId}? A genuine user on this device will be allowed to create 1 new account.`
            : ''
        }
        confirmLabel="Yes, reset device"
        cancelLabel="Cancel"
        loading={Boolean(resettingDeviceKey)}
        onConfirm={() => {
          if (pendingResetDevice) {
            void executeDeviceReset({
              deviceHash: pendingResetDevice.deviceHash,
              deviceId: pendingResetDevice.deviceId,
            });
          }
        }}
        onCancel={() => {
          if (!resettingDeviceKey) setPendingResetDevice(null);
        }}
      />
    </div>
  );
}
