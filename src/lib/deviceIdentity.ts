import type { User } from 'firebase/auth';
import type { AccountModerationStatus, AuthEventType } from '../types.ts';

const DEVICE_ID_STORAGE_KEY = 'pulseline_device_id';
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{12,64}$/;

function generateRandomDeviceId(): string {
  if (typeof window !== 'undefined' && window.crypto) {
    if (typeof window.crypto.randomUUID === 'function') {
      return `dev_${window.crypto.randomUUID().replace(/-/g, '')}`;
    }
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `dev_${hex}`;
  }
  const rand = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `dev_${rand.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24).padEnd(16, '0')}`;
}

export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') {
    return generateRandomDeviceId();
  }
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && DEVICE_ID_PATTERN.test(existing)) {
      return existing;
    }
    const created = generateRandomDeviceId();
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return generateRandomDeviceId();
  }
}

export async function precheckDeviceSignup(consentAccepted: boolean): Promise<{
  ok: boolean;
  code?: string;
  error?: string;
}> {
  try {
    const deviceId = getOrCreateDeviceId();
    const res = await fetch('/api/auth/signup-precheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, consentAccepted }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      code?: string;
      error?: string;
    };
    if (!res.ok || !body.ok) {
      return {
        ok: false,
        code: body.code,
        error: body.error || 'Could not verify this device for registration.',
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not reach the verification server. Please try again.' };
  }
}

export async function signupWithServerGate(
  email: string,
  password: string,
  consentAccepted: boolean,
): Promise<{
  ok: boolean;
  code?: string;
  error?: string;
  verificationSent?: boolean;
  ipFlagged?: boolean;
  moderationStatus?: AccountModerationStatus;
}> {
  try {
    const deviceId = getOrCreateDeviceId();
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, deviceId, consentAccepted }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      code?: string;
      error?: string;
      verificationSent?: boolean;
      ipFlagged?: boolean;
      moderationStatus?: AccountModerationStatus;
    };
    if (!res.ok || !body.ok) {
      return {
        ok: false,
        code: body.code,
        error: body.error || 'Could not create your account right now.',
      };
    }
    return {
      ok: true,
      verificationSent: Boolean(body.verificationSent),
      ipFlagged: Boolean(body.ipFlagged),
      moderationStatus: body.moderationStatus,
    };
  } catch {
    return {
      ok: false,
      error: 'Could not reach the signup server right now. Please try again.',
    };
  }
}

export async function postAuthAuditEvent(
  user: User,
  eventType: AuthEventType,
  consentAccepted: boolean,
): Promise<{
  ok: boolean;
  code?: string;
  error?: string;
  directSignupBlocked?: boolean;
  moderationStatus?: AccountModerationStatus;
  deviceFlagged?: boolean;
  ipFlagged?: boolean;
}> {
  try {
    const token = await user.getIdToken();
    const deviceId = getOrCreateDeviceId();
    const res = await fetch('/api/auth/record', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        eventType,
        deviceId,
        consentAccepted,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      code?: string;
      error?: string;
      directSignupBlocked?: boolean;
      moderationStatus?: AccountModerationStatus;
      deviceFlagged?: boolean;
      ipFlagged?: boolean;
    };
    if (!res.ok || !body.ok) {
      return {
        ok: false,
        code: body.code,
        error: body.error || 'Could not verify sign-in.',
        directSignupBlocked: Boolean(body.directSignupBlocked),
      };
    }
    return {
      ok: true,
      moderationStatus: body.moderationStatus,
      deviceFlagged: body.deviceFlagged,
      ipFlagged: body.ipFlagged,
    };
  } catch {
    return { ok: false, error: 'Could not verify sign-in right now.' };
  }
}
