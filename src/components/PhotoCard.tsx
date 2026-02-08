'use client';

import type { Photo } from '@/lib/types';

interface PhotoCardProps {
  photo: Photo;
  onDelete: (id: number) => void;
  onClick: (photo: Photo) => void;
}

export default function PhotoCard({ photo, onDelete, onClick }: PhotoCardProps) {
  return (
    <div className="photo-card" onClick={() => onClick(photo)}>
      <img src={photo.dataUrl} alt={photo.name || 'Photo'} loading="lazy" />
      <button
        className="delete-btn"
        title="Remove"
        onClick={(e) => {
          e.stopPropagation();
          if (photo.id != null) onDelete(photo.id);
        }}
      >
        &times;
      </button>
    </div>
  );
}
