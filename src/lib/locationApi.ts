import type { PinCodeLookupResult, ReverseGeocodeResult } from '../types.ts';

const reverseCache = new Map<string, ReverseGeocodeResult>();
const pincodeCache = new Map<string, PinCodeLookupResult>();

let lastGeocodeRequestMs = 0;
let geocodeQueueTail: Promise<unknown> = Promise.resolve();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = reverseCache.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }

  const task = geocodeQueueTail.then(async () => {
    const cachedAgain = reverseCache.get(key);
    if (cachedAgain) return cachedAgain;

    const elapsed = Date.now() - lastGeocodeRequestMs;
    if (elapsed < 1050) {
      await delay(1050 - elapsed);
    }
    lastGeocodeRequestMs = Date.now();

    const response = await fetch(
      `/api/geocode/reverse?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`,
    );
    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || 'Could not resolve address from coordinates.');
    }
    const data = (await response.json()) as ReverseGeocodeResult;
    reverseCache.set(key, data);
    return data;
  });

  geocodeQueueTail = task.catch(() => undefined);
  return task;
}

export async function lookupIndianPincode(pincode: string): Promise<PinCodeLookupResult> {
  const clean = pincode.trim();
  if (!/^\d{6}$/.test(clean)) {
    throw new Error('PIN code must be 6 digits.');
  }

  const cached = pincodeCache.get(clean);
  if (cached) {
    return cached;
  }

  const response = await fetch(`/api/pincode/${encodeURIComponent(clean)}`);
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || 'Could not fetch localities for this PIN code.');
  }
  const data = (await response.json()) as PinCodeLookupResult;
  pincodeCache.set(clean, data);
  return data;
}
