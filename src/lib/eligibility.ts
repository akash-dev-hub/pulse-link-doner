import {
  BLOOD_GROUPS,
  type AppNotification,
  type BloodGroup,
  type ChatMessage,
  type ChatThread,
  type DonorPrivate,
  type DonorPublic,
  type EmergencyRequest,
} from '../types.ts';

export const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
export const HIDDEN_SEARCH_SENTINEL_MS = 9999999999999;
export const USERNAME_REGEX = /^[a-z0-9_]{3,24}$/;

export function normalizeUsernameInput(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, '');
}

export function isValidUsername(username: string): boolean {
  return USERNAME_REGEX.test(username);
}

export function sanitizeUsernameCandidate(raw: string, fallbackSuffix = ''): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/@.*/, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 18);
  const base = cleaned.length >= 3 ? cleaned : `user_${cleaned || 'donor'}`;
  const candidate = `${base}${fallbackSuffix}`.slice(0, 24);
  return USERNAME_REGEX.test(candidate) ? candidate : `donor_${Date.now().toString(36).slice(-6)}`;
}

export function makeChatId(uidA: string, uidB: string): string {
  const [p1, p2] = [uidA, uidB].sort();
  return `${p1}__${p2}`;
}

export interface EligibilityStatus {
  eligible: boolean;
  eligibleAfterMs: number;
  daysSinceDonation: number | null;
  daysRemaining: number;
  eligibleDateStr: string | null;
}

export function getTodayLocalDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isFutureDateStr(dateStr: string): boolean {
  if (!dateStr) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return true;
  return dateStr > getTodayLocalDateStr();
}

export function parseDateStrUtcMs(dateStr: string): number | null {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(ms)) return null;
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m - 1 ||
    check.getUTCDate() !== d
  ) {
    return null;
  }
  return ms;
}

export function computeEligibility(lastDonationDate: string, nowMs = Date.now()): EligibilityStatus {
  const trimmed = (lastDonationDate || '').trim();
  if (!trimmed) {
    return {
      eligible: true,
      eligibleAfterMs: 0,
      daysSinceDonation: null,
      daysRemaining: 0,
      eligibleDateStr: null,
    };
  }

  const donationMs = parseDateStrUtcMs(trimmed);
  if (donationMs === null) {
    return {
      eligible: true,
      eligibleAfterMs: 0,
      daysSinceDonation: null,
      daysRemaining: 0,
      eligibleDateStr: null,
    };
  }

  const eligibleAfterMs = donationMs + NINETY_DAYS_MS;
  const diffMs = nowMs - donationMs;
  const daysSinceDonation = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  const eligible = nowMs >= eligibleAfterMs;
  const daysRemaining = eligible ? 0 : Math.max(1, Math.ceil((eligibleAfterMs - nowMs) / (24 * 60 * 60 * 1000)));
  const eligibleDate = new Date(eligibleAfterMs);
  const eligibleDateStr = `${eligibleDate.getUTCFullYear()}-${String(eligibleDate.getUTCMonth() + 1).padStart(2, '0')}-${String(eligibleDate.getUTCDate()).padStart(2, '0')}`;

  return {
    eligible,
    eligibleAfterMs,
    daysSinceDonation,
    daysRemaining,
    eligibleDateStr,
  };
}

export function coerceBloodGroup(value: unknown): BloodGroup {
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    if ((BLOOD_GROUPS as readonly string[]).includes(normalized)) {
      return normalized as BloodGroup;
    }
  }
  return 'O+';
}

export function coerceTimestampMs(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value && typeof value === 'object') {
    const v = value as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v._seconds === 'number') return v._seconds * 1000;
  }
  return fallback;
}

export function coerceOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function normalizeDonorPublic(raw: Record<string, unknown>, id: string): DonorPublic {
  const uid = typeof raw.uid === 'string' && raw.uid ? raw.uid : id;
  const visibleInSearch =
    typeof raw.visibleInSearch === 'boolean'
      ? raw.visibleInSearch
      : typeof raw.isVisible === 'boolean'
        ? raw.isVisible
        : true;

  let eligibleAfterMs = typeof raw.eligibleAfterMs === 'number' ? raw.eligibleAfterMs : 0;
  if (raw.eligibleAfterMs === undefined && typeof raw.lastDonationDate === 'string') {
    eligibleAfterMs = computeEligibility(raw.lastDonationDate).eligibleAfterMs;
  }

  const searchActiveAfterMs =
    typeof raw.searchActiveAfterMs === 'number'
      ? raw.searchActiveAfterMs
      : visibleInSearch
        ? eligibleAfterMs
        : HIDDEN_SEARCH_SENTINEL_MS;

  const rawUsername = typeof raw.username === 'string' ? normalizeUsernameInput(raw.username) : '';
  const username = isValidUsername(rawUsername)
    ? rawUsername
    : `donor_${uid.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 6) || 'user'}`;

  return {
    uid,
    username,
    bloodGroup: coerceBloodGroup(raw.bloodGroup ?? raw.bloodType),
    countryCode: typeof raw.countryCode === 'string' && raw.countryCode ? raw.countryCode : 'IN',
    countryName:
      typeof raw.countryName === 'string' && raw.countryName
        ? raw.countryName
        : typeof raw.country === 'string' && raw.country
          ? raw.country
          : 'India',
    stateCode: typeof raw.stateCode === 'string' ? raw.stateCode : '',
    stateName: typeof raw.stateName === 'string' ? raw.stateName : typeof raw.state === 'string' ? raw.state : '',
    city: typeof raw.city === 'string' && raw.city ? raw.city : 'Unspecified City',
    locality: typeof raw.locality === 'string' ? raw.locality : '',
    pincode: typeof raw.pincode === 'string' ? raw.pincode : '',
    visibleInSearch,
    eligibleAfterMs,
    searchActiveAfterMs,
    contactPreference: visibleInSearch ? 'chat' : 'hidden',
    approxLat: coerceOptionalNumber(raw.approxLat),
    approxLng: coerceOptionalNumber(raw.approxLng),
    createdAtMs: coerceTimestampMs(raw.createdAt),
    updatedAtMs: coerceTimestampMs(raw.updatedAt),
  };
}

export function normalizeDonorPrivate(raw: Record<string, unknown>, id: string): DonorPrivate {
  return {
    uid: typeof raw.uid === 'string' && raw.uid ? raw.uid : id,
    fullName: typeof raw.fullName === 'string' ? raw.fullName : '',
    phone: typeof raw.phone === 'string' ? raw.phone : '',
    email: typeof raw.email === 'string' ? raw.email : '',
    contactPreference: 'chat',
    lastDonationDate: typeof raw.lastDonationDate === 'string' ? raw.lastDonationDate : '',
    exactLat: coerceOptionalNumber(raw.exactLat ?? raw.lat),
    exactLng: coerceOptionalNumber(raw.exactLng ?? raw.lng),
    createdAtMs: coerceTimestampMs(raw.createdAt),
    updatedAtMs: coerceTimestampMs(raw.updatedAt),
  };
}

export function normalizeEmergencyRequest(raw: Record<string, unknown>, id: string): EmergencyRequest {
  const unitsRaw = coerceOptionalNumber(raw.units);
  const units = unitsRaw !== null && unitsRaw >= 1 ? Math.floor(unitsRaw) : 1;
  const status = raw.status === 'fulfilled' ? 'fulfilled' : 'active';

  return {
    id,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : '',
    createdByName: typeof raw.createdByName === 'string' && raw.createdByName ? raw.createdByName : 'Requester',
    bloodGroup: coerceBloodGroup(raw.bloodGroup ?? raw.bloodType),
    units,
    hospitalName:
      typeof raw.hospitalName === 'string' && raw.hospitalName.trim()
        ? raw.hospitalName.trim()
        : 'Hospital',
    countryCode: typeof raw.countryCode === 'string' && raw.countryCode ? raw.countryCode : 'IN',
    countryName:
      typeof raw.countryName === 'string' && raw.countryName
        ? raw.countryName
        : typeof raw.country === 'string' && raw.country
          ? raw.country
          : 'India',
    stateCode: typeof raw.stateCode === 'string' ? raw.stateCode : '',
    stateName: typeof raw.stateName === 'string' ? raw.stateName : typeof raw.state === 'string' ? raw.state : '',
    city:
      typeof raw.city === 'string' && raw.city
        ? raw.city
        : typeof raw.hospitalLocation === 'string'
          ? raw.hospitalLocation
          : 'Unspecified City',
    locality: typeof raw.locality === 'string' ? raw.locality : '',
    pincode: typeof raw.pincode === 'string' ? raw.pincode : '',
    hospitalLat: coerceOptionalNumber(raw.hospitalLat ?? raw.lat),
    hospitalLng: coerceOptionalNumber(raw.hospitalLng ?? raw.lng),
    contact: typeof raw.contact === 'string' && raw.contact ? raw.contact : 'Not provided',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    status,
    createdAtMs: coerceTimestampMs(raw.createdAt),
    updatedAtMs: coerceTimestampMs(raw.updatedAt),
    fulfilledAtMs: raw.fulfilledAt ? coerceTimestampMs(raw.fulfilledAt) : null,
  };
}

export function normalizeNotification(raw: Record<string, unknown>, id: string): AppNotification {
  const unitsRaw = coerceOptionalNumber(raw.units);
  return {
    id,
    recipientId: typeof raw.recipientId === 'string' ? raw.recipientId : '',
    senderId: typeof raw.senderId === 'string' ? raw.senderId : '',
    requestId: typeof raw.requestId === 'string' ? raw.requestId : '',
    bloodGroup: coerceBloodGroup(raw.bloodGroup),
    units: unitsRaw !== null && unitsRaw >= 1 ? Math.floor(unitsRaw) : 1,
    hospitalName: typeof raw.hospitalName === 'string' && raw.hospitalName ? raw.hospitalName : 'Hospital',
    city: typeof raw.city === 'string' ? raw.city : '',
    locality: typeof raw.locality === 'string' ? raw.locality : '',
    stateName: typeof raw.stateName === 'string' ? raw.stateName : '',
    countryName: typeof raw.countryName === 'string' ? raw.countryName : '',
    contact: typeof raw.contact === 'string' ? raw.contact : '',
    hospitalLat: coerceOptionalNumber(raw.hospitalLat),
    hospitalLng: coerceOptionalNumber(raw.hospitalLng),
    sameLocality: Boolean(raw.sameLocality),
    read: Boolean(raw.read),
    createdAtMs: coerceTimestampMs(raw.createdAt),
  };
}

export function normalizeChatThread(raw: Record<string, unknown>, id: string): ChatThread {
  const p1Uid = typeof raw.p1Uid === 'string' ? raw.p1Uid : '';
  const p2Uid = typeof raw.p2Uid === 'string' ? raw.p2Uid : '';
  return {
    id,
    participantIds: [p1Uid, p2Uid],
    p1Uid,
    p2Uid,
    p1Username: typeof raw.p1Username === 'string' ? raw.p1Username : 'user',
    p2Username: typeof raw.p2Username === 'string' ? raw.p2Username : 'user',
    p1Unread: typeof raw.p1Unread === 'number' && raw.p1Unread >= 0 ? Math.floor(raw.p1Unread) : 0,
    p2Unread: typeof raw.p2Unread === 'number' && raw.p2Unread >= 0 ? Math.floor(raw.p2Unread) : 0,
    blockedByP1: Boolean(raw.blockedByP1),
    blockedByP2: Boolean(raw.blockedByP2),
    lastMessageText: typeof raw.lastMessageText === 'string' ? raw.lastMessageText : '',
    lastMessageSenderId: typeof raw.lastMessageSenderId === 'string' ? raw.lastMessageSenderId : '',
    lastMessageAtMs: raw.lastMessageAt ? coerceTimestampMs(raw.lastMessageAt) : null,
    createdAtMs: coerceTimestampMs(raw.createdAt),
    updatedAtMs: coerceTimestampMs(raw.updatedAt),
  };
}

export function normalizeChatMessage(raw: Record<string, unknown>, id: string): ChatMessage {
  const participants = Array.isArray(raw.participantIds) ? raw.participantIds : [];
  return {
    id,
    chatId: typeof raw.chatId === 'string' ? raw.chatId : '',
    participantIds: [
      typeof participants[0] === 'string' ? participants[0] : '',
      typeof participants[1] === 'string' ? participants[1] : '',
    ],
    senderId: typeof raw.senderId === 'string' ? raw.senderId : '',
    senderUsername: typeof raw.senderUsername === 'string' ? raw.senderUsername : 'user',
    text: typeof raw.text === 'string' ? raw.text : '',
    createdAtMs: coerceTimestampMs(raw.createdAt),
  };
}

export function buildGoogleMapsDirectionsUrl(params: {
  lat: number | null;
  lng: number | null;
  hospitalName?: string;
  locality?: string;
  city?: string;
  stateName?: string;
  countryName?: string;
}): string {
  if (params.lat !== null && params.lng !== null && Number.isFinite(params.lat) && Number.isFinite(params.lng)) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${params.lat},${params.lng}`)}`;
  }
  const address = [params.hospitalName, params.locality, params.city, params.stateName, params.countryName]
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .join(', ');
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address || 'Hospital')}`;
}
