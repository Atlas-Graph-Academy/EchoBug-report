'use client';

import { useRef } from 'react';

interface ActionBarProps {
  onFilesSelected: (files: FileList) => void;
  onMemoryPreview: () => void;
}

export default function ActionBar({ onFilesSelected, onMemoryPreview }: ActionBarProps) {
  const albumRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      onFilesSelected(e.target.files);
    }
    e.target.value = '';
  };

  return (
    <div className="action-bar action-bar-triple">
      <button className="action-btn btn-secondary" onClick={() => albumRef.current?.click()}>
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
        Album
      </button>
      <button className="action-btn btn-primary" onClick={() => cameraRef.current?.click()}>
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
        Camera
      </button>
      <button className="action-btn btn-memory" onClick={onMemoryPreview}>
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 9h10M7 13h7M7 17h5" />
        </svg>
        Memory Preview
      </button>
      <input
        ref={albumRef}
        type="file"
        className="hidden-input"
        accept="image/*"
        multiple
        onChange={handleChange}
      />
      <input
        ref={cameraRef}
        type="file"
        className="hidden-input"
        accept="image/*"
        capture="environment"
        onChange={handleChange}
      />
    </div>
  );
}
