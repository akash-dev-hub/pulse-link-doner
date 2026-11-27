import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { MapPin, MessageSquare, RefreshCw, Search } from 'lucide-react';
import { LocationSelector } from './LocationSelector.tsx';
import { BLOOD_GROUPS, type BloodGroup, type LocationValue } from '../types.ts';

interface SearchDonorResult {
  uid: string;
  username: string;
  bloodGroup: BloodGroup;
  countryCode: string;
  countryName: string;
  stateCode: string;
  stateName: string;
  city: string;
  locality: string;
  contactPreference: 'chat';
  approxLat: number | null;
  approxLng: number | null;
}

interface DonorSearchViewProps {
  user: User;
  onStartChat: (targetUid: string, targetUsername: string) => void;
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

export function DonorSearchView({ user, onStartChat, onNotify }: DonorSearchViewProps) {
  const [bloodGroup, setBloodGroup] = useState<string>('');
  const [location, setLocation] = useState<LocationValue>(DEFAULT_FILTER_LOCATION);
  const [donors, setDonors] = useState<SearchDonorResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const token = await user.getIdToken();
      const params = new URLSearchParams();
      if (bloodGroup) params.set('bloodGroup', bloodGroup);
      if (location.countryCode) params.set('countryCode', location.countryCode);
      if (location.stateCode) params.set('stateCode', location.stateCode);
      if (location.city) params.set('city', location.city);
      if (location.locality.trim()) params.set('locality', location.locality.trim());

      const response = await fetch(`/api/donors/search?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || 'Could not load donors right now. Please try again.');
      }
      const data = (await response.json()) as { donors: SearchDonorResult[] };
      setDonors(Array.isArray(data.donors) ? data.donors : []);
    } catch (err) {
      const msg =
        err instanceof Error && err.message && !err.message.startsWith('Firestore')
          ? err.message
          : 'Could not load donors right now. Please try again.';
      setError(msg);
      onNotify('error', msg);
    } finally {
      setLoading(false);
    }
  }, [user, bloodGroup, location, onNotify]);

  useEffect(() => {
    void runSearch();
  }, [runSearch]);

  const handleResetFilters = () => {
    setBloodGroup('');
    setLocation(DEFAULT_FILTER_LOCATION);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
          Find Blood Donors
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Search by blood group and city. Donors who gave blood in the last 90 days are hidden automatically. Send a private in-app message to reach a donor.
        </p>
      </div>

      <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
          <div className="lg:col-span-3">
            <label htmlFor="search-blood-group" className="block text-xs font-medium text-slate-700 mb-1.5">
              Blood Group
            </label>
            <select
              id="search-blood-group"
              value={bloodGroup}
              onChange={(e) => setBloodGroup(e.target.value)}
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

          <div className="lg:col-span-9">
            <LocationSelector
              idPrefix="search"
              mode="filter"
              showPincode={false}
              requiredCity={false}
              value={location}
              onChange={setLocation}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
          <span className="text-xs text-slate-500 font-mono-tabular">
            {loading ? 'Searching donors...' : `${donors.length} ${donors.length === 1 ? 'donor' : 'donors'} available`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleResetFilters}
              className="min-h-[40px] px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
            >
              Reset filters
            </button>
            <button
              type="button"
              onClick={() => void runSearch()}
              disabled={loading}
              className="min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap"
            >
              <Search className="w-3.5 h-3.5" />
              Search
            </button>
          </div>
        </div>
      </section>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-sm text-red-800">{error}</p>
          <button
            type="button"
            onClick={() => void runSearch()}
            className="min-h-[40px] px-3.5 py-2 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 flex items-center gap-1.5 self-start sm:self-auto"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Try again
          </button>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="h-5 w-1/2 bg-slate-200 rounded" />
              <div className="h-4 w-3/4 bg-slate-100 rounded" />
              <div className="h-10 w-full bg-slate-100 rounded-lg" />
            </div>
          ))}
        </div>
      ) : donors.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
          <h3 className="text-base font-semibold text-slate-900">No matching donors found</h3>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            Try clearing the locality or state filter, or post an emergency request so matching donors in the city are notified.
          </p>
          <button
            type="button"
            onClick={handleResetFilters}
            className="min-h-[44px] px-4 py-2 text-sm font-medium text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
          >
            Clear location filters
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {donors.map((donor) => {
            const locationParts = [donor.locality, donor.city, donor.stateName, donor.countryName].filter(Boolean);
            const isSelf = donor.uid === user.uid;

            return (
              <article
                key={donor.uid}
                className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold font-mono-tabular text-slate-900 truncate">
                        @{donor.username}
                      </h3>
                      <p className="text-xs text-slate-500 mt-0.5">Ready to donate</p>
                    </div>
                    <span className="font-mono-tabular text-base font-bold text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1 shrink-0">
                      {donor.bloodGroup}
                    </span>
                  </div>

                  <div className="flex items-start gap-2 text-xs text-slate-600">
                    <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                    <span>{locationParts.join(' · ')}</span>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-100">
                  {isSelf ? (
                    <div className="w-full min-h-[44px] px-3.5 py-2.5 bg-slate-100 text-slate-600 text-xs font-medium rounded-lg flex items-center justify-center">
                      Your donor listing
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onStartChat(donor.uid, donor.username)}
                      className="w-full min-h-[44px] px-3.5 py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors"
                    >
                      <MessageSquare className="w-4 h-4 shrink-0" />
                      <span>Message</span>
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
