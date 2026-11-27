import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { Crosshair, Loader2, MapPin, RotateCcw } from 'lucide-react';
import { reverseGeocode } from '../lib/locationApi.ts';
import type { ReverseGeocodeResult } from '../types.ts';

interface LocationPickerMapProps {
  lat: number | null;
  lng: number | null;
  onCoordinatesChange: (lat: number | null, lng: number | null) => void;
  onReverseGeocode: (result: ReverseGeocodeResult) => void;
  title?: string;
  helperText?: string;
}

const DEFAULT_CENTER: [number, number] = [20.5937, 78.9629];

function createPinIcon(): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div style="width:28px;height:28px;border-radius:9999px;background:#dc2626;border:3px solid #ffffff;box-shadow:0 3px 10px rgba(15,23,42,0.35);display:flex;align-items:center;justify-content:center;"><div style="width:8px;height:8px;border-radius:9999px;background:#ffffff;"></div></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

export function LocationPickerMap({
  lat,
  lng,
  onCoordinatesChange,
  onReverseGeocode,
  title = 'Pinpoint Location on Map',
  helperText = 'Tap "Use my current location" or drag the pin to auto-fill address fields. Manual entry always works.',
}: LocationPickerMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  const onCoordinatesChangeRef = useRef(onCoordinatesChange);
  const onReverseGeocodeRef = useRef(onReverseGeocode);
  onCoordinatesChangeRef.current = onCoordinatesChange;
  onReverseGeocodeRef.current = onReverseGeocode;

  const [geoLoading, setGeoLoading] = useState(false);
  const [reverseLoading, setReverseLoading] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [resolvedLabel, setResolvedLabel] = useState('');

  const runReverse = async (nextLat: number, nextLng: number) => {
    setReverseLoading(true);
    setStatusError('');
    try {
      const result = await reverseGeocode(nextLat, nextLng);
      setResolvedLabel(result.displayName || '');
      onReverseGeocodeRef.current(result);
    } catch (err) {
      setStatusError(
        err instanceof Error
          ? `${err.message} Your pin coordinates are saved, and manual location fields still work.`
          : 'Address lookup unavailable. Manual location fields still work.',
      );
    } finally {
      setReverseLoading(false);
    }
  };

  const placeOrMoveMarker = (nextLat: number, nextLng: number, shouldZoom = false) => {
    const map = mapInstanceRef.current;
    if (!map) return;

    if (!markerRef.current) {
      const marker = L.marker([nextLat, nextLng], {
        draggable: true,
        icon: createPinIcon(),
      }).addTo(map);

      marker.on('dragend', () => {
        const pos = marker.getLatLng();
        const rLat = Number(pos.lat.toFixed(6));
        const rLng = Number(pos.lng.toFixed(6));
        onCoordinatesChangeRef.current(rLat, rLng);
        void runReverse(rLat, rLng);
      });

      markerRef.current = marker;
    } else {
      markerRef.current.setLatLng([nextLat, nextLng]);
    }

    if (shouldZoom) {
      map.setView([nextLat, nextLng], Math.max(map.getZoom(), 14), { animate: true });
    } else {
      map.panTo([nextLat, nextLng], { animate: true });
    }
  };

  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const hasInitial = lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng);
    const map = L.map(mapContainerRef.current, {
      center: hasInitial ? [lat!, lng!] : DEFAULT_CENTER,
      zoom: hasInitial ? 14 : 5,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      const nextLat = Number(e.latlng.lat.toFixed(6));
      const nextLng = Number(e.latlng.lng.toFixed(6));
      onCoordinatesChangeRef.current(nextLat, nextLng);
      placeOrMoveMarker(nextLat, nextLng, false);
      void runReverse(nextLat, nextLng);
    });

    mapInstanceRef.current = map;

    if (hasInitial) {
      placeOrMoveMarker(lat!, lng!, false);
    }

    setTimeout(() => {
      map.invalidateSize();
    }, 100);

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!mapInstanceRef.current) return;
    if (lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)) {
      placeOrMoveMarker(lat, lng, false);
    } else if (markerRef.current) {
      markerRef.current.remove();
      markerRef.current = null;
      setResolvedLabel('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  const handleUseCurrentLocation = () => {
    if (!('geolocation' in navigator)) {
      setStatusError('Browser geolocation is not supported on this device. Please enter your location manually.');
      return;
    }

    setGeoLoading(true);
    setStatusError('');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGeoLoading(false);
        const nextLat = Number(position.coords.latitude.toFixed(6));
        const nextLng = Number(position.coords.longitude.toFixed(6));
        onCoordinatesChange(nextLat, nextLng);
        placeOrMoveMarker(nextLat, nextLng, true);
        void runReverse(nextLat, nextLng);
      },
      (err) => {
        setGeoLoading(false);
        const reason =
          err.code === err.PERMISSION_DENIED
            ? 'Location permission was denied.'
            : err.code === err.TIMEOUT
              ? 'Location request timed out.'
              : 'Unable to detect current location.';
        setStatusError(`${reason} You can drop a pin on the map or fill in the address manually.`);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      },
    );
  };

  const handleClearPin = () => {
    onCoordinatesChange(null, null);
    setResolvedLabel('');
    setStatusError('');
  };

  return (
    <div className="border border-slate-200 rounded-2xl bg-slate-50/70 p-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
        <div>
          <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
          <p className="text-xs text-slate-600 mt-0.5">{helperText}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {lat !== null && lng !== null && (
            <button
              type="button"
              onClick={handleClearPin}
              className="min-h-[40px] px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 bg-white border border-slate-200 rounded-xl flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Clear pin
            </button>
          )}
          <button
            type="button"
            onClick={handleUseCurrentLocation}
            disabled={geoLoading}
            className="min-h-[44px] px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60 rounded-xl flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            {geoLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Crosshair className="w-4 h-4" />
            )}
            Use my current location
          </button>
        </div>
      </div>

      <div
        ref={mapContainerRef}
        className="w-full h-56 sm:h-64 rounded-xl border border-slate-200 overflow-hidden bg-slate-200"
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 text-slate-600">
          <MapPin className="w-3.5 h-3.5 text-red-600 shrink-0" />
          {lat !== null && lng !== null ? (
            <span className="font-mono-tabular">
              Pin: {lat.toFixed(4)}, {lng.toFixed(4)}
            </span>
          ) : (
            <span>Tap anywhere on the map or use current location to drop a draggable pin.</span>
          )}
        </div>
        {reverseLoading && (
          <span className="text-slate-500 flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Looking up address...
          </span>
        )}
      </div>

      {resolvedLabel && !statusError && (
        <p className="text-xs text-slate-600 bg-white border border-slate-200 rounded-lg px-3 py-2">
          Detected area: {resolvedLabel}
        </p>
      )}

      {statusError && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {statusError}
        </p>
      )}
    </div>
  );
}
