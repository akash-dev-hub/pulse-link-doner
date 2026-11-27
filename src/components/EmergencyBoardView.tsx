import { useEffect, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { ExternalLink, Loader2, MapPin, Phone, Plus, X } from 'lucide-react';
import { ConfirmModal } from './ConfirmModal.tsx';
import { LocationPickerMap } from './LocationPickerMap.tsx';
import { LocationSelector, matchReverseGeocodeToLocation } from './LocationSelector.tsx';
import {
  buildGoogleMapsDirectionsUrl,
  normalizeEmergencyRequest,
} from '../lib/eligibility.ts';
import { db } from '../lib/firebase.ts';
import {
  BLOOD_GROUPS,
  type BloodGroup,
  type EmergencyRequest,
  type HospitalApprovalStatus,
  type LocationValue,
  type ReverseGeocodeResult,
  type UserRole,
} from '../types.ts';

import { EmailVerificationNotice } from './EmailVerificationNotice.tsx';

interface EmergencyBoardViewProps {
  user: User;
  emailVerified: boolean;
  userRole: UserRole;
  hospitalStatus: HospitalApprovalStatus | null;
  resendingVerification: boolean;
  checkingVerification: boolean;
  onResendVerification: () => void;
  onCheckVerified: () => void;
  onNotify: (type: 'success' | 'error', message: string) => void;
  initialOpenForm?: boolean;
  onFormOpened?: () => void;
}

const DEFAULT_HOSPITAL_LOCATION: LocationValue = {
  countryCode: 'IN',
  countryName: 'India',
  stateCode: '',
  stateName: '',
  city: '',
  locality: '',
  pincode: '',
};

export function EmergencyBoardView({
  user,
  emailVerified,
  userRole,
  hospitalStatus,
  resendingVerification,
  checkingVerification,
  onResendVerification,
  onCheckVerified,
  onNotify,
  initialOpenForm = false,
  onFormOpened,
}: EmergencyBoardViewProps) {
  const [activeRequests, setActiveRequests] = useState<EmergencyRequest[]>([]);
  const [myFulfilledRequests, setMyFulfilledRequests] = useState<EmergencyRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'active' | 'fulfilled'>('active');

  const [showForm, setShowForm] = useState(initialOpenForm);
  const [bloodGroup, setBloodGroup] = useState<BloodGroup>('O+');
  const [units, setUnits] = useState<string>('1');
  const [hospitalName, setHospitalName] = useState('');
  const [location, setLocation] = useState<LocationValue>(DEFAULT_HOSPITAL_LOCATION);
  const [hospitalLat, setHospitalLat] = useState<number | null>(null);
  const [hospitalLng, setHospitalLng] = useState<number | null>(null);
  const [contact, setContact] = useState('');
  const [notes, setNotes] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [fulfillingId, setFulfillingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<EmergencyRequest | null>(null);
  const [boardError, setBoardError] = useState('');

  useEffect(() => {
    if (initialOpenForm) {
      setShowForm(true);
      onFormOpened?.();
    }
  }, [initialOpenForm, onFormOpened]);

  useEffect(() => {
    const qActive = query(
      collection(db, 'emergency_requests'),
      where('status', '==', 'active'),
    );
    const unsubActive = onSnapshot(
      qActive,
      (snap) => {
        const list = snap.docs
          .map((d) => normalizeEmergencyRequest(d.data() as Record<string, unknown>, d.id))
          .filter((r) => r.status === 'active')
          .sort((a, b) => b.createdAtMs - a.createdAtMs);
        setActiveRequests(list);
        setLoading(false);
      },
      (err) => {
        console.error('Failed to load active emergency requests:', err);
        setLoading(false);
        setBoardError('Could not load active requests right now. Please refresh.');
      },
    );

    const qMine = query(
      collection(db, 'emergency_requests'),
      where('createdBy', '==', user.uid),
    );
    const unsubMine = onSnapshot(
      qMine,
      (snap) => {
        const list = snap.docs
          .map((d) => normalizeEmergencyRequest(d.data() as Record<string, unknown>, d.id))
          .filter((r) => r.status === 'fulfilled')
          .sort((a, b) => (b.fulfilledAtMs || b.updatedAtMs) - (a.fulfilledAtMs || a.updatedAtMs));
        setMyFulfilledRequests(list);
      },
      (err) => {
        console.error('Failed to load fulfilled requests:', err);
      },
    );

    return () => {
      unsubActive();
      unsubMine();
    };
  }, [user.uid]);

  const handleReverseGeocode = (geo: ReverseGeocodeResult) => {
    setLocation((prev) => matchReverseGeocodeToLocation(geo, prev));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!emailVerified) {
      const msg = 'Please verify your email address before posting an emergency request.';
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
    if (hospitalName.trim().length < 2) {
      const msg = 'Please enter the hospital name.';
      setFormError(msg);
      onNotify('error', msg);
      return;
    }
    if (!location.countryCode || !location.city.trim()) {
      const msg = 'Please select the hospital country and city.';
      setFormError(msg);
      onNotify('error', msg);
      return;
    }
    if (location.countryCode === 'IN' && location.pincode && !/^\d{6}$/.test(location.pincode.trim())) {
      const msg = 'Indian PIN code must be 6 digits.';
      setFormError(msg);
      onNotify('error', msg);
      return;
    }
    if (contact.trim().length < 3) {
      const msg = 'Please provide a phone number or email to reach you.';
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
          bloodGroup,
          units: parsedUnits,
          hospitalName: hospitalName.trim(),
          countryCode: location.countryCode,
          countryName: location.countryName,
          stateCode: location.stateCode,
          stateName: location.stateName,
          city: location.city.trim(),
          locality: location.locality.trim(),
          pincode: location.pincode.trim(),
          hospitalLat,
          hospitalLng,
          contact: contact.trim(),
          notes: notes.trim(),
        }),
      });

      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || 'Could not post your request. Please try again.');
      }

      onNotify('success', 'Request posted');

      setHospitalName('');
      setUnits('1');
      setContact('');
      setNotes('');
      setHospitalLat(null);
      setHospitalLng(null);
      setLocation(DEFAULT_HOSPITAL_LOCATION);
      setShowForm(false);
    } catch (err) {
      const msg =
        err instanceof Error && err.message && !err.message.startsWith('Firestore')
          ? err.message
          : 'Could not post your request. Please try again.';
      setFormError(msg);
      onNotify('error', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmFulfill = async () => {
    if (!confirmTarget) return;
    const targetId = confirmTarget.id;
    setFulfillingId(targetId);
    setBoardError('');
    try {
      const token = await user.getIdToken();
      const response = await fetch(`/api/requests/${encodeURIComponent(targetId)}/fulfill`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || 'Could not close this request. Please try again.');
      }
      setConfirmTarget(null);
      onNotify('success', 'Request marked fulfilled');
    } catch (err) {
      const msg =
        err instanceof Error && err.message && !err.message.startsWith('Firestore')
          ? err.message
          : 'Could not close this request. Please try again.';
      setConfirmTarget(null);
      setBoardError(msg);
      onNotify('error', msg);
    } finally {
      setFulfillingId(null);
    }
  };

  const displayedRequests = tab === 'active' ? activeRequests : myFulfilledRequests;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Emergency Requests
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Urgent hospital needs. Posting alerts matching donors in the same city and nearby area first.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="min-h-[44px] px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
        >
          {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showForm ? 'Close form' : 'Post emergency request'}
        </button>
      </div>

      {showForm && !emailVerified && (
        <EmailVerificationNotice
          email={user.email || ''}
          variant="card"
          title="Verify your email to post a request"
          description="Anyone signed in can browse active emergency requests, but only verified accounts can post a new request or notify donors."
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
              : 'Your hospital or blood bank must be registered and approved by an admin before posting emergency requests as a facility. Open the Hospitals tab to check your status.'}
          </p>
        </div>
      )}

      {showForm && emailVerified && !(userRole === 'hospital' && hospitalStatus !== 'approved') && (
        <form
          onSubmit={handleSubmit}
          className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5"
        >
          <div className="border-b border-slate-100 pb-3">
            <h2 className="text-lg font-semibold text-slate-900">Ask for Urgent Blood</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Share where the patient is admitted and how donors can reach you.
            </p>
          </div>

          {formError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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

            <div>
              <label htmlFor="req-contact" className="block text-xs font-medium text-slate-700 mb-1.5">
                Contact Phone or Email<span className="text-red-600 ml-0.5">*</span>
              </label>
              <input
                id="req-contact"
                type="text"
                required
                maxLength={150}
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="Phone number or email"
                className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
              <p className="mt-1 text-xs text-red-700">
                Warning: Other signed-in users will see this contact on the emergency board.
              </p>
            </div>
          </div>

          <div>
            <label htmlFor="req-hospital-name" className="block text-xs font-medium text-slate-700 mb-1.5">
              Hospital Name<span className="text-red-600 ml-0.5">*</span>
            </label>
            <input
              id="req-hospital-name"
              type="text"
              required
              maxLength={120}
              value={hospitalName}
              onChange={(e) => setHospitalName(e.target.value)}
              placeholder="Hospital or blood bank name"
              className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
            />
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-900">Hospital Location</h3>
            <LocationSelector
              idPrefix="req"
              mode="form"
              showPincode
              requiredCity
              value={location}
              onChange={setLocation}
            />
          </div>

          <LocationPickerMap
            lat={hospitalLat}
            lng={hospitalLng}
            onCoordinatesChange={(nextLat, nextLng) => {
              setHospitalLat(nextLat);
              setHospitalLng(nextLng);
            }}
            onReverseGeocode={handleReverseGeocode}
            title="Hospital map pin (optional)"
            helperText="Tap 'Use my current location' or place the pin on the hospital so donors can open directions."
          />

          <div>
            <label htmlFor="req-notes" className="block text-xs font-medium text-slate-700 mb-1.5">
              Helpful notes for donors (optional)
            </label>
            <textarea
              id="req-notes"
              rows={2}
              maxLength={300}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ward, blood bank counter, or best time to call..."
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
              disabled={submitting}
              className="min-h-[44px] px-5 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-lg flex items-center gap-2 transition-colors"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Post Emergency Request
            </button>
          </div>
        </form>
      )}

      <div className="flex items-center justify-between gap-4 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            type="button"
            onClick={() => setTab('active')}
            className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'active'
                ? 'bg-white text-slate-900 border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Active ({activeRequests.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('fulfilled')}
            className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'fulfilled'
                ? 'bg-white text-slate-900 border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Closed by me ({myFulfilledRequests.length})
          </button>
        </div>
      </div>

      {boardError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
          {boardError}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <div key={i} className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="h-5 w-2/3 bg-slate-200 rounded" />
              <div className="h-4 w-1/2 bg-slate-100 rounded" />
              <div className="h-10 w-full bg-slate-100 rounded-lg" />
            </div>
          ))}
        </div>
      ) : displayedRequests.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
          <h3 className="text-base font-semibold text-slate-900">
            {tab === 'active' ? 'No active emergency requests right now' : 'No closed requests yet'}
          </h3>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            {tab === 'active'
              ? 'When a family or hospital posts an urgent blood request, it appears here right away.'
              : 'Requests you mark as fulfilled leave the active list and stay saved here.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {displayedRequests.map((req) => {
            const isCreator = req.createdBy === user.uid;
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

            return (
              <article
                key={req.id}
                className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span className={req.status === 'active' ? 'text-red-700 font-semibold' : 'text-slate-700 font-semibold'}>
                          {req.status === 'active' ? 'Needs blood' : 'Fulfilled'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono-tabular">{req.units} {req.units === 1 ? 'unit' : 'units'}</span>
                        <span aria-hidden="true">·</span>
                        <span>{postedLabel}</span>
                      </div>
                      <h3 className="text-lg font-semibold text-slate-900 mt-1 break-words">
                        {req.hospitalName}
                      </h3>
                    </div>

                    <span className="font-mono-tabular text-base font-bold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5 shrink-0">
                      {req.bloodGroup}
                    </span>
                  </div>

                  <div className="space-y-1.5 text-xs text-slate-600">
                    <div className="flex items-start gap-2">
                      <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                      <span>
                        {locParts.join(' · ')}
                        {req.pincode ? ` (${req.pincode})` : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Phone className="w-4 h-4 text-slate-400 shrink-0" />
                      <span className="font-mono-tabular text-slate-800">{req.contact}</span>
                    </div>
                  </div>

                  {req.notes && (
                    <p className="text-xs text-slate-600 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                      {req.notes}
                    </p>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2.5">
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 min-w-[170px] min-h-[44px] px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-900 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                    Open in Google Maps
                  </a>

                  {isCreator && req.status === 'active' && (
                    <button
                      type="button"
                      disabled={fulfillingId === req.id}
                      onClick={() => setConfirmTarget(req)}
                      className="flex-1 min-w-[150px] min-h-[44px] px-3.5 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      Mark as Fulfilled
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={Boolean(confirmTarget)}
        title="Close this request?"
        message={
          confirmTarget
            ? `Mark the ${confirmTarget.bloodGroup} request at ${confirmTarget.hospitalName} as fulfilled? It will leave the active emergency list.`
            : ''
        }
        confirmLabel="Yes, mark fulfilled"
        cancelLabel="Keep active"
        loading={Boolean(fulfillingId)}
        onConfirm={() => void confirmFulfill()}
        onCancel={() => {
          if (!fulfillingId) setConfirmTarget(null);
        }}
      />
    </div>
  );
}
