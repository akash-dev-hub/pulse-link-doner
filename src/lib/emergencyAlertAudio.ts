import { coerceUrgencyLevel, URGENCY_LABELS } from './eligibility.ts';
import type { AppNotification } from '../types.ts';

let sharedAudioCtx: AudioContext | null = null;
let alarmIntervalId: number | null = null;
let pulseTimeouts: number[] = [];
const activeOscillators = new Set<OscillatorNode>();

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return w.AudioContext || w.webkitAudioContext || null;
}

function getOrCreateAudioContext(): AudioContext | null {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new Ctor();
  }
  return sharedAudioCtx;
}

function playTone(
  ctx: AudioContext,
  freqHz: number,
  startOffsetSec: number,
  durationSec: number,
  volume: number,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freqHz, ctx.currentTime + startOffsetSec);

  const startTime = ctx.currentTime + startOffsetSec;
  const endTime = startTime + durationSec;

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

  osc.connect(gain);
  gain.connect(ctx.destination);

  activeOscillators.add(osc);
  osc.onended = () => {
    activeOscillators.delete(osc);
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {
      // ignore disconnect errors
    }
  };

  osc.start(startTime);
  osc.stop(endTime + 0.02);
}

export type BrowserNotificationPermission = NotificationPermission | 'unsupported';

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function unlockEmergencyAudio(playConfirmChime = false): Promise<boolean> {
  const ctx = getOrCreateAudioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    if (playConfirmChime) {
      playTone(ctx, 523.25, 0, 0.09, 0.06);
      playTone(ctx, 659.25, 0.11, 0.12, 0.06);
    } else {
      // Silent 1-sample unlock for browsers after page reload
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    }
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

function triggerAlarmCycle(): void {
  const ctx = getOrCreateAudioContext();
  if (!ctx) return;

  const scheduleCycle = () => {
    playTone(ctx, 880, 0, 0.18, 0.22);
    playTone(ctx, 1174.66, 0.24, 0.18, 0.22);
    playTone(ctx, 880, 0.48, 0.2, 0.22);
  };

  if (ctx.state === 'suspended') {
    void ctx
      .resume()
      .then(() => {
        if (alarmIntervalId !== null) {
          scheduleCycle();
        }
      })
      .catch(() => undefined);
    return;
  }

  scheduleCycle();
}

export function startLoopingAlarm(): void {
  stopLoopingAlarm();
  if (typeof window === 'undefined') return;

  triggerAlarmCycle();
  alarmIntervalId = window.setInterval(() => {
    triggerAlarmCycle();
  }, 1250);
}

export function stopLoopingAlarm(): void {
  if (typeof window !== 'undefined' && alarmIntervalId !== null) {
    window.clearInterval(alarmIntervalId);
  }
  alarmIntervalId = null;

  for (const t of pulseTimeouts) {
    window.clearTimeout(t);
  }
  pulseTimeouts = [];

  for (const osc of Array.from(activeOscillators)) {
    try {
      osc.stop();
      osc.disconnect();
    } catch {
      // already stopped
    }
  }
  activeOscillators.clear();
}

export function showEmergencyBrowserNotification(
  alert: AppNotification,
  onClickFocus: () => void,
): Notification | null {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return null;
  }
  if (Notification.permission !== 'granted') {
    return null;
  }

  try {
    const urgencyLevel = coerceUrgencyLevel(alert.urgency, 'urgent');
    const locationText = [alert.locality, alert.city].filter(Boolean).join(', ');
    const title = `${URGENCY_LABELS[urgencyLevel]}: ${alert.bloodGroup} blood needed`;
    const body = `${alert.hospitalName}${locationText ? ` · ${locationText}` : ''} (${alert.units} ${alert.units === 1 ? 'unit' : 'units'})`;

    const notification = new Notification(title, {
      body,
      tag: `pulseline-emergency-${alert.requestId}`,
      requireInteraction: true,
    });

    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // ignore focus error
      }
      onClickFocus();
      notification.close();
    };

    return notification;
  } catch {
    return null;
  }
}
