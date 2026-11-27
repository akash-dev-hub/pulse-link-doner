import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
  commitFirestoreWrites,
  computeApproxAreaCoords,
  FirestoreTimestamp,
  generateFirestoreId,
  getFirestoreDoc,
  getPublicFirestoreDoc,
  queryFirestoreCollection,
  type CommitWriteOp,
  type FirestoreConfig,
} from './server/firestoreRest.ts';
import {
  coerceUrgencyLevel,
  computeEligibility,
  createEmptyInventory,
  getEffectiveUrgency,
  getTodayLocalDateStr,
  haversineDistanceKm,
  HIDDEN_SEARCH_SENTINEL_MS,
  isFutureDateStr,
  isOpenRequestStatus,
  isValidUrgencyLevel,
  isValidUsername,
  isValidUserRole,
  MAX_NEW_ACCOUNTS_PER_DEVICE_24H,
  MAX_NEW_ACCOUNTS_PER_IP_24H,
  makeRequestResponseId,
  normalizeAbuseReport,
  normalizeAccountModeration,
  normalizeAuthEventLog,
  normalizeDeviceRegistration,
  normalizeDonorPrivate,
  normalizeDonorPublic,
  normalizeEmergencyRequest,
  normalizeHospitalProfile,
  normalizeInventory,
  normalizeRequestResponse,
  normalizeUsernameInput,
  normalizeUserRateLimit,
  normalizeUserRoleRecord,
  rankHospitals,
  RATE_LIMIT_REQUESTS_PER_DAY,
  sanitizeUsernameCandidate,
  THIRTY_DAYS_MS,
  TWENTY_FOUR_HOURS_MS,
} from './src/lib/eligibility.ts';
import {
  BLOOD_GROUPS,
  type AccountModerationStatus,
  type BloodGroup,
  type ReportReason,
  type ReportTargetType,
  type UrgencyLevel,
  type UserRole,
} from './src/types.ts';

const BOOTSTRAP_ADMIN_EMAIL = 'akshuboi123@gmail.com';
const RUNTIME_FALLBACK_IP_SECRET = crypto.randomBytes(32).toString('hex');
const SERVER_BOOT_MS = Date.now();
const ANTI_FRAUD_ENFORCEMENT_START_MS = 1795796250000;

interface RuntimeFirebaseConfig extends FirestoreConfig {
  apiKey?: string;
}

function getIpHashSecret(): string {
  return (process.env.IP_HASH_SECRET || '').trim() || RUNTIME_FALLBACK_IP_SECRET;
}

function computeKeyedHash(prefix: string, rawValue: string): string {
  return crypto
    .createHmac('sha256', getIpHashSecret())
    .update(`${prefix}:${rawValue}`)
    .digest('hex');
}

function computeDeviceLockHash(deviceId: string): string {
  return crypto
    .createHash('sha256')
    .update(`pulseline_device_lock_v1:${firebaseConfig.projectId}:${deviceId}`)
    .digest('hex')
    .slice(0, 48);
}

function getServerClientIp(req: Request): string {
  const candidate =
    typeof req.ip === 'string' && req.ip
      ? req.ip
      : req.socket?.remoteAddress || 'unknown';
  return candidate.replace(/^::ffff:/, '').trim() || 'unknown';
}

const inMemoryDeviceSignups24h = new Map<string, Array<{ uid: string; ts: number }>>();
const inMemoryIpSignups24h = new Map<string, Array<{ uid: string; ts: number }>>();
const inMemoryRegisteredDevices = new Map<string, string>();
const inMemoryVerifiedSignupUids = new Set<string>();

function recordInMemorySignup(
  bucketMap: Map<string, Array<{ uid: string; ts: number }>>,
  key: string,
  uid: string,
  nowMs: number,
): number {
  const cutoff = nowMs - TWENTY_FOUR_HOURS_MS;
  const existing = (bucketMap.get(key) || []).filter((e) => e.ts >= cutoff);
  if (!existing.some((e) => e.uid === uid)) {
    existing.push({ uid, ts: nowMs });
  }
  bucketMap.set(key, existing);
  return existing.length;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const firebaseConfigRaw = fs.readFileSync(
  path.join(__dirname, 'firebase-applet-config.json'),
  'utf8',
);
const firebaseConfig = JSON.parse(firebaseConfigRaw) as RuntimeFirebaseConfig;

const adminApp = getApps().length
  ? getApp()
  : initializeApp({ projectId: firebaseConfig.projectId });
const adminAuth = getAuth(adminApp);

interface AuthenticatedUser {
  uid: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

interface FirebaseAuthLookupUser {
  localId: string;
  email: string;
  emailVerified: boolean;
  createdAtMs: number;
  providers: string[];
}

async function lookupFirebaseAuthAccount(idToken: string): Promise<FirebaseAuthLookupUser | null> {
  const apiKey = (firebaseConfig.apiKey || '').trim();
  if (!apiKey || !idToken) return null;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      users?: Array<{
        localId?: string;
        email?: string;
        emailVerified?: boolean;
        createdAt?: string;
        providerUserInfo?: Array<{ providerId?: string }>;
      }>;
    };
    const u = Array.isArray(json.users) ? json.users[0] : undefined;
    if (!u || !u.localId) return null;
    const createdAtMs = Number(u.createdAt || 0);
    const providers = Array.isArray(u.providerUserInfo)
      ? u.providerUserInfo
          .map((p) => (typeof p.providerId === 'string' ? p.providerId : ''))
          .filter(Boolean)
      : [];
    return {
      localId: u.localId,
      email: typeof u.email === 'string' ? u.email : '',
      emailVerified: Boolean(u.emailVerified),
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
      providers,
    };
  } catch {
    return null;
  }
}

async function signUpFirebaseEmailPassword(
  email: string,
  password: string,
): Promise<
  | { ok: true; uid: string; idToken: string; email: string }
  | { ok: false; status: number; code: string; error: string }
> {
  const apiKey = (firebaseConfig.apiKey || '').trim();
  if (!apiKey) {
    return {
      ok: false,
      status: 500,
      code: 'CONFIG_ERROR',
      error: 'Firebase authentication is not configured.',
    };
  }

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      localId?: string;
      idToken?: string;
      email?: string;
      error?: { message?: string };
    };

    if (!res.ok || !json.localId || !json.idToken) {
      const code = String(json.error?.message || 'SIGNUP_FAILED');
      if (code === 'EMAIL_EXISTS') {
        return {
          ok: false,
          status: 409,
          code,
          error: 'An account with this email already exists. Try signing in instead.',
        };
      }
      if (code === 'INVALID_EMAIL') {
        return { ok: false, status: 400, code, error: 'Please enter a valid email address.' };
      }
      if (code.startsWith('WEAK_PASSWORD')) {
        return {
          ok: false,
          status: 400,
          code: 'WEAK_PASSWORD',
          error: 'Please choose a password with at least 6 characters.',
        };
      }
      if (code === 'OPERATION_NOT_ALLOWED' || code === 'ADMIN_ONLY_OPERATION') {
        return {
          ok: false,
          status: 400,
          code,
          error:
            'Email sign-in is not turned on in Firebase yet. Enable Email/Password in Firebase Authentication or continue with Google.',
        };
      }
      if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
        return {
          ok: false,
          status: 429,
          code,
          error: 'Too many attempts. Please wait a minute and try again.',
        };
      }
      return {
        ok: false,
        status: 400,
        code,
        error: 'Could not create your account. Please try again.',
      };
    }

    return {
      ok: true,
      uid: json.localId,
      idToken: json.idToken,
      email: json.email || email,
    };
  } catch {
    return {
      ok: false,
      status: 500,
      code: 'UPSTREAM_ERROR',
      error: 'Could not reach authentication service. Please try again.',
    };
  }
}

async function sendVerificationEmailRest(idToken: string): Promise<boolean> {
  const apiKey = (firebaseConfig.apiKey || '').trim();
  if (!apiKey || !idToken) return false;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteFirebaseAuthAccount(idToken: string): Promise<boolean> {
  const apiKey = (firebaseConfig.apiKey || '').trim();
  if (!apiKey || !idToken) return false;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

function isFirestoreAlreadyExistsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  return msg.includes('ALREADY_EXISTS') || msg.includes('(409)');
}

async function verifyServerSignupGate(
  idToken: string,
  authUser: AuthenticatedUser,
  preloaded?: {
    userPubExists?: boolean;
    donorPubExists?: boolean;
    roleExists?: boolean;
    hospitalExists?: boolean;
    modData?: Record<string, unknown> | null;
    lookup?: FirebaseAuthLookupUser | null;
  },
): Promise<boolean> {
  if (authUser.emailVerified && authUser.email.trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL) {
    inMemoryVerifiedSignupUids.add(authUser.uid);
    return true;
  }
  if (inMemoryVerifiedSignupUids.has(authUser.uid)) {
    return true;
  }

  let userPubExists = preloaded?.userPubExists;
  let donorPubExists = preloaded?.donorPubExists;
  let roleExists = preloaded?.roleExists;
  let hospitalExists = preloaded?.hospitalExists;
  let modData = preloaded?.modData;

  if (
    userPubExists === undefined ||
    donorPubExists === undefined ||
    roleExists === undefined ||
    hospitalExists === undefined ||
    modData === undefined
  ) {
    const [uDoc, dDoc, rDoc, hDoc, mDoc] = await Promise.all([
      userPubExists === undefined
        ? getFirestoreDoc(firebaseConfig, idToken, 'users_public', authUser.uid)
        : Promise.resolve({ exists: userPubExists, data: null }),
      donorPubExists === undefined
        ? getFirestoreDoc(firebaseConfig, idToken, 'donors_public', authUser.uid)
        : Promise.resolve({ exists: donorPubExists, data: null }),
      roleExists === undefined
        ? getFirestoreDoc(firebaseConfig, idToken, 'user_roles', authUser.uid)
        : Promise.resolve({ exists: roleExists, data: null }),
      hospitalExists === undefined
        ? getFirestoreDoc(firebaseConfig, idToken, 'hospitals', authUser.uid)
        : Promise.resolve({ exists: hospitalExists, data: null }),
      modData === undefined
        ? getFirestoreDoc(firebaseConfig, idToken, 'account_moderation', authUser.uid)
        : Promise.resolve({ exists: Boolean(modData), data: modData }),
    ]);
    userPubExists = uDoc.exists;
    donorPubExists = dDoc.exists;
    roleExists = rDoc.exists;
    hospitalExists = hDoc.exists;
    modData = mDoc.data;
  }

  if (userPubExists || donorPubExists || roleExists || hospitalExists) {
    inMemoryVerifiedSignupUids.add(authUser.uid);
    return true;
  }

  if (modData && typeof modData.signupSig === 'string' && /^[a-f0-9]{64}$/.test(modData.signupSig)) {
    const devId = typeof modData.lastDeviceId === 'string' ? modData.lastDeviceId : '';
    if (/^[a-zA-Z0-9_\-]{12,64}$/.test(devId)) {
      const devHash = computeDeviceLockHash(devId);
      const expectedSig = computeKeyedHash('signup_sig', `${authUser.uid}:${devHash}`);
      if (modData.signupSig === expectedSig) {
        inMemoryVerifiedSignupUids.add(authUser.uid);
        return true;
      }
    }
    if (!process.env.IP_HASH_SECRET) {
      const modCreatedMs = Date.parse(String(modData.createdAt || ''));
      if (Number.isFinite(modCreatedMs) && modCreatedMs < SERVER_BOOT_MS) {
        inMemoryVerifiedSignupUids.add(authUser.uid);
        return true;
      }
    }
  }

  const lookup =
    preloaded?.lookup !== undefined
      ? preloaded.lookup
      : await lookupFirebaseAuthAccount(idToken);
  if (lookup && lookup.createdAtMs > 0 && lookup.createdAtMs < ANTI_FRAUD_ENFORCEMENT_START_MS) {
    inMemoryVerifiedSignupUids.add(authUser.uid);
    return true;
  }

  return false;
}

interface AuthenticatedRequest extends Request {
  authUser?: AuthenticatedUser;
  idToken?: string;
}

async function authenticateBearer(
  req: AuthenticatedRequest,
  res: Response,
): Promise<boolean> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return false;
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token.' });
    return false;
  }
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    req.authUser = {
      uid: decoded.uid,
      email: typeof decoded.email === 'string' ? decoded.email : '',
      name: typeof decoded.name === 'string' ? decoded.name : '',
      emailVerified: Boolean(decoded.email_verified),
    };
    req.idToken = token;
    return true;
  } catch {
    res.status(401).json({ error: 'Invalid or expired authentication token.' });
    return false;
  }
}

async function requireSignedIn(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ok = await authenticateBearer(req, res);
  if (ok) next();
}

async function requireVerifiedAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ok = await authenticateBearer(req, res);
  if (!ok) return;
  if (!req.authUser?.emailVerified) {
    res.status(403).json({
      error: 'Please verify your email address using the link sent to your inbox before doing this.',
    });
    return;
  }
  try {
    const passedGate = await verifyServerSignupGate(req.idToken!, req.authUser);
    if (!passedGate) {
      res.status(403).json({
        code: 'DIRECT_SIGNUP_BLOCKED',
        directSignupBlocked: true,
        error:
          'Direct account creation bypassing server verification is not allowed. Please create your account through PulseLine.',
      });
      return;
    }
    next();
  } catch {
    res.status(500).json({ error: 'Could not verify account registration status right now.' });
  }
}

async function resolveUserRoleState(
  idToken: string,
  authUser: AuthenticatedUser,
): Promise<{
  role: UserRole;
  hasRoleDoc: boolean;
  isBootstrapAdmin: boolean;
  roleDocData: Record<string, unknown> | null;
}> {
  const isBootstrap =
    authUser.emailVerified && authUser.email.trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
  const roleDoc = await getFirestoreDoc(firebaseConfig, idToken, 'user_roles', authUser.uid);
  const storedRole = isValidUserRole(roleDoc.data?.role) ? roleDoc.data.role : null;

  if (isBootstrap) {
    return {
      role: 'admin',
      hasRoleDoc: roleDoc.exists,
      isBootstrapAdmin: true,
      roleDocData: roleDoc.data,
    };
  }
  if (storedRole) {
    return {
      role: storedRole,
      hasRoleDoc: true,
      isBootstrapAdmin: false,
      roleDocData: roleDoc.data,
    };
  }
  return {
    role: 'donor',
    hasRoleDoc: false,
    isBootstrapAdmin: false,
    roleDocData: null,
  };
}

async function requireAdminAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ok = await authenticateBearer(req, res);
  if (!ok) return;
  if (!req.authUser?.emailVerified) {
    res.status(403).json({ error: 'Verified email account is required.' });
    return;
  }
  try {
    const roleState = await resolveUserRoleState(req.idToken!, req.authUser);
    if (roleState.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required.' });
      return;
    }
    next();
  } catch {
    res.status(500).json({ error: 'Could not verify admin permissions right now.' });
  }
}

async function resolveAccountModerationState(
  idToken: string,
  authUser: AuthenticatedUser,
): Promise<{
  status: AccountModerationStatus;
  flagReasons: string[];
  reviewNote: string;
  docExists: boolean;
  docData: Record<string, unknown> | null;
}> {
  const isBootstrap =
    authUser.emailVerified && authUser.email.trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
  const modDoc = await getFirestoreDoc(firebaseConfig, idToken, 'account_moderation', authUser.uid);
  if (isBootstrap) {
    return {
      status: 'active',
      flagReasons: [],
      reviewNote: '',
      docExists: modDoc.exists,
      docData: modDoc.data,
    };
  }
  if (!modDoc.exists || !modDoc.data) {
    return {
      status: 'active',
      flagReasons: [],
      reviewNote: '',
      docExists: false,
      docData: null,
    };
  }
  const normalized = normalizeAccountModeration(modDoc.data, authUser.uid);
  return {
    status: normalized.status,
    flagReasons: normalized.flagReasons,
    reviewNote: normalized.reviewNote,
    docExists: true,
    docData: modDoc.data,
  };
}

function getBlockedAccountError(status: AccountModerationStatus): string {
  if (status === 'suspended') {
    return 'Your account is suspended. An admin can review and restore it.';
  }
  return 'Your account is paused for admin review due to multiple signups from one device in 24 hours.';
}

// --- Nominatim global 1 req/sec rate limiter + cache ---
interface ReverseGeoPayload {
  countryCode: string;
  countryName: string;
  stateName: string;
  city: string;
  locality: string;
  pincode: string;
  displayName: string;
}

const reverseGeoCache = new Map<string, { expiresAt: number; data: ReverseGeoPayload }>();
let lastNominatimCallMs = 0;
let nominatimQueueTail: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNominatimRateLimited(lat: number, lng: number): Promise<ReverseGeoPayload> {
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = reverseGeoCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.data);
  }

  const job = nominatimQueueTail.then(async () => {
    const cachedAgain = reverseGeoCache.get(cacheKey);
    if (cachedAgain && cachedAgain.expiresAt > Date.now()) {
      return cachedAgain.data;
    }

    const elapsed = Date.now() - lastNominatimCallMs;
    if (elapsed < 1050) {
      await sleep(1050 - elapsed);
    }
    lastNominatimCallMs = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
        String(lat),
      )}&lon=${encodeURIComponent(String(lng))}&addressdetails=1`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'PulseLineBloodDonorApp/1.0 (https://pulseline.local)',
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Nominatim HTTP ${response.status}`);
      }
      const json = (await response.json()) as {
        display_name?: string;
        address?: Record<string, string | undefined>;
      };
      const addr = json.address || {};
      const countryCode = (addr.country_code || '').toUpperCase();
      const countryName = addr.country || '';
      const stateName = addr.state || addr.region || addr.province || '';
      const city =
        addr.city ||
        addr.town ||
        addr.municipality ||
        addr.village ||
        addr.state_district ||
        addr.county ||
        '';
      const locality =
        addr.suburb ||
        addr.neighbourhood ||
        addr.quarter ||
        addr.residential ||
        addr.road ||
        '';
      const pincode = addr.postcode || '';

      const payload: ReverseGeoPayload = {
        countryCode,
        countryName,
        stateName,
        city,
        locality,
        pincode,
        displayName: json.display_name || '',
      };

      reverseGeoCache.set(cacheKey, {
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        data: payload,
      });
      return payload;
    } finally {
      clearTimeout(timer);
    }
  });

  nominatimQueueTail = job.catch(() => undefined);
  return job;
}

// --- India Post PIN code cache ---
interface PinLookupPayload {
  pincode: string;
  localities: string[];
  district: string;
  state: string;
}
const pincodeCache = new Map<string, { expiresAt: number; data: PinLookupPayload }>();

function parseCoord(val: unknown, min: number, max: number): number | null {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  if (!Number.isFinite(num) || num < min || num > max) return null;
  return num;
}

function cleanStr(val: unknown, maxLen: number): string {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

function isValidBloodGroup(val: unknown): val is BloodGroup {
  return typeof val === 'string' && (BLOOD_GROUPS as readonly string[]).includes(val);
}

function toTimestampField(raw: unknown): FirestoreTimestamp | null {
  if (typeof raw === 'string' && raw.length > 0 && !Number.isNaN(Date.parse(raw))) {
    return new FirestoreTimestamp(raw);
  }
  return null;
}

function hasLegacyPublicFields(data: Record<string, unknown> | null): boolean {
  if (!data) return false;
  return (
    'displayName' in data ||
    'preferredContactType' in data ||
    'preferredContactValue' in data ||
    !('username' in data) ||
    !('contactPreference' in data)
  );
}

function buildMigratedLegacyPrivateFields(
  uid: string,
  authUser: AuthenticatedUser,
  existingPublicData: Record<string, unknown> | null,
  existingPrivateData: Record<string, unknown> | null,
): Record<string, unknown> {
  const priv = existingPrivateData ? normalizeDonorPrivate(existingPrivateData, uid) : null;
  const pubLegacyName = cleanStr(existingPublicData?.displayName, 100);
  const pubLegacyPrefType = existingPublicData?.preferredContactType;
  const pubLegacyPrefVal = cleanStr(existingPublicData?.preferredContactValue, 150);

  const fullName =
    (priv?.fullName && priv.fullName.trim()) ||
    pubLegacyName ||
    cleanStr(authUser.name, 100) ||
    'Donor';

  let phone = priv?.phone || '';
  if (!phone && pubLegacyPrefType === 'phone' && pubLegacyPrefVal) {
    phone = pubLegacyPrefVal.slice(0, 30);
  }

  let email = priv?.email || '';
  if (!email && pubLegacyPrefType === 'email' && pubLegacyPrefVal) {
    email = pubLegacyPrefVal;
  }
  if (!email) {
    email = cleanStr(authUser.email, 150);
  }

  const privFields: Record<string, unknown> = {
    uid,
    fullName,
    phone,
    email,
    contactPreference: 'chat',
    lastDonationDate: priv?.lastDonationDate || '',
    exactLat: priv?.exactLat ?? null,
    exactLng: priv?.exactLng ?? null,
  };
  if (typeof existingPrivateData?.lastCompletedRequestId === 'string' && existingPrivateData.lastCompletedRequestId) {
    privFields.lastCompletedRequestId = existingPrivateData.lastCompletedRequestId;
  }
  return privFields;
}

function buildCleanPublicFromExisting(
  uid: string,
  username: string,
  existingPublicData: Record<string, unknown>,
): { fields: Record<string, unknown>; serverTimestampFields: string[] } {
  const normalized = normalizeDonorPublic(existingPublicData, uid);
  const createdAtTs = toTimestampField(existingPublicData.createdAt);
  const fields: Record<string, unknown> = {
    uid,
    username,
    bloodGroup: normalized.bloodGroup,
    countryCode: normalized.countryCode,
    countryName: normalized.countryName,
    stateCode: normalized.stateCode,
    stateName: normalized.stateName,
    city: normalized.city,
    locality: normalized.locality,
    pincode: normalized.pincode,
    visibleInSearch: normalized.visibleInSearch,
    eligibleAfterMs: normalized.eligibleAfterMs,
    searchActiveAfterMs: normalized.visibleInSearch
      ? normalized.eligibleAfterMs
      : HIDDEN_SEARCH_SENTINEL_MS,
    contactPreference: normalized.visibleInSearch ? 'chat' : 'hidden',
    approxLat: normalized.approxLat,
    approxLng: normalized.approxLng,
  };
  if (typeof existingPublicData.lastCompletedRequestId === 'string' && existingPublicData.lastCompletedRequestId) {
    fields.lastCompletedRequestId = existingPublicData.lastCompletedRequestId;
  }

  if (createdAtTs) {
    fields.createdAt = createdAtTs;
    return { fields, serverTimestampFields: ['updatedAt'] };
  }
  return { fields, serverTimestampFields: ['createdAt', 'updatedAt'] };
}

async function syncChatUsernamesBestEffort(
  idToken: string,
  uid: string,
  newUsername: string,
): Promise<void> {
  try {
    const chats = await queryFirestoreCollection(
      firebaseConfig,
      idToken,
      'chats',
      { fieldPath: 'participantIds', op: 'ARRAY_CONTAINS', value: uid },
      100,
    );
    const ops: CommitWriteOp[] = [];
    for (const chat of chats) {
      if (chat.data.p1Uid === uid && chat.data.p1Username !== newUsername) {
        ops.push({
          collection: 'chats',
          docId: chat.id,
          fields: { p1Username: newUsername },
          isCreate: false,
          updateMaskFields: ['p1Username'],
          serverTimestampFields: ['updatedAt'],
        });
      } else if (chat.data.p2Uid === uid && chat.data.p2Username !== newUsername) {
        ops.push({
          collection: 'chats',
          docId: chat.id,
          fields: { p2Username: newUsername },
          isCreate: false,
          updateMaskFields: ['p2Username'],
          serverTimestampFields: ['updatedAt'],
        });
      }
    }
    if (ops.length > 0) {
      await commitFirestoreWrites(firebaseConfig, idToken, ops);
    }
  } catch (err) {
    console.warn('Non-fatal chat username sync skipped:', err);
  }
}

async function updatePublicStatsDelta(
  idToken: string,
  deltas: { donorsDelta: number; activeDelta: number; fulfilledDelta: number },
): Promise<void> {
  try {
    const existing = await getFirestoreDoc(firebaseConfig, idToken, 'public_stats', 'summary');
    if (!existing.exists || !existing.data) {
      await commitFirestoreWrites(firebaseConfig, idToken, [
        {
          collection: 'public_stats',
          docId: 'summary',
          fields: {
            registeredDonors: Math.max(0, Math.min(1, deltas.donorsDelta)),
            activeRequests: Math.max(0, Math.min(1, deltas.activeDelta)),
            fulfilledRequests: Math.max(0, Math.min(1, deltas.fulfilledDelta)),
          },
          isCreate: true,
          serverTimestampFields: ['updatedAt'],
        },
      ]);
      return;
    }

    const curDonors = Number(existing.data.registeredDonors);
    const curActive = Number(existing.data.activeRequests);
    const curFulfilled = Number(existing.data.fulfilledRequests);

    const safeDonors = Number.isInteger(curDonors) && curDonors >= 0 ? curDonors : 0;
    const safeActive = Number.isInteger(curActive) && curActive >= 0 ? curActive : 0;
    const safeFulfilled = Number.isInteger(curFulfilled) && curFulfilled >= 0 ? curFulfilled : 0;

    await commitFirestoreWrites(firebaseConfig, idToken, [
      {
        collection: 'public_stats',
        docId: 'summary',
        fields: {
          registeredDonors: Math.max(0, safeDonors + deltas.donorsDelta),
          activeRequests: Math.max(0, safeActive + deltas.activeDelta),
          fulfilledRequests: Math.max(0, safeFulfilled + deltas.fulfilledDelta),
        },
        isCreate: false,
        updateMaskFields: ['registeredDonors', 'activeRequests', 'fulfilledRequests'],
        serverTimestampFields: ['updatedAt'],
      },
    ]);
  } catch (err) {
    console.warn('Non-fatal public_stats update skipped:', err);
  }
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, serverTimeMs: Date.now() });
  });

  // Public aggregate stats endpoint (zero PII, reads only /public_stats/summary)
  app.get('/api/stats', async (_req, res) => {
    try {
      const summary = await getPublicFirestoreDoc(firebaseConfig, 'public_stats', 'summary');
      if (!summary.exists || !summary.data) {
        res.json({ available: false });
        return;
      }

      const registeredDonors = Number(summary.data.registeredDonors);
      const activeRequests = Number(summary.data.activeRequests);
      const fulfilledRequests = Number(summary.data.fulfilledRequests);

      if (
        !Number.isInteger(registeredDonors) ||
        registeredDonors < 0 ||
        !Number.isInteger(activeRequests) ||
        activeRequests < 0 ||
        !Number.isInteger(fulfilledRequests) ||
        fulfilledRequests < 0
      ) {
        res.json({ available: false });
        return;
      }

      res.json({
        available: true,
        registeredDonors,
        activeRequests,
        fulfilledRequests,
      });
    } catch {
      res.json({ available: false });
    }
  });

  async function completeServerSignupWrites(params: {
    idToken: string;
    uid: string;
    email: string;
    username: string;
    deviceId: string;
    provider: 'password' | 'google' | 'other';
    rawServerIp: string;
    isBootstrap: boolean;
  }): Promise<
    | { ok: true; ipFlagged: boolean; ipCount24h: number; moderationStatus: AccountModerationStatus }
    | { ok: false; code: 'DEVICE_ALREADY_REGISTERED' }
  > {
    const { idToken, uid, email, username, deviceId, provider, rawServerIp, isBootstrap } = params;
    const ipHash = computeKeyedHash('ip', rawServerIp);
    const deviceHash = computeDeviceLockHash(deviceId);
    const ipWindowHash = computeKeyedHash('ipwin', ipHash).slice(0, 48);
    const uidHash = computeKeyedHash('uid', uid).slice(0, 24);
    const signupSig = computeKeyedHash('signup_sig', `${uid}:${deviceHash}`);
    const serverNow = Date.now();
    const expiresAtIso = new Date(serverNow + THIRTY_DAYS_MS).toISOString();

    const cachedUid = inMemoryRegisteredDevices.get(deviceHash);
    if (cachedUid && cachedUid !== uid) {
      return { ok: false, code: 'DEVICE_ALREADY_REGISTERED' };
    }

    const [ipWinDoc, modDoc] = await Promise.all([
      getFirestoreDoc(firebaseConfig, idToken, 'ip_signup_windows', ipWindowHash),
      getFirestoreDoc(firebaseConfig, idToken, 'account_moderation', uid),
    ]);

    const memIpCount = recordInMemorySignup(inMemoryIpSignups24h, ipWindowHash, uid, serverNow);
    let nextIpWin: { windowStartMs: number; uidHashes: string[]; count24h: number };
    if (!ipWinDoc.exists || !ipWinDoc.data) {
      nextIpWin = { windowStartMs: serverNow, uidHashes: [uidHash], count24h: 1 };
    } else {
      const prevStart = Number(ipWinDoc.data.windowStartMs);
      if (!Number.isFinite(prevStart) || serverNow - prevStart > TWENTY_FOUR_HOURS_MS) {
        nextIpWin = { windowStartMs: serverNow, uidHashes: [uidHash], count24h: 1 };
      } else {
        const prevHashes = Array.isArray(ipWinDoc.data.uidHashes)
          ? ipWinDoc.data.uidHashes.filter((h): h is string => typeof h === 'string' && h.length > 0)
          : [];
        const nextHashes = prevHashes.includes(uidHash)
          ? prevHashes.slice(-20)
          : [...prevHashes, uidHash].slice(-20);
        const prevCount = Number(ipWinDoc.data.count24h);
        const baseCount = Number.isInteger(prevCount) && prevCount >= 1 ? prevCount : prevHashes.length;
        const nextCount = prevHashes.includes(uidHash) ? baseCount : baseCount + 1;
        nextIpWin = {
          windowStartMs: prevStart,
          uidHashes: nextHashes,
          count24h: Math.max(nextCount, nextHashes.length),
        };
      }
    }

    const ipCount24h = Math.max(nextIpWin.count24h, memIpCount);
    const ipFlagged = !isBootstrap && ipCount24h > MAX_NEW_ACCOUNTS_PER_IP_24H;
    const logFlagReasons = ipFlagged ? ['ip_shared_24h'] : [];

    const existingMod =
      modDoc.exists && modDoc.data ? normalizeAccountModeration(modDoc.data, uid) : null;
    const mergedReasons = Array.from(
      new Set([...(existingMod?.flagReasons || []), ...logFlagReasons]),
    ).slice(0, 20);

    const ops: CommitWriteOp[] = [
      {
        collection: 'device_registrations',
        docId: deviceHash,
        fields: {
          deviceHash,
          deviceId,
          registeredUid: uid,
          registeredUsername: username,
          registeredEmail: email,
          ipHash,
          expiresAt: new FirestoreTimestamp(expiresAtIso),
        },
        isCreate: true,
        serverTimestampFields: ['createdAt'],
      },
      {
        collection: 'account_signups',
        docId: uid,
        fields: {
          uid,
          deviceHash,
          deviceId,
          ipHash,
          provider,
          consentAccepted: true,
          serverSig: signupSig,
          expiresAt: new FirestoreTimestamp(expiresAtIso),
        },
        isCreate: true,
        serverTimestampFields: ['createdAt'],
      },
      {
        collection: 'ip_signup_windows',
        docId: ipWindowHash,
        fields: {
          windowStartMs: nextIpWin.windowStartMs,
          uidHashes: nextIpWin.uidHashes,
          count24h: nextIpWin.count24h,
          expiresAt: new FirestoreTimestamp(expiresAtIso),
        },
        isCreate: !ipWinDoc.exists,
        serverTimestampFields: ['updatedAt'],
      },
      {
        collection: 'auth_logs',
        docId: generateFirestoreId('alog'),
        fields: {
          uid,
          username,
          email,
          eventType: 'signup',
          ipHash,
          deviceId,
          consentAccepted: true,
          deviceFlagged: false,
          ipFlagged,
          flagged: ipFlagged,
          flagReasons: logFlagReasons,
          expiresAt: new FirestoreTimestamp(expiresAtIso),
        },
        isCreate: true,
        serverTimestampFields: ['createdAt'],
      },
    ];

    if (!modDoc.exists) {
      ops.push({
        collection: 'account_moderation',
        docId: uid,
        fields: {
          uid,
          username,
          email,
          status: 'active',
          requiresAdminReview: ipFlagged,
          deviceFlagged: false,
          ipFlagged,
          reportedFlagged: false,
          flagReasons: mergedReasons,
          deviceSignupCount24h: 1,
          ipSignupCount24h: ipCount24h,
          lastDeviceId: deviceId,
          lastIpHash: ipHash,
          reviewNote: '',
          reviewedBy: '',
          reviewedAt: null,
          signupSig,
          ...(ipFlagged ? {} : { flaggedAt: null }),
        },
        isCreate: true,
        serverTimestampFields: ipFlagged
          ? ['flaggedAt', 'createdAt', 'updatedAt']
          : ['createdAt', 'updatedAt'],
      });
    }

    try {
      await commitFirestoreWrites(firebaseConfig, idToken, ops);
    } catch (err) {
      if (isFirestoreAlreadyExistsError(err)) {
        inMemoryRegisteredDevices.set(deviceHash, 'locked');
        return { ok: false, code: 'DEVICE_ALREADY_REGISTERED' };
      }
      throw err;
    }

    inMemoryRegisteredDevices.set(deviceHash, uid);
    inMemoryVerifiedSignupUids.add(uid);
    return {
      ok: true,
      ipFlagged,
      ipCount24h,
      moderationStatus: existingMod?.status || 'active',
    };
  }

  // Precheck whether this browser device ID has already registered an account (called before opening OAuth signup)
  app.post('/api/auth/signup-precheck', (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const deviceId = cleanStr(body.deviceId, 64);
    const consentAccepted = Boolean(body.consentAccepted);

    if (!/^[a-zA-Z0-9_\-]{12,64}$/.test(deviceId)) {
      res.status(400).json({ ok: false, error: 'Invalid device identifier.' });
      return;
    }
    if (!consentAccepted) {
      res.status(400).json({
        ok: false,
        error: 'Please read the privacy notice and tick the consent box before creating an account.',
      });
      return;
    }

    const deviceHash = computeDeviceLockHash(deviceId);
    if (inMemoryRegisteredDevices.has(deviceHash)) {
      res.status(403).json({
        ok: false,
        code: 'DEVICE_ALREADY_REGISTERED',
        error:
          'Only one new account can be created on this device. Existing users can still sign in, or an admin can reset this device.',
      });
      return;
    }

    res.json({ ok: true });
  });

  // Server-gated email/password signup (blocks direct client signup & enforces 1 account per device ID)
  app.post('/api/auth/signup', async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const email = cleanStr(body.email, 150);
    const password = typeof body.password === 'string' ? body.password : '';
    const deviceId = cleanStr(body.deviceId, 64);
    const consentAccepted = Boolean(body.consentAccepted);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (password.length < 6 || password.length > 128) {
      res.status(400).json({ error: 'Password must be between 6 and 128 characters.' });
      return;
    }
    if (!/^[a-zA-Z0-9_\-]{12,64}$/.test(deviceId)) {
      res.status(400).json({ error: 'Invalid device identifier.' });
      return;
    }
    if (!consentAccepted) {
      res.status(400).json({
        error: 'Please read the privacy notice and tick the consent box before creating an account.',
      });
      return;
    }

    const deviceHash = computeDeviceLockHash(deviceId);
    if (inMemoryRegisteredDevices.has(deviceHash)) {
      res.status(403).json({
        code: 'DEVICE_ALREADY_REGISTERED',
        error:
          'Only one new account can be created on this device. Existing users can still sign in, or an admin can reset this device.',
      });
      return;
    }

    const created = await signUpFirebaseEmailPassword(email, password);
    if (created.ok === false) {
      res.status(created.status).json({ code: created.code, error: created.error });
      return;
    }

    const rawServerIp = getServerClientIp(req);
    const isBootstrap = created.email.trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;

    try {
      const writeResult = await completeServerSignupWrites({
        idToken: created.idToken,
        uid: created.uid,
        email: cleanStr(created.email, 150),
        username: '',
        deviceId,
        provider: 'password',
        rawServerIp,
        isBootstrap,
      });

      if (writeResult.ok === false) {
        await deleteFirebaseAuthAccount(created.idToken);
        res.status(403).json({
          code: 'DEVICE_ALREADY_REGISTERED',
          error:
            'Only one new account can be created on this device. Existing users can still sign in, or an admin can reset this device.',
        });
        return;
      }

      const verificationSent = await sendVerificationEmailRest(created.idToken);
      res.status(201).json({
        ok: true,
        uid: created.uid,
        email: created.email,
        emailVerified: false,
        verificationSent,
        ipFlagged: writeResult.ipFlagged,
        moderationStatus: writeResult.moderationStatus,
      });
    } catch (err) {
      await deleteFirebaseAuthAccount(created.idToken);
      console.error('Server-gated signup failed:', err);
      res.status(500).json({ error: 'Could not complete account registration right now.' });
    }
  });

  // Server-side Auth Audit Log & Google signup gate (keyed IP hash, random device ID, user ID, time, 30-day TTL)
  app.post('/api/auth/record', requireSignedIn, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const body = (req.body || {}) as Record<string, unknown>;

    const eventType = body.eventType === 'signup' ? 'signup' : body.eventType === 'login' ? 'login' : null;
    const deviceId = cleanStr(body.deviceId, 64);
    const consentAccepted = Boolean(body.consentAccepted);

    if (!eventType) {
      res.status(400).json({ error: 'Invalid auth event type.' });
      return;
    }
    if (!/^[a-zA-Z0-9_\-]{12,64}$/.test(deviceId)) {
      res.status(400).json({ error: 'Invalid device identifier.' });
      return;
    }
    if (eventType === 'signup' && !consentAccepted) {
      res.status(400).json({ error: 'Please accept the privacy notice before creating an account.' });
      return;
    }

    const rawServerIp = getServerClientIp(req);
    const ipHash = computeKeyedHash('ip', rawServerIp);
    const serverNow = Date.now();
    const expiresAtIso = new Date(serverNow + THIRTY_DAYS_MS).toISOString();
    const isBootstrap =
      req.authUser!.emailVerified && req.authUser!.email.trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;

    try {
      const [userPubDoc, donorPubDoc, roleDoc, hospitalDoc, modDoc, lookup] = await Promise.all([
        getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'donors_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'user_roles', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'account_moderation', uid),
        lookupFirebaseAuthAccount(idToken),
      ]);

      const username = cleanStr(String(userPubDoc.data?.username || ''), 24);
      const email = cleanStr(req.authUser!.email, 150);

      if (eventType === 'signup') {
        const alreadyRegistered =
          userPubDoc.exists ||
          donorPubDoc.exists ||
          roleDoc.exists ||
          hospitalDoc.exists ||
          Boolean(modDoc.data && typeof modDoc.data.signupSig === 'string' && modDoc.data.signupSig) ||
          Boolean(lookup && lookup.createdAtMs > 0 && lookup.createdAtMs < ANTI_FRAUD_ENFORCEMENT_START_MS);

        if (!alreadyRegistered) {
          const isGoogleUser = Boolean(lookup?.providers.includes('google.com'));
          if (!isGoogleUser) {
            if (lookup && lookup.createdAtMs >= ANTI_FRAUD_ENFORCEMENT_START_MS) {
              await deleteFirebaseAuthAccount(idToken);
            }
            res.status(403).json({
              code: 'DIRECT_SIGNUP_BLOCKED',
              directSignupBlocked: true,
              error: 'Direct email signup bypassing the server check is not allowed. Please sign up on PulseLine.',
            });
            return;
          }

          const writeResult = await completeServerSignupWrites({
            idToken,
            uid,
            email,
            username,
            deviceId,
            provider: 'google',
            rawServerIp,
            isBootstrap,
          });

          if (writeResult.ok === false) {
            await deleteFirebaseAuthAccount(idToken);
            res.status(403).json({
              code: 'DEVICE_ALREADY_REGISTERED',
              error:
                'Only one new account can be created on this device. Existing users can still sign in, or an admin can reset this device.',
            });
            return;
          }

          res.json({
            ok: true,
            moderationStatus: isBootstrap ? 'active' : writeResult.moderationStatus,
            deviceFlagged: false,
            ipFlagged: writeResult.ipFlagged,
          });
          return;
        }
      }

      const gatePassed = await verifyServerSignupGate(idToken, req.authUser!, {
        userPubExists: userPubDoc.exists,
        donorPubExists: donorPubDoc.exists,
        roleExists: roleDoc.exists,
        hospitalExists: hospitalDoc.exists,
        modData: modDoc.data,
        lookup,
      });

      if (!gatePassed) {
        res.status(403).json({
          code: 'DIRECT_SIGNUP_BLOCKED',
          directSignupBlocked: true,
          error:
            'Direct account creation bypassing server verification is not allowed. Please sign up through PulseLine.',
        });
        return;
      }

      const existingMod =
        modDoc.exists && modDoc.data ? normalizeAccountModeration(modDoc.data, uid) : null;

      const ops: CommitWriteOp[] = [
        {
          collection: 'auth_logs',
          docId: generateFirestoreId('alog'),
          fields: {
            uid,
            username,
            email,
            eventType: 'login',
            ipHash,
            deviceId,
            consentAccepted,
            deviceFlagged: Boolean(existingMod?.deviceFlagged),
            ipFlagged: Boolean(existingMod?.ipFlagged),
            flagged: Boolean(existingMod?.deviceFlagged || existingMod?.ipFlagged),
            flagReasons: existingMod?.flagReasons || [],
            expiresAt: new FirestoreTimestamp(expiresAtIso),
          },
          isCreate: true,
          serverTimestampFields: ['createdAt'],
        },
      ];

      if (existingMod && existingMod.status !== 'suspended' && !isBootstrap) {
        ops.push({
          collection: 'account_moderation',
          docId: uid,
          fields: {
            username: username || existingMod.username || '',
            email: email || existingMod.email || '',
            lastDeviceId: deviceId,
            lastIpHash: ipHash,
          },
          isCreate: false,
          updateMaskFields: ['username', 'email', 'lastDeviceId', 'lastIpHash'],
          serverTimestampFields: ['updatedAt'],
        });
      }

      await commitFirestoreWrites(firebaseConfig, idToken, ops);

      res.json({
        ok: true,
        moderationStatus: isBootstrap ? 'active' : existingMod?.status || 'active',
        deviceFlagged: Boolean(existingMod?.deviceFlagged),
        ipFlagged: Boolean(existingMod?.ipFlagged),
      });
    } catch (err) {
      console.error('Failed to record auth audit event:', err);
      res.status(500).json({ error: 'Could not record sign-in event right now.' });
    }
  });

  // Account bootstrap + automatic legacy donor PII migration + role & moderation resolution
  app.get('/api/account/me', requireSignedIn, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const emailVerified = req.authUser!.emailVerified;
    const idToken = req.idToken!;

    try {
      const [userPub, donorPub, roleDoc, hospitalDoc, moderation] = await Promise.all([
        getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'donors_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'user_roles', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid),
        resolveAccountModerationState(idToken, req.authUser!),
      ]);

      const passedGate = await verifyServerSignupGate(idToken, req.authUser!, {
        userPubExists: userPub.exists,
        donorPubExists: donorPub.exists,
        roleExists: roleDoc.exists,
        hospitalExists: hospitalDoc.exists,
        modData: moderation.docData,
      });

      if (!passedGate) {
        res.status(403).json({
          code: 'DIRECT_SIGNUP_BLOCKED',
          directSignupBlocked: true,
          error:
            'Direct account creation bypassing server verification is not allowed. Please sign up through PulseLine.',
        });
        return;
      }

      const rawUserPubName = normalizeUsernameInput(String(userPub.data?.username || ''));
      const rawDonorPubName = normalizeUsernameInput(String(donorPub.data?.username || ''));
      const currentUsername = isValidUsername(rawUserPubName)
        ? rawUserPubName
        : isValidUsername(rawDonorPubName)
          ? rawDonorPubName
          : null;

      const isBootstrapAdmin =
        emailVerified && req.authUser!.email.trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
      const storedRole = isValidUserRole(roleDoc.data?.role) ? roleDoc.data.role : null;
      const fallbackRole: UserRole = donorPub.exists ? 'donor' : 'requester';
      const effectiveRole: UserRole = isBootstrapAdmin ? 'admin' : storedRole || fallbackRole;
      const hospitalStatus =
        hospitalDoc.exists &&
        (hospitalDoc.data?.status === 'pending' ||
          hospitalDoc.data?.status === 'approved' ||
          hospitalDoc.data?.status === 'rejected')
          ? hospitalDoc.data.status
          : null;

      if (!emailVerified) {
        const suggestedSource =
          cleanStr(donorPub.data?.displayName, 50) ||
          req.authUser!.email ||
          req.authUser!.name ||
          'donor';

        res.json({
          uid,
          email: req.authUser!.email,
          emailVerified: false,
          username: currentUsername,
          needsUsername: false,
          suggestedUsername: sanitizeUsernameCandidate(suggestedSource),
          hasLegacyDonorProfile: Boolean(donorPub.exists),
          role: effectiveRole,
          isAdmin: false,
          hospitalStatus,
          moderationStatus: moderation.status,
          flagReasons: moderation.flagReasons,
          moderationNote: moderation.reviewNote,
        });
        return;
      }

      const donorPriv = await getFirestoreDoc(firebaseConfig, idToken, 'donors_private', uid);

      // Ensure verified users have a persisted user_roles doc (without overriding existing admin roles)
      if (!roleDoc.exists || (isBootstrapAdmin && storedRole !== 'admin')) {
        try {
          await commitFirestoreWrites(firebaseConfig, idToken, [
            {
              collection: 'user_roles',
              docId: uid,
              fields: {
                uid,
                email: cleanStr(req.authUser!.email, 150),
                username: currentUsername || '',
                role: effectiveRole,
                assignedBy: uid,
              },
              isCreate: !roleDoc.exists,
              updateMaskFields: roleDoc.exists ? ['role', 'email', 'username', 'assignedBy'] : undefined,
              serverTimestampFields: roleDoc.exists ? ['updatedAt'] : ['createdAt', 'updatedAt'],
            },
          ]);
        } catch (roleSyncErr) {
          console.warn('Non-fatal user_roles init skipped:', roleSyncErr);
        }
      }

      // If user already has a valid username and legacy public fields exist, scrub & migrate immediately
      if (
        moderation.status === 'active' &&
        currentUsername &&
        donorPub.exists &&
        donorPub.data &&
        (hasLegacyPublicFields(donorPub.data) || !donorPriv.data?.fullName)
      ) {
        const usernameClaim = await getFirestoreDoc(firebaseConfig, idToken, 'usernames', currentUsername);
        const ops: CommitWriteOp[] = [];

        if (!usernameClaim.exists) {
          ops.push({
            collection: 'usernames',
            docId: currentUsername,
            fields: { uid, username: currentUsername },
            isCreate: true,
            serverTimestampFields: ['createdAt', 'updatedAt'],
          });
        }

        if (!userPub.exists) {
          ops.push({
            collection: 'users_public',
            docId: uid,
            fields: { uid, username: currentUsername },
            isCreate: true,
            serverTimestampFields: ['createdAt', 'updatedAt'],
          });
        }

        const privFields = buildMigratedLegacyPrivateFields(uid, req.authUser!, donorPub.data, donorPriv.data);
        const privCreatedAtTs = toTimestampField(donorPriv.data?.createdAt);
        if (donorPriv.exists && privCreatedAtTs) {
          ops.push({
            collection: 'donors_private',
            docId: uid,
            fields: { ...privFields, createdAt: privCreatedAtTs },
            isCreate: false,
            serverTimestampFields: ['updatedAt'],
          });
        } else {
          ops.push({
            collection: 'donors_private',
            docId: uid,
            fields: privFields,
            isCreate: !donorPriv.exists,
            serverTimestampFields: donorPriv.exists ? ['updatedAt'] : ['createdAt', 'updatedAt'],
          });
        }

        const cleanPub = buildCleanPublicFromExisting(uid, currentUsername, donorPub.data);
        ops.push({
          collection: 'donors_public',
          docId: uid,
          fields: cleanPub.fields,
          isCreate: false,
          serverTimestampFields: cleanPub.serverTimestampFields,
        });

        await commitFirestoreWrites(firebaseConfig, idToken, ops);
      }

      const suggestedSource =
        cleanStr(donorPub.data?.displayName, 50) ||
        cleanStr(donorPriv.data?.fullName, 50) ||
        req.authUser!.email ||
        req.authUser!.name ||
        'donor';

      res.json({
        uid,
        email: req.authUser!.email,
        emailVerified: true,
        username: currentUsername,
        needsUsername: !currentUsername,
        suggestedUsername: sanitizeUsernameCandidate(suggestedSource),
        hasLegacyDonorProfile: Boolean(donorPub.exists),
        role: effectiveRole,
        isAdmin: effectiveRole === 'admin',
        hospitalStatus,
        moderationStatus: moderation.status,
        flagReasons: moderation.flagReasons,
        moderationNote: moderation.reviewNote,
      });
    } catch (err) {
      console.error('Failed to load account status:', err);
      res.status(500).json({ error: 'Could not load your account details right now.' });
    }
  });

  // Self-service role selection (donor, requester, hospital). Never allows assigning 'admin'.
  app.post('/api/account/role', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const body = (req.body || {}) as Record<string, unknown>;
    const requestedRole = body.role;

    if (requestedRole === 'admin') {
      res.status(403).json({ error: 'Only an admin can assign the admin role.' });
      return;
    }
    if (requestedRole !== 'donor' && requestedRole !== 'requester' && requestedRole !== 'hospital') {
      res.status(400).json({ error: 'Please choose donor, requester, or hospital/blood bank.' });
      return;
    }

    try {
      const [roleDoc, userPub] = await Promise.all([
        getFirestoreDoc(firebaseConfig, idToken, 'user_roles', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid),
      ]);

      const currentRole = isValidUserRole(roleDoc.data?.role) ? roleDoc.data.role : null;
      const isBootstrapAdmin =
        req.authUser!.email.trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
      if (currentRole === 'admin' || isBootstrapAdmin) {
        res.status(403).json({
          error: 'Admin accounts already have full access and can manage roles in the Admin panel.',
        });
        return;
      }

      const username = normalizeUsernameInput(String(userPub.data?.username || roleDoc.data?.username || ''));
      await commitFirestoreWrites(firebaseConfig, idToken, [
        {
          collection: 'user_roles',
          docId: uid,
          fields: {
            uid,
            email: cleanStr(req.authUser!.email, 150),
            username: isValidUsername(username) ? username : '',
            role: requestedRole,
            assignedBy: uid,
          },
          isCreate: !roleDoc.exists,
          updateMaskFields: roleDoc.exists ? ['role', 'email', 'username', 'assignedBy'] : undefined,
          serverTimestampFields: roleDoc.exists ? ['updatedAt'] : ['createdAt', 'updatedAt'],
        },
      ]);

      res.json({ ok: true, role: requestedRole });
    } catch (err) {
      console.error('Failed to update role:', err);
      res.status(500).json({ error: 'Could not update your account role right now.' });
    }
  });

  app.get('/api/account/username-available', requireSignedIn, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const username = normalizeUsernameInput(String(req.query.username || ''));

    if (!isValidUsername(username)) {
      res.status(400).json({
        available: false,
        error: 'Use 3 to 24 lowercase letters, numbers, or underscores.',
      });
      return;
    }

    try {
      const existing = await getFirestoreDoc(firebaseConfig, idToken, 'usernames', username);
      const available = !existing.exists || existing.data?.uid === uid;
      res.json({ available, username });
    } catch {
      res.status(500).json({ available: false, error: 'Could not check username right now.' });
    }
  });

  app.post('/api/account/username', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const body = (req.body || {}) as Record<string, unknown>;
    const username = normalizeUsernameInput(String(body.username || ''));

    if (!isValidUsername(username)) {
      res.status(400).json({
        error: 'Username must be 3 to 24 characters using lowercase letters, numbers, or underscores.',
      });
      return;
    }

    try {
      const [claimDoc, userPubDoc, donorPubDoc, donorPrivDoc] = await Promise.all([
        getFirestoreDoc(firebaseConfig, idToken, 'usernames', username),
        getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'donors_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'donors_private', uid),
      ]);

      if (claimDoc.exists && claimDoc.data?.uid !== uid) {
        res.status(409).json({ error: 'That username is already taken. Please pick another.' });
        return;
      }

      const oldUsername = normalizeUsernameInput(
        String(userPubDoc.data?.username || donorPubDoc.data?.username || ''),
      );

      const ops: CommitWriteOp[] = [];

      if (oldUsername && oldUsername !== username && isValidUsername(oldUsername)) {
        const oldClaim = await getFirestoreDoc(firebaseConfig, idToken, 'usernames', oldUsername);
        if (oldClaim.exists && oldClaim.data?.uid === uid) {
          ops.push({ opType: 'delete', collection: 'usernames', docId: oldUsername });
        }
      }

      if (!claimDoc.exists) {
        ops.push({
          collection: 'usernames',
          docId: username,
          fields: { uid, username },
          isCreate: true,
          serverTimestampFields: ['createdAt', 'updatedAt'],
        });
      }

      if (userPubDoc.exists) {
        ops.push({
          collection: 'users_public',
          docId: uid,
          fields: { username },
          isCreate: false,
          updateMaskFields: ['username'],
          serverTimestampFields: ['updatedAt'],
        });
      } else {
        ops.push({
          collection: 'users_public',
          docId: uid,
          fields: { uid, username },
          isCreate: true,
          serverTimestampFields: ['createdAt', 'updatedAt'],
        });
      }

      // Migrate any existing donor profile at the same time so real name/phone/email move to private and leave public
      if (donorPubDoc.exists && donorPubDoc.data) {
        const privFields = buildMigratedLegacyPrivateFields(
          uid,
          req.authUser!,
          donorPubDoc.data,
          donorPrivDoc.data,
        );
        const privCreatedAtTs = toTimestampField(donorPrivDoc.data?.createdAt);
        if (donorPrivDoc.exists && privCreatedAtTs) {
          ops.push({
            collection: 'donors_private',
            docId: uid,
            fields: { ...privFields, createdAt: privCreatedAtTs },
            isCreate: false,
            serverTimestampFields: ['updatedAt'],
          });
        } else {
          ops.push({
            collection: 'donors_private',
            docId: uid,
            fields: privFields,
            isCreate: !donorPrivDoc.exists,
            serverTimestampFields: donorPrivDoc.exists ? ['updatedAt'] : ['createdAt', 'updatedAt'],
          });
        }

        const cleanPub = buildCleanPublicFromExisting(uid, username, donorPubDoc.data);
        ops.push({
          collection: 'donors_public',
          docId: uid,
          fields: cleanPub.fields,
          isCreate: false,
          serverTimestampFields: cleanPub.serverTimestampFields,
        });
      }

      await commitFirestoreWrites(firebaseConfig, idToken, ops);
      await syncChatUsernamesBestEffort(idToken, uid, username);

      res.json({ ok: true, username });
    } catch (err) {
      console.error('Failed to set username:', err);
      res.status(500).json({ error: 'Could not save that username right now. Please try again.' });
    }
  });

  app.get('/api/geocode/reverse', async (req, res) => {
    const lat = parseCoord(req.query.lat, -90, 90);
    const lng = parseCoord(req.query.lng, -180, 180);
    if (lat === null || lng === null) {
      res.status(400).json({ error: 'Valid lat and lng query parameters are required.' });
      return;
    }
    try {
      const data = await runNominatimRateLimited(lat, lng);
      res.json(data);
    } catch {
      res.status(502).json({
        error: 'Reverse geocoding service unavailable. Please enter location manually.',
      });
    }
  });

  app.get('/api/pincode/:pincode', async (req, res) => {
    const pincode = String(req.params.pincode || '').trim();
    if (!/^\d{6}$/.test(pincode)) {
      res.status(400).json({ error: 'Indian PIN code must be 6 digits.' });
      return;
    }

    const cached = pincodeCache.get(pincode);
    if (cached && cached.expiresAt > Date.now()) {
      res.json(cached.data);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const upstream = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, {
        signal: controller.signal,
      });
      if (!upstream.ok) {
        res.status(502).json({ error: 'PIN code service unavailable. Enter locality manually.' });
        return;
      }
      const json = (await upstream.json()) as Array<{
        Status?: string;
        PostOffice?: Array<{ Name?: string; District?: string; State?: string }>;
      }>;
      const entry = Array.isArray(json) ? json[0] : null;
      if (!entry || entry.Status !== 'Success' || !Array.isArray(entry.PostOffice)) {
        res.status(404).json({ error: 'No post offices found for this PIN code.' });
        return;
      }

      const localities = Array.from(
        new Set(
          entry.PostOffice.map((po) => cleanStr(po.Name, 100)).filter((name) => name.length > 0),
        ),
      );
      const first = entry.PostOffice[0] || {};
      const payload: PinLookupPayload = {
        pincode,
        localities,
        district: cleanStr(first.District, 100),
        state: cleanStr(first.State, 100),
      };

      pincodeCache.set(pincode, {
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        data: payload,
      });
      res.json(payload);
    } catch {
      res.status(502).json({ error: 'Failed to look up PIN code. Enter locality manually.' });
    } finally {
      clearTimeout(timer);
    }
  });

  // Server-side Donor Profile Save: private PII (fullName, phone, email, exact coords) goes ONLY to donors_private;
  // donors_public stores ONLY username, blood group, approximate area, eligibility, and in-app chat preference.
  app.put('/api/donor/profile', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const body = (req.body || {}) as Record<string, unknown>;

    const username = normalizeUsernameInput(String(body.username || ''));
    const fullName = cleanStr(body.fullName, 100);
    const bloodGroup = body.bloodGroup;
    const countryCode = cleanStr(body.countryCode, 4).toUpperCase() || 'IN';
    const countryName = cleanStr(body.countryName, 100) || 'India';
    const stateCode = cleanStr(body.stateCode, 16);
    const stateName = cleanStr(body.stateName, 100);
    const city = cleanStr(body.city, 100);
    const locality = cleanStr(body.locality, 120);
    const pincode = cleanStr(body.pincode, 16);
    const phone = cleanStr(body.phone, 30);
    const email = cleanStr(body.email, 150) || req.authUser!.email;
    const lastDonationDate = cleanStr(body.lastDonationDate, 10);
    const visibleInSearch = Boolean(body.visibleInSearch);
    const exactLat = parseCoord(body.exactLat, -90, 90);
    const exactLng = parseCoord(body.exactLng, -180, 180);

    if (!isValidUsername(username)) {
      res.status(400).json({
        error: 'Username must be 3 to 24 characters using lowercase letters, numbers, or underscores.',
      });
      return;
    }
    if (fullName.length < 1) {
      res.status(400).json({ error: 'Your full name is required (stored privately).' });
      return;
    }
    if (!isValidBloodGroup(bloodGroup)) {
      res.status(400).json({ error: 'Please select a valid blood group.' });
      return;
    }
    if (city.length < 1) {
      res.status(400).json({ error: 'City is required.' });
      return;
    }
    if (countryCode === 'IN' && pincode && !/^\d{6}$/.test(pincode)) {
      res.status(400).json({ error: 'Indian PIN code must be 6 digits.' });
      return;
    }
    if (lastDonationDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDonationDate)) {
        res.status(400).json({ error: 'Last donation date must be in YYYY-MM-DD format.' });
        return;
      }
      if (isFutureDateStr(lastDonationDate)) {
        res.status(400).json({ error: 'Last donation date cannot be in the future.' });
        return;
      }
    }

    const eligibility = computeEligibility(lastDonationDate);
    const contactPreference = visibleInSearch ? 'chat' : 'hidden';
    const searchActiveAfterMs = visibleInSearch
      ? eligibility.eligibleAfterMs
      : HIDDEN_SEARCH_SENTINEL_MS;

    const { approxLat, approxLng } = computeApproxAreaCoords(uid, exactLat, exactLng);

    try {
      const [claimDoc, existingUserPub, existingPublic, existingPrivate, roleState, moderation] = await Promise.all([
        getFirestoreDoc(firebaseConfig, idToken, 'usernames', username),
        getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'donors_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'donors_private', uid),
        resolveUserRoleState(idToken, req.authUser!),
        resolveAccountModerationState(idToken, req.authUser!),
      ]);

      if (moderation.status !== 'active') {
        res.status(403).json({ error: getBlockedAccountError(moderation.status) });
        return;
      }

      if (roleState.hasRoleDoc && roleState.role !== 'donor' && roleState.role !== 'admin') {
        res.status(403).json({
          error: 'Only accounts with the Donor role can register or update a donor profile.',
        });
        return;
      }

      if (claimDoc.exists && claimDoc.data?.uid !== uid) {
        res.status(409).json({ error: 'That username is already taken. Please pick another.' });
        return;
      }

      const oldUsername = normalizeUsernameInput(
        String(existingUserPub.data?.username || existingPublic.data?.username || ''),
      );

      const ops: CommitWriteOp[] = [];

      if (oldUsername && oldUsername !== username && isValidUsername(oldUsername)) {
        const oldClaim = await getFirestoreDoc(firebaseConfig, idToken, 'usernames', oldUsername);
        if (oldClaim.exists && oldClaim.data?.uid === uid) {
          ops.push({ opType: 'delete', collection: 'usernames', docId: oldUsername });
        }
      }

      if (!claimDoc.exists) {
        ops.push({
          collection: 'usernames',
          docId: username,
          fields: { uid, username },
          isCreate: true,
          serverTimestampFields: ['createdAt', 'updatedAt'],
        });
      }

      if (existingUserPub.exists) {
        ops.push({
          collection: 'users_public',
          docId: uid,
          fields: { username },
          isCreate: false,
          updateMaskFields: ['username'],
          serverTimestampFields: ['updatedAt'],
        });
      } else {
        ops.push({
          collection: 'users_public',
          docId: uid,
          fields: { uid, username },
          isCreate: true,
          serverTimestampFields: ['createdAt', 'updatedAt'],
        });
      }

      const publicCreatedAtTs = toTimestampField(existingPublic.data?.createdAt);
      const publicFields: Record<string, unknown> = {
        uid,
        username,
        bloodGroup,
        countryCode,
        countryName,
        stateCode,
        stateName,
        city,
        locality,
        pincode,
        visibleInSearch,
        eligibleAfterMs: eligibility.eligibleAfterMs,
        searchActiveAfterMs,
        contactPreference,
        approxLat,
        approxLng,
      };
      if (existingPublic.exists && publicCreatedAtTs) {
        publicFields.createdAt = publicCreatedAtTs;
      }
      if (typeof existingPublic.data?.lastCompletedRequestId === 'string' && existingPublic.data.lastCompletedRequestId) {
        publicFields.lastCompletedRequestId = existingPublic.data.lastCompletedRequestId;
      }

      const privateCreatedAtTs = toTimestampField(existingPrivate.data?.createdAt);
      const privateFields: Record<string, unknown> = {
        uid,
        fullName,
        phone,
        email,
        contactPreference: 'chat',
        lastDonationDate,
        exactLat,
        exactLng,
      };
      if (existingPrivate.exists && privateCreatedAtTs) {
        privateFields.createdAt = privateCreatedAtTs;
      }
      if (typeof existingPrivate.data?.lastCompletedRequestId === 'string' && existingPrivate.data.lastCompletedRequestId) {
        privateFields.lastCompletedRequestId = existingPrivate.data.lastCompletedRequestId;
      }

      // Full document writes without updateMaskFields on donors_public guarantee any legacy PII fields are removed
      ops.push(
        {
          collection: 'donors_public',
          docId: uid,
          fields: publicFields,
          isCreate: !existingPublic.exists,
          serverTimestampFields:
            existingPublic.exists && publicCreatedAtTs ? ['updatedAt'] : ['createdAt', 'updatedAt'],
        },
        {
          collection: 'donors_private',
          docId: uid,
          fields: privateFields,
          isCreate: !existingPrivate.exists,
          serverTimestampFields:
            existingPrivate.exists && privateCreatedAtTs ? ['updatedAt'] : ['createdAt', 'updatedAt'],
        },
      );

      const isNewRegistration = !existingPublic.exists;
      await commitFirestoreWrites(firebaseConfig, idToken, ops);
      await syncChatUsernamesBestEffort(idToken, uid, username);

      if (isNewRegistration) {
        await updatePublicStatsDelta(idToken, {
          donorsDelta: 1,
          activeDelta: 0,
          fulfilledDelta: 0,
        });
      }

      res.json({ ok: true, isNewRegistration, username, eligibility });
    } catch (err) {
      console.error('Failed to save donor profile:', err);
      res.status(500).json({
        error: 'Could not save your donor profile right now. Please try again.',
      });
    }
  });

  // Server-side Donor Search: enforces 90-day eligibility, visibleInSearch, and returns ONLY username, blood group & approximate area
  app.get('/api/donors/search', requireSignedIn, async (req: AuthenticatedRequest, res) => {
    const idToken = req.idToken!;
    const bloodGroupFilter = cleanStr(req.query.bloodGroup, 5);
    const countryCodeFilter = cleanStr(req.query.countryCode, 4).toUpperCase();
    const stateCodeFilter = cleanStr(req.query.stateCode, 16).toUpperCase();
    const cityFilter = cleanStr(req.query.city, 100).toLowerCase();
    const localityFilter = cleanStr(req.query.locality, 120).toLowerCase();

    try {
      const serverNow = Date.now();
      const rawDocs = await queryFirestoreCollection(
        firebaseConfig,
        idToken,
        'donors_public',
        {
          fieldPath: 'searchActiveAfterMs',
          op: 'LESS_THAN_OR_EQUAL',
          value: serverNow - 5000,
        },
        300,
      );

      const donors = rawDocs
        .map(({ id, data }) => normalizeDonorPublic(data, id))
        .filter((d) => {
          if (!d.visibleInSearch) return false;
          if (d.eligibleAfterMs > serverNow) return false;
          if (bloodGroupFilter && d.bloodGroup !== bloodGroupFilter) return false;
          if (countryCodeFilter && d.countryCode.toUpperCase() !== countryCodeFilter) return false;
          if (stateCodeFilter && d.stateCode.toUpperCase() !== stateCodeFilter) return false;
          if (cityFilter && d.city.toLowerCase() !== cityFilter) return false;
          if (localityFilter && !d.locality.toLowerCase().includes(localityFilter)) return false;
          return true;
        })
        .map((d) => ({
          uid: d.uid,
          username: d.username,
          bloodGroup: d.bloodGroup,
          countryCode: d.countryCode,
          countryName: d.countryName,
          stateCode: d.stateCode,
          stateName: d.stateName,
          city: d.city,
          locality: d.locality,
          contactPreference: 'chat' as const,
          approxLat: d.approxLat,
          approxLng: d.approxLng,
        }));

      res.json({ donors, serverTimeMs: serverNow });
    } catch (err) {
      console.error('Failed to search donors:', err);
      res.status(500).json({
        error: 'Could not load donors right now. Please try again.',
      });
    }
  });

  // Helper: find eligible visible donors of same blood group nearby (same city or within 50km), same locality first
  async function buildDonorNotificationOps(params: {
    idToken: string;
    senderUid: string;
    requestId: string;
    bloodGroup: BloodGroup;
    units: number;
    urgency: UrgencyLevel;
    hospitalName: string;
    city: string;
    locality: string;
    stateName: string;
    countryName: string;
    hospitalLat: number | null;
    hospitalLng: number | null;
    excludeUids: Set<string>;
    serverNow: number;
  }): Promise<{ ops: CommitWriteOp[]; sameLocalityCount: number }> {
    const donorDocs = await queryFirestoreCollection(
      firebaseConfig,
      params.idToken,
      'donors_public',
      {
        fieldPath: 'searchActiveAfterMs',
        op: 'LESS_THAN_OR_EQUAL',
        value: params.serverNow - 5000,
      },
      300,
    );

    const cityLower = params.city.trim().toLowerCase();
    const localityLower = params.locality.trim().toLowerCase();
    const hasHospitalCoords = params.hospitalLat !== null && params.hospitalLng !== null;

    const matchingDonors = donorDocs
      .map(({ id, data }) => normalizeDonorPublic(data, id))
      .filter((d) => {
        if (params.excludeUids.has(d.uid)) return false;
        if (!d.visibleInSearch) return false;
        if (d.eligibleAfterMs > params.serverNow) return false;
        if (d.bloodGroup !== params.bloodGroup) return false;

        const sameCity = d.city.trim().toLowerCase() === cityLower;
        let within50Km = false;
        if (hasHospitalCoords && d.approxLat !== null && d.approxLng !== null) {
          within50Km =
            haversineDistanceKm(params.hospitalLat!, params.hospitalLng!, d.approxLat, d.approxLng) <= 50;
        }
        return sameCity || within50Km;
      })
      .map((d) => {
        const sameLocality =
          Boolean(localityLower) &&
          Boolean(d.locality) &&
          d.locality.trim().toLowerCase() === localityLower;
        const sameCity = d.city.trim().toLowerCase() === cityLower;
        const distanceKm =
          hasHospitalCoords && d.approxLat !== null && d.approxLng !== null
            ? haversineDistanceKm(params.hospitalLat!, params.hospitalLng!, d.approxLat, d.approxLng)
            : Number.POSITIVE_INFINITY;
        return { donor: d, sameLocality, sameCity, distanceKm };
      })
      .sort((a, b) => {
        if (a.sameLocality !== b.sameLocality) return Number(b.sameLocality) - Number(a.sameLocality);
        if (a.sameCity !== b.sameCity) return Number(b.sameCity) - Number(a.sameCity);
        return a.distanceKm - b.distanceKm;
      });

    const selected = matchingDonors.slice(0, 100);
    const ops: CommitWriteOp[] = selected.map(({ donor, sameLocality }) => ({
      collection: 'notifications',
      docId: generateFirestoreId('ntf'),
      fields: {
        recipientId: donor.uid,
        senderId: params.senderUid,
        requestId: params.requestId,
        bloodGroup: params.bloodGroup,
        units: params.units,
        urgency: coerceUrgencyLevel(params.urgency, 'urgent'),
        hospitalName: params.hospitalName,
        city: donor.city,
        locality: params.locality,
        stateName: params.stateName,
        countryName: params.countryName,
        hospitalLat: params.hospitalLat,
        hospitalLng: params.hospitalLng,
        sameLocality,
        read: false,
      },
      isCreate: true,
      serverTimestampFields: ['createdAt'],
    }));

    const sameLocalityCount = selected.filter((m) => m.sameLocality).length;
    return { ops, sameLocalityCount };
  }

  // Step 1: Requester submits a request tied to an approved hospital.
  // Donors are NOT notified yet and requester contact is stored privately in request_private_contacts.
  app.post('/api/requests', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const body = (req.body || {}) as Record<string, unknown>;

    const hospitalId = cleanStr(body.hospitalId, 128);
    const bloodGroup = body.bloodGroup;
    const units = Number(body.units);
    const rawUrgency = cleanStr(body.urgency, 20).toLowerCase();
    const urgency: UrgencyLevel | null = isValidUrgencyLevel(rawUrgency) ? rawUrgency : null;
    const contact = cleanStr(body.contact, 150);
    const notes = cleanStr(body.notes, 300);

    if (!hospitalId || !/^[a-zA-Z0-9_\-]+$/.test(hospitalId)) {
      res.status(400).json({ error: 'Please select an approved hospital or blood bank.' });
      return;
    }
    if (!isValidBloodGroup(bloodGroup)) {
      res.status(400).json({ error: 'Please select a valid blood group.' });
      return;
    }
    if (!Number.isInteger(units) || units < 1 || units > 100) {
      res.status(400).json({ error: 'Units must be a whole number of at least 1.' });
      return;
    }
    if (!urgency) {
      res.status(400).json({ error: 'Please choose an urgency level (Critical, Urgent, or Planned).' });
      return;
    }
    if (contact.length < 3) {
      res.status(400).json({ error: 'Your private contact phone or email is required.' });
      return;
    }

    const requestId = generateFirestoreId('req');

    try {
      const [roleState, hospitalDoc, userPubDoc, moderation, rateLimitDoc] = await Promise.all([
        resolveUserRoleState(idToken, req.authUser!),
        getFirestoreDoc(firebaseConfig, idToken, 'hospitals', hospitalId),
        getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid),
        resolveAccountModerationState(idToken, req.authUser!),
        getFirestoreDoc(firebaseConfig, idToken, 'user_rate_limits', uid),
      ]);

      if (moderation.status !== 'active') {
        res.status(403).json({ error: getBlockedAccountError(moderation.status) });
        return;
      }

      if (roleState.role === 'hospital') {
        const ownHospitalDoc =
          hospitalId === uid ? hospitalDoc : await getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid);
        if (!ownHospitalDoc.exists || ownHospitalDoc.data?.status !== 'approved') {
          res.status(403).json({
            error: 'Your hospital or blood bank must be approved by an admin before posting requests.',
          });
          return;
        }
      }

      if (!hospitalDoc.exists || !hospitalDoc.data || hospitalDoc.data.status !== 'approved') {
        res.status(400).json({
          error: 'Selected hospital or blood bank is not approved. Please pick an approved facility.',
        });
        return;
      }

      // Enforce 3 emergency requests per 24 hours per user
      const serverNow = Date.now();
      let rateLimitOp: CommitWriteOp;
      if (!rateLimitDoc.exists || !rateLimitDoc.data) {
        rateLimitOp = {
          collection: 'user_rate_limits',
          docId: uid,
          fields: {
            uid,
            reqCount: 1,
            msgWindowStart: null,
            msgCount: 0,
          },
          isCreate: true,
          serverTimestampFields: ['reqWindowStart', 'updatedAt'],
        };
      } else {
        const currentLimit = normalizeUserRateLimit(rateLimitDoc.data, uid);
        const existingReqTs = toTimestampField(rateLimitDoc.data.reqWindowStart);
        const withinWindow =
          existingReqTs !== null &&
          currentLimit.reqWindowStartMs !== null &&
          serverNow - currentLimit.reqWindowStartMs <= TWENTY_FOUR_HOURS_MS;

        if (withinWindow) {
          if (currentLimit.reqCount >= RATE_LIMIT_REQUESTS_PER_DAY) {
            res.status(429).json({
              error: 'Daily limit reached: you can post up to 3 emergency requests per day.',
            });
            return;
          }
          rateLimitOp = {
            collection: 'user_rate_limits',
            docId: uid,
            fields: {
              reqWindowStart: existingReqTs,
              reqCount: currentLimit.reqCount + 1,
            },
            isCreate: false,
            updateMaskFields: ['reqWindowStart', 'reqCount'],
            serverTimestampFields: ['updatedAt'],
          };
        } else {
          rateLimitOp = {
            collection: 'user_rate_limits',
            docId: uid,
            fields: {
              reqCount: 1,
            },
            isCreate: false,
            updateMaskFields: ['reqCount'],
            serverTimestampFields: ['reqWindowStart', 'updatedAt'],
          };
        }
      }

      const hospital = normalizeHospitalProfile(hospitalDoc.data, hospitalId);
      const posterUsername =
        userPubDoc.exists && typeof userPubDoc.data?.username === 'string' && userPubDoc.data.username
          ? userPubDoc.data.username
          : `member_${uid.slice(0, 6)}`;

      await commitFirestoreWrites(firebaseConfig, idToken, [
        rateLimitOp,
        {
          collection: 'emergency_requests',
          docId: requestId,
          fields: {
            createdBy: uid,
            createdByName: posterUsername,
            hospitalId,
            hospitalName: hospital.name,
            bloodGroup,
            units,
            unitsCompleted: 0,
            urgency,
            confirmedUrgency: null,
            countryCode: hospital.countryCode,
            countryName: hospital.countryName,
            stateCode: hospital.stateCode,
            stateName: hospital.stateName,
            city: hospital.city,
            locality: hospital.locality,
            pincode: hospital.pincode,
            hospitalLat: hospital.lat,
            hospitalLng: hospital.lng,
            notes,
            status: 'submitted',
            hospitalVerifiedAt: null,
            donorsNotifiedAt: null,
            notifiedDonorCount: 0,
            fulfilledAt: null,
            cancelledAt: null,
            cancelledBy: '',
          },
          isCreate: true,
          serverTimestampFields: ['createdAt', 'updatedAt'],
        },
        {
          collection: 'request_private_contacts',
          docId: requestId,
          fields: {
            requestId,
            requesterUid: uid,
            hospitalId,
            requesterContact: contact,
          },
          isCreate: true,
          serverTimestampFields: ['createdAt', 'updatedAt'],
        },
      ]);

      await updatePublicStatsDelta(idToken, {
        donorsDelta: 0,
        activeDelta: 1,
        fulfilledDelta: 0,
      });

      res.status(201).json({
        ok: true,
        requestId,
        status: 'submitted',
        hospitalName: hospital.name,
      });
    } catch (err) {
      console.error('Failed to submit blood request:', err);
      res.status(500).json({
        error: 'Could not submit your request right now. Please try again.',
      });
    }
  });

  // Step 2 & 3: ONLY the assigned approved hospital verifies the request, confirms urgency, and notifies nearby eligible donors
  app.post('/api/requests/:id/verify', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const requestId = cleanStr(req.params.id, 128);
    const body = (req.body || {}) as Record<string, unknown>;

    if (!/^[a-zA-Z0-9_\-]+$/.test(requestId)) {
      res.status(400).json({ error: 'Invalid request ID.' });
      return;
    }

    try {
      const [existing, hospitalDoc] = await Promise.all([
        getFirestoreDoc(firebaseConfig, idToken, 'emergency_requests', requestId),
        getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid),
      ]);

      if (!existing.exists || !existing.data) {
        res.status(404).json({ error: 'Blood request not found.' });
        return;
      }

      const normalizedReq = normalizeEmergencyRequest(existing.data, requestId);
      if (!normalizedReq.hospitalId || normalizedReq.hospitalId !== uid) {
        res.status(403).json({
          error: 'Only the assigned hospital for this request can verify it.',
        });
        return;
      }
      if (!hospitalDoc.exists || hospitalDoc.data?.status !== 'approved') {
        res.status(403).json({
          error: 'Only an approved hospital or blood bank can verify requests.',
        });
        return;
      }
      if (normalizedReq.status !== 'submitted') {
        res.status(400).json({
          error: 'Only submitted requests awaiting hospital review can be verified.',
        });
        return;
      }

      const requestedUrgencyRaw = cleanStr(body.confirmedUrgency, 20).toLowerCase();
      const confirmedUrgency: UrgencyLevel = requestedUrgencyRaw
        ? coerceUrgencyLevel(requestedUrgencyRaw, normalizedReq.urgency)
        : normalizedReq.urgency;
      if (requestedUrgencyRaw && !isValidUrgencyLevel(requestedUrgencyRaw)) {
        res.status(400).json({ error: 'Confirmed urgency must be Critical, Urgent, or Planned.' });
        return;
      }

      const serverNow = Date.now();
      const excludeUids = new Set<string>([uid, normalizedReq.createdBy]);
      const { ops: notifOps, sameLocalityCount } = await buildDonorNotificationOps({
        idToken,
        senderUid: uid,
        requestId,
        bloodGroup: normalizedReq.bloodGroup,
        units: normalizedReq.units,
        urgency: confirmedUrgency,
        hospitalName: normalizedReq.hospitalName,
        city: normalizedReq.city,
        locality: normalizedReq.locality,
        stateName: normalizedReq.stateName,
        countryName: normalizedReq.countryName,
        hospitalLat: normalizedReq.hospitalLat,
        hospitalLng: normalizedReq.hospitalLng,
        excludeUids,
        serverNow,
      });

      const commitOps: CommitWriteOp[] = [
        {
          collection: 'emergency_requests',
          docId: requestId,
          fields: {
            status: 'donors_notified',
            confirmedUrgency,
            notifiedDonorCount: notifOps.length,
          },
          isCreate: false,
          updateMaskFields: ['status', 'confirmedUrgency', 'notifiedDonorCount'],
          serverTimestampFields: ['hospitalVerifiedAt', 'donorsNotifiedAt', 'updatedAt'],
        },
        ...notifOps,
      ];

      await commitFirestoreWrites(firebaseConfig, idToken, commitOps);

      res.json({
        ok: true,
        status: 'donors_notified',
        confirmedUrgency,
        notifiedCount: notifOps.length,
        sameLocalityCount,
      });
    } catch (err) {
      console.error('Failed to verify blood request:', err);
      res.status(500).json({
        error: 'Could not verify this request right now. Please try again.',
      });
    }
  });

  // Optional re-notify for already verified requests (excludes donors who already responded)
  app.post('/api/requests/:id/notify', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const requestId = cleanStr(req.params.id, 128);

    if (!/^[a-zA-Z0-9_\-]+$/.test(requestId)) {
      res.status(400).json({ error: 'Invalid request ID.' });
      return;
    }

    try {
      const [existing, hospitalDoc, hospitalResponses] = await Promise.all([
        getFirestoreDoc(firebaseConfig, idToken, 'emergency_requests', requestId),
        getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid),
        queryFirestoreCollection(
          firebaseConfig,
          idToken,
          'request_responses',
          { fieldPath: 'hospitalId', op: 'EQUAL', value: uid },
          300,
        ),
      ]);

      if (!existing.exists || !existing.data) {
        res.status(404).json({ error: 'Blood request not found.' });
        return;
      }

      const normalizedReq = normalizeEmergencyRequest(existing.data, requestId);
      if (normalizedReq.hospitalId !== uid) {
        res.status(403).json({ error: 'Only the assigned hospital can notify donors.' });
        return;
      }
      if (!hospitalDoc.exists || hospitalDoc.data?.status !== 'approved') {
        res.status(403).json({ error: 'Approved hospital status is required.' });
        return;
      }
      if (!normalizedReq.hospitalVerifiedAtMs || !isOpenRequestStatus(normalizedReq.status)) {
        res.status(400).json({ error: 'Verify this open request before notifying donors.' });
        return;
      }

      const excludeUids = new Set<string>([uid, normalizedReq.createdBy]);
      for (const r of hospitalResponses) {
        if (r.data.requestId === requestId && typeof r.data.donorUid === 'string') {
          excludeUids.add(r.data.donorUid);
        }
      }

      const serverNow = Date.now();
      const { ops: notifOps, sameLocalityCount } = await buildDonorNotificationOps({
        idToken,
        senderUid: uid,
        requestId,
        bloodGroup: normalizedReq.bloodGroup,
        units: normalizedReq.units,
        urgency: getEffectiveUrgency(normalizedReq),
        hospitalName: normalizedReq.hospitalName,
        city: normalizedReq.city,
        locality: normalizedReq.locality,
        stateName: normalizedReq.stateName,
        countryName: normalizedReq.countryName,
        hospitalLat: normalizedReq.hospitalLat,
        hospitalLng: normalizedReq.hospitalLng,
        excludeUids,
        serverNow,
      });

      const nextNotifiedCount = normalizedReq.notifiedDonorCount + notifOps.length;
      const nextStatus =
        normalizedReq.status === 'hospital_verified' ? 'donors_notified' : normalizedReq.status;

      await commitFirestoreWrites(firebaseConfig, idToken, [
        {
          collection: 'emergency_requests',
          docId: requestId,
          fields: {
            status: nextStatus,
            notifiedDonorCount: nextNotifiedCount,
          },
          isCreate: false,
          updateMaskFields: ['status', 'notifiedDonorCount'],
          serverTimestampFields: ['donorsNotifiedAt', 'updatedAt'],
        },
        ...notifOps,
      ]);

      res.json({
        ok: true,
        notifiedCount: notifOps.length,
        sameLocalityCount,
      });
    } catch (err) {
      console.error('Failed to notify additional donors:', err);
      res.status(500).json({ error: 'Could not notify donors right now.' });
    }
  });

  // Step 4: Eligible, visible donor with matching blood group accepts or declines
  function describeRespondFailure(raw: string): { status: number; error: string } {
    const statusMatch = raw.match(/Firestore (?:commit|GET|runQuery|public GET) failed \((\d{3})\)/);
    const httpStatus = statusMatch ? Number(statusMatch[1]) : 0;
    const grpcIdx = raw.indexOf('):');
    const detail = grpcIdx >= 0 ? raw.slice(grpcIdx + 2).trim() : raw;
    const grpcStatus =
      detail.match(/"status"\s*:\s*"([A-Z_]+)"/)?.[1] || detail.match(/\b([A-Z_]{8,})\b/)?.[1] || '';
    if (httpStatus === 401 || grpcStatus === 'UNAUTHENTICATED') {
      return {
        status: 401,
        error: 'Your sign-in session expired, so your response could not be saved. Please sign in again and tap Accept once more.',
      };
    }
    if (httpStatus === 403 || grpcStatus === 'PERMISSION_DENIED') {
      return {
        status: 403,
        error:
          'Your response was not saved because the security rules rejected it. Please make sure your donor profile is complete and visible in search, that you are outside the 90-day donation waiting window, and that your account is in good standing — then try again.',
      };
    }
    if (httpStatus === 429 || grpcStatus === 'RESOURCE_EXHAUSTED') {
      return {
        status: 429,
        error: 'Too many attempts right now. Please wait a moment and try again.',
      };
    }
    if (httpStatus === 412 || httpStatus === 409 || grpcStatus === 'ALREADY_EXISTS' || grpcStatus === 'FAILED_PRECONDITION') {
      return {
        status: 409,
        error: 'This request or your previous response changed while you were responding. Please refresh the page and try again.',
      };
    }
    return { status: 500, error: 'Could not save your response right now. Please try again.' };
  }

  app.post('/api/requests/:id/respond', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const requestId = cleanStr(req.params.id, 128);
    const body = (req.body || {}) as Record<string, unknown>;

    if (!/^[a-zA-Z0-9_\-]+$/.test(requestId)) {
      res.status(400).json({ error: 'Invalid request ID.' });
      return;
    }

    const decision = body.decision === 'accept' ? 'accept' : body.decision === 'decline' ? 'decline' : null;
    if (!decision) {
      res.status(400).json({ error: 'Decision must be accept or decline.' });
      return;
    }
    const decisionNote = cleanStr(body.decisionNote, 300);

    try {
      const moderation = await resolveAccountModerationState(idToken, req.authUser!);
      if (moderation.status !== 'active') {
        res.status(403).json({ error: getBlockedAccountError(moderation.status) });
        return;
      }

      const responseId = makeRequestResponseId(requestId, uid);
      const [reqDoc, donorPubDoc, donorPrivDoc, userPubDoc, existingRespDoc, existingDonorContactDoc] =
        await Promise.all([
          getFirestoreDoc(firebaseConfig, idToken, 'emergency_requests', requestId),
          getFirestoreDoc(firebaseConfig, idToken, 'donors_public', uid),
          getFirestoreDoc(firebaseConfig, idToken, 'donors_private', uid),
          getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid),
          getFirestoreDoc(firebaseConfig, idToken, 'request_responses', responseId),
          getFirestoreDoc(firebaseConfig, idToken, 'request_donor_contacts', responseId),
        ]);

      if (!reqDoc.exists || !reqDoc.data) {
        res.status(404).json({ error: 'Blood request not found.' });
        return;
      }

      const normalizedReq = normalizeEmergencyRequest(reqDoc.data, requestId);
      if (!normalizedReq.hospitalId || !normalizedReq.hospitalVerifiedAtMs) {
        res.status(400).json({
          error: 'Wait until the assigned hospital verifies this request before responding.',
        });
        return;
      }
      if (!isOpenRequestStatus(normalizedReq.status)) {
        res.status(400).json({ error: 'This request is already closed.' });
        return;
      }
      if (normalizedReq.createdBy === uid) {
        res.status(403).json({ error: 'You cannot respond as a donor to your own request.' });
        return;
      }
      if (normalizedReq.hospitalId === uid) {
        res.status(403).json({ error: 'The assigned hospital cannot respond as a donor.' });
        return;
      }

      if (!donorPubDoc.exists || !donorPubDoc.data) {
        res.status(403).json({
          error: 'Complete your donor profile first to respond to blood requests.',
        });
        return;
      }

      const donorPub = normalizeDonorPublic(donorPubDoc.data, uid);
      const serverNow = Date.now();
      if (!donorPub.visibleInSearch || donorPub.eligibleAfterMs > serverNow) {
        res.status(403).json({
          error: 'Only visible donors who are outside the 90-day donation waiting window can respond.',
        });
        return;
      }
      if (donorPub.bloodGroup !== normalizedReq.bloodGroup) {
        res.status(400).json({
          error: `This request needs ${normalizedReq.bloodGroup} blood, while your donor profile is ${donorPub.bloodGroup}.`,
        });
        return;
      }

      if (existingRespDoc.exists && existingRespDoc.data) {
        const curResp = normalizeRequestResponse(existingRespDoc.data, responseId);
        if (curResp.status !== 'donor_accepted' && curResp.status !== 'donor_declined') {
          res.status(400).json({
            error: 'This response has already been verified by the hospital and cannot be changed.',
          });
          return;
        }
      }

      const donorUsername =
        userPubDoc.exists && typeof userPubDoc.data?.username === 'string' && isValidUsername(userPubDoc.data.username)
          ? userPubDoc.data.username
          : donorPub.username;
      const targetStatus = decision === 'accept' ? 'donor_accepted' : 'donor_declined';

      const ops: CommitWriteOp[] = [];

      if (decision === 'accept') {
        const donorPriv = donorPrivDoc.exists && donorPrivDoc.data
          ? normalizeDonorPrivate(donorPrivDoc.data, uid)
          : null;
        const donorContact =
          cleanStr(body.donorContact, 150) ||
          cleanStr(donorPriv?.phone, 30) ||
          cleanStr(donorPriv?.email, 150) ||
          cleanStr(req.authUser!.email, 150);

        if (donorContact.length < 3) {
          res.status(400).json({
            error: 'Add a phone number or email on your donor profile before accepting.',
          });
          return;
        }

        // Guarantee donors_private exists so the hospital can update lastDonationDate upon completion
        if (!donorPrivDoc.exists) {
          ops.push({
            collection: 'donors_private',
            docId: uid,
            fields: {
              uid,
              fullName: cleanStr(req.authUser!.name, 100) || donorUsername,
              phone: '',
              email: cleanStr(req.authUser!.email, 150) || donorContact,
              contactPreference: 'chat',
              lastDonationDate: '',
              exactLat: null,
              exactLng: null,
            },
            isCreate: true,
            serverTimestampFields: ['createdAt', 'updatedAt'],
          });
        }

        if (existingDonorContactDoc.exists) {
          ops.push({
            collection: 'request_donor_contacts',
            docId: responseId,
            fields: { donorContact },
            isCreate: false,
            updateMaskFields: ['donorContact'],
            serverTimestampFields: ['updatedAt'],
          });
        } else {
          ops.push({
            collection: 'request_donor_contacts',
            docId: responseId,
            fields: {
              requestId,
              donorUid: uid,
              hospitalId: normalizedReq.hospitalId,
              donorContact,
            },
            isCreate: true,
            serverTimestampFields: ['createdAt', 'updatedAt'],
          });
        }
      }

      if (existingRespDoc.exists) {
        ops.push({
          collection: 'request_responses',
          docId: responseId,
          fields: {
            status: targetStatus,
            decisionNote,
            donorUsername,
          },
          isCreate: false,
          updateMaskFields: ['status', 'decisionNote', 'donorUsername'],
          serverTimestampFields: ['updatedAt'],
        });
      } else {
        ops.push({
          collection: 'request_responses',
          docId: responseId,
          fields: {
            requestId,
            requesterUid: normalizedReq.createdBy,
            hospitalId: normalizedReq.hospitalId,
            donorUid: uid,
            donorUsername,
            bloodGroup: normalizedReq.bloodGroup,
            status: targetStatus,
            decisionNote,
            verifiedBy: '',
            verifiedAt: null,
            contactsSharedAt: null,
            completedBy: '',
            completedAt: null,
          },
          isCreate: true,
          serverTimestampFields: ['createdAt', 'updatedAt'],
        });
      }

      if (
        decision === 'accept' &&
        (normalizedReq.status === 'hospital_verified' || normalizedReq.status === 'donors_notified')
      ) {
        ops.push({
          collection: 'emergency_requests',
          docId: requestId,
          fields: { status: 'donor_accepted' },
          isCreate: false,
          updateMaskFields: ['status'],
          serverTimestampFields: ['updatedAt'],
        });
      }

      await commitFirestoreWrites(firebaseConfig, idToken, ops);

      res.json({
        ok: true,
        responseId,
        status: targetStatus,
      });
    } catch (err) {
      const rawErr = err instanceof Error ? `${err.message}` : String(err);
      console.error(
        JSON.stringify({
          event: 'donor_respond_failed',
          requestId,
          donorUid: uid,
          firestoreError: rawErr,
        }),
      );
      const mapped = describeRespondFailure(rawErr);
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  // Step 5 & 6: Assigned approved hospital verifies an accepting donor and shares contacts ONLY between that requester and donor
  app.post(
    '/api/requests/:id/responses/:donorUid/verify',
    requireVerifiedAuth,
    async (req: AuthenticatedRequest, res) => {
      const uid = req.authUser!.uid;
      const idToken = req.idToken!;
      const requestId = cleanStr(req.params.id, 128);
      const donorUid = cleanStr(req.params.donorUid, 128);

      if (!/^[a-zA-Z0-9_\-]+$/.test(requestId) || !/^[a-zA-Z0-9_\-]+$/.test(donorUid)) {
        res.status(400).json({ error: 'Invalid request or donor ID.' });
        return;
      }

      const responseId = makeRequestResponseId(requestId, donorUid);

      try {
        const [reqDoc, hospitalDoc, respDoc, privContactDoc, donorContactDoc] = await Promise.all([
          getFirestoreDoc(firebaseConfig, idToken, 'emergency_requests', requestId),
          getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid),
          getFirestoreDoc(firebaseConfig, idToken, 'request_responses', responseId),
          getFirestoreDoc(firebaseConfig, idToken, 'request_private_contacts', requestId),
          getFirestoreDoc(firebaseConfig, idToken, 'request_donor_contacts', responseId),
        ]);

        if (!reqDoc.exists || !reqDoc.data) {
          res.status(404).json({ error: 'Blood request not found.' });
          return;
        }

        const normalizedReq = normalizeEmergencyRequest(reqDoc.data, requestId);
        if (normalizedReq.hospitalId !== uid) {
          res.status(403).json({
            error: 'Only the assigned hospital can verify accepting donors.',
          });
          return;
        }
        if (!hospitalDoc.exists || hospitalDoc.data?.status !== 'approved') {
          res.status(403).json({ error: 'Approved hospital status is required.' });
          return;
        }
        if (!isOpenRequestStatus(normalizedReq.status) || normalizedReq.unitsCompleted >= normalizedReq.units) {
          res.status(400).json({ error: 'This blood request is already closed.' });
          return;
        }

        if (!respDoc.exists || !respDoc.data) {
          res.status(404).json({ error: 'Donor response not found.' });
          return;
        }
        const resp = normalizeRequestResponse(respDoc.data, responseId);
        if (resp.status !== 'donor_accepted') {
          res.status(400).json({
            error:
              resp.status === 'contacts_shared' || resp.status === 'donor_verified'
                ? 'This donor has already been verified and contacts have been shared.'
                : 'Only donors who accepted this request can be verified.',
          });
          return;
        }

        const requesterContact = cleanStr(privContactDoc.data?.requesterContact, 150);
        const donorContact = cleanStr(donorContactDoc.data?.donorContact, 150);
        if (requesterContact.length < 3 || donorContact.length < 3) {
          res.status(400).json({
            error: 'Both requester and donor contacts must be on file before sharing.',
          });
          return;
        }

        const requesterUsername = isValidUsername(normalizeUsernameInput(normalizedReq.createdByName))
          ? normalizeUsernameInput(normalizedReq.createdByName)
          : `member_${normalizedReq.createdBy.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6) || 'user'}`;

        const ops: CommitWriteOp[] = [
          {
            collection: 'request_shared_contacts',
            docId: responseId,
            fields: {
              requestId,
              requesterUid: normalizedReq.createdBy,
              donorUid,
              hospitalId: uid,
              requesterUsername,
              donorUsername: resp.donorUsername,
              requesterContact,
              donorContact,
              sharedBy: uid,
            },
            isCreate: true,
            serverTimestampFields: ['sharedAt', 'createdAt', 'updatedAt'],
          },
          {
            collection: 'request_responses',
            docId: responseId,
            fields: {
              status: 'contacts_shared',
              verifiedBy: uid,
            },
            isCreate: false,
            updateMaskFields: ['status', 'verifiedBy'],
            serverTimestampFields: ['verifiedAt', 'contactsSharedAt', 'updatedAt'],
          },
        ];

        if (normalizedReq.status !== 'contacts_shared') {
          ops.push({
            collection: 'emergency_requests',
            docId: requestId,
            fields: { status: 'contacts_shared' },
            isCreate: false,
            updateMaskFields: ['status'],
            serverTimestampFields: ['updatedAt'],
          });
        }

        await commitFirestoreWrites(firebaseConfig, idToken, ops);

        res.json({
          ok: true,
          responseId,
          status: 'contacts_shared',
        });
      } catch (err) {
        console.error('Failed to verify donor and share contacts:', err);
        res.status(500).json({
          error: 'Could not verify this donor right now. Please try again.',
        });
      }
    },
  );

  // Step 7: Assigned approved hospital marks a verified donor's donation completed,
  // updates the donor's lastDonationDate & 90-day window, and closes the request once all units are met.
  app.post(
    '/api/requests/:id/responses/:donorUid/complete',
    requireVerifiedAuth,
    async (req: AuthenticatedRequest, res) => {
      const uid = req.authUser!.uid;
      const idToken = req.idToken!;
      const requestId = cleanStr(req.params.id, 128);
      const donorUid = cleanStr(req.params.donorUid, 128);

      if (!/^[a-zA-Z0-9_\-]+$/.test(requestId) || !/^[a-zA-Z0-9_\-]+$/.test(donorUid)) {
        res.status(400).json({ error: 'Invalid request or donor ID.' });
        return;
      }

      const responseId = makeRequestResponseId(requestId, donorUid);

      try {
        const [reqDoc, hospitalDoc, respDoc, donorPubDoc] = await Promise.all([
          getFirestoreDoc(firebaseConfig, idToken, 'emergency_requests', requestId),
          getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid),
          getFirestoreDoc(firebaseConfig, idToken, 'request_responses', responseId),
          getFirestoreDoc(firebaseConfig, idToken, 'donors_public', donorUid),
        ]);

        if (!reqDoc.exists || !reqDoc.data) {
          res.status(404).json({ error: 'Blood request not found.' });
          return;
        }

        const normalizedReq = normalizeEmergencyRequest(reqDoc.data, requestId);
        if (normalizedReq.hospitalId !== uid) {
          res.status(403).json({
            error: 'Only the assigned hospital can mark donations completed.',
          });
          return;
        }
        if (!hospitalDoc.exists || hospitalDoc.data?.status !== 'approved') {
          res.status(403).json({ error: 'Approved hospital status is required.' });
          return;
        }
        if (!isOpenRequestStatus(normalizedReq.status) || normalizedReq.unitsCompleted >= normalizedReq.units) {
          res.status(400).json({ error: 'All units for this request are already completed.' });
          return;
        }

        if (!respDoc.exists || !respDoc.data) {
          res.status(404).json({ error: 'Donor response not found.' });
          return;
        }
        const resp = normalizeRequestResponse(respDoc.data, responseId);
        if (resp.status !== 'donor_verified' && resp.status !== 'contacts_shared') {
          res.status(400).json({
            error: 'Verify the accepting donor before marking the donation completed.',
          });
          return;
        }

        const todayStr = getTodayLocalDateStr();
        const eligibility = computeEligibility(todayStr);
        const nextUnitsCompleted = Math.min(normalizedReq.units, normalizedReq.unitsCompleted + 1);
        const allMet = nextUnitsCompleted >= normalizedReq.units;

        const donorVisible = donorPubDoc.exists ? Boolean(donorPubDoc.data?.visibleInSearch) : true;
        const nextSearchActiveAfterMs = donorVisible
          ? eligibility.eligibleAfterMs
          : HIDDEN_SEARCH_SENTINEL_MS;

        const rawHospitalName = cleanStr(
          String(hospitalDoc.data?.name || normalizedReq.hospitalName),
          120,
        );
        const hospitalName = rawHospitalName.length >= 2 ? rawHospitalName : 'Hospital';
        const thankYouMessage = cleanStr(
          `Thank you for donating ${normalizedReq.bloodGroup} blood at ${hospitalName}. Your generosity helps save lives.`,
          300,
        );

        const ops: CommitWriteOp[] = [
          {
            collection: 'request_responses',
            docId: responseId,
            fields: {
              status: 'donation_completed',
              completedBy: uid,
            },
            isCreate: false,
            updateMaskFields: ['status', 'completedBy'],
            serverTimestampFields: ['completedAt', 'updatedAt'],
          },
          {
            collection: 'thank_you_cards',
            docId: responseId,
            fields: {
              requestId,
              responseId,
              donorUid,
              donorUsername: resp.donorUsername,
              bloodGroup: normalizedReq.bloodGroup,
              donationDate: todayStr,
              hospitalId: uid,
              hospitalName,
              message: thankYouMessage,
              createdBy: uid,
            },
            isCreate: true,
            serverTimestampFields: ['createdAt', 'updatedAt'],
          },
          allMet
            ? {
                collection: 'emergency_requests',
                docId: requestId,
                fields: {
                  unitsCompleted: nextUnitsCompleted,
                  status: 'donation_completed',
                },
                isCreate: false,
                updateMaskFields: ['unitsCompleted', 'status'],
                serverTimestampFields: ['fulfilledAt', 'updatedAt'],
              }
            : {
                collection: 'emergency_requests',
                docId: requestId,
                fields: {
                  unitsCompleted: nextUnitsCompleted,
                },
                isCreate: false,
                updateMaskFields: ['unitsCompleted'],
                serverTimestampFields: ['updatedAt'],
              },
        ];

        if (donorPubDoc.exists) {
          ops.push(
            {
              collection: 'donors_public',
              docId: donorUid,
              fields: {
                eligibleAfterMs: eligibility.eligibleAfterMs,
                searchActiveAfterMs: nextSearchActiveAfterMs,
                lastCompletedRequestId: requestId,
              },
              isCreate: false,
              updateMaskFields: ['eligibleAfterMs', 'searchActiveAfterMs', 'lastCompletedRequestId'],
              serverTimestampFields: ['updatedAt'],
            },
            {
              collection: 'donors_private',
              docId: donorUid,
              fields: {
                lastDonationDate: todayStr,
                lastCompletedRequestId: requestId,
              },
              isCreate: false,
              updateMaskFields: ['lastDonationDate', 'lastCompletedRequestId'],
              serverTimestampFields: ['updatedAt'],
            },
          );
        }

        await commitFirestoreWrites(firebaseConfig, idToken, ops);

        if (allMet) {
          await updatePublicStatsDelta(idToken, {
            donorsDelta: 0,
            activeDelta: -1,
            fulfilledDelta: 1,
          });
        }

        res.json({
          ok: true,
          status: allMet ? 'donation_completed' : normalizedReq.status,
          unitsCompleted: nextUnitsCompleted,
          units: normalizedReq.units,
          allMet,
          lastDonationDate: todayStr,
          thankYouCardCreated: true,
          thankYouCardId: responseId,
        });
      } catch (err) {
        console.error('Failed to complete donation:', err);
        res.status(500).json({
          error: 'Could not mark donation completed right now. Please try again.',
        });
      }
    },
  );

  // Cancel Request (Requester or Assigned Hospital)
  app.post('/api/requests/:id/cancel', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const requestId = cleanStr(req.params.id, 128);

    if (!/^[a-zA-Z0-9_\-]+$/.test(requestId)) {
      res.status(400).json({ error: 'Invalid request ID.' });
      return;
    }

    try {
      const existing = await getFirestoreDoc(firebaseConfig, idToken, 'emergency_requests', requestId);
      if (!existing.exists || !existing.data) {
        res.status(404).json({ error: 'Blood request not found.' });
        return;
      }
      if (!existing.data.hospitalId) {
        res.status(400).json({ error: 'Legacy requests can only be marked fulfilled by their creator.' });
        return;
      }

      const normalizedReq = normalizeEmergencyRequest(existing.data, requestId);
      const isRequester = normalizedReq.createdBy === uid;
      const isAssignedHospital = normalizedReq.hospitalId === uid;
      if (!isRequester && !isAssignedHospital) {
        res.status(403).json({
          error: 'Only the requester or the assigned hospital can cancel this request.',
        });
        return;
      }
      if (!isOpenRequestStatus(normalizedReq.status)) {
        res.status(400).json({ error: 'This request is already closed or cancelled.' });
        return;
      }

      const relatedResponses = await queryFirestoreCollection(
        firebaseConfig,
        idToken,
        'request_responses',
        isAssignedHospital
          ? { fieldPath: 'hospitalId', op: 'EQUAL', value: uid }
          : { fieldPath: 'requesterUid', op: 'EQUAL', value: uid },
        300,
      );

      const ops: CommitWriteOp[] = [
        {
          collection: 'emergency_requests',
          docId: requestId,
          fields: {
            status: 'cancelled',
            cancelledBy: uid,
          },
          isCreate: false,
          updateMaskFields: ['status', 'cancelledBy'],
          serverTimestampFields: ['cancelledAt', 'updatedAt'],
        },
      ];

      for (const r of relatedResponses) {
        if (
          r.data.requestId === requestId &&
          (r.data.status === 'donor_accepted' ||
            r.data.status === 'donor_verified' ||
            r.data.status === 'contacts_shared')
        ) {
          ops.push({
            collection: 'request_responses',
            docId: r.id,
            fields: { status: 'cancelled' },
            isCreate: false,
            updateMaskFields: ['status'],
            serverTimestampFields: ['updatedAt'],
          });
        }
      }

      await commitFirestoreWrites(firebaseConfig, idToken, ops);

      await updatePublicStatsDelta(idToken, {
        donorsDelta: 0,
        activeDelta: -1,
        fulfilledDelta: 0,
      });

      res.json({ ok: true, status: 'cancelled' });
    } catch (err) {
      console.error('Failed to cancel blood request:', err);
      res.status(500).json({ error: 'Could not cancel this request right now. Please try again.' });
    }
  });

  // Legacy Request Fulfillment (Creator Only, for older active requests created before hospital-verified workflow)
  app.post('/api/requests/:id/fulfill', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const requestId = cleanStr(req.params.id, 128);

    if (!/^[a-zA-Z0-9_\-]+$/.test(requestId)) {
      res.status(400).json({ error: 'Invalid request ID.' });
      return;
    }

    try {
      const existing = await getFirestoreDoc(firebaseConfig, idToken, 'emergency_requests', requestId);
      if (!existing.exists || !existing.data) {
        res.status(404).json({ error: 'Emergency request not found.' });
        return;
      }
      if (existing.data.hospitalId) {
        res.status(400).json({
          error: 'Hospital-verified requests are completed by the assigned hospital once donations finish.',
        });
        return;
      }
      if (existing.data.createdBy !== uid) {
        res.status(403).json({ error: 'Only the creator of this request can mark it fulfilled.' });
        return;
      }
      if (existing.data.status === 'fulfilled') {
        res.status(400).json({ error: 'This request is already marked fulfilled.' });
        return;
      }

      await commitFirestoreWrites(firebaseConfig, idToken, [
        {
          collection: 'emergency_requests',
          docId: requestId,
          fields: {
            status: 'fulfilled',
          },
          isCreate: false,
          updateMaskFields: ['status'],
          serverTimestampFields: ['fulfilledAt', 'updatedAt'],
        },
      ]);

      await updatePublicStatsDelta(idToken, {
        donorsDelta: 0,
        activeDelta: -1,
        fulfilledDelta: 1,
      });

      res.json({ ok: true });
    } catch (err) {
      console.error('Failed to mark request as fulfilled:', err);
      res.status(500).json({
        error: 'Could not close this request right now. Please try again.',
      });
    }
  });

  // --- Hospital / Blood Bank Endpoints ---

  // Public/Browseable Ranked List of Approved Hospitals & Blood Banks (unverified signed-in users can browse)
  app.get('/api/hospitals/ranked', requireSignedIn, async (req: AuthenticatedRequest, res) => {
    const idToken = req.idToken!;
    const bloodGroupRaw = cleanStr(req.query.bloodGroup, 5);
    const bloodGroupFilter = isValidBloodGroup(bloodGroupRaw) ? bloodGroupRaw : '';
    const countryCodeFilter = cleanStr(req.query.countryCode, 4).toUpperCase();
    const stateCodeFilter = cleanStr(req.query.stateCode, 16).toUpperCase();
    const cityFilter = cleanStr(req.query.city, 100).toLowerCase();
    const localityFilter = cleanStr(req.query.locality, 120).toLowerCase();
    const userLat = parseCoord(req.query.lat, -90, 90);
    const userLng = parseCoord(req.query.lng, -180, 180);

    try {
      const rawDocs = await queryFirestoreCollection(
        firebaseConfig,
        idToken,
        'hospitals',
        { fieldPath: 'status', op: 'EQUAL', value: 'approved' },
        300,
      );

      const approved = rawDocs
        .map(({ id, data }) => normalizeHospitalProfile(data, id))
        .filter((h) => {
          if (h.status !== 'approved') return false;
          if (countryCodeFilter && h.countryCode.toUpperCase() !== countryCodeFilter) return false;
          if (stateCodeFilter && h.stateCode.toUpperCase() !== stateCodeFilter) return false;
          if (cityFilter && h.city.toLowerCase() !== cityFilter) return false;
          if (localityFilter && !h.locality.toLowerCase().includes(localityFilter)) return false;
          return true;
        });

      const ranked = rankHospitals(approved, {
        requiredBloodGroup: bloodGroupFilter,
        userLat,
        userLng,
      });

      res.json({ hospitals: ranked, serverTimeMs: Date.now() });
    } catch (err) {
      console.error('Failed to load approved hospitals:', err);
      res.status(500).json({ error: 'Could not load approved hospitals and blood banks right now.' });
    }
  });

  // Hospital/Blood Bank owner gets their own facility record
  app.get('/api/hospitals/me', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;

    try {
      const [roleState, doc] = await Promise.all([
        resolveUserRoleState(idToken, req.authUser!),
        getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid),
      ]);
      if (roleState.role !== 'hospital' && roleState.role !== 'admin') {
        res.status(403).json({
          error: 'Switch your account role to Hospital / Blood Bank to manage a facility.',
        });
        return;
      }

      res.json({
        hospital: doc.exists && doc.data ? normalizeHospitalProfile(doc.data, uid) : null,
      });
    } catch (err) {
      console.error('Failed to load my hospital profile:', err);
      res.status(500).json({ error: 'Could not load your hospital profile right now.' });
    }
  });

  // Register or update own Hospital / Blood Bank (new registration always starts as 'pending')
  app.put('/api/hospitals/me', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const body = (req.body || {}) as Record<string, unknown>;

    const name = cleanStr(body.name, 120);
    const facilityType = body.facilityType === 'blood_bank' ? 'blood_bank' : 'hospital';
    const licenseNumber = cleanStr(body.licenseNumber, 80);
    const contact = cleanStr(body.contact, 150);
    const countryCode = cleanStr(body.countryCode, 4).toUpperCase() || 'IN';
    const countryName = cleanStr(body.countryName, 100) || 'India';
    const stateCode = cleanStr(body.stateCode, 16);
    const stateName = cleanStr(body.stateName, 100);
    const city = cleanStr(body.city, 100);
    const locality = cleanStr(body.locality, 120);
    const pincode = cleanStr(body.pincode, 16);
    const lat = parseCoord(body.lat, -90, 90);
    const lng = parseCoord(body.lng, -180, 180);

    if (name.length < 2) {
      res.status(400).json({ error: 'Facility name must be at least 2 characters.' });
      return;
    }
    if (contact.length < 3) {
      res.status(400).json({ error: 'Facility contact phone or email is required.' });
      return;
    }
    if (city.length < 1) {
      res.status(400).json({ error: 'City is required.' });
      return;
    }
    if (countryCode === 'IN' && pincode && !/^\d{6}$/.test(pincode)) {
      res.status(400).json({ error: 'Indian PIN code must be 6 digits.' });
      return;
    }

    try {
      const [roleState, userPubDoc, existingHospital, moderation] = await Promise.all([
        resolveUserRoleState(idToken, req.authUser!),
        getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid),
        resolveAccountModerationState(idToken, req.authUser!),
      ]);

      if (moderation.status !== 'active') {
        res.status(403).json({ error: getBlockedAccountError(moderation.status) });
        return;
      }

      if (roleState.role !== 'hospital' && roleState.role !== 'admin') {
        res.status(403).json({
          error: 'Only accounts with the Hospital / Blood Bank role can register a facility.',
        });
        return;
      }

      const ownerUsername = normalizeUsernameInput(String(userPubDoc.data?.username || ''));
      if (!isValidUsername(ownerUsername)) {
        res.status(400).json({ error: 'Please choose a valid username first.' });
        return;
      }

      const ops: CommitWriteOp[] = [];
      if (!roleState.hasRoleDoc) {
        ops.push({
          collection: 'user_roles',
          docId: uid,
          fields: {
            uid,
            email: cleanStr(req.authUser!.email, 150),
            username: ownerUsername,
            role: roleState.role,
            assignedBy: uid,
          },
          isCreate: true,
          serverTimestampFields: ['createdAt', 'updatedAt'],
        });
      }

      if (!existingHospital.exists) {
        ops.push({
          collection: 'hospitals',
          docId: uid,
          fields: {
            uid,
            ownerUsername,
            name,
            facilityType,
            licenseNumber,
            contact,
            countryCode,
            countryName,
            stateCode,
            stateName,
            city,
            locality,
            pincode,
            lat,
            lng,
            status: 'pending',
            reviewNote: '',
            reviewedBy: '',
            reviewedAt: null,
            inventory: createEmptyInventory(),
            inventoryUpdatedAt: null,
          },
          isCreate: true,
          serverTimestampFields: ['createdAt', 'updatedAt'],
        });
      } else {
        ops.push({
          collection: 'hospitals',
          docId: uid,
          fields: {
            name,
            facilityType,
            licenseNumber,
            contact,
            countryCode,
            countryName,
            stateCode,
            stateName,
            city,
            locality,
            pincode,
            lat,
            lng,
            ownerUsername,
          },
          isCreate: false,
          updateMaskFields: [
            'name',
            'facilityType',
            'licenseNumber',
            'contact',
            'countryCode',
            'countryName',
            'stateCode',
            'stateName',
            'city',
            'locality',
            'pincode',
            'lat',
            'lng',
            'ownerUsername',
          ],
          serverTimestampFields: ['updatedAt'],
        });
      }

      await commitFirestoreWrites(firebaseConfig, idToken, ops);
      const saved = await getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid);
      res.json({
        ok: true,
        isNewRegistration: !existingHospital.exists,
        hospital: saved.exists && saved.data ? normalizeHospitalProfile(saved.data, uid) : null,
      });
    } catch (err) {
      console.error('Failed to save hospital registration:', err);
      res.status(500).json({ error: 'Could not save your hospital registration right now.' });
    }
  });

  // Approved hospital updates available blood units per blood group
  app.put('/api/hospitals/me/inventory', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const body = (req.body || {}) as Record<string, unknown>;
    const rawInventory = body.inventory;

    if (!rawInventory || typeof rawInventory !== 'object') {
      res.status(400).json({ error: 'Inventory units for each blood group are required.' });
      return;
    }

    const parsedInventory = normalizeInventory(rawInventory);
    for (const bg of BLOOD_GROUPS) {
      const val = Number((rawInventory as Record<string, unknown>)[bg]);
      if (!Number.isInteger(val) || val < 0 || val > 100000) {
        res.status(400).json({
          error: `Units for ${bg} must be a whole number between 0 and 100,000.`,
        });
        return;
      }
      parsedInventory[bg] = val;
    }

    try {
      const [roleState, existingHospital] = await Promise.all([
        resolveUserRoleState(idToken, req.authUser!),
        getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid),
      ]);

      if (roleState.role !== 'hospital' && roleState.role !== 'admin') {
        res.status(403).json({ error: 'Hospital / Blood Bank role is required.' });
        return;
      }
      if (!existingHospital.exists || !existingHospital.data) {
        res.status(404).json({ error: 'Register your hospital or blood bank first.' });
        return;
      }
      if (existingHospital.data.status !== 'approved') {
        res.status(403).json({
          error: 'Your hospital or blood bank is pending admin approval and cannot update stock yet.',
        });
        return;
      }

      await commitFirestoreWrites(firebaseConfig, idToken, [
        {
          collection: 'hospitals',
          docId: uid,
          fields: {
            inventory: parsedInventory,
          },
          isCreate: false,
          updateMaskFields: ['inventory'],
          serverTimestampFields: ['inventoryUpdatedAt', 'updatedAt'],
        },
      ]);

      const updated = await getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid);
      res.json({
        ok: true,
        hospital: updated.exists && updated.data ? normalizeHospitalProfile(updated.data, uid) : null,
      });
    } catch (err) {
      console.error('Failed to update hospital inventory:', err);
      res.status(500).json({ error: 'Could not update blood stock right now.' });
    }
  });

  // --- Abuse Reports (Submitted by active verified users) ---

  app.post('/api/reports', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const body = (req.body || {}) as Record<string, unknown>;

    const targetTypeRaw = body.targetType;
    const targetType: ReportTargetType | null =
      targetTypeRaw === 'user' || targetTypeRaw === 'request' || targetTypeRaw === 'message'
        ? targetTypeRaw
        : null;
    const targetId = cleanStr(body.targetId, 128);
    const targetUid = cleanStr(body.targetUid, 128);
    const targetUsername = normalizeUsernameInput(String(body.targetUsername || '')).slice(0, 24);
    const contextId = cleanStr(body.contextId, 128);
    const targetPreview = cleanStr(body.targetPreview, 300);
    const reasonRaw = body.reason;
    const reason: ReportReason =
      reasonRaw === 'spam' ||
      reasonRaw === 'harassment' ||
      reasonRaw === 'fake_request' ||
      reasonRaw === 'suspicious_activity'
        ? reasonRaw
        : 'other';
    const details = cleanStr(body.details, 500);

    if (!targetType) {
      res.status(400).json({ error: 'Invalid report target type.' });
      return;
    }
    if (!targetId || !/^[a-zA-Z0-9_\-]+$/.test(targetId)) {
      res.status(400).json({ error: 'Invalid report target identifier.' });
      return;
    }
    if (targetUid && targetUid === uid) {
      res.status(400).json({ error: 'You cannot report your own account or content.' });
      return;
    }

    try {
      const [moderation, userPubDoc] = await Promise.all([
        resolveAccountModerationState(idToken, req.authUser!),
        getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid),
      ]);

      if (moderation.status !== 'active') {
        res.status(403).json({ error: getBlockedAccountError(moderation.status) });
        return;
      }

      const reporterUsername = cleanStr(String(userPubDoc.data?.username || ''), 24);
      const reportId = generateFirestoreId('rep');

      await commitFirestoreWrites(firebaseConfig, idToken, [
        {
          collection: 'reports',
          docId: reportId,
          fields: {
            reporterUid: uid,
            reporterUsername,
            targetType,
            targetId,
            targetUid,
            targetUsername,
            contextId,
            targetPreview,
            reason,
            details,
            status: 'open',
            reviewNote: '',
            reviewedBy: '',
            reviewedAt: null,
          },
          isCreate: true,
          serverTimestampFields: ['createdAt', 'updatedAt'],
        },
      ]);

      res.status(201).json({ ok: true, reportId });
    } catch (err) {
      console.error('Failed to submit report:', err);
      res.status(500).json({ error: 'Could not submit your report right now. Please try again.' });
    }
  });

  // --- Admin Endpoints (Admin Role Strictly Required) ---

  app.get('/api/admin/overview', requireAdminAuth, async (req: AuthenticatedRequest, res) => {
    const idToken = req.idToken!;
    try {
      const [
        hospitalDocs,
        roleDocs,
        modDocs,
        reportDocs,
        authLogDocs,
        deviceRegDocs,
        accountSignupDocs,
      ] = await Promise.all([
        queryFirestoreCollection(firebaseConfig, idToken, 'hospitals', undefined, 300),
        queryFirestoreCollection(firebaseConfig, idToken, 'user_roles', undefined, 300),
        queryFirestoreCollection(firebaseConfig, idToken, 'account_moderation', undefined, 300),
        queryFirestoreCollection(firebaseConfig, idToken, 'reports', undefined, 300),
        queryFirestoreCollection(firebaseConfig, idToken, 'auth_logs', undefined, 300),
        queryFirestoreCollection(firebaseConfig, idToken, 'device_registrations', undefined, 300).catch(() => []),
        queryFirestoreCollection(firebaseConfig, idToken, 'account_signups', undefined, 300).catch(() => []),
      ]);

      const nowMs = Date.now();
      const expiredLogIds: string[] = [];
      const activeAuthLogs = [];

      for (const { id, data } of authLogDocs) {
        const log = normalizeAuthEventLog(data, id);
        const isExpired =
          (log.expiresAtMs > 0 && log.expiresAtMs <= nowMs) ||
          (log.createdAtMs > 0 && nowMs - log.createdAtMs >= THIRTY_DAYS_MS);
        if (isExpired) {
          expiredLogIds.push(id);
        } else {
          activeAuthLogs.push(log);
        }
      }

      const expiredDeviceIds: string[] = [];
      const activeDeviceRegs = [];
      for (const { id, data } of deviceRegDocs) {
        const reg = normalizeDeviceRegistration(data, id);
        const isExpired =
          (reg.expiresAtMs > 0 && reg.expiresAtMs <= nowMs) ||
          (reg.createdAtMs > 0 && nowMs - reg.createdAtMs >= THIRTY_DAYS_MS);
        if (isExpired) {
          expiredDeviceIds.push(id);
          inMemoryRegisteredDevices.delete(id);
        } else {
          activeDeviceRegs.push(reg);
        }
      }

      const expiredSignupIds: string[] = [];
      for (const { id, data } of accountSignupDocs) {
        const expMs = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : 0;
        const createdMs = typeof data.createdAt === 'string' ? Date.parse(data.createdAt) : 0;
        const isExpired =
          (Number.isFinite(expMs) && expMs > 0 && expMs <= nowMs) ||
          (Number.isFinite(createdMs) && createdMs > 0 && nowMs - createdMs >= THIRTY_DAYS_MS);
        if (isExpired) {
          expiredSignupIds.push(id);
        }
      }

      // Automatically purge expired records (>30 days old)
      const purgeOps: CommitWriteOp[] = [
        ...expiredLogIds.map((docId) => ({
          opType: 'delete' as const,
          collection: 'auth_logs',
          docId,
        })),
        ...expiredDeviceIds.map((docId) => ({
          opType: 'delete' as const,
          collection: 'device_registrations',
          docId,
        })),
        ...expiredSignupIds.map((docId) => ({
          opType: 'delete' as const,
          collection: 'account_signups',
          docId,
        })),
      ];
      if (purgeOps.length > 0) {
        try {
          for (let i = 0; i < purgeOps.length; i += 200) {
            await commitFirestoreWrites(firebaseConfig, idToken, purgeOps.slice(i, i + 200));
          }
        } catch (purgeErr) {
          console.warn('Non-fatal expired security records purge failed:', purgeErr);
        }
      }

      const hospitals = hospitalDocs
        .map(({ id, data }) => normalizeHospitalProfile(data, id))
        .sort((a, b) => b.createdAtMs - a.createdAtMs);
      const users = roleDocs
        .map(({ id, data }) => normalizeUserRoleRecord(data, id))
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      const flaggedAccounts = modDocs
        .map(({ id, data }) => normalizeAccountModeration(data, id))
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      const reports = reportDocs
        .map(({ id, data }) => normalizeAbuseReport(data, id))
        .sort((a, b) => b.createdAtMs - a.createdAtMs);
      activeAuthLogs.sort((a, b) => b.createdAtMs - a.createdAtMs);
      activeDeviceRegs.sort((a, b) => b.createdAtMs - a.createdAtMs);

      res.json({
        hospitals,
        users,
        flaggedAccounts,
        reports,
        authLogs: activeAuthLogs,
        deviceRegistrations: activeDeviceRegs,
        purgedExpiredLogs: expiredLogIds.length + expiredDeviceIds.length + expiredSignupIds.length,
      });
    } catch (err) {
      console.error('Failed to load admin overview:', err);
      res.status(500).json({ error: 'Could not load admin dashboard right now.' });
    }
  });

  app.post('/api/admin/devices/reset', requireAdminAuth, async (req: AuthenticatedRequest, res) => {
    const idToken = req.idToken!;
    const body = (req.body || {}) as Record<string, unknown>;
    const rawDeviceId = cleanStr(body.deviceId, 64);
    const rawDeviceHash = cleanStr(body.deviceHash, 64);

    let deviceHash = '';
    if (rawDeviceHash && /^[a-f0-9]{16,64}$/.test(rawDeviceHash)) {
      deviceHash = rawDeviceHash;
    } else if (rawDeviceId && /^[a-zA-Z0-9_\-]{12,64}$/.test(rawDeviceId)) {
      deviceHash = computeDeviceLockHash(rawDeviceId);
    } else {
      res.status(400).json({ error: 'Valid device ID or device lock hash is required.' });
      return;
    }

    try {
      const existingReg = await getFirestoreDoc(firebaseConfig, idToken, 'device_registrations', deviceHash);
      const hadMemory = inMemoryRegisteredDevices.has(deviceHash);

      if (!existingReg.exists && !hadMemory) {
        res.status(404).json({ error: 'No registration lock found for that device.' });
        return;
      }

      const ops: CommitWriteOp[] = [];
      if (existingReg.exists) {
        ops.push({
          opType: 'delete',
          collection: 'device_registrations',
          docId: deviceHash,
        });
      }

      const effectiveDeviceId =
        rawDeviceId ||
        (existingReg.data && typeof existingReg.data.deviceId === 'string' ? existingReg.data.deviceId : '');
      if (effectiveDeviceId) {
        const legacyWindowHash = computeKeyedHash('device', effectiveDeviceId).slice(0, 48);
        const legacyWinDoc = await getFirestoreDoc(
          firebaseConfig,
          idToken,
          'device_signup_windows',
          legacyWindowHash,
        );
        if (legacyWinDoc.exists) {
          ops.push({
            opType: 'delete',
            collection: 'device_signup_windows',
            docId: legacyWindowHash,
          });
        }
        inMemoryDeviceSignups24h.delete(legacyWindowHash);
      }

      if (ops.length > 0) {
        await commitFirestoreWrites(firebaseConfig, idToken, ops);
      }
      inMemoryRegisteredDevices.delete(deviceHash);
      inMemoryDeviceSignups24h.delete(deviceHash);

      res.json({
        ok: true,
        deviceHash,
        deviceId: effectiveDeviceId,
        registeredUid:
          existingReg.data && typeof existingReg.data.registeredUid === 'string'
            ? existingReg.data.registeredUid
            : '',
      });
    } catch (err) {
      console.error('Failed to reset device lock:', err);
      res.status(500).json({ error: 'Could not reset device right now.' });
    }
  });

  app.post('/api/admin/hospitals/:id/review', requireAdminAuth, async (req: AuthenticatedRequest, res) => {
    const adminUid = req.authUser!.uid;
    const idToken = req.idToken!;
    const hospitalId = cleanStr(req.params.id, 128);
    const body = (req.body || {}) as Record<string, unknown>;
    const status = body.status;
    const reviewNote = cleanStr(body.reviewNote, 300);

    if (!/^[a-zA-Z0-9_\-]+$/.test(hospitalId)) {
      res.status(400).json({ error: 'Invalid hospital ID.' });
      return;
    }
    if (status !== 'approved' && status !== 'rejected' && status !== 'pending') {
      res.status(400).json({ error: 'Status must be approved, rejected, or pending.' });
      return;
    }

    try {
      const existing = await getFirestoreDoc(firebaseConfig, idToken, 'hospitals', hospitalId);
      if (!existing.exists || !existing.data) {
        res.status(404).json({ error: 'Hospital or blood bank registration not found.' });
        return;
      }

      await commitFirestoreWrites(firebaseConfig, idToken, [
        {
          collection: 'hospitals',
          docId: hospitalId,
          fields: {
            status,
            reviewNote,
            reviewedBy: adminUid,
          },
          isCreate: false,
          updateMaskFields: ['status', 'reviewNote', 'reviewedBy'],
          serverTimestampFields: ['reviewedAt', 'updatedAt'],
        },
      ]);

      res.json({ ok: true, status });
    } catch (err) {
      console.error('Failed to review hospital:', err);
      res.status(500).json({ error: 'Could not update hospital approval status right now.' });
    }
  });

  app.post('/api/admin/users/:uid/role', requireAdminAuth, async (req: AuthenticatedRequest, res) => {
    const adminUid = req.authUser!.uid;
    const idToken = req.idToken!;
    const targetUid = cleanStr(req.params.uid, 128);
    const body = (req.body || {}) as Record<string, unknown>;
    const targetRole = body.role;

    if (!/^[a-zA-Z0-9_\-]+$/.test(targetUid)) {
      res.status(400).json({ error: 'Invalid user ID.' });
      return;
    }
    if (!isValidUserRole(targetRole)) {
      res.status(400).json({ error: 'Role must be donor, requester, hospital, or admin.' });
      return;
    }

    try {
      const [existingRole, userPub] = await Promise.all([
        getFirestoreDoc(firebaseConfig, idToken, 'user_roles', targetUid),
        getFirestoreDoc(firebaseConfig, idToken, 'users_public', targetUid),
      ]);

      const username = cleanStr(
        String(userPub.data?.username || existingRole.data?.username || ''),
        24,
      );
      const email = cleanStr(String(existingRole.data?.email || ''), 150);

      await commitFirestoreWrites(firebaseConfig, idToken, [
        {
          collection: 'user_roles',
          docId: targetUid,
          fields: {
            uid: targetUid,
            email,
            username,
            role: targetRole,
            assignedBy: adminUid,
          },
          isCreate: !existingRole.exists,
          updateMaskFields: existingRole.exists ? ['role', 'email', 'username', 'assignedBy'] : undefined,
          serverTimestampFields: existingRole.exists ? ['updatedAt'] : ['createdAt', 'updatedAt'],
        },
      ]);

      res.json({ ok: true, uid: targetUid, role: targetRole });
    } catch (err) {
      console.error('Failed to assign user role:', err);
      res.status(500).json({ error: 'Could not update user role right now.' });
    }
  });

  app.post(
    '/api/admin/accounts/:uid/moderate',
    requireAdminAuth,
    async (req: AuthenticatedRequest, res) => {
      const adminUid = req.authUser!.uid;
      const idToken = req.idToken!;
      const targetUid = cleanStr(req.params.uid, 128);
      const body = (req.body || {}) as Record<string, unknown>;
      const action =
        body.action === 'approve' || body.action === 'suspend' || body.action === 'restore'
          ? body.action
          : null;
      const reviewNote = cleanStr(body.reviewNote, 300);

      if (!/^[a-zA-Z0-9_\-]+$/.test(targetUid)) {
        res.status(400).json({ error: 'Invalid user ID.' });
        return;
      }
      if (!action) {
        res.status(400).json({ error: 'Action must be approve, suspend, or restore.' });
        return;
      }
      if (action === 'suspend' && targetUid === adminUid) {
        res.status(400).json({ error: 'You cannot suspend your own admin account.' });
        return;
      }

      const nextStatus: AccountModerationStatus =
        action === 'suspend' ? 'suspended' : 'active';

      try {
        const [modDoc, userPubDoc, roleDoc, donorPubDoc] = await Promise.all([
          getFirestoreDoc(firebaseConfig, idToken, 'account_moderation', targetUid),
          getFirestoreDoc(firebaseConfig, idToken, 'users_public', targetUid),
          getFirestoreDoc(firebaseConfig, idToken, 'user_roles', targetUid),
          getFirestoreDoc(firebaseConfig, idToken, 'donors_public', targetUid),
        ]);

        const ops: CommitWriteOp[] = [];
        if (!modDoc.exists) {
          ops.push({
            collection: 'account_moderation',
            docId: targetUid,
            fields: {
              uid: targetUid,
              username: cleanStr(String(userPubDoc.data?.username || roleDoc.data?.username || ''), 24),
              email: cleanStr(String(roleDoc.data?.email || ''), 150),
              status: nextStatus,
              requiresAdminReview: false,
              deviceFlagged: false,
              ipFlagged: false,
              reportedFlagged: action === 'suspend',
              flagReasons: action === 'suspend' ? ['admin_action'] : [],
              deviceSignupCount24h: 0,
              ipSignupCount24h: 0,
              lastDeviceId: '',
              lastIpHash: '',
              reviewNote,
              reviewedBy: adminUid,
              flaggedAt: null,
            },
            isCreate: true,
            serverTimestampFields: ['reviewedAt', 'createdAt', 'updatedAt'],
          });
        } else {
          const existing = normalizeAccountModeration(modDoc.data!, targetUid);
          ops.push({
            collection: 'account_moderation',
            docId: targetUid,
            fields: {
              status: nextStatus,
              requiresAdminReview: false,
              reportedFlagged: existing.reportedFlagged,
              flagReasons: existing.flagReasons,
              reviewNote,
              reviewedBy: adminUid,
            },
            isCreate: false,
            updateMaskFields: [
              'status',
              'requiresAdminReview',
              'reportedFlagged',
              'flagReasons',
              'reviewNote',
              'reviewedBy',
            ],
            serverTimestampFields: ['reviewedAt', 'updatedAt'],
          });
        }

        if (action === 'suspend' && donorPubDoc.exists) {
          ops.push({
            collection: 'donors_public',
            docId: targetUid,
            fields: {
              visibleInSearch: false,
              searchActiveAfterMs: HIDDEN_SEARCH_SENTINEL_MS,
              contactPreference: 'hidden',
            },
            isCreate: false,
            updateMaskFields: ['visibleInSearch', 'searchActiveAfterMs', 'contactPreference'],
            serverTimestampFields: ['updatedAt'],
          });
        }

        await commitFirestoreWrites(firebaseConfig, idToken, ops);
        res.json({ ok: true, uid: targetUid, status: nextStatus });
      } catch (err) {
        console.error('Failed to moderate account:', err);
        res.status(500).json({ error: 'Could not update account moderation status right now.' });
      }
    },
  );

  app.post('/api/admin/reports/:id/review', requireAdminAuth, async (req: AuthenticatedRequest, res) => {
    const adminUid = req.authUser!.uid;
    const idToken = req.idToken!;
    const reportId = cleanStr(req.params.id, 128);
    const body = (req.body || {}) as Record<string, unknown>;
    const action =
      body.action === 'approve_dismiss' ||
      body.action === 'suspend_user' ||
      body.action === 'restore_user'
        ? body.action
        : null;
    const reviewNote = cleanStr(body.reviewNote, 300);

    if (!/^[a-zA-Z0-9_\-]+$/.test(reportId)) {
      res.status(400).json({ error: 'Invalid report ID.' });
      return;
    }
    if (!action) {
      res.status(400).json({ error: 'Action must be approve_dismiss, suspend_user, or restore_user.' });
      return;
    }

    try {
      const reportDoc = await getFirestoreDoc(firebaseConfig, idToken, 'reports', reportId);
      if (!reportDoc.exists || !reportDoc.data) {
        res.status(404).json({ error: 'Report not found.' });
        return;
      }

      const report = normalizeAbuseReport(reportDoc.data, reportId);
      const nextReportStatus =
        action === 'suspend_user'
          ? 'suspended'
          : action === 'restore_user'
            ? 'restored'
            : 'approved_dismissed';

      if (action === 'suspend_user' && report.targetUid === adminUid) {
        res.status(400).json({ error: 'You cannot suspend your own admin account.' });
        return;
      }

      const ops: CommitWriteOp[] = [
        {
          collection: 'reports',
          docId: reportId,
          fields: {
            status: nextReportStatus,
            reviewNote,
            reviewedBy: adminUid,
          },
          isCreate: false,
          updateMaskFields: ['status', 'reviewNote', 'reviewedBy'],
          serverTimestampFields: ['reviewedAt', 'updatedAt'],
        },
      ];

      if ((action === 'suspend_user' || action === 'restore_user') && report.targetUid) {
        const targetUid = report.targetUid;
        const [modDoc, userPubDoc, roleDoc, donorPubDoc] = await Promise.all([
          getFirestoreDoc(firebaseConfig, idToken, 'account_moderation', targetUid),
          getFirestoreDoc(firebaseConfig, idToken, 'users_public', targetUid),
          getFirestoreDoc(firebaseConfig, idToken, 'user_roles', targetUid),
          getFirestoreDoc(firebaseConfig, idToken, 'donors_public', targetUid),
        ]);

        const nextModStatus: AccountModerationStatus =
          action === 'suspend_user' ? 'suspended' : 'active';

        if (!modDoc.exists) {
          ops.push({
            collection: 'account_moderation',
            docId: targetUid,
            fields: {
              uid: targetUid,
              username: cleanStr(
                String(userPubDoc.data?.username || roleDoc.data?.username || report.targetUsername || ''),
                24,
              ),
              email: cleanStr(String(roleDoc.data?.email || ''), 150),
              status: nextModStatus,
              requiresAdminReview: false,
              deviceFlagged: false,
              ipFlagged: false,
              reportedFlagged: true,
              flagReasons: ['reported'],
              deviceSignupCount24h: 0,
              ipSignupCount24h: 0,
              lastDeviceId: '',
              lastIpHash: '',
              reviewNote,
              reviewedBy: adminUid,
              flaggedAt: null,
            },
            isCreate: true,
            serverTimestampFields: ['reviewedAt', 'createdAt', 'updatedAt'],
          });
        } else {
          const existingMod = normalizeAccountModeration(modDoc.data!, targetUid);
          const reasons = Array.from(new Set([...existingMod.flagReasons, 'reported'])).slice(0, 20);
          ops.push({
            collection: 'account_moderation',
            docId: targetUid,
            fields: {
              status: nextModStatus,
              requiresAdminReview: false,
              reportedFlagged: true,
              flagReasons: reasons,
              reviewNote,
              reviewedBy: adminUid,
            },
            isCreate: false,
            updateMaskFields: [
              'status',
              'requiresAdminReview',
              'reportedFlagged',
              'flagReasons',
              'reviewNote',
              'reviewedBy',
            ],
            serverTimestampFields: ['reviewedAt', 'updatedAt'],
          });
        }

        if (action === 'suspend_user' && donorPubDoc.exists) {
          ops.push({
            collection: 'donors_public',
            docId: targetUid,
            fields: {
              visibleInSearch: false,
              searchActiveAfterMs: HIDDEN_SEARCH_SENTINEL_MS,
              contactPreference: 'hidden',
            },
            isCreate: false,
            updateMaskFields: ['visibleInSearch', 'searchActiveAfterMs', 'contactPreference'],
            serverTimestampFields: ['updatedAt'],
          });
        }
      }

      await commitFirestoreWrites(firebaseConfig, idToken, ops);
      res.json({ ok: true, status: nextReportStatus });
    } catch (err) {
      console.error('Failed to review report:', err);
      res.status(500).json({ error: 'Could not update report status right now.' });
    }
  });

  // Vite dev middleware or static production serving
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist'));
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`PulseLine server listening on http://0.0.0.0:${port}`);
  });
}

void startServer();
