import { useState } from 'react';
import { doc, updateDoc, writeBatch } from 'firebase/firestore';
import { Bell, Check, CheckCheck, ExternalLink, MapPin, Phone } from 'lucide-react';
import { buildGoogleMapsDirectionsUrl } from '../lib/eligibility.ts';
import { db, handleFirestoreError, OperationType } from '../lib/firebase.ts';
import type { AppNotification } from '../types.ts';

interface NotificationsViewProps {
  notifications: AppNotification[];
  loading: boolean;
}

export function NotificationsView({ notifications, loading }: NotificationsViewProps) {
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const sorted = [...notifications].sort((a, b) => {
    if (a.read !== b.read) return Number(a.read) - Number(b.read);
    if (a.sameLocality !== b.sameLocality) return Number(b.sameLocality) - Number(a.sameLocality);
    return b.createdAtMs - a.createdAtMs;
  });

  const unreadCount = notifications.filter((n) => !n.read).length;

  const handleMarkRead = async (id: string) => {
    setUpdatingId(id);
    try {
      await updateDoc(doc(db, 'notifications', id), { read: true });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `notifications/${id}`);
    } finally {
      setUpdatingId(null);
    }
  };

  const handleMarkAllRead = async () => {
    const unread = notifications.filter((n) => !n.read);
    if (unread.length === 0) return;
    setMarkingAll(true);
    try {
      const batch = writeBatch(db);
      for (const n of unread) {
        batch.update(doc(db, 'notifications', n.id), { read: true });
      }
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'notifications');
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Donor Alerts
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            In-app notifications sent when an emergency request matches your blood group and city, prioritizing your locality first.
          </p>
        </div>

        {unreadCount > 0 && (
          <button
            type="button"
            disabled={markingAll}
            onClick={() => void handleMarkAllRead()}
            className="min-h-[44px] px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <CheckCheck className="w-4 h-4" />
            Mark all as read ({unreadCount})
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white border border-slate-200 rounded-2xl p-5 space-y-2 animate-pulse">
              <div className="h-4 w-1/3 bg-slate-200 rounded" />
              <div className="h-5 w-1/2 bg-slate-100 rounded" />
            </div>
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-500 flex items-center justify-center mx-auto">
            <Bell className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-slate-900">No donor alerts yet</h3>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            Make sure your donor profile is completed, eligible (90+ days since last donation), and toggled visible in search to receive city and locality alerts.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((item) => {
            const mapsUrl = buildGoogleMapsDirectionsUrl({
              lat: item.hospitalLat,
              lng: item.hospitalLng,
              hospitalName: item.hospitalName,
              locality: item.locality,
              city: item.city,
              stateName: item.stateName,
              countryName: item.countryName,
            });
            const locParts = [item.locality, item.city, item.stateName, item.countryName].filter(Boolean);
            const timeLabel = item.createdAtMs
              ? new Date(item.createdAtMs).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : 'Recently';

            return (
              <article
                key={item.id}
                className={`border rounded-2xl p-5 transition-colors ${
                  item.read ? 'bg-white border-slate-200' : 'bg-red-50/40 border-red-200'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="space-y-2 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <span className={item.sameLocality ? 'font-semibold text-red-700' : 'font-medium text-slate-700'}>
                        {item.sameLocality ? 'Same Locality Match' : 'Same City Match'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono-tabular font-semibold text-slate-900">
                        {item.bloodGroup} ({item.units} {item.units === 1 ? 'unit' : 'units'})
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{timeLabel}</span>
                      {!item.read && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-red-700">Unread</span>
                        </>
                      )}
                    </div>

                    <h3 className="text-base font-semibold text-slate-900">
                      {item.hospitalName}
                    </h3>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                      <span className="flex items-center gap-1.5">
                        <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        {locParts.join(' · ')}
                      </span>
                      <span className="flex items-center gap-1.5 font-mono-tabular text-slate-800">
                        <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        {item.contact}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 shrink-0">
                    <a
                      href={mapsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-h-[40px] px-3 py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-800 text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Open in Google Maps
                    </a>

                    {!item.read && (
                      <button
                        type="button"
                        disabled={updatingId === item.id}
                        onClick={() => void handleMarkRead(item.id)}
                        className="min-h-[40px] px-3 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        <Check className="w-3.5 h-3.5" />
                        Mark read
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
