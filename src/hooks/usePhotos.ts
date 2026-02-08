'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Photo } from '@/lib/types';
import { dbAdd, dbGetAll, dbDelete, openDB } from '@/lib/db';

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function usePhotos() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    openDB()
      .then(() => dbGetAll())
      .then((all) => setPhotos(all))
      .finally(() => setLoading(false));
  }, []);

  const addPhotos = useCallback(async (files: FileList | File[]): Promise<Photo[]> => {
    const added: Photo[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const dataUrl = await readFileAsDataURL(file);
      const record = { name: file.name, dataUrl, createdAt: Date.now() };
      const id = await dbAdd(record);
      const photo = { ...record, id };
      added.push(photo);
    }
    if (added.length > 0) {
      setPhotos((prev) => [...prev, ...added]);
    }
    return added;
  }, []);

  const deletePhoto = useCallback(async (id: number) => {
    await dbDelete(id);
    setPhotos((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return { photos, addPhotos, deletePhoto, loading };
}
