import type { ThankYouCard } from '../types.ts';

export interface ThankYouCardRenderInput {
  card: ThankYouCard;
  donorDisplayName: string;
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = words[0];

  for (let i = 1; i < words.length; i += 1) {
    const candidate = `${current} ${words[i]}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function formatDonationDateLabel(dateStr: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr || 'Completed';
  }
  const [y, m, d] = dateStr.split('-').map((n) => Number(n));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return dateStr;
  return dt.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function renderThankYouCardCanvas({
  card,
  donorDisplayName,
}: ThankYouCardRenderInput): HTMLCanvasElement {
  const width = 1200;
  const height = 760;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context is not available in this browser.');
  }

  // Outer mat background (slate-50)
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, width, height);

  // Card surface
  const cardX = 56;
  const cardY = 56;
  const cardW = width - 112;
  const cardH = height - 112;

  drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 24);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#e2e8f0';
  ctx.stroke();

  // Top crimson accent bar clipped inside rounded corners
  ctx.save();
  drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 24);
  ctx.clip();
  ctx.fillStyle = '#dc2626';
  ctx.fillRect(cardX, cardY, cardW, 14);
  ctx.restore();

  // Header row: PulseLine emblem + title + Blood group badge
  const padX = cardX + 64;
  const headerY = cardY + 64;

  // Emblem circle
  drawRoundedRect(ctx, padX, headerY, 48, 48, 12);
  ctx.fillStyle = '#fef2f2';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#fecaca';
  ctx.stroke();

  // Droplet / cross vector mark inside emblem
  ctx.fillStyle = '#dc2626';
  ctx.beginPath();
  ctx.moveTo(padX + 24, headerY + 11);
  ctx.bezierCurveTo(padX + 33, headerY + 21, padX + 35, headerY + 27, padX + 35, headerY + 30);
  ctx.arc(padX + 24, headerY + 30, 11, 0, Math.PI, false);
  ctx.bezierCurveTo(padX + 13, headerY + 27, padX + 15, headerY + 21, padX + 24, headerY + 11);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#0f172a';
  ctx.font = '700 22px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('PulseLine', padX + 64, headerY + 4);

  ctx.fillStyle = '#64748b';
  ctx.font = '600 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('DONATION APPRECIATION CARD', padX + 64, headerY + 30);

  // Blood group pill on top-right
  const bgW = 128;
  const bgH = 58;
  const bgX = cardX + cardW - 64 - bgW;
  const bgY = headerY - 4;
  drawRoundedRect(ctx, bgX, bgY, bgW, bgH, 14);
  ctx.fillStyle = '#fef2f2';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fecaca';
  ctx.stroke();

  ctx.fillStyle = '#b91c1c';
  ctx.font = '700 30px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(card.bloodGroup, bgX + bgW / 2, bgY + bgH / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  // Divider
  ctx.strokeStyle = '#f1f5f9';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padX, headerY + 78);
  ctx.lineTo(cardX + cardW - 64, headerY + 78);
  ctx.stroke();

  // Main "Thank You" & Donor Name
  const bodyY = headerY + 112;
  ctx.fillStyle = '#dc2626';
  ctx.font = '700 16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('THANK YOU', padX, bodyY);

  const safeName = (donorDisplayName || '').trim() || `@${card.donorUsername}`;
  ctx.fillStyle = '#0f172a';
  ctx.font = '700 44px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(safeName, padX, bodyY + 32, cardW - 128);

  const showHandleSub =
    safeName.toLowerCase() !== `@${card.donorUsername}`.toLowerCase();
  if (showHandleSub) {
    ctx.fillStyle = '#64748b';
    ctx.font = '500 18px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    ctx.fillText(`@${card.donorUsername}`, padX, bodyY + 86);
  }

  // Thank-you message
  const msgY = showHandleSub ? bodyY + 132 : bodyY + 106;
  ctx.fillStyle = '#334155';
  ctx.font = '400 24px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const lines = wrapTextLines(ctx, card.message, cardW - 128).slice(0, 4);
  lines.forEach((line, index) => {
    ctx.fillText(line, padX, msgY + index * 36);
  });

  // Details Grid (Hospital + Date)
  const metaY = cardY + cardH - 186;
  const metaH = 104;
  const metaW = cardW - 128;

  drawRoundedRect(ctx, padX, metaY, metaW, metaH, 14);
  ctx.fillStyle = '#f8fafc';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#e2e8f0';
  ctx.stroke();

  const colDividerX = padX + Math.floor(metaW * 0.62);
  ctx.beginPath();
  ctx.moveTo(colDividerX, metaY + 18);
  ctx.lineTo(colDividerX, metaY + metaH - 18);
  ctx.stroke();

  // Left column: Hospital Name
  ctx.fillStyle = '#64748b';
  ctx.font = '600 13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('VERIFIED HOSPITAL / BLOOD BANK', padX + 24, metaY + 22);

  ctx.fillStyle = '#0f172a';
  ctx.font = '700 22px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(card.hospitalName, padX + 24, metaY + 48, colDividerX - padX - 44);

  // Right column: Donation Date
  ctx.fillStyle = '#64748b';
  ctx.font = '600 13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('DONATION DATE', colDividerX + 24, metaY + 22);

  ctx.fillStyle = '#0f172a';
  ctx.font = '700 22px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(
    formatDonationDateLabel(card.donationDate),
    colDividerX + 24,
    metaY + 48,
    padX + metaW - colDividerX - 40,
  );

  // Footer note (explicitly zero patient details)
  ctx.fillStyle = '#64748b';
  ctx.font = '500 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(
    'Private donor appreciation record · No patient details included',
    padX,
    cardY + cardH - 46,
  );

  ctx.textAlign = 'right';
  ctx.font = '500 14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  ctx.fillText(card.donationDate || '', cardX + cardW - 64, cardY + cardH - 46);
  ctx.textAlign = 'left';

  return canvas;
}

export async function downloadThankYouCardPng(
  input: ThankYouCardRenderInput,
): Promise<void> {
  const canvas = renderThankYouCardCanvas(input);
  const safeDate = (input.card.donationDate || 'donation').replace(/[^0-9-]/g, '') || 'donation';
  const safeBg = input.card.bloodGroup.replace('+', 'pos').replace('-', 'neg');
  const filename = `pulseline-thank-you-${safeBg}-${safeDate}.png`;

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/png');
  });

  if (blob) {
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return;
  }

  const dataUrl = canvas.toDataURL('image/png');
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
