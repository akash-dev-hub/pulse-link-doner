import { BellRing, Check, ExternalLink, Loader2, MapPin, X } from 'lucide-react';
import { buildGoogleMapsDirectionsUrl, URGENCY_LABELS } from '../lib/eligibility.ts';
import type { AppNotification } from '../types.ts';

interface EmergencyAlertModalProps {
  alert: AppNotification | null;
  secondsLeft: number;
  submitting: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onDismiss: () => void;
}

export function EmergencyAlertModal({
  alert,
  secondsLeft,
  submitting,
  onAccept,
  onDecline,
  onDismiss,
}: EmergencyAlertModalProps) {
  if (!alert) return null;

  const mapsUrl = buildGoogleMapsDirectionsUrl({
    lat: alert.hospitalLat,
    lng: alert.hospitalLng,
    hospitalName: alert.hospitalName,
    locality: alert.locality,
    city: alert.city,
    stateName: alert.stateName,
    countryName: alert.countryName,
  });

  const locationParts = [alert.locality, alert.city, alert.stateName, alert.countryName].filter(Boolean);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="emergency-alert-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/55"
    >
      <div className="w-full max-w-md bg-white border-2 border-red-600 rounded-xl p-5 sm:p-6 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-600 text-white flex items-center justify-center shrink-0">
              <BellRing className="w-5 h-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span className="font-semibold text-red-700">{URGENCY_LABELS[alert.urgency]}</span>
                <span aria-hidden="true">·</span>
                <span>{alert.sameLocality ? 'Same Local Area' : 'Nearby'}</span>
              </div>
              <h2
                id="emergency-alert-modal-title"
                className="text-lg font-bold text-slate-900 mt-0.5"
              >
                Matching Blood Request
              </h2>
            </div>
          </div>

          <button
            type="button"
            disabled={submitting}
            onClick={onDismiss}
            aria-label="Silence and close alert"
            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono-tabular text-2xl font-bold text-red-700">
              {alert.bloodGroup}
            </span>
            <span className="font-mono-tabular text-sm font-semibold text-slate-800">
              {alert.units} {alert.units === 1 ? 'unit' : 'units'} needed
            </span>
          </div>

          <div className="text-sm font-semibold text-slate-900">{alert.hospitalName}</div>

          {locationParts.length > 0 && (
            <div className="flex items-start gap-1.5 text-xs text-slate-600">
              <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
              <span>{locationParts.join(' · ')}</span>
            </div>
          )}

          <div className="pt-1">
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 hover:underline"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open hospital in Google Maps
            </a>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-slate-600">
          <span>Contacts stay private until the hospital verifies you.</span>
          <span className="font-mono-tabular font-semibold text-slate-900 whitespace-nowrap ml-2">
            {secondsLeft}s
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={submitting}
            onClick={onDecline}
            className="min-h-[46px] px-4 py-2.5 text-sm font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg flex items-center justify-center gap-1.5 transition-colors"
          >
            <X className="w-4 h-4" />
            Decline
          </button>

          <button
            type="button"
            disabled={submitting}
            onClick={onAccept}
            className="min-h-[46px] px-4 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-lg flex items-center justify-center gap-1.5 transition-colors"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
