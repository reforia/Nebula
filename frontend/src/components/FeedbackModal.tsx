import { useState } from 'react';
import Modal from './Modal';
import { submitFeedback, type FeedbackData } from '../api/client';

const TYPES: { value: FeedbackData['type']; label: string }[] = [
  { value: 'bug', label: 'Bug Report' },
  { value: 'feature', label: 'Feature Request' },
  { value: 'feedback', label: 'General Feedback' },
  { value: 'support', label: 'Support' },
];

export default function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<FeedbackData['type']>('feedback');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!message.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await submitFeedback({
        type,
        subject: subject.trim() || undefined,
        message: message.trim(),
        metadata: { page: window.location.pathname },
      });
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || 'Failed to submit feedback');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} size="sm">
      {submitted ? (
        <div className="text-center py-4">
          <div className="text-2xl mb-2">&#10003;</div>
          <h2 className="text-base font-medium mb-1">Thanks for your feedback!</h2>
          <p className="text-nebula-muted text-xs mb-4">We'll review it and get back to you if needed.</p>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-nebula-accent text-nebula-bg rounded-lg font-medium hover:brightness-110 transition-all"
          >
            Close
          </button>
        </div>
      ) : (
        <>
          <h2 className="text-base font-medium mb-3">Send Feedback</h2>

          {/* Type selector */}
          <div className="flex gap-1.5 mb-3">
            {TYPES.map(t => (
              <button
                key={t.value}
                onClick={() => setType(t.value)}
                className={`flex-1 py-1.5 text-[11px] rounded-lg border transition-colors ${
                  type === t.value
                    ? 'bg-nebula-accent/10 border-nebula-accent/30 text-nebula-accent'
                    : 'bg-nebula-bg border-nebula-border text-nebula-muted hover:text-nebula-text'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Subject */}
          <input
            type="text"
            placeholder="Subject (optional)"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            className="w-full p-2.5 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text mb-2 focus:outline-none focus:border-nebula-accent/50 transition-colors"
          />

          {/* Message */}
          <textarea
            placeholder="Describe your feedback, bug, or idea..."
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={5}
            className="w-full p-2.5 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text mb-3 resize-none focus:outline-none focus:border-nebula-accent/50 transition-colors"
            autoFocus
          />

          {error && <p role="alert" className="text-nebula-red text-xs mb-2">{error}</p>}

          <div className="flex gap-2 justify-end">
            <button
              onClick={onClose}
              className="px-3 py-2 text-xs text-nebula-muted hover:text-nebula-text transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!message.trim() || submitting}
              className="px-4 py-2 text-xs bg-nebula-accent text-nebula-bg rounded-lg font-medium hover:brightness-110 disabled:opacity-30 transition-all"
            >
              {submitting ? 'Sending...' : 'Send'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
