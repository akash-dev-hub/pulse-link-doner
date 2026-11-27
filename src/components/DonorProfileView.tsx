import { useEffect, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { BellOff, BellRing, Eye, EyeOff, Loader2, MessageSquare } from 'lucide-react';
import { LocationPickerMap } from './LocationPickerMap.tsx';
import { LocationSelector, matchReverseGeocodeToLocation } from './LocationSelector.tsx';
import {
  computeEligibility,
  getTodayLocalDateStr,
  isFutureDateStr,
  isValidUsername,
  normalizeDonorPrivate,
  normalizeDonorPublic,
  normalizeUsernameInput,
} from '../lib/eligibility.ts';
import type { BrowserNotificationPermission } from '../lib/emergencyAlertAudio.ts';
import { db } from '../lib/firebase.ts';
import {
  BLOOD_GROUPS,
  type BloodGroup,
  type LocationValue,
  type ReverseGeocodeResult,
  type UserRole,
} from '../types.ts';

interface DonorProfileViewProps {
  user: User;
  myUsername: string;
  userRole: UserRole;
  alertsEnabled?: boolean;
  notificationPermission?: BrowserNotificationPermission;
  onEnableAlerts?: () => void;
  onDisableAlerts?: () => void;
  onUsernameUpdated: (nextUsername: string) => void;
  onRoleUpdated: (nextRole: UserRole) => void;
  onOpenHospitals?: () => void;
  onNotify: (type: 'success' | 'error', message: string) => void;
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

export function DonorProfileView({
  user,
  myUsername,
  userRole,
  alertsEnabled = false,
  notificationPermission = 'default',
  onEnableAlerts,
  onDisableAlerts,
  onUsernameUpdated,
  onRoleUpdated,
  onOpenHospitals,
  onNotify,
}: DonorProfileViewProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [roleSaving, setRoleSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');

  const [username, setUsername] = useState(myUsername);
  const [fullName, setFullName] = useState(user.displayName || '');
  const [bloodGroup, setBloodGroup] = useState<BloodGroup>('O+');
  const [location, setLocation] = useState<LocationValue>(DEFAULT_LOCATION);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState(user.email || '');
  const [lastDonationDate, setLastDonationDate] = useState('');
  const [visibleInSearch, setVisibleInSearch] = useState(true);
  const [exactLat, setExactLat] = useState<number | null>(null);
  const [exactLng, setExactLng] = useState<number | null>(null);

  useEffect(() => {
    setUsername(myUsername);
  }, [myUsername]);

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

        let legacyDisplayName = '';
        if (pubSnap.exists()) {
          const rawPub = pubSnap.data() as Record<string, unknown>;
          if (typeof rawPub.displayName === 'string') {
            legacyDisplayName = rawPub.displayName.trim();
          }
          const pub = normalizeDonorPublic(rawPub, pubSnap.id);
          if (typeof rawPub.username === 'string' && isValidUsername(normalizeUsernameInput(rawPub.username))) {
            setUsername(pub.username);
          }
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
          setFullName(priv.fullName || legacyDisplayName || user.displayName || '');
          setPhone(priv.phone || '');
          setEmail(priv.email || user.email || '');
          setLastDonationDate(priv.lastDonationDate || '');
          setExactLat(priv.exactLat);
          setExactLng(priv.exactLng);
        } else if (legacyDisplayName) {
          setFullName(legacyDisplayName);
        }
      } catch (err) {
        console.error('Failed to load donor profile:', err);
        if (!cancelled) {
          const msg = 'Could not load your saved profile details. Please refresh and try again.';
          setLoadError(msg);
          onNotify('error', msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, onNotify]);

  const eligibility = computeEligibility(lastDonationDate);
  const todayStr = getTodayLocalDateStr();

  const handleReverseGeocode = (geo: ReverseGeocodeResult) => {
    setLocation((prev) => matchReverseGeocodeToLocation(geo, prev));
  };

  const canSaveDonorProfile = userRole === 'donor' || userRole === 'admin';

  const handleSwitchRole = async (nextRole: 'donor' | 'requester' | 'hospital') => {
    if (nextRole === userRole || userRole === 'admin') return;
    setRoleSaving(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/account/role', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ role: nextRole }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; role?: UserRole };
      if (!res.ok) {
        throw new Error(data.error || 'Could not update your role.');
      }
      const updated = data.role || nextRole;
      onRoleUpdated(updated);
      const label =
        updated === 'donor'
          ? 'Donor'
          : updated === 'hospital'
            ? 'Hospital / Blood Bank'
            : 'Requester';
      onNotify('success', `Account role set to ${label}`);
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Could not update your role.';
      onNotify('error', msg);
    } finally {
      setRoleSaving(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!canSaveDonorProfile) {
      const msg = 'Switch your account role to Donor to save or appear in donor search.';
      setFormError(msg);
      onNotify('error', msg);
      return;
    }

    const normalizedUsername = normalizeUsernameInput(username);
    if (!isValidUsername(normalizedUsername)) {
      const msg = 'Username must be 3 to 24 lowercase letters, numbers, or underscores.';
      setFormError(msg);
      onNotify('error', msg);
      return;
    }
    if (fullName.trim().length < 1) {
      const msg = 'Please enter your full name (stored privately).';
      setFormError(msg);
      onNotify('error', msg);
      return;
    }
    if (!location.countryCode || !location.city.trim()) {
      const msg = 'Please select your country and city.';
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
    if (lastDonationDate && isFutureDateStr(lastDonationDate)) {
      const msg = 'Last donation date cannot be in the future.';
      setFormError(msg);
      onNotify('error', msg);
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
          username: normalizedUsername,
          fullName: fullName.trim(),
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
          lastDonationDate: lastDonationDate.trim(),
          visibleInSearch,
          exactLat,
          exactLng,
        }),
      });

      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        isNewRegistration?: boolean;
        username?: string;
      };
      if (!response.ok) {
        throw new Error(body.error || 'Could not save your profile. Please try again.');
      }

      if (body.username) {
        setUsername(body.username);
        onUsernameUpdated(body.username);
      }

      onNotify('success', body.isNewRegistration ? 'Registration completed' : 'Profile updated');
    } catch (err) {
      const msg =
        err instanceof Error && err.message && !err.message.startsWith('Firestore')
          ? err.message
          : 'Could not save your profile. Please try again.';
      setFormError(msg);
      onNotify('error', msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="h-6 w-48 bg-slate-200 rounded" />
        <div className="h-11 w-full bg-slate-100 rounded-lg" />
        <div className="h-11 w-full bg-slate-100 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
          My Donor Profile
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Other users see only your username, blood group, and general area. Your real name, phone, and email are kept private and visible only to you.
        </p>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
          {loadError}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Account Role</h2>
            <p className="text-xs text-slate-600 mt-0.5">
              {userRole === 'admin'
                ? 'You have Admin access to approve hospitals and assign user roles.'
                : 'Choose how you use PulseLine. Only Donor accounts appear in donor search.'}
            </p>
          </div>
          <span className="self-start sm:self-auto text-xs font-semibold px-2.5 py-1 rounded-md bg-slate-100 text-slate-800 border border-slate-200">
            {userRole === 'donor'
              ? 'Donor'
              : userRole === 'hospital'
                ? 'Hospital / Blood Bank'
                : userRole === 'admin'
                  ? 'Admin'
                  : 'Requester'}
          </span>
        </div>

        {userRole !== 'admin' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {(
              [
                { id: 'donor', label: 'Donor', desc: 'Appear in donor search & alerts' },
                { id: 'requester', label: 'Requester', desc: 'Search donors & post requests' },
                { id: 'hospital', label: 'Hospital / Blood Bank', desc: 'Register facility & update stock' },
              ] as const
            ).map((opt) => {
              const active = userRole === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={roleSaving || active}
                  onClick={() => void handleSwitchRole(opt.id)}
                  className={`p-3 rounded-lg border text-left transition-colors ${
                    active
                      ? 'bg-red-50 border-red-300 text-red-900'
                      : 'bg-white border-slate-200 hover:border-slate-300 text-slate-800'
                  }`}
                >
                  <div className="text-xs font-semibold">{opt.label}</div>
                  <div className="text-[11px] text-slate-600 mt-0.5">{opt.desc}</div>
                </button>
              );
            })}
          </div>
        )}

        {userRole === 'hospital' && onOpenHospitals && (
          <div className="pt-1">
            <button
              type="button"
              onClick={onOpenHospitals}
              className="text-xs font-semibold text-red-700 hover:underline"
            >
              Open Hospitals tab to register your facility or update blood stock →
            </button>
          </div>
        )}
      </div>

      {!canSaveDonorProfile && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs sm:text-sm text-amber-900">
          <span>
            Your account is currently set to{' '}
            <strong>{userRole === 'hospital' ? 'Hospital / Blood Bank' : 'Requester'}</strong>. Switch to the Donor role above if you also want to save a donor profile.
          </span>
          <button
            type="button"
            disabled={roleSaving}
            onClick={() => void handleSwitchRole('donor')}
            className="min-h-[38px] px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg whitespace-nowrap shrink-0"
          >
            Switch to Donor
          </button>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
        <p className={`text-sm font-semibold ${eligibility.eligible ? 'text-slate-900' : 'text-red-700'}`}>
          {eligibility.eligible
            ? 'Ready to donate'
            : `Resting period (${eligibility.daysRemaining} ${eligibility.daysRemaining === 1 ? 'day' : 'days'} left)`}
        </p>
        <p className="text-xs text-slate-600">
          {eligibility.eligible
            ? eligibility.daysSinceDonation === null
              ? 'If you have never donated before or left the date blank, you can appear in search when visibility is on.'
              : `Your last donation was ${eligibility.daysSinceDonation} days ago (at least 90 days have passed).`
            : `To protect your health, you stay hidden from donor search and alerts until ${eligibility.eligibleDateStr}.`}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-6">
        {formError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
            {formError}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="donor-username" className="block text-xs font-medium text-slate-700 mb-1.5">
              Public Username<span className="text-red-600 ml-0.5">*</span>
            </label>
            <div className="relative flex items-center">
              <span className="absolute left-3 text-sm font-mono-tabular text-slate-500">@</span>
              <input
                id="donor-username"
                type="text"
                required
                maxLength={24}
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                placeholder="your_username"
                className="w-full min-h-[44px] pl-7 pr-3 py-2 text-sm font-mono-tabular bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
            </div>
            <p className="mt-1 text-xs text-slate-500">Shown to others in search, map, and chat.</p>
          </div>

          <div>
            <label htmlFor="donor-name" className="block text-xs font-medium text-slate-700 mb-1.5">
              Full Name (Private)<span className="text-red-600 ml-0.5">*</span>
            </label>
            <input
              id="donor-name"
              type="text"
              required
              maxLength={100}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Your real name"
              className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
            />
            <p className="mt-1 text-xs text-slate-500">Only you can see this.</p>
          </div>

          <div>
            <label htmlFor="donor-blood-group" className="block text-xs font-medium text-slate-700 mb-1.5">
              Blood Group<span className="text-red-600 ml-0.5">*</span>
            </label>
            <select
              id="donor-blood-group"
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
          title="Your area on the map"
          helperText="Tap 'Use my current location' or move the pin. Your exact spot stays private—only your general neighborhood is shown on the map."
        />

        <div className="space-y-4 pt-2 border-t border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">Private Details &amp; Contact</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="donor-phone" className="block text-xs font-medium text-slate-700 mb-1.5">
                Phone Number (Private, optional)
              </label>
              <input
                id="donor-phone"
                type="tel"
                maxLength={30}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91 98765 43210"
                className="w-full min-h-[44px] px-3 py-2 text-sm font-mono-tabular bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
              <p className="mt-1 text-xs text-slate-500">Never shown to other users.</p>
            </div>

            <div>
              <label htmlFor="donor-email" className="block text-xs font-medium text-slate-700 mb-1.5">
                Email Address (Private, optional)
              </label>
              <input
                id="donor-email"
                type="email"
                maxLength={150}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
              <p className="mt-1 text-xs text-slate-500">Never shown to other users.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-3.5 rounded-lg border border-slate-200 bg-slate-50 space-y-1">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
                <MessageSquare className="w-4 h-4 text-red-600 shrink-0" />
                <span>Contact preference: In-app chat</span>
              </div>
              <p className="text-xs text-slate-600">
                Families contact you through private in-app messages using your username. You can block anyone at any time.
              </p>
            </div>

            <div>
              <label htmlFor="donor-last-donation" className="block text-xs font-medium text-slate-700 mb-1.5">
                Last donation date (optional)
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="donor-last-donation"
                  type="date"
                  max={todayStr}
                  value={lastDonationDate}
                  onChange={(e) => setLastDonationDate(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 text-sm font-mono-tabular bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                />
                {lastDonationDate && (
                  <button
                    type="button"
                    onClick={() => setLastDonationDate('')}
                    className="min-h-[44px] px-3 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-100 rounded-lg whitespace-nowrap"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-slate-200 bg-slate-50">
            <div className="flex items-start gap-3">
              {visibleInSearch ? (
                <Eye className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              ) : (
                <EyeOff className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
              )}
              <div>
                <p className="text-sm font-semibold text-slate-900">Show me in donor search</p>
                <p className="text-xs text-slate-600 mt-0.5">
                  Turn this off any time to hide your profile from search, the map, and emergency alerts.
                </p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={visibleInSearch}
              aria-label="Show me in donor search"
              onClick={() => setVisibleInSearch((v) => !v)}
              className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 ${
                visibleInSearch ? 'bg-red-600' : 'bg-slate-300'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white transition-transform ${
                  visibleInSearch ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {canSaveDonorProfile && (onEnableAlerts || onDisableAlerts) && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl border border-slate-200 bg-slate-50">
              <div className="flex items-start gap-3">
                {alertsEnabled ? (
                  <BellRing className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                ) : (
                  <BellOff className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
                )}
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {alertsEnabled ? 'Emergency alerts enabled' : 'Emergency alerts'}
                  </p>
                  <p className="text-xs text-slate-600 mt-0.5">
                    {alertsEnabled
                      ? notificationPermission === 'denied'
                        ? 'Alarm sound and Accept/Decline popups are active while this app is open. Browser notifications are blocked in browser settings.'
                        : 'Plays a looping alarm sound, sends a browser notification, and opens an Accept or Decline popup when a matching verified request arrives.'
                      : 'Get an alarm sound, browser notification, and Accept or Decline popup when a verified matching request arrives while the app is open.'}
                  </p>
                </div>
              </div>
              {alertsEnabled && onDisableAlerts ? (
                <button
                  type="button"
                  onClick={onDisableAlerts}
                  className="min-h-[40px] px-4 py-2 bg-white border border-slate-200 hover:bg-slate-100 text-slate-800 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0"
                >
                  Turn off alerts
                </button>
              ) : !alertsEnabled && onEnableAlerts ? (
                <button
                  type="button"
                  onClick={onEnableAlerts}
                  className="min-h-[40px] px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg whitespace-nowrap shrink-0"
                >
                  Enable emergency alerts
                </button>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end pt-3 border-t border-slate-100">
          <button
            type="submit"
            disabled={saving || !canSaveDonorProfile}
            className="w-full sm:w-auto min-h-[46px] px-6 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save Donor Profile
          </button>
        </div>
      </form>
    </div>
  );
}
