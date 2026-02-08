'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import type { Stroke } from '@/lib/types';

const COLORS = ['#e94560', '#ff9f43', '#feca57', '#48dbfb', '#0abde3', '#ffffff'];
const SIZES = [3, 6, 12];

interface AnnotationOverlayProps {
  imageDataUrl: string;
  onDone: (annotatedBlob: Blob) => void;
  onCancel: () => void;
}

export default function AnnotationOverlay({ imageDataUrl, onDone, onCancel }: AnnotationOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(SIZES[1]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);

  const [imgLayout, setImgLayout] = useState({ x: 0, y: 0, w: 0, h: 0 });

  // Compute image layout (object-fit: contain)
  const computeLayout = useCallback(() => {
    const container = containerRef.current;
    const img = imgRef.current;
    if (!container || !img || !img.naturalWidth) return;

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    const scale = Math.min(cw / iw, ch / ih);
    const w = iw * scale;
    const h = ih * scale;
    const x = (cw - w) / 2;
    const y = (ch - h) / 2;

    setImgLayout({ x, y, w, h });

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = cw;
      canvas.height = ch;
      canvas.style.width = cw + 'px';
      canvas.style.height = ch + 'px';
    }
  }, []);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    const onLoad = () => computeLayout();
    img.addEventListener('load', onLoad);
    window.addEventListener('resize', computeLayout);

    if (img.complete) computeLayout();

    return () => {
      img.removeEventListener('load', onLoad);
      window.removeEventListener('resize', computeLayout);
    };
  }, [computeLayout]);

  // Redraw all strokes
  const redraw = useCallback(
    (allStrokes: Stroke[], active: Stroke | null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const drawStroke = (s: Stroke) => {
        if (s.points.length < 2) return;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(s.points[0].x, s.points[0].y);

        for (let i = 1; i < s.points.length - 1; i++) {
          const midX = (s.points[i].x + s.points[i + 1].x) / 2;
          const midY = (s.points[i].y + s.points[i + 1].y) / 2;
          ctx.quadraticCurveTo(s.points[i].x, s.points[i].y, midX, midY);
        }

        const last = s.points[s.points.length - 1];
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
      };

      allStrokes.forEach(drawStroke);
      if (active) drawStroke(active);
    },
    []
  );

  useEffect(() => {
    redraw(strokes, currentStroke);
  }, [strokes, currentStroke, redraw]);

  // Pointer event handlers
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.setPointerCapture(e.pointerId);

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setCurrentStroke({ color, size, points: [{ x, y }] });
    },
    [color, size]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!currentStroke) return;
      e.preventDefault();

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setCurrentStroke((prev) =>
        prev ? { ...prev, points: [...prev.points, { x, y }] } : null
      );
    },
    [currentStroke]
  );

  const handlePointerUp = useCallback(() => {
    if (currentStroke && currentStroke.points.length >= 2) {
      setStrokes((prev) => [...prev, currentStroke]);
    }
    setCurrentStroke(null);
  }, [currentStroke]);

  const handleUndo = () => {
    setStrokes((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    setStrokes([]);
  };

  const handleDone = () => {
    const img = imgRef.current;
    if (!img) return;

    // Export at original image resolution
    const offscreen = document.createElement('canvas');
    offscreen.width = img.naturalWidth;
    offscreen.height = img.naturalHeight;
    const ctx = offscreen.getContext('2d')!;

    ctx.drawImage(img, 0, 0);

    // Scale strokes from display coords to image coords
    const scaleX = img.naturalWidth / imgLayout.w;
    const scaleY = img.naturalHeight / imgLayout.h;

    strokes.forEach((s) => {
      if (s.points.length < 2) return;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size * Math.max(scaleX, scaleY);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();

      const toImgX = (px: number) => (px - imgLayout.x) * scaleX;
      const toImgY = (py: number) => (py - imgLayout.y) * scaleY;

      ctx.moveTo(toImgX(s.points[0].x), toImgY(s.points[0].y));

      for (let i = 1; i < s.points.length - 1; i++) {
        const midX = (toImgX(s.points[i].x) + toImgX(s.points[i + 1].x)) / 2;
        const midY = (toImgY(s.points[i].y) + toImgY(s.points[i + 1].y)) / 2;
        ctx.quadraticCurveTo(toImgX(s.points[i].x), toImgY(s.points[i].y), midX, midY);
      }

      const last = s.points[s.points.length - 1];
      ctx.lineTo(toImgX(last.x), toImgY(last.y));
      ctx.stroke();
    });

    offscreen.toBlob(
      (blob) => {
        if (blob) onDone(blob);
      },
      'image/jpeg',
      0.7
    );
  };

  return (
    <div className="annotation-overlay">
      <div className="annotation-toolbar">
        <button onClick={onCancel}>Cancel</button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleUndo} disabled={strokes.length === 0}>
            Undo
          </button>
          <button onClick={handleClear} disabled={strokes.length === 0}>
            Clear
          </button>
        </div>
        <button className="done-btn" onClick={handleDone}>
          Done
        </button>
      </div>

      <div className="annotation-tools">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`color-swatch${color === c ? ' active' : ''}`}
            style={{ backgroundColor: c }}
            onClick={() => setColor(c)}
          />
        ))}
        <div className="tools-divider" />
        {SIZES.map((s) => (
          <button
            key={s}
            className={`brush-size${size === s ? ' active' : ''}`}
            onClick={() => setSize(s)}
          >
            <div className="brush-dot" style={{ width: s + 2, height: s + 2 }} />
          </button>
        ))}
      </div>

      <div className="annotation-canvas-area" ref={containerRef}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={imgRef} src={imageDataUrl} alt="Annotation base" />
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{ touchAction: 'none' }}
        />
      </div>
    </div>
  );
}
