'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { usePhotos } from '@/hooks/usePhotos';
import { useToast } from '@/components/Toast';
import LoginScreen from '@/components/LoginScreen';
import AppShell from '@/components/AppShell';
import PhotoGrid from '@/components/PhotoGrid';
import ActionBar from '@/components/ActionBar';
import AnnotationOverlay from '@/components/AnnotationOverlay';
import BugReportSheet from '@/components/BugReportSheet';
import SuccessOverlay from '@/components/SuccessOverlay';
import Toast from '@/components/Toast';
import type { Photo, CreatedIssue } from '@/lib/types';

type AppFlow = 'idle' | 'annotating' | 'reporting' | 'success';

export default function Home() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading, error, login, logout, getAccessToken } = useAuth();
  const { photos, addPhotos, deletePhoto } = usePhotos();
  const showToast = useToast();

  const [flow, setFlow] = useState<AppFlow>('idle');
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [annotatedBlob, setAnnotatedBlob] = useState<Blob | null>(null);
  const [annotatedPreview, setAnnotatedPreview] = useState<string>('');
  const [createdIssue, setCreatedIssue] = useState<CreatedIssue | null>(null);

  // Photo card click → open annotation
  const handlePhotoClick = useCallback((photo: Photo) => {
    setSelectedPhoto(photo);
    setFlow('annotating');
  }, []);

  // Camera/album files selected
  const handleFilesSelected = useCallback(
    async (files: FileList) => {
      const added = await addPhotos(files);
      if (added.length > 0) {
        showToast(`${added.length} photo${added.length > 1 ? 's' : ''} added`);
        // Auto-open annotation for last added photo
        const lastPhoto = added[added.length - 1];
        setSelectedPhoto(lastPhoto);
        setFlow('annotating');
      }
    },
    [addPhotos, showToast]
  );

  // Delete photo
  const handleDeletePhoto = useCallback(
    async (id: number) => {
      await deletePhoto(id);
      showToast('Photo removed');
    },
    [deletePhoto, showToast]
  );

  // Annotation done → open bug report
  const handleAnnotationDone = useCallback((blob: Blob) => {
    setAnnotatedBlob(blob);
    const url = URL.createObjectURL(blob);
    setAnnotatedPreview(url);
    setFlow('reporting');
  }, []);

  // Annotation cancel
  const handleAnnotationCancel = useCallback(() => {
    setSelectedPhoto(null);
    setFlow('idle');
  }, []);

  // Bug report close
  const handleReportClose = useCallback(() => {
    setFlow('idle');
    setAnnotatedBlob(null);
    if (annotatedPreview) URL.revokeObjectURL(annotatedPreview);
    setAnnotatedPreview('');
    setSelectedPhoto(null);
  }, [annotatedPreview]);

  // Issue created
  const handleSuccess = useCallback(
    (issue: CreatedIssue) => {
      setCreatedIssue(issue);
      setFlow('success');
      if (annotatedPreview) URL.revokeObjectURL(annotatedPreview);
      setAnnotatedPreview('');
      setAnnotatedBlob(null);
      setSelectedPhoto(null);
    },
    [annotatedPreview]
  );

  // Dismiss success
  const handleDismissSuccess = useCallback(() => {
    setCreatedIssue(null);
    setFlow('idle');
  }, []);

  const handleOpenMemoryPrompt = useCallback(() => {
    router.push('/memory-preview');
  }, [router]);

  const handleOpenWaitlistDashboard = useCallback(() => {
    router.push('/waitlist/dashboard');
  }, [router]);

  // Loading state
  if (isLoading) {
    return (
      <div className="login-screen">
        <div className="login-spinner" />
      </div>
    );
  }

  // Not authenticated
  if (!isAuthenticated || !user) {
    return (
      <>
        <LoginScreen onLogin={login} error={error} isLoading={false} />
        <Toast />
      </>
    );
  }

  return (
    <>
      <AppShell
        user={user}
        photoCount={photos.length}
        onOpenWaitlist={handleOpenWaitlistDashboard}
        onLogout={logout}
      >
        <PhotoGrid
          photos={photos}
          onDelete={handleDeletePhoto}
          onPhotoClick={handlePhotoClick}
        />
      </AppShell>

      <ActionBar
        onFilesSelected={handleFilesSelected}
        onMemoryPreview={handleOpenMemoryPrompt}
      />

      {/* Annotation overlay */}
      {flow === 'annotating' && selectedPhoto && (
        <AnnotationOverlay
          imageDataUrl={selectedPhoto.dataUrl}
          onDone={handleAnnotationDone}
          onCancel={handleAnnotationCancel}
        />
      )}

      {/* Bug report sheet */}
      {flow === 'reporting' && annotatedBlob && (
        <BugReportSheet
          annotatedBlob={annotatedBlob}
          previewUrl={annotatedPreview}
          getAccessToken={getAccessToken}
          onClose={handleReportClose}
          onSuccess={handleSuccess}
        />
      )}

      {/* Success overlay */}
      {flow === 'success' && createdIssue && (
        <SuccessOverlay issue={createdIssue} onDismiss={handleDismissSuccess} />
      )}

      <Toast />
    </>
  );
}
