import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
  commitFirestoreWrites,
  computeApproxAreaCoords,
  generateFirestoreId,
  getFirestoreDoc,
  queryFirestoreCollection,
  type CommitWriteOp,
  type FirestoreConfig,
} from './server/firestoreRest.ts';
import {
  computeEligibility,
  HIDDEN_SEARCH_SENTINEL_MS,
  isFutureDateStr,
  normalizeDonorPublic,
} from './src/lib/eligibility.ts';
import { BLOOD_GROUPS, type BloodGroup } from './src/types.ts';

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
}

interface AuthenticatedRequest extends Request {
  authUser?: AuthenticatedUser;
  idToken?: string;
}

async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token.' });
    return;
  }
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    if (!decoded.email_verified) {
      res.status(403).json({ error: 'Verified email account is required.' });
      return;
    }
    req.authUser = {
      uid: decoded.uid,
      email: typeof decoded.email === 'string' ? decoded.email : '',
      name: typeof decoded.name === 'string' ? decoded.name : '',
    };
    req.idToken = token;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired authentication token.' });
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

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, serverTimeMs: Date.now() });
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

  // Server-side Donor Profile Save: splits PII into donors_private and projects sanitized donors_public
  app.put('/api/donor/profile', requireAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const idToken = req.idToken!;
    const body = (req.body || {}) as Record<string, unknown>;

    const displayName = cleanStr(body.displayName, 100);
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
    const contactPreference = body.contactPreference === 'email' ? 'email' : 'phone';
    const lastDonationDate = cleanStr(body.lastDonationDate, 10);
    const visibleInSearch = Boolean(body.visibleInSearch);
    const exactLat = parseCoord(body.exactLat, -90, 90);
    const exactLng = parseCoord(body.exactLng, -180, 180);

    if (displayName.length < 1) {
      res.status(400).json({ error: 'Name is required.' });
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
    if (contactPreference === 'phone' && phone.replace(/[^0-9+]/g, '').length < 7) {
      res.status(400).json({ error: 'A valid phone number is required when phone is your preferred contact.' });
      return;
    }
    if (contactPreference === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'A valid email address is required when email is your preferred contact.' });
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
    const preferredContactType = !visibleInSearch ? 'hidden' : contactPreference;
    const preferredContactValue = !visibleInSearch
      ? ''
      : contactPreference === 'email'
        ? email
        : phone;
    const searchActiveAfterMs = visibleInSearch
      ? eligibility.eligibleAfterMs
      : HIDDEN_SEARCH_SENTINEL_MS;

    // Server-side coordinate anonymization: exact coords stay in donors_private only
    const { approxLat, approxLng } = computeApproxAreaCoords(uid, exactLat, exactLng);

    try {
      const [existingPublic, existingPrivate] = await Promise.all([
        getFirestoreDoc(firebaseConfig, idToken, 'donors_public', uid),
        getFirestoreDoc(firebaseConfig, idToken, 'donors_private', uid),
      ]);

      const publicFields: Record<string, unknown> = {
        uid,
        displayName,
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
        preferredContactType,
        preferredContactValue,
        approxLat,
        approxLng,
      };

      const privateFields: Record<string, unknown> = {
        uid,
        phone,
        email,
        contactPreference,
        lastDonationDate,
        exactLat,
        exactLng,
      };

      const ops: CommitWriteOp[] = [
        {
          collection: 'donors_public',
          docId: uid,
          fields: publicFields,
          isCreate: !existingPublic.exists,
          updateMaskFields: existingPublic.exists
            ? Object.keys(publicFields).filter((k) => k !== 'uid')
            : undefined,
          serverTimestampFields: existingPublic.exists ? ['updatedAt'] : ['createdAt', 'updatedAt'],
        },
        {
          collection: 'donors_private',
          docId: uid,
          fields: privateFields,
          isCreate: !existingPrivate.exists,
          updateMaskFields: existingPrivate.exists
            ? Object.keys(privateFields).filter((k) => k !== 'uid')
            : undefined,
          serverTimestampFields: existingPrivate.exists ? ['updatedAt'] : ['createdAt', 'updatedAt'],
        },
      ];

      await commitFirestoreWrites(firebaseConfig, idToken, ops);
      res.json({ ok: true, eligibility });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to save donor profile.',
      });
    }
  });

  // Server-side Donor Search: enforces 90-day eligibility, visibleInSearch, and returns ONLY preferred contact + approx coords
  app.get('/api/donors/search', requireAuth, async (req: AuthenticatedRequest, res) => {
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
          if (d.preferredContactType === 'hidden' || !d.preferredContactValue) return false;
          if (bloodGroupFilter && d.bloodGroup !== bloodGroupFilter) return false;
          if (countryCodeFilter && d.countryCode.toUpperCase() !== countryCodeFilter) return false;
          if (stateCodeFilter && d.stateCode.toUpperCase() !== stateCodeFilter) return false;
          if (cityFilter && d.city.toLowerCase() !== cityFilter) return false;
          if (localityFilter && !d.locality.toLowerCase().includes(localityFilter)) return false;
          return true;
        })
        .map((d) => ({
          uid: d.uid,
          displayName: d.displayName,
          bloodGroup: d.bloodGroup,
          countryCode: d.countryCode,
          countryName: d.countryName,
          stateCode: d.stateCode,
          stateName: d.stateName,
          city: d.city,
          locality: d.locality,
          pincode: d.pincode,
          preferredContactType: d.preferredContactType,
          preferredContactValue: d.preferredContactValue,
          approxLat: d.approxLat,
          approxLng: d.approxLng,
        }));

      res.json({ donors, serverTimeMs: serverNow });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to search donors.',
      });
    }
  });

  // Server-side Emergency Request Create + Same-Locality-First Donor Notifications
  app.post('/api/requests', requireAuth, async (req: AuthenticatedRequest, res) => {
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
    const createdByName = cleanStr(req.authUser!.name, 100) || req.authUser!.email || 'Community Member';

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
      await commitFirestoreWrites(firebaseConfig, idToken, [
        {
          collection: 'emergency_requests',
          docId: requestId,
          fields: {
            createdBy: uid,
            createdByName,
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
          city: donor.city, // Exact city match required by Firestore rule
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
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to post emergency request.',
      });
    }
  });

  // Server-side Request Fulfillment (Creator Only)
  app.post('/api/requests/:id/fulfill', requireAuth, async (req: AuthenticatedRequest, res) => {
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

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to mark request as fulfilled.',
      });
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
