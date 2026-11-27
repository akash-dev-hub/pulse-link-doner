import { useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import L from 'leaflet';
import { Hospital, MapPin, Users } from 'lucide-react';
import {
  buildGoogleMapsDirectionsUrl,
  normalizeEmergencyRequest,
} from '../lib/eligibility.ts';
import { db } from '../lib/firebase.ts';
import { BLOOD_GROUPS, type BloodGroup, type EmergencyRequest } from '../types.ts';

interface MapDonorPoint {
  uid: string;
  username: string;
  bloodGroup: BloodGroup;
  city: string;
  locality: string;
  approxLat: number | null;
  approxLng: number | null;
}

interface MapViewProps {
  user: User;
  onStartChat: (targetUid: string, targetUsername: string) => void;
  onNotify: (type: 'success' | 'error', message: string) => void;
}

function createHospitalIcon(bloodGroup: string): L.DivIcon {
  const safeBg = bloodGroup.replace(/[^A-Z0-9+-]/g, '');
  return L.divIcon({
    className: '',
    html: `<div style="min-width:34px;height:30px;padding:0 6px;border-radius:8px;background:#dc2626;color:#ffffff;border:2px solid #ffffff;display:flex;align-items:center;justify-content:center;font-family:JetBrains Mono,monospace;font-size:11px;font-weight:700;">${safeBg}</div>`,
    iconSize: [36, 30],
    iconAnchor: [18, 15],
  });
}

function createDonorAreaIcon(bloodGroup: string): L.DivIcon {
  const safeBg = bloodGroup.replace(/[^A-Z0-9+-]/g, '');
  return L.divIcon({
    className: '',
    html: `<div style="min-width:30px;height:26px;padding:0 5px;border-radius:9999px;background:#334155;color:#ffffff;border:2px solid #ffffff;display:flex;align-items:center;justify-content:center;font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;">${safeBg}</div>`,
    iconSize: [32, 26],
    iconAnchor: [16, 13],
  });
}

function buildHospitalPopupNode(req: EmergencyRequest): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'space-y-1.5 text-xs text-slate-800 max-w-[230px]';

  const badge = document.createElement('div');
  badge.className = 'font-bold text-red-700';
  badge.textContent = `Emergency Request · ${req.bloodGroup} (${req.units} ${req.units === 1 ? 'unit' : 'units'})`;
  wrap.appendChild(badge);

  const title = document.createElement('div');
  title.className = 'font-semibold text-slate-900 text-sm';
  title.textContent = req.hospitalName;
  wrap.appendChild(title);

  const loc = document.createElement('div');
  loc.className = 'text-slate-600';
  loc.textContent = [req.locality, req.city, req.stateName].filter(Boolean).join(', ');
  wrap.appendChild(loc);

  const contact = document.createElement('div');
  contact.className = 'font-mono text-slate-800';
  contact.textContent = `Contact: ${req.contact}`;
  wrap.appendChild(contact);

  const link = document.createElement('a');
  link.href = buildGoogleMapsDirectionsUrl({
    lat: req.hospitalLat,
    lng: req.hospitalLng,
    hospitalName: req.hospitalName,
    locality: req.locality,
    city: req.city,
    stateName: req.stateName,
    countryName: req.countryName,
  });
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'inline-block mt-1 font-semibold text-red-700 underline';
  link.textContent = 'Open in Google Maps';
  wrap.appendChild(link);

  return wrap;
}

function buildDonorPopupNode(
  donor: MapDonorPoint,
  currentUid: string,
  onMessage: (uid: string, username: string) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'space-y-1.5 text-xs text-slate-800 max-w-[220px]';

  const badge = document.createElement('div');
  badge.className = 'font-bold text-slate-900';
  badge.textContent = `Ready Donor · ${donor.bloodGroup}`;
  wrap.appendChild(badge);

  const name = document.createElement('div');
  name.className = 'font-semibold font-mono text-slate-900 text-sm';
  name.textContent = `@${donor.username}`;
  wrap.appendChild(name);

  const loc = document.createElement('div');
  loc.className = 'text-slate-600';
  loc.textContent = [donor.locality, donor.city].filter(Boolean).join(', ');
  wrap.appendChild(loc);

  const note = document.createElement('div');
  note.className = 'text-[11px] text-slate-500';
  note.textContent = 'Approximate area only.';
  wrap.appendChild(note);

  if (donor.uid !== currentUid) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'mt-1.5 w-full px-3 py-1.5 bg-red-600 text-white text-xs font-semibold rounded-md cursor-pointer';
    btn.textContent = 'Message';
    btn.addEventListener('click', () => {
      onMessage(donor.uid, donor.username);
    });
    wrap.appendChild(btn);
  }

  return wrap;
}

export function MapView({ user, onStartChat, onNotify }: MapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const onStartChatRef = useRef(onStartChat);
  onStartChatRef.current = onStartChat;

  const [requests, setRequests] = useState<EmergencyRequest[]>([]);
  const [donors, setDonors] = useState<MapDonorPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [layerMode, setLayerMode] = useState<'all' | 'requests' | 'donors'>('all');
  const [bloodGroupFilter, setBloodGroupFilter] = useState<string>('');

  useEffect(() => {
    const qActive = query(
      collection(db, 'emergency_requests'),
      where('status', '==', 'active'),
    );
    const unsub = onSnapshot(
      qActive,
      (snap) => {
        const list = snap.docs
          .map((d) => normalizeEmergencyRequest(d.data() as Record<string, unknown>, d.id))
          .filter((r) => r.status === 'active');
        setRequests(list);
      },
      (err) => {
        console.error('Failed to load map requests:', err);
      },
    );

    let cancelled = false;
    (async () => {
      try {
        const token = await user.getIdToken();
        const res = await fetch('/api/donors/search', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Could not load donor areas on the map.');
        const body = (await res.json()) as { donors: MapDonorPoint[] };
        if (!cancelled) {
          setDonors(Array.isArray(body.donors) ? body.donors : []);
        }
      } catch (err) {
        console.error('Map donor load error:', err);
        if (!cancelled) {
          const msg = 'Could not load donor areas on the map right now.';
          setError(msg);
          onNotify('error', msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      unsub();
    };
  }, [user, onNotify]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [20.5937, 78.9629],
      zoom: 5,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    const group = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerGroupRef.current = group;

    setTimeout(() => map.invalidateSize(), 120);

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, []);

  const filteredRequests = useMemo(() => {
    if (layerMode === 'donors') return [];
    return requests.filter(
      (r) =>
        r.hospitalLat !== null &&
        r.hospitalLng !== null &&
        (!bloodGroupFilter || r.bloodGroup === bloodGroupFilter),
    );
  }, [requests, layerMode, bloodGroupFilter]);

  const filteredDonors = useMemo(() => {
    if (layerMode === 'requests') return [];
    return donors.filter(
      (d) =>
        d.approxLat !== null &&
        d.approxLng !== null &&
        (!bloodGroupFilter || d.bloodGroup === bloodGroupFilter),
    );
  }, [donors, layerMode, bloodGroupFilter]);

  useEffect(() => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    if (!map || !group) return;

    group.clearLayers();
    const bounds: [number, number][] = [];

    for (const d of filteredDonors) {
      if (d.approxLat === null || d.approxLng === null) continue;
      const latlng: [number, number] = [d.approxLat, d.approxLng];
      bounds.push(latlng);

      L.circle(latlng, {
        radius: 900,
        color: '#475569',
        weight: 1,
        fillColor: '#64748b',
        fillOpacity: 0.12,
      }).addTo(group);

      const marker = L.marker(latlng, {
        icon: createDonorAreaIcon(d.bloodGroup),
      }).addTo(group);
      marker.bindPopup(
        buildDonorPopupNode(d, user.uid, (uid, username) => {
          onStartChatRef.current(uid, username);
        }),
      );
    }

    for (const r of filteredRequests) {
      if (r.hospitalLat === null || r.hospitalLng === null) continue;
      const latlng: [number, number] = [r.hospitalLat, r.hospitalLng];
      bounds.push(latlng);

      const marker = L.marker(latlng, {
        icon: createHospitalIcon(r.bloodGroup),
      }).addTo(group);
      marker.bindPopup(buildHospitalPopupNode(r));
    }

    if (bounds.length === 1) {
      map.setView(bounds[0], 13, { animate: false });
    } else if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }
  }, [filteredRequests, filteredDonors, user.uid]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
          Hospital &amp; Donor Map
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Red markers show hospitals asking for blood. Grey circles show general areas where ready donors live.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          <button
            type="button"
            onClick={() => setLayerMode('all')}
            className={`min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              layerMode === 'all'
                ? 'bg-white text-slate-900 border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            All Markers
          </button>
          <button
            type="button"
            onClick={() => setLayerMode('requests')}
            className={`min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              layerMode === 'requests'
                ? 'bg-white text-slate-900 border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Hospitals ({filteredRequests.length})
          </button>
          <button
            type="button"
            onClick={() => setLayerMode('donors')}
            className={`min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              layerMode === 'donors'
                ? 'bg-white text-slate-900 border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Donor Areas ({filteredDonors.length})
          </button>
        </div>

        <div className="flex items-center gap-3">
          <select
            aria-label="Filter map by blood group"
            value={bloodGroupFilter}
            onChange={(e) => setBloodGroupFilter(e.target.value)}
            className="min-h-[40px] px-3 py-1.5 text-xs font-medium bg-white border border-slate-200 rounded-lg focus:border-red-500 outline-none text-slate-900"
          >
            <option value="">All blood groups</option>
            {BLOOD_GROUPS.map((bg) => (
              <option key={bg} value={bg}>
                {bg}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div ref={mapContainerRef} className="w-full h-[460px] sm:h-[540px] bg-slate-200" />
        <div className="px-4 py-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 bg-slate-50">
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-1.5">
              <Hospital className="w-4 h-4 text-red-600" />
              Red pins: Hospitals needing blood ({filteredRequests.length})
            </span>
            <span className="flex items-center gap-1.5">
              <Users className="w-4 h-4 text-slate-700" />
              Grey circles: General donor areas ({filteredDonors.length})
            </span>
          </div>
          {loading && <span>Loading map...</span>}
          {!loading && filteredRequests.length === 0 && filteredDonors.length === 0 && (
            <span className="flex items-center gap-1 text-slate-500">
              <MapPin className="w-3.5 h-3.5" />
              No pinned locations for this selection.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
