'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

interface MemoryRecord {
  id: string;
  object: string;
  time: string;
  createdAt: string;
}

interface DisplayMemoryRecord {
  label: string;
}

interface PillLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  glow: string;
  text: string;
}

const CSV_PATH = '/echo-memories-2026-02-15.csv';

const PALETTE = [
  { color: '#ff9f43', glow: 'rgba(255,159,67,0.45)' },
  { color: '#f368e0', glow: 'rgba(243,104,224,0.45)' },
  { color: '#00d2d3', glow: 'rgba(0,210,211,0.45)' },
  { color: '#54a0ff', glow: 'rgba(84,160,255,0.45)' },
  { color: '#feca57', glow: 'rgba(254,202,87,0.45)' },
  { color: '#a29bfe', glow: 'rgba(162,155,254,0.45)' },
  { color: '#1dd1a1', glow: 'rgba(29,209,161,0.45)' },
  { color: '#ff6b81', glow: 'rgba(255,107,129,0.45)' },
];

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
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
  if (!value) return 'Unknown';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
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
  const layoutsRef = useRef<PillLayout[]>([]);
  const totalHeightRef = useRef(0);

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
      const shortTime = formatTime(record.time || record.createdAt);
      return { label: `${keyValue} · ${shortTime}` };
    });
  }, [records]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const spacer = spacerRef.current;

    if (!container || !canvas || !spacer) return;

    const buildLayout = (ctx: CanvasRenderingContext2D, width: number) => {
      const horizontalPadding = 14;
      const verticalPadding = 14;
      const gapX = 8;
      const gapY = 10;
      const pillHeight = 34;
      const maxPillWidth = Math.min(280, width - horizontalPadding * 2);
      const minPillWidth = 90;

      ctx.font = '600 16px "Avenir Next", "Segoe UI", sans-serif';

      const layouts: PillLayout[] = [];
      let cursorX = horizontalPadding;
      let cursorY = verticalPadding;

      displayRecords.forEach((item, index) => {
        const textWidth = ctx.measureText(item.label).width;
        const widthByText = Math.ceil(textWidth + 28);
        const pillWidth = Math.max(minPillWidth, Math.min(maxPillWidth, widthByText));

        if (cursorX + pillWidth > width - horizontalPadding && cursorX > horizontalPadding) {
          cursorX = horizontalPadding;
          cursorY += pillHeight + gapY;
        }

        const palette = PALETTE[index % PALETTE.length];
        layouts.push({
          x: cursorX,
          y: cursorY,
          width: pillWidth,
          height: pillHeight,
          color: palette.color,
          glow: palette.glow,
          text: item.label,
        });

        cursorX += pillWidth + gapX;
      });

      layoutsRef.current = layouts;
      totalHeightRef.current = cursorY + pillHeight + verticalPadding;
      spacer.style.height = `${Math.max(totalHeightRef.current, container.clientHeight)}px`;
    };

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
      background.addColorStop(0, '#070a14');
      background.addColorStop(1, '#080e1f');
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);

      if (!displayRecords.length) {
        spacer.style.height = `${height}px`;
        return;
      }

      buildLayout(ctx, width);

      const scrollTop = container.scrollTop;
      const visibleTop = scrollTop - 80;
      const visibleBottom = scrollTop + height + 80;

      ctx.textBaseline = 'middle';
      ctx.font = '600 16px "Avenir Next", "Segoe UI", sans-serif';

      for (let i = 0; i < layoutsRef.current.length; i += 1) {
        const pill = layoutsRef.current[i];
        const yOnCanvas = pill.y - scrollTop;
        const bottom = pill.y + pill.height;

        if (bottom < visibleTop || pill.y > visibleBottom) continue;

        const fill = ctx.createLinearGradient(pill.x, yOnCanvas, pill.x + pill.width, yOnCanvas + pill.height);
        fill.addColorStop(0, 'rgba(255,255,255,0.06)');
        fill.addColorStop(1, 'rgba(255,255,255,0.02)');

        ctx.save();
        ctx.shadowBlur = 12;
        ctx.shadowColor = pill.glow;
        ctx.fillStyle = fill;
        roundRectPath(ctx, pill.x, yOnCanvas, pill.width, pill.height, 999);
        ctx.fill();
        ctx.restore();

        ctx.strokeStyle = pill.color;
        ctx.lineWidth = 1.1;
        roundRectPath(ctx, pill.x, yOnCanvas, pill.width, pill.height, 999);
        ctx.stroke();

        ctx.fillStyle = pill.color;
        const maxTextWidth = pill.width - 20;
        const text = trimToWidth(ctx, pill.text, maxTextWidth);
        ctx.fillText(text, pill.x + 10, yOnCanvas + pill.height / 2);
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
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
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
        <h2>Memory Stream</h2>
        <span>{displayRecords.length} pills</span>
      </div>
      <div className="memory-canvas-scroll" ref={containerRef}>
        <div ref={spacerRef} className="memory-canvas-spacer" />
        <canvas ref={canvasRef} className="memory-canvas" />
      </div>
    </div>
  );
}
