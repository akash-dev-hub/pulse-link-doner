import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { Award, Building2, Calendar, Download, Eye, Loader2, Lock, X } from 'lucide-react';
import { normalizeThankYouCard } from '../lib/eligibility.ts';
import { db } from '../lib/firebase.ts';
import {
  downloadThankYouCardPng,
  formatDonationDateLabel,
} from '../lib/thankYouCardPng.ts';
import type { ThankYouCard } from '../types.ts';

interface ThankYouCardPreviewModalProps {
  card: ThankYouCard | null;
  donorDisplayName: string;
  downloading: boolean;
  onDownload: (card: ThankYouCard) => void;
  onClose: () => void;
}

export function ThankYouCardPreviewModal({
  card,
  donorDisplayName,
  downloading,
  onDownload,
  onClose,
}: ThankYouCardPreviewModalProps) {
  if (!card) return null;

  const displayName = donorDisplayName.trim() || `@${card.donorUsername}`;
  const showHandle = displayName.toLowerCase() !== `@${card.donorUsername}`.toLowerCase();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="thank-you-modal-title"
    >
      <div className="bg-white border border-slate-200 rounded-2xl max-w-xl w-full overflow-hidden">
        <div className="h-2 bg-red-600 w-full" />

        <div className="p-6 sm:p-8 space-y-6">
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center shrink-0">
                <Award className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-red-700">
                  Donation Appreciation Card
                </p>
                <h2 id="thank-you-modal-title" className="text-lg font-bold text-slate-900">
                  Thank You from {card.hospitalName}
                </h2>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono-tabular text-base font-bold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1">
                {card.bloodGroup}
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close card preview"
                className="min-h-[38px] min-w-[38px] rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Presented to
            </p>
            <div>
              <p className="text-2xl font-bold text-slate-900">{displayName}</p>
              {showHandle && (
                <p className="text-xs font-mono-tabular text-slate-500 mt-0.5">
                  @{card.donorUsername}
                </p>
              )}
            </div>
            <p className="text-sm text-slate-700 leading-relaxed pt-1">{card.message}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-slate-50 border border-slate-200 rounded-xl p-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Hospital / Blood Bank
              </p>
              <p className="text-sm font-semibold text-slate-900 mt-1">{card.hospitalName}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Donation Date
              </p>
              <p className="text-sm font-semibold text-slate-900 mt-1">
                {formatDonationDateLabel(card.donationDate)}
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
              <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              Visible only to you · No patient details
            </span>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[40px] px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold rounded-lg"
              >
                Close
              </button>
              <button
                type="button"
                disabled={downloading}
                onClick={() => onDownload(card)}
                className="min-h-[40px] px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5"
              >
                {downloading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                Download PNG
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ThankYouCardSectionProps {
  user: User;
  donorFullName: string;
  onNotify: (type: 'success' | 'error', message: string) => void;
}

export function ThankYouCardSection({
  user,
  donorFullName,
  onNotify,
}: ThankYouCardSectionProps) {
  const [cards, setCards] = useState<ThankYouCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewCard, setPreviewCard] = useState<ThankYouCard | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const q = query(
      collection(db, 'thank_you_cards'),
      where('donorUid', '==', user.uid),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => normalizeThankYouCard(d.data() as Record<string, unknown>, d.id))
          .sort((a, b) => {
            if (b.donationDate !== a.donationDate) {
              return b.donationDate.localeCompare(a.donationDate);
            }
            return b.createdAtMs - a.createdAtMs;
          });
        setCards(list);
        setLoading(false);
      },
      (err) => {
        console.error('Failed to load Thank You cards:', err);
        setLoading(false);
      },
    );

    return () => unsub();
  }, [user.uid]);

  const resolvedDonorName =
    donorFullName.trim() ||
    (user.displayName ? user.displayName.trim() : '');

  const handleDownload = async (card: ThankYouCard) => {
    setDownloadingId(card.id);
    try {
      await downloadThankYouCardPng({
        card,
        donorDisplayName: resolvedDonorName || `@${card.donorUsername}`,
      });
      onNotify('success', 'Thank You card downloaded as PNG.');
    } catch (err) {
      console.error('Failed to generate Thank You card PNG:', err);
      onNotify('error', 'Could not download the Thank You card PNG. Please try again.');
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
            <Award className="w-4 h-4 text-red-600 shrink-0" />
            My Thank You Cards
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            Created automatically when a hospital marks your verified donation completed. Only you can view or download these cards, and they never contain patient details.
          </p>
        </div>
        {cards.length > 0 && (
          <span className="self-start sm:self-auto font-mono-tabular text-xs font-semibold px-2.5 py-1 rounded-md bg-slate-100 text-slate-800 border border-slate-200">
            {cards.length} {cards.length === 1 ? 'card' : 'cards'}
          </span>
        )}
      </div>

      {loading ? (
        <div className="h-24 bg-slate-50 border border-slate-100 rounded-lg" />
      ) : cards.length === 0 ? (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-600">
          No Thank You cards yet. After you complete a verified blood donation at an approved hospital, your downloadable Thank You card will appear here.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cards.map((card) => {
            const nameOnCard = resolvedDonorName || `@${card.donorUsername}`;
            const isBusy = downloadingId === card.id;
            return (
              <article
                key={card.id}
                className="border border-slate-200 rounded-xl overflow-hidden bg-white flex flex-col justify-between"
              >
                <div className="h-1.5 bg-red-600 w-full" />
                <div className="p-4 space-y-3 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-red-700">
                        Thank You
                      </p>
                      <h3 className="text-base font-bold text-slate-900 mt-0.5">
                        {nameOnCard}
                      </h3>
                    </div>
                    <span className="font-mono-tabular text-sm font-bold text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-1 shrink-0">
                      {card.bloodGroup}
                    </span>
                  </div>

                  <p className="text-xs text-slate-700 leading-relaxed">{card.message}</p>

                  <div className="space-y-1 text-xs text-slate-600 pt-1">
                    <div className="flex items-center gap-1.5">
                      <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="font-medium text-slate-800">{card.hospitalName}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span>{formatDonationDateLabel(card.donationDate)}</span>
                    </div>
                  </div>
                </div>

                <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                    <Lock className="w-3 h-3 text-slate-400" />
                    Private to you
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPreviewCard(card)}
                      className="min-h-[36px] px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-100 text-slate-800 text-xs font-semibold rounded-lg flex items-center gap-1.5"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      View
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleDownload(card)}
                      className="min-h-[36px] px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5"
                    >
                      {isBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                      Download PNG
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ThankYouCardPreviewModal
        card={previewCard}
        donorDisplayName={resolvedDonorName}
        downloading={Boolean(previewCard && downloadingId === previewCard.id)}
        onDownload={(card) => void handleDownload(card)}
        onClose={() => setPreviewCard(null)}
      />
    </section>
  );
}
