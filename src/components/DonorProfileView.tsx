import { useEffect, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { CheckCircle2, Clock, Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { LocationPickerMap } from './LocationPickerMap.tsx';
import { LocationSelector, matchReverseGeocodeToLocation } from './LocationSelector.tsx';
import {
  computeEligibility,
  getTodayLocalDateStr,
  isFutureDateStr,
  normalizeDonorPrivate,
  normalizeDonorPublic,
} from '../lib/eligibility.ts';
import { db, handleFirestoreError, OperationType } from '../lib/firebase.ts';
import {
  BLOOD_GROUPS,
  type BloodGroup,
  type ContactPreference,
  type LocationValue,
  type ReverseGeocodeResult,
} from '../types.ts';

interface DonorProfileViewProps {
  user: User;
}

const DEFAULT_LOCATION: LocationValue = {
  countryCode: 'IN',
  countryName: 'India',
  stateCode: '',
  stateName: '',
  city: '',
  locality: '',
  pincode: '',
};

export function DonorProfileView({ user }: DonorProfileViewProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');

  const [displayName, setDisplayName] = useState(user.displayName || '');
  const [bloodGroup, setBloodGroup] = useState<BloodGroup>('O+');
  const [location, setLocation] = useState<LocationValue>(DEFAULT_LOCATION);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState(user.email || '');
  const [contactPreference, setContactPreference] = useState<ContactPreference>('phone');
  const [lastDonationDate, setLastDonationDate] = useState('');
  const [visibleInSearch, setVisibleInSearch] = useState(true);
  const [exactLat, setExactLat] = useState<number | null>(null);
  const [exactLng, setExactLng] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError('');
      try {
        const [pubSnap, privSnap] = await Promise.all([
          getDoc(doc(db, 'donors_public', user.uid)),
          getDoc(doc(db, 'donors_private', user.uid)),
        ]);

        if (cancelled) return;

        if (pubSnap.exists()) {
          const pub = normalizeDonorPublic(pubSnap.data() as Record<string, unknown>, pubSnap.id);
          setDisplayName(pub.displayName || user.displayName || '');
          setBloodGroup(pub.bloodGroup);
          setLocation({
            countryCode: pub.countryCode || 'IN',
            countryName: pub.countryName || 'India',
            stateCode: pub.stateCode || '',
            stateName: pub.stateName || '',
            city: pub.city === 'Unspecified City' ? '' : pub.city,
            locality: pub.locality || '',
            pincode: pub.pincode || '',
          });
          setVisibleInSearch(pub.visibleInSearch);
        }

        if (privSnap.exists()) {
          const priv = normalizeDonorPrivate(privSnap.data() as Record<string, unknown>, privSnap.id);
          setPhone(priv.phone || '');
          setEmail(priv.email || user.email || '');
          setContactPreference(priv.contactPreference);
          setLastDonationDate(priv.lastDonationDate || '');
          setExactLat(priv.exactLat);
          setExactLng(priv.exactLng);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load profile.');
          handleFirestoreError(err, OperationType.GET, `donors_private/${user.uid}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const eligibility = computeEligibility(lastDonationDate);
  const todayStr = getTodayLocalDateStr();

  const handleReverseGeocode = (geo: ReverseGeocodeResult) => {
    setLocation((prev) => matchReverseGeocodeToLocation(geo, prev));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    setSavedMessage('');

    if (displayName.trim().length < 1) {
      setFormError('Your name is required.');
      return;
    }
    if (!location.countryCode || !location.city.trim()) {
      setFormError('Please select your country and city.');
      return;
    }
    if (location.countryCode === 'IN' && location.pincode && !/^\d{6}$/.test(location.pincode.trim())) {
      setFormError('Indian PIN code must be 6 digits.');
      return;
    }
    if (contactPreference === 'phone' && phone.replace(/[^0-9+]/g, '').length < 7) {
      setFormError('Please enter a valid phone number when Phone is your preferred contact.');
      return;
    }
    if (contactPreference === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setFormError('Please enter a valid email address when Email is your preferred contact.');
      return;
    }
    if (lastDonationDate && isFutureDateStr(lastDonationDate)) {
      setFormError('Last donation date cannot be in the future.');
      return;
    }

    setSaving(true);
    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/donor/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          displayName: displayName.trim(),
          bloodGroup,
          countryCode: location.countryCode,
          countryName: location.countryName,
          stateCode: location.stateCode,
          stateName: location.stateName,
          city: location.city.trim(),
          locality: location.locality.trim(),
          pincode: location.pincode.trim(),
          phone: phone.trim(),
          email: email.trim(),
          contactPreference,
          lastDonationDate: lastDonationDate.trim(),
          visibleInSearch,
          exactLat,
          exactLng,
        }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || 'Could not save donor profile.');
      }

      setSavedMessage(
        visibleInSearch
          ? eligibility.eligible
            ? 'Profile saved. You are visible in donor search with only your preferred contact and approximate area.'
            : `Profile saved. You are in the 90-day cooldown and will automatically appear in search starting ${eligibility.eligibleDateStr}.`
          : 'Profile saved. You are currently hidden from donor search.',
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save profile.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4 animate-pulse">
        <div className="h-6 w-48 bg-slate-200 rounded" />
        <div className="h-11 w-full bg-slate-100 rounded-xl" />
        <div className="h-11 w-full bg-slate-100 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            My Donor Profile
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Private contact details and exact coordinates are stored separately and never exposed in search or map results.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600 shrink-0">
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
          <span>Split private &amp; public storage</span>
        </div>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-800">
          {loadError}
        </div>
      )}

      <div
        className={`border rounded-2xl p-4 flex items-start gap-3 ${
          eligibility.eligible
            ? 'bg-emerald-50/70 border-emerald-200 text-emerald-900'
            : 'bg-amber-50/80 border-amber-200 text-amber-900'
        }`}
      >
        {eligibility.eligible ? (
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
        ) : (
          <Clock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        )}
        <div className="text-sm">
          <p className="font-semibold">
            {eligibility.eligible
              ? 'Eligible to donate now'
              : `In 90-day recovery cooldown (${eligibility.daysRemaining} ${eligibility.daysRemaining === 1 ? 'day' : 'days'} remaining)`}
          </p>
          <p className="text-xs mt-0.5 opacity-85">
            {eligibility.eligible
              ? eligibility.daysSinceDonation === null
                ? 'Never donated previously (or date not set) — eligible in donor search if visibility is enabled.'
                : `Last donation was ${eligibility.daysSinceDonation} days ago (90+ days elapsed).`
              : `You are automatically hidden from donor search and emergency alerts until ${eligibility.eligibleDateStr}.`}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-6">
        {formError && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
            {formError}
          </div>
        )}

        {savedMessage && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-900">
            {savedMessage}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-2">
            <label htmlFor="donor-name" className="block text-xs font-medium text-slate-700 mb-1.5">
              Full Name<span className="text-red-600 ml-0.5">*</span>
            </label>
            <input
              id="donor-name"
              type="text"
              required
              maxLength={100}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
            />
          </div>

          <div>
            <label htmlFor="donor-blood-group" className="block text-xs font-medium text-slate-700 mb-1.5">
              Blood Group<span className="text-red-600 ml-0.5">*</span>
            </label>
            <select
              id="donor-blood-group"
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
        </div>

        <div className="space-y-2 pt-2 border-t border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">Location</h2>
          <LocationSelector
            idPrefix="profile"
            mode="form"
            showPincode
            requiredCity
            value={location}
            onChange={setLocation}
          />
        </div>

        <LocationPickerMap
          lat={exactLat}
          lng={exactLng}
          onCoordinatesChange={(nextLat, nextLng) => {
            setExactLat(nextLat);
            setExactLng(nextLng);
          }}
          onReverseGeocode={handleReverseGeocode}
          title="My Area Pin (Private Exact Pin)"
          helperText="Tap 'Use my current location' or drag the pin. Exact coordinates remain private; only a ~1.5km approximate area point appears on the public map."
        />

        <div className="space-y-4 pt-2 border-t border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">Contact &amp; Privacy</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="donor-phone" className="block text-xs font-medium text-slate-700 mb-1.5">
                Phone Number{contactPreference === 'phone' && <span className="text-red-600 ml-0.5">*</span>}
              </label>
              <input
                id="donor-phone"
                type="tel"
                maxLength={30}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91 98765 43210"
                className="w-full min-h-[44px] px-3 py-2 text-sm font-mono-tabular bg-white border border-slate-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
            </div>

            <div>
              <label htmlFor="donor-email" className="block text-xs font-medium text-slate-700 mb-1.5">
                Email Address{contactPreference === 'email' && <span className="text-red-600 ml-0.5">*</span>}
              </label>
              <input
                id="donor-email"
                type="email"
                maxLength={150}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <span className="block text-xs font-medium text-slate-700 mb-1.5">
                Preferred Contact Shown in Search
              </span>
              <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-xl">
                <button
                  type="button"
                  onClick={() => setContactPreference('phone')}
                  className={`min-h-[40px] px-3 py-2 text-xs font-semibold rounded-lg transition-colors ${
                    contactPreference === 'phone'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Phone Only
                </button>
                <button
                  type="button"
                  onClick={() => setContactPreference('email')}
                  className={`min-h-[40px] px-3 py-2 text-xs font-semibold rounded-lg transition-colors ${
                    contactPreference === 'email'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Email Only
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                The non-selected contact stays locked in your private record.
              </p>
            </div>

            <div>
              <label htmlFor="donor-last-donation" className="block text-xs font-medium text-slate-700 mb-1.5">
                Last Donation Date (optional, no future dates)
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="donor-last-donation"
                  type="date"
                  max={todayStr}
                  value={lastDonationDate}
                  onChange={(e) => setLastDonationDate(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 text-sm font-mono-tabular bg-white border border-slate-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                />
                {lastDonationDate && (
                  <button
                    type="button"
                    onClick={() => setLastDonationDate('')}
                    className="min-h-[44px] px-3 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-100 rounded-xl whitespace-nowrap"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-slate-200 bg-slate-50/70">
            <div className="flex items-start gap-3">
              {visibleInSearch ? (
                <Eye className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <EyeOff className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
              )}
              <div>
                <p className="text-sm font-semibold text-slate-900">Visible in donor search</p>
                <p className="text-xs text-slate-600 mt-0.5">
                  When disabled, your profile and preferred contact are completely hidden from search, map view, and emergency alerts.
                </p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={visibleInSearch}
              aria-label="Visible in donor search"
              onClick={() => setVisibleInSearch((v) => !v)}
              className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 ${
                visibleInSearch ? 'bg-emerald-600' : 'bg-slate-300'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow transition-transform ${
                  visibleInSearch ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-end pt-3 border-t border-slate-100">
          <button
            type="submit"
            disabled={saving}
            className="w-full sm:w-auto min-h-[46px] px-6 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save Donor Profile
          </button>
        </div>
      </form>
    </div>
  );
}
