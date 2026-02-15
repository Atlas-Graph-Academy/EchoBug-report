'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import NarrativeGraph from '@/components/NarrativeGraph';
import ClusterGraph from '@/components/ClusterGraph';
import { buildNarrativeChains, type MemoryNode, type EmbeddingsData } from '@/lib/narrative';

interface MemoryRecord {
  id: string;
  object: string;
  category: string;
  emotion: string;
  description: string;
  details: string;
  visibility: string;
  location: string;
  time: string;
  createdAt: string;
}

interface DisplayMemoryRecord {
  keyText: string;
  shortTimeText: string;
  createdTimeText: string;
  category: string;
  object: string;
  emotion: string;
  visibility: string;
  description: string;
  details: string;
  color: string;
  glow: string;
}

interface PillLayout {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  glow: string;
  text: string;
}

const CSV_PATH = '/echo-memories-2026-02-15.csv';
const EMBEDDINGS_PATH = '/echo-embeddings.json';

const EMOTION_PALETTE = [
  { color: '#ff9f43', glow: 'rgba(255,159,67,0.45)' },
  { color: '#f368e0', glow: 'rgba(243,104,224,0.45)' },
  { color: '#00d2d3', glow: 'rgba(0,210,211,0.45)' },
  { color: '#54a0ff', glow: 'rgba(84,160,255,0.45)' },
  { color: '#feca57', glow: 'rgba(254,202,87,0.45)' },
  { color: '#a29bfe', glow: 'rgba(162,155,254,0.45)' },
  { color: '#1dd1a1', glow: 'rgba(29,209,161,0.45)' },
  { color: '#ff6b81', glow: 'rgba(255,107,129,0.45)' },
  { color: '#7bed9f', glow: 'rgba(123,237,159,0.45)' },
  { color: '#70a1ff', glow: 'rgba(112,161,255,0.45)' },
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
  const getIndex = (name: string) => header.indexOf(name);

  const idIndex = getIndex('id');
  const objectIndex = getIndex('object');
  const categoryIndex = getIndex('category');
  const emotionIndex = getIndex('emotion');
  const descriptionIndex = getIndex('description');
  const detailsIndex = getIndex('details');
  const visibilityIndex = getIndex('visibility');
  const locationIndex = getIndex('location');
  const timeIndex = getIndex('time');
  const createdAtIndex = getIndex('created_at');

  const read = (row: string[], index: number) => (index >= 0 ? (row[index] ?? '').trim() : '');

  return rows
    .slice(1)
    .filter((row) => row.some((value) => value.trim().length > 0))
    .map((row) => ({
      id: read(row, idIndex),
      object: read(row, objectIndex),
      category: read(row, categoryIndex),
      emotion: read(row, emotionIndex),
      description: read(row, descriptionIndex),
      details: read(row, detailsIndex),
      visibility: read(row, visibilityIndex),
      location: read(row, locationIndex),
      time: read(row, timeIndex),
      createdAt: read(row, createdAtIndex),
    }));
}

function formatShortTime(value: string): string {
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

function formatCreatedTime(value: string): string {
  if (!value) return 'Unknown';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
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

function normalizeValue(value: string): string {
  return value && value.trim() ? value.trim() : 'Unknown';
}

function getTimestamp(record: MemoryRecord): number {
  const raw = record.time || record.createdAt;
  if (!raw) return 0;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return 0;
  return date.getTime();
}

function hashEmotion(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getEmotionStyle(emotion: string) {
  const key = normalizeValue(emotion).toLowerCase();
  const style = EMOTION_PALETTE[hashEmotion(key) % EMOTION_PALETTE.length];
  return style;
}

export default function MemoryPreviewCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const layoutsRef = useRef<PillLayout[]>([]);

  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [embeddingsData, setEmbeddingsData] = useState<EmbeddingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEmotion, setSelectedEmotion] = useState('All');
  const [selectedRecord, setSelectedRecord] = useState<DisplayMemoryRecord | null>(null);
  const [narrativeMemoryId, setNarrativeMemoryId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'stream' | 'constellation'>('constellation');

  useEffect(() => {
    const load = async () => {
      try {
        const [csvResponse, embResponse] = await Promise.all([
          fetch(CSV_PATH),
          fetch(EMBEDDINGS_PATH),
        ]);

        if (!csvResponse.ok) throw new Error(`Failed to load memory CSV (${csvResponse.status})`);

        const content = await csvResponse.text();
        setRecords(mapRecords(parseCsv(content)));

        if (embResponse.ok) {
          const embJson = await embResponse.json();
          setEmbeddingsData(embJson as EmbeddingsData);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to read memory data';
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  useEffect(() => {
    if (!selectedRecord) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedRecord(null);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedRecord]);

  const sortedRecords = useMemo(() => {
    return [...records].sort((a, b) => getTimestamp(b) - getTimestamp(a));
  }, [records]);

  const emotionSummary = useMemo(() => {
    const countByEmotion = new Map<string, number>();

    for (const record of sortedRecords) {
      const emotion = normalizeValue(record.emotion);
      countByEmotion.set(emotion, (countByEmotion.get(emotion) ?? 0) + 1);
    }

    return Array.from(countByEmotion.entries())
      .map(([emotion, count]) => ({ emotion, count, ...getEmotionStyle(emotion) }))
      .sort((a, b) => b.count - a.count || a.emotion.localeCompare(b.emotion));
  }, [sortedRecords]);

  const filteredRecords = useMemo(() => {
    if (selectedEmotion === 'All') return sortedRecords;
    return sortedRecords.filter((record) => normalizeValue(record.emotion) === selectedEmotion);
  }, [selectedEmotion, sortedRecords]);

  const displayRecords = useMemo<DisplayMemoryRecord[]>(() => {
    return filteredRecords.map((record) => {
      const keyText = normalizeValue(record.object || record.id);
      const createdSource = record.createdAt || record.time;
      const shortTimeText = formatShortTime(record.time || record.createdAt);
      const emotion = normalizeValue(record.emotion);
      const emotionStyle = getEmotionStyle(emotion);

      return {
        keyText,
        shortTimeText,
        createdTimeText: formatCreatedTime(createdSource),
        category: normalizeValue(record.category),
        object: normalizeValue(record.object || record.id),
        emotion,
        visibility: normalizeValue(record.visibility || record.location),
        description: normalizeValue(record.description),
        details: normalizeValue(record.details),
        color: emotionStyle.color,
        glow: emotionStyle.glow,
      };
    });
  }, [filteredRecords]);

  useEffect(() => {
    if (!selectedRecord) return;
    if (selectedEmotion === 'All') return;
    if (selectedRecord.emotion !== selectedEmotion) {
      setSelectedRecord(null);
    }
  }, [selectedEmotion, selectedRecord]);

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
        const text = `${item.keyText} · ${item.shortTimeText}`;
        const textWidth = ctx.measureText(text).width;
        const widthByText = Math.ceil(textWidth + 28);
        const pillWidth = Math.max(minPillWidth, Math.min(maxPillWidth, widthByText));

        if (cursorX + pillWidth > width - horizontalPadding && cursorX > horizontalPadding) {
          cursorX = horizontalPadding;
          cursorY += pillHeight + gapY;
        }

        layouts.push({
          index,
          x: cursorX,
          y: cursorY,
          width: pillWidth,
          height: pillHeight,
          color: item.color,
          glow: item.glow,
          text,
        });

        cursorX += pillWidth + gapX;
      });

      layoutsRef.current = layouts;
      const totalHeight = cursorY + pillHeight + verticalPadding;
      spacer.style.height = `${Math.max(totalHeight, container.clientHeight)}px`;
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
  }, [displayRecords, viewMode]);

  const memoryNodes = useMemo<MemoryNode[]>(() => {
    return sortedRecords.map(record => ({
      id: record.id,
      text: record.description || record.object,
      createdAt: record.createdAt || record.time,
      object: normalizeValue(record.object),
      category: normalizeValue(record.category),
      emotion: normalizeValue(record.emotion),
    }));
  }, [sortedRecords]);

  const narrativeContext = useMemo(() => {
    if (!narrativeMemoryId || !embeddingsData) return null;

    const currentNode = memoryNodes.find(n => n.id === narrativeMemoryId);
    if (!currentNode) return null;

    const chains = buildNarrativeChains(currentNode, memoryNodes, embeddingsData, {
      similarityThreshold: 0.4,
      upstreamCount: 3,
      downstreamCount: 3,
      objectCount: 5,
      categoryCount: 5,
      surpriseRange: [0.25, 0.4],
    });

    return {
      currentMemory: currentNode,
      chains: {
        upstream: chains.primary.upstream,
        downstream: chains.primary.downstream,
        objectChain: chains.objectChain,
        categoryChain: chains.categoryChain,
        surprise: chains.surprise,
      },
    };
  }, [narrativeMemoryId, memoryNodes, embeddingsData]);

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top + container.scrollTop;

    for (let i = layoutsRef.current.length - 1; i >= 0; i -= 1) {
      const pill = layoutsRef.current[i];
      const insideX = x >= pill.x && x <= pill.x + pill.width;
      const insideY = y >= pill.y && y <= pill.y + pill.height;

      if (insideX && insideY) {
        const record = displayRecords[pill.index];
        if (record) {
          setSelectedRecord(record);
          // 找到对应的原始记录 ID
          const originalRecord = filteredRecords[pill.index];
          if (originalRecord) {
            setNarrativeMemoryId(originalRecord.id);
          }
        }
        return;
      }
    }
  };

  const handleNarrativeNodeClick = useCallback((nodeId: string) => {
    // 跳转到该记忆节点
    const record = sortedRecords.find(r => r.id === nodeId);
    if (!record) return;

    // 更新选中的记忆
    const keyText = normalizeValue(record.object || record.id);
    const createdSource = record.createdAt || record.time;
    const shortTimeText = formatShortTime(record.time || record.createdAt);
    const emotion = normalizeValue(record.emotion);
    const emotionStyle = getEmotionStyle(emotion);

    setSelectedRecord({
      keyText,
      shortTimeText,
      createdTimeText: formatCreatedTime(createdSource),
      category: normalizeValue(record.category),
      object: normalizeValue(record.object || record.id),
      emotion,
      visibility: normalizeValue(record.visibility || record.location),
      description: normalizeValue(record.description),
      details: normalizeValue(record.details),
      color: emotionStyle.color,
      glow: emotionStyle.glow,
    });

    setNarrativeMemoryId(nodeId);
  }, [sortedRecords]);

  const handleCloseNarrative = useCallback(() => {
    setNarrativeMemoryId(null);
  }, []);

  const handleConstellationMemoryClick = useCallback((memoryId: string) => {
    const record = sortedRecords.find(r => r.id === memoryId);
    if (!record) return;

    const keyText = normalizeValue(record.object || record.id);
    const createdSource = record.createdAt || record.time;
    const shortTimeText = formatShortTime(record.time || record.createdAt);
    const emotion = normalizeValue(record.emotion);
    const emotionStyle = getEmotionStyle(emotion);

    setSelectedRecord({
      keyText,
      shortTimeText,
      createdTimeText: formatCreatedTime(createdSource),
      category: normalizeValue(record.category),
      object: normalizeValue(record.object || record.id),
      emotion,
      visibility: normalizeValue(record.visibility || record.location),
      description: normalizeValue(record.description),
      details: normalizeValue(record.details),
      color: emotionStyle.color,
      glow: emotionStyle.glow,
    });

    setNarrativeMemoryId(memoryId);
  }, [sortedRecords]);

  if (loading) {
    return <div className="memory-status">Loading memory data...</div>;
  }

  if (error) {
    return <div className="memory-status memory-error">{error}</div>;
  }

  return (
    <>
      <div className="memory-canvas-wrapper">
        <div className="memory-canvas-meta">
          <h2>{viewMode === 'stream' ? 'Memory Stream' : 'Constellation'}</h2>
          <div className="memory-view-toggle">
            <button
              className={viewMode === 'stream' ? 'active' : ''}
              onClick={() => setViewMode('stream')}
            >
              Stream
            </button>
            <button
              className={viewMode === 'constellation' ? 'active' : ''}
              onClick={() => setViewMode('constellation')}
            >
              Constellation
            </button>
          </div>
          <span>
            {displayRecords.length}/{sortedRecords.length} pills · {emotionSummary.length} emotions
          </span>
        </div>
        {viewMode === 'stream' && (
          <div className="memory-emotion-tags">
            <button
              className={`memory-emotion-tag ${selectedEmotion === 'All' ? 'active' : ''}`}
              onClick={() => setSelectedEmotion('All')}
            >
              All ({sortedRecords.length})
            </button>
            {emotionSummary.map((item) => (
              <button
                key={item.emotion}
                className={`memory-emotion-tag ${selectedEmotion === item.emotion ? 'active' : ''}`}
                onClick={() => setSelectedEmotion(item.emotion)}
                style={{
                  borderColor: item.color,
                  color: item.color,
                  boxShadow: selectedEmotion === item.emotion ? `0 0 16px ${item.glow}` : 'none',
                }}
              >
                {item.emotion} ({item.count})
              </button>
            ))}
          </div>
        )}
        {viewMode === 'stream' ? (
          <div className="memory-canvas-scroll" ref={containerRef}>
            <div ref={spacerRef} className="memory-canvas-spacer" />
            <canvas ref={canvasRef} className="memory-canvas" onClick={handleCanvasClick} />
          </div>
        ) : (
          embeddingsData && (
            <ClusterGraph
              memories={memoryNodes}
              embeddingsData={embeddingsData}
              onMemoryClick={handleConstellationMemoryClick}
            />
          )
        )}
      </div>

      {selectedRecord && (
        <div className="memory-detail-backdrop" onClick={() => { setSelectedRecord(null); setNarrativeMemoryId(null); }}>
          <article className="memory-detail-card" onClick={(event) => event.stopPropagation()}>
            <header className="memory-detail-header">
              <div>
                <h3>{selectedRecord.keyText}</h3>
                <p>Created: {selectedRecord.createdTimeText}</p>
              </div>
              <button className="memory-detail-close" onClick={() => { setSelectedRecord(null); setNarrativeMemoryId(null); }}>
                Close
              </button>
            </header>

            {narrativeContext && (
              <NarrativeGraph
                currentMemory={narrativeContext.currentMemory}
                chains={narrativeContext.chains}
                onNodeClick={handleNarrativeNodeClick}
              />
            )}

            <dl className="memory-detail-meta">
              <div>
                <dt>Category</dt>
                <dd>{selectedRecord.category}</dd>
              </div>
              <div>
                <dt>Object</dt>
                <dd>{selectedRecord.object}</dd>
              </div>
              <div>
                <dt>Emotion</dt>
                <dd>{selectedRecord.emotion}</dd>
              </div>
              <div>
                <dt>Visibility</dt>
                <dd>{selectedRecord.visibility}</dd>
              </div>
            </dl>

            <section className="memory-detail-section">
              <h4>Description</h4>
              <p>{selectedRecord.description}</p>
            </section>

            <section className="memory-detail-section">
              <h4>Details</h4>
              <p>{selectedRecord.details}</p>
            </section>
          </article>
        </div>
      )}
    </>
  );
}
