import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import {
  Building2,
  Clock,
  Crosshair,
  ExternalLink,
  Loader2,
  MapPin,
  Phone,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { EmailVerificationNotice } from './EmailVerificationNotice.tsx';
import { LocationPickerMap } from './LocationPickerMap.tsx';
import { LocationSelector, matchReverseGeocodeToLocation } from './LocationSelector.tsx';
import {
  buildGoogleMapsDirectionsUrl,
  createEmptyInventory,
  normalizeInventory,
  sumInventoryUnits,
} from '../lib/eligibility.ts';
import {
  BLOOD_GROUPS,
  type BloodGroup,
  type BloodInventory,
  type FacilityType,
  type HospitalApprovalStatus,
  type HospitalProfile,
  type LocationValue,
  type RankedHospital,
  type ReverseGeocodeResult,
  type UserRole,
} from '../types.ts';

interface HospitalsViewProps {
  user: User;
  emailVerified: boolean;
  userRole: UserRole;
  resendingVerification: boolean;
  checkingVerification: boolean;
  onResendVerification: () => void;
  onCheckVerified: () => void;
  onHospitalStatusUpdated: (status: HospitalApprovalStatus | null) => void;
  onNotify: (type: 'success' | 'error', message: string) => void;
}

const DEFAULT_FILTER_LOCATION: LocationValue = {
  countryCode: 'IN',
  countryName: 'India',
  stateCode: '',
  stateName: '',
  city: '',
  locality: '',
  pincode: '',
};

const DEFAULT_FORM_LOCATION: LocationValue = {
  countryCode: 'IN',
  countryName: 'India',
  stateCode: '',
  stateName: '',
  city: '',
  locality: '',
  pincode: '',
};

function formatLastUpdated(ms: number | null): string {
  if (!ms) return 'Not updated yet';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  let relative = 'Just now';
  if (diffSec >= 86400) {
    const days = Math.floor(diffSec / 86400);
    relative = `${days} ${days === 1 ? 'day' : 'days'} ago`;
  } else if (diffSec >= 3600) {
    const hrs = Math.floor(diffSec / 3600);
    relative = `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  } else if (diffSec >= 60) {
    const mins = Math.floor(diffSec / 60);
    relative = `${mins} ${mins === 1 ? 'min' : 'mins'} ago`;
  }

  const formatted = new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${relative} (${formatted})`;
}

export function HospitalsView({
  user,
  emailVerified,
  userRole,
  resendingVerification,
  checkingVerification,
  onResendVerification,
  onCheckVerified,
  onHospitalStatusUpdated,
  onNotify,
}: HospitalsViewProps) {
  const canManageFacility = userRole === 'hospital' || userRole === 'admin';
  const [subTab, setSubTab] = useState<'browse' | 'manage'>('browse');

  // Browse / ranked state
  const [bloodGroup, setBloodGroup] = useState<BloodGroup | ''>('');
  const [filterLocation, setFilterLocation] = useState<LocationValue>(DEFAULT_FILTER_LOCATION);
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [hospitals, setHospitals] = useState<RankedHospital[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState('');

  // Own hospital management state
  const [myHospital, setMyHospital] = useState<HospitalProfile | null>(null);
  const [loadingMine, setLoadingMine] = useState(false);
  const [savingFacility, setSavingFacility] = useState(false);
  const [savingInventory, setSavingInventory] = useState(false);

  const [facilityName, setFacilityName] = useState('');
  const [facilityType, setFacilityType] = useState<FacilityType>('hospital');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [contact, setContact] = useState('');
  const [formLocation, setFormLocation] = useState<LocationValue>(DEFAULT_FORM_LOCATION);
  const [facilityLat, setFacilityLat] = useState<number | null>(null);
  const [facilityLng, setFacilityLng] = useState<number | null>(null);
  const [facilityError, setFacilityError] = useState('');

  const [inventoryDraft, setInventoryDraft] = useState<BloodInventory>(createEmptyInventory());
  const [inventoryError, setInventoryError] = useState('');

  const fetchRankedHospitals = useCallback(
    async (opts?: {
      bg?: BloodGroup | '';
      loc?: LocationValue;
      coords?: { lat: number; lng: number } | null;
    }) => {
      const targetBg = opts?.bg !== undefined ? opts.bg : bloodGroup;
      const targetLoc = opts?.loc !== undefined ? opts.loc : filterLocation;
      const targetCoords = opts?.coords !== undefined ? opts.coords : userCoords;

      setLoadingList(true);
      setListError('');
      try {
        const token = await user.getIdToken();
        const params = new URLSearchParams();
        if (targetBg) params.set('bloodGroup', targetBg);
        if (targetLoc.countryCode) params.set('countryCode', targetLoc.countryCode);
        if (targetLoc.stateCode) params.set('stateCode', targetLoc.stateCode);
        if (targetLoc.city.trim()) params.set('city', targetLoc.city.trim());
        if (targetLoc.locality.trim()) params.set('locality', targetLoc.locality.trim());
        if (targetCoords) {
          params.set('lat', String(targetCoords.lat));
          params.set('lng', String(targetCoords.lng));
        }

        const res = await fetch(`/api/hospitals/ranked?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json().catch(() => ({}))) as {
          hospitals?: RankedHospital[];
          error?: string;
        };
        if (!res.ok) {
          throw new Error(data.error || 'Could not load approved hospitals right now.');
        }
        setHospitals(Array.isArray(data.hospitals) ? data.hospitals : []);
      } catch (err) {
        const msg =
          err instanceof Error && err.message
            ? err.message
            : 'Could not load approved hospitals right now.';
        setListError(msg);
      } finally {
        setLoadingList(false);
      }
    },
    [user, bloodGroup, filterLocation, userCoords],
  );

  useEffect(() => {
    void fetchRankedHospitals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const loadMyHospital = useCallback(async () => {
    if (!canManageFacility || !emailVerified) {
      setMyHospital(null);
      return;
    }
    setLoadingMine(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/hospitals/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as {
        hospital?: HospitalProfile | null;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Could not load your facility record.');
      }
      const h = data.hospital || null;
      setMyHospital(h);
      onHospitalStatusUpdated(h ? h.status : null);

      if (h) {
        setFacilityName(h.name);
        setFacilityType(h.facilityType);
        setLicenseNumber(h.licenseNumber);
        setContact(h.contact);
        setFormLocation({
          countryCode: h.countryCode || 'IN',
          countryName: h.countryName || 'India',
          stateCode: h.stateCode || '',
          stateName: h.stateName || '',
          city: h.city === 'Unspecified City' ? '' : h.city,
          locality: h.locality || '',
          pincode: h.pincode || '',
        });
        setFacilityLat(h.lat);
        setFacilityLng(h.lng);
        setInventoryDraft(normalizeInventory(h.inventory));
      }
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Could not load facility details.';
      onNotify('error', msg);
    } finally {
      setLoadingMine(false);
    }
  }, [canManageFacility, emailVerified, user, onHospitalStatusUpdated, onNotify]);

  useEffect(() => {
    if (subTab === 'manage' && canManageFacility && emailVerified) {
      void loadMyHospital();
    }
  }, [subTab, canManageFacility, emailVerified, loadMyHospital]);

  useEffect(() => {
    if (!canManageFacility && subTab === 'manage') {
      setSubTab('browse');
    }
  }, [canManageFacility, subTab]);

  const handleUseMyLocationForRanking = () => {
    if (!('geolocation' in navigator)) {
      onNotify('error', 'Location is not supported in this browser.');
      return;
    }
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoLoading(false);
        const coords = {
          lat: Number(pos.coords.latitude.toFixed(6)),
          lng: Number(pos.coords.longitude.toFixed(6)),
        };
        setUserCoords(coords);
        void fetchRankedHospitals({ coords });
      },
      () => {
        setGeoLoading(false);
        onNotify('error', 'Could not read your location. You can still filter by city or state.');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  };

  const handleClearMyLocation = () => {
    setUserCoords(null);
    void fetchRankedHospitals({ coords: null });
  };

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    void fetchRankedHospitals();
  };

  const handleResetFilters = () => {
    setBloodGroup('');
    setFilterLocation(DEFAULT_FILTER_LOCATION);
    void fetchRankedHospitals({ bg: '', loc: DEFAULT_FILTER_LOCATION });
  };

  const handleReverseGeocode = (geo: ReverseGeocodeResult) => {
    setFormLocation((prev) => matchReverseGeocodeToLocation(geo, prev));
  };

  const handleSaveFacility = async (e: FormEvent) => {
    e.preventDefault();
    setFacilityError('');

    if (facilityName.trim().length < 2) {
      const msg = 'Enter the hospital or blood bank name.';
      setFacilityError(msg);
      onNotify('error', msg);
      return;
    }
    if (contact.trim().length < 3) {
      const msg = 'Enter a phone number or email for this facility.';
      setFacilityError(msg);
      onNotify('error', msg);
      return;
    }
    if (!formLocation.countryCode || !formLocation.city.trim()) {
      const msg = 'Select the country and city for this facility.';
      setFacilityError(msg);
      onNotify('error', msg);
      return;
    }
    if (
      formLocation.countryCode === 'IN' &&
      formLocation.pincode &&
      !/^\d{6}$/.test(formLocation.pincode.trim())
    ) {
      const msg = 'Indian PIN code must be 6 digits.';
      setFacilityError(msg);
      onNotify('error', msg);
      return;
    }

    setSavingFacility(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/hospitals/me', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: facilityName.trim(),
          facilityType,
          licenseNumber: licenseNumber.trim(),
          contact: contact.trim(),
          countryCode: formLocation.countryCode,
          countryName: formLocation.countryName,
          stateCode: formLocation.stateCode,
          stateName: formLocation.stateName,
          city: formLocation.city.trim(),
          locality: formLocation.locality.trim(),
          pincode: formLocation.pincode.trim(),
          lat: facilityLat,
          lng: facilityLng,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        isNewRegistration?: boolean;
        hospital?: HospitalProfile | null;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Could not save hospital registration.');
      }
      if (data.hospital) {
        setMyHospital(data.hospital);
        onHospitalStatusUpdated(data.hospital.status);
      }
      onNotify(
        'success',
        data.isNewRegistration
          ? 'Facility registered (pending admin approval)'
          : 'Facility details updated',
      );
      void fetchRankedHospitals();
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : 'Could not save hospital registration.';
      setFacilityError(msg);
      onNotify('error', msg);
    } finally {
      setSavingFacility(false);
    }
  };

  const handleSaveInventory = async (e: FormEvent) => {
    e.preventDefault();
    setInventoryError('');

    for (const bg of BLOOD_GROUPS) {
      const val = Number(inventoryDraft[bg]);
      if (!Number.isInteger(val) || val < 0 || val > 100000) {
        const msg = `Units for ${bg} must be a whole number (0 or higher).`;
        setInventoryError(msg);
        onNotify('error', msg);
        return;
      }
    }

    setSavingInventory(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/hospitals/me/inventory', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ inventory: inventoryDraft }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        hospital?: HospitalProfile | null;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Could not update blood stock.');
      }
      if (data.hospital) {
        setMyHospital(data.hospital);
        setInventoryDraft(normalizeInventory(data.hospital.inventory));
      }
      onNotify('success', 'Blood stock updated');
      void fetchRankedHospitals();
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Could not update blood stock.';
      setInventoryError(msg);
      onNotify('error', msg);
    } finally {
      setSavingInventory(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Hospitals &amp; Blood Banks
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Approved facilities ranked by stock for your blood group, distance, available units, and latest stock update.
          </p>
        </div>

        {canManageFacility && (
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
            <button
              type="button"
              onClick={() => setSubTab('browse')}
              className={`min-h-[38px] px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                subTab === 'browse'
                  ? 'bg-white text-slate-900 border border-slate-200'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Approved List
            </button>
            <button
              type="button"
              onClick={() => setSubTab('manage')}
              className={`min-h-[38px] px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                subTab === 'manage'
                  ? 'bg-white text-slate-900 border border-slate-200'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              My Facility &amp; Stock
            </button>
          </div>
        )}
      </div>

      {subTab === 'browse' && (
        <>
          <form
            onSubmit={handleSearchSubmit}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-end">
              <div>
                <label
                  htmlFor="hosp-filter-bg"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  Required Blood Group
                </label>
                <select
                  id="hosp-filter-bg"
                  value={bloodGroup}
                  onChange={(e) => {
                    const nextBg = e.target.value as BloodGroup | '';
                    setBloodGroup(nextBg);
                    void fetchRankedHospitals({ bg: nextBg });
                  }}
                  className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                >
                  <option value="">All blood groups</option>
                  {BLOOD_GROUPS.map((bg) => (
                    <option key={bg} value={bg}>
                      {bg}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2 sm:col-span-1 lg:col-span-2">
                <button
                  type="button"
                  onClick={handleUseMyLocationForRanking}
                  disabled={geoLoading}
                  className="min-h-[44px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60 rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap"
                >
                  {geoLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Crosshair className="w-4 h-4" />
                  )}
                  {userCoords ? 'Update my distance' : 'Sort by my distance'}
                </button>
                {userCoords && (
                  <button
                    type="button"
                    onClick={handleClearMyLocation}
                    className="min-h-[44px] px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-100 rounded-lg flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Clear location
                  </button>
                )}
              </div>
            </div>

            <LocationSelector
              idPrefix="hosp-filter"
              mode="filter"
              showPincode={false}
              requiredCity={false}
              value={filterLocation}
              onChange={setFilterLocation}
            />

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={handleResetFilters}
                className="min-h-[40px] px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 rounded-lg"
              >
                Reset filters
              </button>
              <button
                type="submit"
                disabled={loadingList}
                className="min-h-[44px] px-5 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-lg flex items-center gap-2 transition-colors"
              >
                {loadingList && <Loader2 className="w-4 h-4 animate-spin" />}
                Search Approved Facilities
              </button>
            </div>
          </form>

          {listError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
              {listError}
            </div>
          )}

          {loadingList ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[1, 2].map((i) => (
                <div key={i} className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                  <div className="h-5 w-2/3 bg-slate-200 rounded" />
                  <div className="h-4 w-1/2 bg-slate-100 rounded" />
                  <div className="h-20 w-full bg-slate-100 rounded-lg" />
                </div>
              ))}
            </div>
          ) : hospitals.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
              <Building2 className="w-8 h-8 text-slate-400 mx-auto" />
              <h2 className="text-base font-semibold text-slate-900">
                No approved hospitals or blood banks match these filters
              </h2>
              <p className="text-sm text-slate-600 max-w-md mx-auto">
                Only admin-approved facilities appear here. Try clearing your city filter or selecting all blood groups.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {hospitals.map((h, idx) => {
                const mapsUrl = buildGoogleMapsDirectionsUrl({
                  lat: h.lat,
                  lng: h.lng,
                  hospitalName: h.name,
                  locality: h.locality,
                  city: h.city,
                  stateName: h.stateName,
                  countryName: h.countryName,
                });
                const locParts = [h.locality, h.city, h.stateName, h.countryName].filter(Boolean);

                return (
                  <article
                    key={h.uid}
                    className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
                  >
                    <div className="space-y-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span className="font-mono-tabular font-semibold text-slate-700">
                              #{idx + 1}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{h.facilityType === 'blood_bank' ? 'Blood Bank' : 'Hospital'}</span>
                            {h.distanceKm !== null && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono-tabular font-semibold text-slate-900">
                                  {h.distanceKm < 1
                                    ? `${Math.round(h.distanceKm * 1000)} m away`
                                    : `${h.distanceKm.toFixed(1)} km away`}
                                </span>
                              </>
                            )}
                          </div>
                          <h2 className="text-lg font-semibold text-slate-900 mt-1 break-words">
                            {h.name}
                          </h2>
                        </div>

                        {bloodGroup ? (
                          <span
                            className={`font-mono-tabular text-xs font-bold px-3 py-1.5 rounded-lg border shrink-0 ${
                              h.inStockForQuery
                                ? 'bg-green-50 border-green-200 text-green-800'
                                : 'bg-slate-100 border-slate-200 text-slate-600'
                            }`}
                          >
                            {bloodGroup}: {h.unitsForQuery} {h.unitsForQuery === 1 ? 'unit' : 'units'}
                          </span>
                        ) : (
                          <span className="font-mono-tabular text-xs font-bold px-3 py-1.5 rounded-lg border bg-slate-50 border-slate-200 text-slate-800 shrink-0">
                            {sumInventoryUnits(h.inventory)} total units
                          </span>
                        )}
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
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4 text-slate-400 shrink-0" />
                          <span>
                            Last updated: {formatLastUpdated(h.inventoryUpdatedAtMs)}
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-4 gap-2 pt-1">
                        {BLOOD_GROUPS.map((bg) => {
                          const qty = h.inventory[bg] || 0;
                          const isSelected = bloodGroup === bg;
                          return (
                            <div
                              key={bg}
                              className={`px-2 py-1.5 rounded-lg border text-center ${
                                isSelected
                                  ? 'bg-red-50 border-red-300'
                                  : qty > 0
                                    ? 'bg-slate-50 border-slate-200'
                                    : 'bg-white border-slate-100 opacity-70'
                              }`}
                            >
                              <div className="text-[11px] font-semibold text-slate-700">{bg}</div>
                              <div
                                className={`font-mono-tabular text-xs font-bold ${
                                  qty > 0 ? 'text-slate-900' : 'text-slate-400'
                                }`}
                              >
                                {qty}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="pt-3 border-t border-slate-100 flex items-center gap-2.5">
                      <a
                        href={mapsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 min-h-[44px] px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-900 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                        Open in Google Maps
                      </a>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}

      {subTab === 'manage' && canManageFacility && (
        <div className="space-y-6">
          {!emailVerified ? (
            <EmailVerificationNotice
              email={user.email || ''}
              variant="card"
              title="Verify your email to register a hospital or blood bank"
              description="Email verification is required before registering a facility or updating available blood units."
              resending={resendingVerification}
              checking={checkingVerification}
              onResend={onResendVerification}
              onCheckVerified={onCheckVerified}
            />
          ) : loadingMine ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-600">
              Loading your facility profile...
            </div>
          ) : (
            <>
              <div
                className={`rounded-xl border p-4 flex items-start gap-3 ${
                  myHospital?.status === 'approved'
                    ? 'bg-green-50 border-green-200 text-green-900'
                    : myHospital?.status === 'rejected'
                      ? 'bg-red-50 border-red-200 text-red-900'
                      : 'bg-amber-50 border-amber-200 text-amber-900'
                }`}
              >
                {myHospital?.status === 'approved' ? (
                  <ShieldCheck className="w-5 h-5 text-green-700 shrink-0 mt-0.5" />
                ) : (
                  <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1 text-xs sm:text-sm">
                  <p className="font-semibold">
                    {!myHospital
                      ? 'Facility not registered yet'
                      : myHospital.status === 'approved'
                        ? 'Approved Hospital / Blood Bank'
                        : myHospital.status === 'rejected'
                          ? 'Registration Rejected'
                          : 'Pending Admin Approval'}
                  </p>
                  <p>
                    {!myHospital
                      ? 'Submit your facility details below. New hospitals and blood banks stay pending until an admin approves them.'
                      : myHospital.status === 'approved'
                        ? 'Your facility appears in the public ranked list. Keep your available blood units updated below.'
                        : myHospital.status === 'rejected'
                          ? 'An admin rejected this registration. Update your details and ask an admin to review again.'
                          : 'Your facility is saved and waiting for admin approval. You can update blood stock once approved.'}
                  </p>
                  {myHospital?.reviewNote && (
                    <p className="font-medium pt-1">Admin note: {myHospital.reviewNote}</p>
                  )}
                </div>
              </div>

              {myHospital && (
                <form
                  onSubmit={handleSaveInventory}
                  className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-100 pb-3">
                    <div>
                      <h2 className="text-lg font-semibold text-slate-900">
                        Available Blood Units
                      </h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Last updated: {formatLastUpdated(myHospital.inventoryUpdatedAtMs)}
                      </p>
                    </div>
                  </div>

                  {myHospital.status !== 'approved' && (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-xs text-slate-700">
                      Stock updates are locked until an admin approves your hospital or blood bank.
                    </div>
                  )}

                  {inventoryError && (
                    <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
                      {inventoryError}
                    </div>
                  )}

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {BLOOD_GROUPS.map((bg) => (
                      <div key={bg} className="border border-slate-200 rounded-lg p-3 bg-slate-50">
                        <label
                          htmlFor={`inv-${bg}`}
                          className="block text-xs font-bold text-slate-800 mb-1.5"
                        >
                          {bg} Units
                        </label>
                        <input
                          id={`inv-${bg}`}
                          type="number"
                          min={0}
                          max={100000}
                          step={1}
                          disabled={myHospital.status !== 'approved' || savingInventory}
                          value={inventoryDraft[bg]}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const num = raw === '' ? 0 : Math.max(0, Math.floor(Number(raw)));
                            setInventoryDraft((prev) => ({
                              ...prev,
                              [bg]: Number.isFinite(num) ? num : 0,
                            }));
                          }}
                          className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono-tabular bg-white border border-slate-200 rounded-lg disabled:bg-slate-100 disabled:text-slate-400 focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                        />
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end pt-2 border-t border-slate-100">
                    <button
                      type="submit"
                      disabled={myHospital.status !== 'approved' || savingInventory}
                      className="min-h-[44px] px-5 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg flex items-center gap-2 transition-colors"
                    >
                      {savingInventory && <Loader2 className="w-4 h-4 animate-spin" />}
                      Save Blood Stock
                    </button>
                  </div>
                </form>
              )}

              <form
                onSubmit={handleSaveFacility}
                className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5"
              >
                <div className="border-b border-slate-100 pb-3">
                  <h2 className="text-lg font-semibold text-slate-900">
                    {myHospital ? 'Facility Registration Details' : 'Register Hospital / Blood Bank'}
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Provide accurate location and contact details so patients and families can reach you quickly.
                  </p>
                </div>

                {facilityError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
                    {facilityError}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="hosp-name"
                      className="block text-xs font-medium text-slate-700 mb-1.5"
                    >
                      Facility Name<span className="text-red-600 ml-0.5">*</span>
                    </label>
                    <input
                      id="hosp-name"
                      type="text"
                      required
                      maxLength={120}
                      value={facilityName}
                      onChange={(e) => setFacilityName(e.target.value)}
                      placeholder="City General Hospital Blood Bank"
                      className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="hosp-type"
                      className="block text-xs font-medium text-slate-700 mb-1.5"
                    >
                      Facility Type<span className="text-red-600 ml-0.5">*</span>
                    </label>
                    <select
                      id="hosp-type"
                      value={facilityType}
                      onChange={(e) =>
                        setFacilityType(
                          e.target.value === 'blood_bank' ? 'blood_bank' : 'hospital',
                        )
                      }
                      className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                    >
                      <option value="hospital">Hospital</option>
                      <option value="blood_bank">Blood Bank</option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="hosp-license"
                      className="block text-xs font-medium text-slate-700 mb-1.5"
                    >
                      License / Registration Number (optional)
                    </label>
                    <input
                      id="hosp-license"
                      type="text"
                      maxLength={80}
                      value={licenseNumber}
                      onChange={(e) => setLicenseNumber(e.target.value)}
                      placeholder="State / national blood bank license ID"
                      className="w-full min-h-[44px] px-3 py-2 text-sm font-mono-tabular bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="hosp-contact"
                      className="block text-xs font-medium text-slate-700 mb-1.5"
                    >
                      Public Blood Bank Desk Phone / Email<span className="text-red-600 ml-0.5">*</span>
                    </label>
                    <input
                      id="hosp-contact"
                      type="text"
                      required
                      maxLength={150}
                      value={contact}
                      onChange={(e) => setContact(e.target.value)}
                      placeholder="+91 80 2345 6789"
                      className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                    />
                  </div>
                </div>

                <div className="space-y-2 pt-2 border-t border-slate-100">
                  <h3 className="text-sm font-semibold text-slate-900">Facility Location</h3>
                  <LocationSelector
                    idPrefix="hosp-form"
                    mode="form"
                    showPincode
                    requiredCity
                    value={formLocation}
                    onChange={setFormLocation}
                  />
                </div>

                <LocationPickerMap
                  lat={facilityLat}
                  lng={facilityLng}
                  onCoordinatesChange={(nextLat, nextLng) => {
                    setFacilityLat(nextLat);
                    setFacilityLng(nextLng);
                  }}
                  onReverseGeocode={handleReverseGeocode}
                  title="Pin facility on map (for distance ranking & directions)"
                  helperText="Tap 'Use my current location' or place the pin at your hospital or blood bank so families see accurate distances."
                />

                <div className="flex justify-end pt-2 border-t border-slate-100">
                  <button
                    type="submit"
                    disabled={savingFacility}
                    className="w-full sm:w-auto min-h-[46px] px-6 py-2.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors"
                  >
                    {savingFacility && <Loader2 className="w-4 h-4 animate-spin" />}
                    {myHospital ? 'Save Facility Details' : 'Submit for Admin Approval'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      )}
    </div>
  );
}
