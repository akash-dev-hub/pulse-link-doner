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
  computeEligibility,
  createEmptyInventory,
  HIDDEN_SEARCH_SENTINEL_MS,
  isFutureDateStr,
  isValidUsername,
  isValidUserRole,
  normalizeDonorPrivate,
  normalizeDonorPublic,
  normalizeHospitalProfile,
  normalizeInventory,
  normalizeUsernameInput,
  normalizeUserRoleRecord,
  rankHospitals,
  sanitizeUsernameCandidate,
} from './src/lib/eligibility.ts';
import { BLOOD_GROUPS, type BloodGroup, type UserRole } from './src/types.ts';

const BOOTSTRAP_ADMIN_EMAIL = 'akshuboi123@gmail.com';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const firebaseConfigRaw = fs.readFileSync(
  path.join(__dirname, 'firebase-applet-config.json'),
  'utf8',
);
const firebaseConfig = JSON.parse(firebaseConfigRaw) as FirestoreConfig;

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
  next();
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

  return {
    uid,
    fullName,
    phone,
    email,
    contactPreference: 'chat',
    lastDonationDate: priv?.lastDonationDate || '',
    exactLat: priv?.exactLat ?? null,
    exactLng: priv?.exactLng ?? null,
  };
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

  // Account bootstrap + automatic legacy donor PII migration + role resolution
  app.get('/api/account/me', requireSignedIn, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const emailVerified = req.authUser!.emailVerified;
    const idToken = req.idToken!;

    try {
      const [userPub, donorPub, roleDoc, hospitalDoc] = await Promise.all([
        getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'donors_public', uid),
        emailVerified ? getFirestoreDoc(firebaseConfig, idToken, 'user_roles', uid) : Promise.resolve({ exists: false, data: null }),
        getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid),
      ]);

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
      if (currentUsername && donorPub.exists && donorPub.data && (hasLegacyPublicFields(donorPub.data) || !donorPriv.data?.fullName)) {
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
      const [claimDoc, existingUserPub, existingPublic, existingPrivate, roleState] = await Promise.all([
        getFirestoreDoc(firebaseConfig, idToken, 'usernames', username),
        getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'donors_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'donors_private', uid),
        resolveUserRoleState(idToken, req.authUser!),
      ]);

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

  // Server-side Emergency Request Create + Same-Locality-First Donor Notifications
  app.post('/api/requests', requireVerifiedAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const body = (req.body || {}) as Record<string, unknown>;

    const bloodGroup = body.bloodGroup;
    const units = Number(body.units);
    const hospitalName = cleanStr(body.hospitalName, 120);
    const countryCode = cleanStr(body.countryCode, 4).toUpperCase() || 'IN';
    const countryName = cleanStr(body.countryName, 100) || 'India';
    const stateCode = cleanStr(body.stateCode, 16);
    const stateName = cleanStr(body.stateName, 100);
    const city = cleanStr(body.city, 100);
    const locality = cleanStr(body.locality, 120);
    const pincode = cleanStr(body.pincode, 16);
    const hospitalLat = parseCoord(body.hospitalLat, -90, 90);
    const hospitalLng = parseCoord(body.hospitalLng, -180, 180);
    const contact = cleanStr(body.contact, 150);
    const notes = cleanStr(body.notes, 300);

    if (!isValidBloodGroup(bloodGroup)) {
      res.status(400).json({ error: 'Please select a valid blood group.' });
      return;
    }
    if (!Number.isInteger(units) || units < 1 || units > 100) {
      res.status(400).json({ error: 'Units must be a whole number of at least 1.' });
      return;
    }
    if (hospitalName.length < 2) {
      res.status(400).json({ error: 'Hospital name is required (at least 2 characters).' });
      return;
    }
    if (city.length < 1) {
      res.status(400).json({ error: 'Hospital city is required.' });
      return;
    }
    if (countryCode === 'IN' && pincode && !/^\d{6}$/.test(pincode)) {
      res.status(400).json({ error: 'Indian PIN code must be 6 digits.' });
      return;
    }
    if (contact.length < 3) {
      res.status(400).json({ error: 'Hospital or requester contact is required.' });
      return;
    }

    const requestId = generateFirestoreId('req');
    const serverNow = Date.now();

    try {
      const roleState = await resolveUserRoleState(idToken, req.authUser!);
      if (roleState.role === 'hospital') {
        const hospitalDoc = await getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid);
        if (!hospitalDoc.exists || hospitalDoc.data?.status !== 'approved') {
          res.status(403).json({
            error: 'Your hospital or blood bank must be approved by an admin before posting emergency requests.',
          });
          return;
        }
      }

      // Never store poster's real Google name or email on public emergency request docs — use username
      const userPubDoc = await getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid);
      const posterUsername =
        userPubDoc.exists && typeof userPubDoc.data?.username === 'string' && userPubDoc.data.username
          ? userPubDoc.data.username
          : `member_${uid.slice(0, 6)}`;

      await commitFirestoreWrites(firebaseConfig, idToken, [
        {
          collection: 'emergency_requests',
          docId: requestId,
          fields: {
            createdBy: uid,
            createdByName: posterUsername,
            bloodGroup,
            units,
            hospitalName,
            countryCode,
            countryName,
            stateCode,
            stateName,
            city,
            locality,
            pincode,
            hospitalLat,
            hospitalLng,
            contact,
            notes,
            status: 'active',
            fulfilledAt: null,
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

      // Find eligible, visible donors with same blood group in the same city
      const donorDocs = await queryFirestoreCollection(
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

      const cityLower = city.toLowerCase();
      const localityLower = locality.toLowerCase();

      const matchingDonors = donorDocs
        .map(({ id, data }) => normalizeDonorPublic(data, id))
        .filter((d) => {
          if (d.uid === uid) return false;
          if (!d.visibleInSearch) return false;
          if (d.eligibleAfterMs > serverNow) return false;
          if (d.bloodGroup !== bloodGroup) return false;
          if (d.city.toLowerCase() !== cityLower) return false;
          return true;
        })
        .map((d) => {
          const sameLocality =
            Boolean(localityLower) &&
            Boolean(d.locality) &&
            d.locality.toLowerCase() === localityLower;
          return { donor: d, sameLocality };
        })
        .sort((a, b) => Number(b.sameLocality) - Number(a.sameLocality));

      const notifOps: CommitWriteOp[] = matchingDonors.slice(0, 100).map(({ donor, sameLocality }) => ({
        collection: 'notifications',
        docId: generateFirestoreId('ntf'),
        fields: {
          recipientId: donor.uid,
          senderId: uid,
          requestId,
          bloodGroup,
          units,
          hospitalName,
          city: donor.city,
          locality,
          stateName,
          countryName,
          contact,
          hospitalLat,
          hospitalLng,
          sameLocality,
          read: false,
        },
        isCreate: true,
        serverTimestampFields: ['createdAt'],
      }));

      if (notifOps.length > 0) {
        await commitFirestoreWrites(firebaseConfig, idToken, notifOps);
      }

      const sameLocalityCount = matchingDonors.filter((m) => m.sameLocality).length;
      res.status(201).json({
        ok: true,
        requestId,
        notifiedCount: notifOps.length,
        sameLocalityCount,
      });
    } catch (err) {
      console.error('Failed to post emergency request:', err);
      res.status(500).json({
        error: 'Could not post your emergency request right now. Please try again.',
      });
    }
  });

  // Server-side Request Fulfillment (Creator Only)
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
      const [roleState, userPubDoc, existingHospital] = await Promise.all([
        resolveUserRoleState(idToken, req.authUser!),
        getFirestoreDoc(firebaseConfig, idToken, 'users_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'hospitals', uid),
      ]);

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

  // --- Admin Endpoints (Admin Role Strictly Required) ---

  app.get('/api/admin/overview', requireAdminAuth, async (req: AuthenticatedRequest, res) => {
    const idToken = req.idToken!;
    try {
      const [hospitalDocs, roleDocs] = await Promise.all([
        queryFirestoreCollection(firebaseConfig, idToken, 'hospitals', undefined, 300),
        queryFirestoreCollection(firebaseConfig, idToken, 'user_roles', undefined, 300),
      ]);

      const hospitals = hospitalDocs
        .map(({ id, data }) => normalizeHospitalProfile(data, id))
        .sort((a, b) => b.createdAtMs - a.createdAtMs);
      const users = roleDocs
        .map(({ id, data }) => normalizeUserRoleRecord(data, id))
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs);

      res.json({ hospitals, users });
    } catch (err) {
      console.error('Failed to load admin overview:', err);
      res.status(500).json({ error: 'Could not load admin dashboard right now.' });
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
