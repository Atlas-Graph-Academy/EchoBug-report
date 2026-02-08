'use client';

import type { Photo } from '@/lib/types';
import PhotoCard from './PhotoCard';

interface PhotoGridProps {
  photos: Photo[];
  onDelete: (id: number) => void;
  onPhotoClick: (photo: Photo) => void;
}

export default function PhotoGrid({ photos, onDelete, onPhotoClick }: PhotoGridProps) {
  if (photos.length === 0) {
    return (
      <div className="empty-state">
        <svg width="80" height="80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
        <p>No photos yet.<br />Tap a button below to pick from your album or take a new photo.</p>
      </div>
    );
  }

  return (
    <div className="photo-grid">
      {photos.map((photo) => (
        <PhotoCard
          key={photo.id}
          photo={photo}
          onDelete={onDelete}
          onClick={onPhotoClick}
        />
      ))}
    </div>
  );
}
