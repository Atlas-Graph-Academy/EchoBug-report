'use client';

import type { CreatedIssue } from '@/lib/types';

interface SuccessOverlayProps {
  issue: CreatedIssue;
  onDismiss: () => void;
}

export default function SuccessOverlay({ issue, onDismiss }: SuccessOverlayProps) {
  return (
    <div className="success-overlay" onClick={onDismiss}>
      <div className="success-checkmark">
        <svg width="40" height="40" fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth="3">
          <path d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h2>Issue Created</h2>
      <p>{issue.identifier}: {issue.title}</p>
      <a
        className="success-link"
        href={issue.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        Open in Linear
      </a>
      <div className="success-dismiss">Tap anywhere to dismiss</div>
    </div>
  );
}
