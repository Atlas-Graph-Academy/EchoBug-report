'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

interface MemoryRecord {
  id: string;
  object: string;
  time: string;
  createdAt: string;
}

interface DisplayMemoryRecord {
  keyText: string;
  timeText: string;
}

const CSV_PATH = '/echo-memories-2026-02-15.csv';

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        const next = content[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function mapRecords(rows: string[][]): MemoryRecord[] {
  if (!rows.length) return [];

  const header = rows[0];
  const idIndex = header.indexOf('id');
  const objectIndex = header.indexOf('object');
  const timeIndex = header.indexOf('time');
  const createdAtIndex = header.indexOf('created_at');

  return rows
    .slice(1)
    .filter((row) => row.some((value) => value.trim().length > 0))
    .map((row) => ({
      id: idIndex >= 0 ? (row[idIndex] ?? '').trim() : '',
      object: objectIndex >= 0 ? (row[objectIndex] ?? '').trim() : '',
      time: timeIndex >= 0 ? (row[timeIndex] ?? '').trim() : '',
      createdAt: createdAtIndex >= 0 ? (row[createdAtIndex] ?? '').trim() : '',
    }));
}

function formatTime(value: string): string {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
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

function trimToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;

  const ellipsis = '...';
  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${text.slice(0, mid)}${ellipsis}`;

    if (ctx.measureText(candidate).width <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return `${text.slice(0, low)}${ellipsis}`;
}

export default function MemoryPreviewCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch(CSV_PATH);
        if (!response.ok) throw new Error(`Failed to load memory CSV (${response.status})`);

        const content = await response.text();
        const parsedRows = parseCsv(content);
        setRecords(mapRecords(parsedRows));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to read memory data';
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  const displayRecords = useMemo<DisplayMemoryRecord[]>(() => {
    return records.map((record) => {
      const keyValue = record.object || record.id || 'Unknown';
      const timeValue = formatTime(record.time || record.createdAt);

      return {
        keyText: keyValue,
        timeText: timeValue,
      };
    });
  }, [records]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const spacer = spacerRef.current;

    if (!container || !canvas || !spacer) return;

    const render = () => {
      rafRef.current = null;

      const width = container.clientWidth;
      const height = container.clientHeight;
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const background = ctx.createLinearGradient(0, 0, width, height);
      background.addColorStop(0, '#0e162d');
      background.addColorStop(1, '#0b1e2e');
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);

      if (!displayRecords.length) {
        spacer.style.height = '0px';
        return;
      }

      const padding = 16;
      const gap = 10;
      const itemHeight = 62;
      const minItemWidth = 220;
      const columns = Math.max(1, Math.floor((width - padding * 2 + gap) / (minItemWidth + gap)));
      const itemWidth = (width - padding * 2 - gap * (columns - 1)) / columns;
      const rowHeight = itemHeight + gap;
      const totalRows = Math.ceil(displayRecords.length / columns);
      const contentHeight = padding * 2 + totalRows * rowHeight - gap;

      spacer.style.height = `${Math.max(contentHeight, height)}px`;

      const scrollTop = container.scrollTop;
      const startRow = Math.max(0, Math.floor((scrollTop - padding) / rowHeight) - 2);
      const endRow = Math.min(totalRows - 1, Math.ceil((scrollTop + height - padding) / rowHeight) + 2);

      ctx.textBaseline = 'top';

      for (let row = startRow; row <= endRow; row += 1) {
        for (let col = 0; col < columns; col += 1) {
          const index = row * columns + col;
          if (index >= displayRecords.length) break;

          const x = padding + col * (itemWidth + gap);
          const y = padding + row * rowHeight - scrollTop;

          const glow = ctx.createLinearGradient(x, y, x + itemWidth, y + itemHeight);
          glow.addColorStop(0, 'rgba(95, 197, 255, 0.22)');
          glow.addColorStop(1, 'rgba(99, 246, 180, 0.2)');

          ctx.save();
          ctx.shadowBlur = 20;
          ctx.shadowColor = 'rgba(82, 233, 214, 0.25)';
          ctx.fillStyle = glow;
          roundRectPath(ctx, x, y, itemWidth, itemHeight, 20);
          ctx.fill();
          ctx.restore();

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
          ctx.lineWidth = 1;
          roundRectPath(ctx, x, y, itemWidth, itemHeight, 20);
          ctx.stroke();

          const contentWidth = itemWidth - 24;
          const record = displayRecords[index];

          ctx.font = '600 13px "Segoe UI", sans-serif';
          ctx.fillStyle = '#e7f6ff';
          const keyText = `Key: ${trimToWidth(ctx, record.keyText, contentWidth - 35)}`;
          ctx.fillText(keyText, x + 12, y + 12);

          ctx.font = '500 12px "Segoe UI", sans-serif';
          ctx.fillStyle = 'rgba(234, 247, 255, 0.78)';
          const timeText = `Time: ${trimToWidth(ctx, record.timeText, contentWidth - 40)}`;
          ctx.fillText(timeText, x + 12, y + 35);
        }
      }
    };

    const requestRender = () => {
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(render);
    };

    requestRender();
    container.addEventListener('scroll', requestRender, { passive: true });
    window.addEventListener('resize', requestRender);

    return () => {
      container.removeEventListener('scroll', requestRender);
      window.removeEventListener('resize', requestRender);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = null;
    };
  }, [displayRecords]);

  if (loading) {
    return <div className="memory-status">Loading memory data...</div>;
  }

  if (error) {
    return <div className="memory-status memory-error">{error}</div>;
  }

  return (
    <div className="memory-canvas-wrapper">
      <div className="memory-canvas-meta">
        <h2>Memory Canvas</h2>
        <span>{displayRecords.length} memories</span>
      </div>
      <div className="memory-canvas-scroll" ref={containerRef}>
        <div ref={spacerRef} className="memory-canvas-spacer" />
        <canvas ref={canvasRef} className="memory-canvas" />
      </div>
    </div>
  );
}
