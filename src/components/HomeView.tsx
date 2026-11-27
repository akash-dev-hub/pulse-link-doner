import { useEffect, useState } from 'react';

interface PublicStatsData {
  registeredDonors: number;
  activeRequests: number;
  fulfilledRequests: number;
}

interface HomeViewProps {
  isSignedIn: boolean;
  signingIn: boolean;
  onAction: (target: 'profile' | 'search' | 'emergency') => void;
}

export function HomeView({ isSignedIn, signingIn, onAction }: HomeViewProps) {
  const [stats, setStats] = useState<PublicStatsData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/stats')
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (data: {
          available?: boolean;
          registeredDonors?: number;
          activeRequests?: number;
          fulfilledRequests?: number;
        } | null) => {
          if (cancelled || !data || !data.available) return;
          if (
            typeof data.registeredDonors === 'number' &&
            typeof data.activeRequests === 'number' &&
            typeof data.fulfilledRequests === 'number'
          ) {
            setStats({
              registeredDonors: data.registeredDonors,
              activeRequests: data.activeRequests,
              fulfilledRequests: data.fulfilledRequests,
            });
          }
        },
      )
      .catch(() => {
        // Hide stats if loading fails
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-4xl mx-auto space-y-8 py-2 sm:py-4">
      <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
        <div className="space-y-3">
          <h1 className="text-2xl sm:text-4xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
            Find a blood donor or ask for urgent help
          </h1>
          <p className="text-base text-slate-600 leading-relaxed max-w-2xl">
            When someone you love needs blood urgently, you should not have to search through confusing lists. PulseLine helps families reach ready donors nearby or share a hospital blood request with people who can help.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row flex-wrap gap-3">
          <button
            type="button"
            disabled={signingIn}
            onClick={() => onAction('search')}
            className="min-h-[46px] px-5 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            Find donors
          </button>

          <button
            type="button"
            disabled={signingIn}
            onClick={() => onAction('emergency')}
            className="min-h-[46px] px-5 py-2.5 bg-white border border-red-600 text-red-700 hover:bg-red-50 disabled:opacity-60 text-sm font-semibold rounded-lg transition-colors"
          >
            Post emergency request
          </button>

          <button
            type="button"
            disabled={signingIn}
            onClick={() => onAction('profile')}
            className="min-h-[46px] px-5 py-2.5 bg-white border border-slate-300 text-slate-900 hover:bg-slate-50 disabled:opacity-60 text-sm font-semibold rounded-lg transition-colors"
          >
            Register as donor
          </button>
        </div>

        {!isSignedIn && (
          <p className="text-xs text-slate-500">
            You will be asked to sign in before messaging donors, viewing request contact numbers, posting a request, or saving your profile.
          </p>
        )}
      </section>

      {stats && (
        <section aria-label="Community statistics" className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <p className="text-xs font-medium text-slate-600">Registered donors</p>
            <p className="mt-1 text-2xl font-bold text-slate-900 font-mono-tabular">
              {stats.registeredDonors}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <p className="text-xs font-medium text-slate-600">Active requests</p>
            <p className="mt-1 text-2xl font-bold text-red-700 font-mono-tabular">
              {stats.activeRequests}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <p className="text-xs font-medium text-slate-600">Fulfilled requests</p>
            <p className="mt-1 text-2xl font-bold text-slate-900 font-mono-tabular">
              {stats.fulfilledRequests}
            </p>
          </div>
        </section>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900">How it works in 3 steps</h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
            <span className="text-xs font-semibold text-red-700">Step 1</span>
            <h3 className="text-sm font-semibold text-slate-900">
              Search donors or post the need
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Look up matching blood groups by city, or post the hospital name, units needed, and a contact number.
            </p>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
            <span className="text-xs font-semibold text-red-700">Step 2</span>
            <h3 className="text-sm font-semibold text-slate-900">
              Message ready donors in-app
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Only donors who have not donated in the last 90 days are shown. Message donors privately using usernames—personal phone numbers and emails stay hidden.
            </p>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
            <span className="text-xs font-semibold text-red-700">Step 3</span>
            <h3 className="text-sm font-semibold text-slate-900">
              Coordinate and close when done
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Share hospital directions with one tap, and mark the request fulfilled once your family has the blood needed.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
