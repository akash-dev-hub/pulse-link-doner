import { useEffect, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  CheckCircle2,
  ExternalLink,
  Hospital,
  Loader2,
  MapPin,
  Phone,
  Plus,
  X,
} from 'lucide-react';
import { LocationPickerMap } from './LocationPickerMap.tsx';
import { LocationSelector, matchReverseGeocodeToLocation } from './LocationSelector.tsx';
import {
  buildGoogleMapsDirectionsUrl,
  normalizeEmergencyRequest,
} from '../lib/eligibility.ts';
import { db, handleFirestoreError, OperationType } from '../lib/firebase.ts';
import {
  BLOOD_GROUPS,
  type BloodGroup,
  type EmergencyRequest,
  type LocationValue,
  type ReverseGeocodeResult,
} from '../types.ts';

interface EmergencyBoardViewProps {
  user: User;
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

export function EmergencyBoardView({ user }: EmergencyBoardViewProps) {
  const [activeRequests, setActiveRequests] = useState<EmergencyRequest[]>([]);
  const [myFulfilledRequests, setMyFulfilledRequests] = useState<EmergencyRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'active' | 'fulfilled'>('active');

  const [showForm, setShowForm] = useState(false);
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
  const [submitBanner, setSubmitBanner] = useState('');
  const [fulfillingId, setFulfillingId] = useState<string | null>(null);
  const [boardError, setBoardError] = useState('');

  // Active requests real-time listener
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
        setLoading(false);
        handleFirestoreError(err, OperationType.LIST, 'emergency_requests');
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
        handleFirestoreError(err, OperationType.LIST, 'emergency_requests');
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
    setSubmitBanner('');

    const parsedUnits = Number(units);
    if (!Number.isInteger(parsedUnits) || parsedUnits < 1 || parsedUnits > 100) {
      setFormError('Units required must be a whole number of at least 1.');
      return;
    }
    if (hospitalName.trim().length < 2) {
      setFormError('Please enter a valid hospital name.');
      return;
    }
    if (!location.countryCode || !location.city.trim()) {
      setFormError('Please select the hospital country and city.');
      return;
    }
    if (location.countryCode === 'IN' && location.pincode && !/^\d{6}$/.test(location.pincode.trim())) {
      setFormError('Indian PIN code must be 6 digits.');
      return;
    }
    if (contact.trim().length < 3) {
      setFormError('Please provide a hospital or coordinator contact number/email.');
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

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || 'Could not post emergency request.');
      }

      const notifiedCount = Number(body.notifiedCount || 0);
      const sameLocalityCount = Number(body.sameLocalityCount || 0);
      setSubmitBanner(
        notifiedCount > 0
          ? `Request posted. Notified ${notifiedCount} eligible ${bloodGroup} ${notifiedCount === 1 ? 'donor' : 'donors'} in ${location.city} (${sameLocalityCount} in same locality).`
          : `Request posted on the active emergency board. No eligible ${bloodGroup} donors are currently opted into alerts in ${location.city}.`,
      );

      setHospitalName('');
      setUnits('1');
      setContact('');
      setNotes('');
      setHospitalLat(null);
      setHospitalLng(null);
      setLocation(DEFAULT_HOSPITAL_LOCATION);
      setShowForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to post request.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleMarkFulfilled = async (requestId: string) => {
    setFulfillingId(requestId);
    setBoardError('');
    try {
      const token = await user.getIdToken();
      const response = await fetch(`/api/requests/${encodeURIComponent(requestId)}/fulfill`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || 'Could not mark request fulfilled.');
      }
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : 'Failed to update request.');
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
            Emergency Board
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Active hospital blood requests. Posting notifies matching eligible donors in the same city, prioritizing the same locality first.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="min-h-[44px] px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
        >
          {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showForm ? 'Close form' : 'Post Emergency Request'}
        </button>
      </div>

      {submitBanner && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 text-sm text-emerald-900">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            <span>{submitBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setSubmitBanner('')}
            aria-label="Dismiss confirmation"
            className="p-1 text-emerald-700 hover:text-emerald-900"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5"
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h2 className="text-lg font-semibold text-slate-900">New Hospital Blood Request</h2>
            <span className="text-xs text-slate-500">All required fields validated</span>
          </div>

          {formError && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
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
                className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
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
                Units Needed (min 1)<span className="text-red-600 ml-0.5">*</span>
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
                className="w-full min-h-[44px] px-3 py-2 text-sm font-mono-tabular bg-white border border-slate-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
            </div>

            <div>
              <label htmlFor="req-contact" className="block text-xs font-medium text-slate-700 mb-1.5">
                Hospital / Coordinator Contact<span className="text-red-600 ml-0.5">*</span>
              </label>
              <input
                id="req-contact"
                type="text"
                required
                maxLength={150}
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="Phone number or email"
                className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
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
              placeholder="e.g. St. John's Medical Centre"
              className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
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
            title="Hospital Map Pin (for Map View & Google Maps directions)"
            helperText="Tap 'Use my current location' or drag the pin onto the hospital location."
          />

          <div>
            <label htmlFor="req-notes" className="block text-xs font-medium text-slate-700 mb-1.5">
              Additional Notes (optional)
            </label>
            <textarea
              id="req-notes"
              rows={2}
              maxLength={300}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Blood bank desk, ward details, or timing..."
              className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="min-h-[44px] px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 bg-slate-100 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="min-h-[44px] px-5 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl flex items-center gap-2 transition-colors"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Post Emergency Request
            </button>
          </div>
        </form>
      )}

      <div className="flex items-center justify-between gap-4 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl">
          <button
            type="button"
            onClick={() => setTab('active')}
            className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              tab === 'active'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Active Requests ({activeRequests.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('fulfilled')}
            className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              tab === 'fulfilled'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            My Fulfilled ({myFulfilledRequests.length})
          </button>
        </div>
      </div>

      {boardError && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-800">
          {boardError}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <div key={i} className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3 animate-pulse">
              <div className="h-5 w-2/3 bg-slate-200 rounded" />
              <div className="h-4 w-1/2 bg-slate-100 rounded" />
              <div className="h-10 w-full bg-slate-100 rounded-xl" />
            </div>
          ))}
        </div>
      ) : displayedRequests.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-500 flex items-center justify-center mx-auto">
            <Hospital className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-slate-900">
            {tab === 'active' ? 'No active emergency requests right now' : 'No fulfilled requests posted by you yet'}
          </h3>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            {tab === 'active'
              ? 'When a hospital or family posts an urgent blood need, it appears here immediately for donors and coordinators.'
              : 'Requests you mark as fulfilled leave the active board and appear here for your records.'}
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
                className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span className={req.status === 'active' ? 'text-red-700 font-semibold' : 'text-emerald-700 font-semibold'}>
                          {req.status === 'active' ? 'Active Request' : 'Fulfilled'}
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

                    <span className="font-mono-tabular text-base font-bold text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-1.5 shrink-0">
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
                    <p className="text-xs text-slate-600 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">
                      {req.notes}
                    </p>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2.5">
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 min-w-[170px] min-h-[44px] px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-900 text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                    Open in Google Maps
                  </a>

                  {isCreator && req.status === 'active' && (
                    <button
                      type="button"
                      disabled={fulfillingId === req.id}
                      onClick={() => void handleMarkFulfilled(req.id)}
                      className="flex-1 min-w-[150px] min-h-[44px] px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      {fulfillingId === req.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      )}
                      Mark as Fulfilled
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
