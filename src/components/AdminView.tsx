import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import { Building2, Check, Loader2, MapPin, Phone, ShieldCheck, Users, X } from 'lucide-react';
import { ConfirmModal } from './ConfirmModal.tsx';
import {
  USER_ROLES,
  type HospitalApprovalStatus,
  type HospitalProfile,
  type UserRole,
  type UserRoleRecord,
} from '../types.ts';

interface AdminViewProps {
  user: User;
  onNotify: (type: 'success' | 'error', message: string) => void;
}

const ROLE_LABELS: Record<UserRole, string> = {
  donor: 'Donor',
  requester: 'Requester',
  hospital: 'Hospital / Blood Bank',
  admin: 'Admin',
};

export function AdminView({ user, onNotify }: AdminViewProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [hospitals, setHospitals] = useState<HospitalProfile[]>([]);
  const [users, setUsers] = useState<UserRoleRecord[]>([]);

  const [hospitalFilter, setHospitalFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>(
    'pending',
  );
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [pendingReviewAction, setPendingReviewAction] = useState<{
    hospital: HospitalProfile;
    status: HospitalApprovalStatus;
  } | null>(null);

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
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Could not load admin dashboard.');
      }
      const nextHospitals = Array.isArray(data.hospitals) ? data.hospitals : [];
      const nextUsers = Array.isArray(data.users) ? data.users : [];
      setHospitals(nextHospitals);
      setUsers(nextUsers);

      const notesMap: Record<string, string> = {};
      for (const h of nextHospitals) {
        notesMap[h.uid] = h.reviewNote || '';
      }
      setReviewNotes(notesMap);

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
    return { pending, approved, rejected, all: hospitals.length };
  }, [hospitals]);

  const filteredHospitals = useMemo(() => {
    if (hospitalFilter === 'all') return hospitals;
    return hospitals.filter((h) => h.status === hospitalFilter);
  }, [hospitals, hospitalFilter]);

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

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Admin Panel
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Approve or reject hospital and blood bank registrations, and assign user roles including admin access.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadOverview()}
          disabled={loading}
          className="min-h-[42px] px-4 py-2 text-xs font-semibold text-slate-700 hover:text-slate-900 bg-white border border-slate-200 rounded-lg self-start sm:self-auto"
        >
          {loading ? 'Refreshing...' : 'Refresh list'}
        </button>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
          {loadError}
        </div>
      )}

      {/* Section 1: Hospital & Blood Bank Approvals */}
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
                { id: 'all', label: `All (${counts.all})` },
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

      {/* Section 2: User Role Assignment */}
      <section className="space-y-4 pt-4 border-t border-slate-200">
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
    </div>
  );
}
