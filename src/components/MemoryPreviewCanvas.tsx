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
  isPublic: boolean;
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
  isPublic: boolean;
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

type EntityType = 'person' | 'place';

interface ExtractedEntity {
  type: EntityType;
  name: string;
  memoryIds: string[];
}

interface MemoryDataResponse {
  records: MemoryRecord[];
  embeddingsData: EmbeddingsData | null;
}

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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const ENTITY_STOPWORDS = new Set([
  'Unknown',
  'The',
  'This',
  'That',
  'And',
  'But',
  'For',
  'With',
  'Without',
  'Today',
  'Yesterday',
  'Tomorrow',
  'Echo',
  'AI',
]);

function normalizeEntityName(raw: string): string {
  return raw.replace(/^[^A-Za-z@]+|[^A-Za-z0-9.' -]+$/g, '').replace(/\s+/g, ' ').trim();
}

function addEntity(map: Map<string, ExtractedEntity>, type: EntityType, nameRaw: string, memoryId: string) {
  const name = normalizeEntityName(nameRaw);
  if (!name || ENTITY_STOPWORDS.has(name)) return;
  if (/^\d+$/.test(name)) return;

  const key = `${type}:${name.toLowerCase()}`;
  const existing = map.get(key);
  if (existing) {
    if (!existing.memoryIds.includes(memoryId)) existing.memoryIds.push(memoryId);
    return;
  }

  map.set(key, { type, name, memoryIds: [memoryId] });
}

function splitLocationParts(location: string): string[] {
  return location
    .split(/[;,/]/g)
    .flatMap((part) => part.split(/\(|\)/g))
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractEntitiesFromRecord(record: MemoryRecord, map: Map<string, ExtractedEntity>) {
  const memoryId = record.id;
  const keyText = normalizeValue(record.object);
  const description = normalizeValue(record.description);
  const location = normalizeValue(record.location);
  const source = `${keyText}\n${description}`;

  const mentionRegex = /@([A-Za-z][A-Za-z0-9_.-]{1,40})/g;
  let mentionMatch = mentionRegex.exec(source);
  while (mentionMatch) {
    addEntity(map, 'person', mentionMatch[1], memoryId);
    mentionMatch = mentionRegex.exec(source);
  }

  const personContextRegex = /\b(?:with|from|met|meeting with|asked|learned from|talked to)\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\b/g;
  let personMatch = personContextRegex.exec(source);
  while (personMatch) {
    addEntity(map, 'person', personMatch[1], memoryId);
    personMatch = personContextRegex.exec(source);
  }

  if (location !== 'Unknown') {
    for (const locationPart of splitLocationParts(location)) {
      addEntity(map, 'place', locationPart, memoryId);
    }
  }

  const placeContextRegex = /\b(?:in|at|from|to|near)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/g;
  let placeMatch = placeContextRegex.exec(source);
  while (placeMatch) {
    addEntity(map, 'place', placeMatch[1], memoryId);
    placeMatch = placeContextRegex.exec(source);
  }
}

function getEmotionStyle(emotion: string) {
  const key = normalizeValue(emotion).toLowerCase();
  const style = EMOTION_PALETTE[hashEmotion(key) % EMOTION_PALETTE.length];
  return style;
}

function buildNarrativeHtml(rawText: string, keyIdMap: Record<string, string>, publicIds?: Set<string>): string {
  const raw = rawText
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\n\n+/g, '\n\n');

  const entries = Object.entries(keyIdMap)
    .filter(([k]) => k.length >= 2)
    .sort((a, b) => b[0].length - a[0].length);

  if (entries.length === 0) return raw.replace(/\n\n/g, '<br/><br/>');

  const escapedKeys = entries.map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const combined = new RegExp(`(${escapedKeys.join('|')})`, 'gi');
  const lowerMap = new Map(entries.map(([k, id]) => [k.toLowerCase(), id]));

  const html = raw.replace(combined, (match) => {
    const id = lowerMap.get(match.toLowerCase());
    if (id) {
      const isPublic = publicIds ? publicIds.has(id) : true;
      if (isPublic) {
        const seed = hashEmotion(`${id}:${match.toLowerCase()}`);
        const tagClass = seed % 2 === 0 ? 'memory-tag-public' : 'memory-tag-travel';
        return `<span class="narrative-key narrative-key-link ${tagClass}" data-mem-id="${id}">${match}</span>`;
      } else {
        return `<span class="narrative-key narrative-key-link narrative-key-private" data-mem-id="${id}">&#x1F512; ${match}</span>`;
      }
    }
    return match;
  });

  return html.replace(/\n\n/g, '<br/><br/>');
}

function toDisplayMemoryRecord(record: MemoryRecord): DisplayMemoryRecord {
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
    isPublic: record.isPublic,
  };
}

export default function MemoryPreviewCanvas({ reloadKey = 0 }: { reloadKey?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const constellationMainRef = useRef<HTMLDivElement>(null);
  const metaMenuRef = useRef<HTMLDivElement>(null);
  const detailCardRef = useRef<HTMLElement>(null);
  const peoplePanelRef = useRef<HTMLDivElement>(null);
  const narrativePanelRef = useRef<HTMLDivElement>(null);
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
  const [detailSource, setDetailSource] = useState<'stream' | 'constellation' | null>(null);
  const [constellationFocusActive, setConstellationFocusActive] = useState(true);
  const [narrativeMemoryId, setNarrativeMemoryId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'stream' | 'constellation'>('constellation');
  const [showDetails, setShowDetails] = useState(false);
  const [showMetaMenu, setShowMetaMenu] = useState(false);
  const [constellationDetailAnchor, setConstellationDetailAnchor] = useState<{ x: number; y: number } | null>(null);
  const [isDetailDetached, setIsDetailDetached] = useState(false);
  const [detachedDetailPosition, setDetachedDetailPosition] = useState<{ left: number; top: number } | null>(null);
  const [narrativeText, setNarrativeText] = useState<string | null>(null);
  const [narrativeKeyIdMap, setNarrativeKeyIdMap] = useState<Record<string, string>>({});
  const [narrativeLoading, setNarrativeLoading] = useState(false);
  const [narrativeGraphOpen, setNarrativeGraphOpen] = useState(false);
  const [activeEntity, setActiveEntity] = useState<{ type: 'person'; name: string } | null>(null);
  const [personNarrativeText, setPersonNarrativeText] = useState<string | null>(null);
  const [personNarrativeKeyIdMap, setPersonNarrativeKeyIdMap] = useState<Record<string, string>>({});
  const [personNarrativeLoading, setPersonNarrativeLoading] = useState(false);
  const [personListOpen, setPersonListOpen] = useState(false);
  const [peoplePanelVisible, setPeoplePanelVisible] = useState(true);
  const [peoplePanelDetached, setPeoplePanelDetached] = useState(false);
  const [peoplePanelPosition, setPeoplePanelPosition] = useState<{ left: number; top: number } | null>(null);
  const [narrativeMode, setNarrativeMode] = useState<'chain' | 'person'>('chain');
  const [narrativeLanguage, setNarrativeLanguage] = useState<'zh' | 'en'>('zh');
  const [narrativePanelVisible, setNarrativePanelVisible] = useState(true);
  const [narrativePanelDetached, setNarrativePanelDetached] = useState(false);
  const [narrativePanelPosition, setNarrativePanelPosition] = useState<{ left: number; top: number } | null>(null);

  // Reset narrative graph panel when narrative overlay closes
  useEffect(() => {
    if (!narrativeMemoryId) setNarrativeGraphOpen(false);
  }, [narrativeMemoryId]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/api/memory-data', { credentials: 'include' });
        if (!response.ok) throw new Error(`Failed to load memory data (${response.status})`);
        const data = (await response.json()) as MemoryDataResponse;
        setRecords(Array.isArray(data.records) ? data.records : []);
        setEmbeddingsData(data.embeddingsData || null);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to read memory data';
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [reloadKey]);

  useEffect(() => {
    if (!selectedRecord) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedRecord(null);
        setNarrativeMemoryId(null);
        setDetailSource(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedRecord]);

  useEffect(() => {
    setShowDetails(false);
    setShowMetaMenu(false);
  }, [selectedRecord?.keyText, detailSource]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!metaMenuRef.current?.contains(target)) setShowMetaMenu(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, []);

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

  const entitySummary = useMemo(() => {
    const entityMap = new Map<string, ExtractedEntity>();
    for (const record of sortedRecords) {
      extractEntitiesFromRecord(record, entityMap);
    }

    const people: ExtractedEntity[] = [];
    for (const item of entityMap.values()) {
      if (item.type === 'person') {
        people.push(item);
      }
    }

    const sorter = (a: ExtractedEntity, b: ExtractedEntity) =>
      b.memoryIds.length - a.memoryIds.length || a.name.localeCompare(b.name);
    people.sort(sorter);

    return { people };
  }, [sortedRecords]);

  const filteredRecords = useMemo(() => {
    const emotionFiltered =
      selectedEmotion === 'All'
        ? sortedRecords
        : sortedRecords.filter((record) => normalizeValue(record.emotion) === selectedEmotion);

    if (!activeEntity) return emotionFiltered;

    const target = activeEntity.name.toLowerCase();
    return emotionFiltered.filter((record) => {
      const source = `${normalizeValue(record.object)}\n${normalizeValue(record.description)}\n${normalizeValue(record.location)}`;
      return source.toLowerCase().includes(target);
    });
  }, [selectedEmotion, sortedRecords, activeEntity]);

  const displayRecords = useMemo<DisplayMemoryRecord[]>(() => {
    return filteredRecords.map((record) => toDisplayMemoryRecord(record));
  }, [filteredRecords]);

  const activePersonEntity = useMemo(() => {
    if (!activeEntity) return null;
    return entitySummary.people.find((item) => item.name.toLowerCase() === activeEntity.name.toLowerCase()) ?? null;
  }, [activeEntity, entitySummary]);

  const activePersonRecords = useMemo(() => {
    if (!activePersonEntity) return [];
    const idSet = new Set(activePersonEntity.memoryIds);
    return sortedRecords.filter((record) => idSet.has(record.id));
  }, [activePersonEntity, sortedRecords]);

  const activePersonSequenceIds = useMemo(() => {
    return [...activePersonRecords]
      .sort((a, b) => getTimestamp(a) - getTimestamp(b))
      .map((record) => record.id);
  }, [activePersonRecords]);

  useEffect(() => {
    if (!selectedRecord) return;
    if (selectedEmotion === 'All') return;
    if (selectedRecord.emotion !== selectedEmotion) {
      setSelectedRecord(null);
    }
  }, [selectedEmotion, selectedRecord]);

  useEffect(() => {
    if (!activeEntity) return;
    const currentSet = new Set(entitySummary.people.map((item) => item.name.toLowerCase()));
    if (!currentSet.has(activeEntity.name.toLowerCase())) {
      setActiveEntity(null);
    }
  }, [activeEntity, entitySummary]);

  useEffect(() => {
    if (activeEntity) {
      setPersonListOpen(true);
      setPeoplePanelVisible(true);
      setNarrativePanelVisible(true);
      setNarrativeMode('person');
    }
  }, [activeEntity]);

  useEffect(() => {
    if (!activeEntity && narrativeMode === 'person') {
      setNarrativeMode('chain');
    }
  }, [activeEntity, narrativeMode]);

  useEffect(() => {
    if (!activeEntity || activePersonRecords.length === 0) {
      setPersonNarrativeText(null);
      setPersonNarrativeKeyIdMap({});
      return;
    }

    const memories = [...activePersonRecords]
      .sort((a, b) => getTimestamp(a) - getTimestamp(b))
      .slice(-12)
      .map((record) => ({
        id: record.id,
        key: normalizeValue(record.object || record.id),
        description: normalizeValue(record.description),
        details: normalizeValue(record.details),
        createdAt: record.createdAt || record.time,
      }));

    let cancelled = false;
    setPersonNarrativeLoading(true);

    fetch('/api/narrative-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memories, language: narrativeLanguage }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.narrative) {
          setPersonNarrativeText(data.narrative);
          setPersonNarrativeKeyIdMap(data.keyIdMap || {});
        }
      })
      .catch((err) => {
        console.error('[person-narrative] fetch error:', err);
      })
      .finally(() => {
        if (!cancelled) setPersonNarrativeLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeEntity, activePersonRecords, narrativeLanguage]);

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
      canvas.style.transform = `translateY(${scrollTop}px)`;
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
      key: normalizeValue(record.object || record.id),
      text: record.description || record.object,
      createdAt: record.createdAt || record.time,
      object: normalizeValue(record.object),
      category: normalizeValue(record.category),
      emotion: normalizeValue(record.emotion),
      isPublic: record.isPublic,
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

    const primarySequence = [
      ...chains.primary.upstream,
      currentNode,
      ...chains.primary.downstream,
    ].sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
    });

    const listedSet = new Set<string>();
    const listedIds: string[] = [];
    const pushListed = (id: string) => {
      if (!id || listedSet.has(id)) return;
      listedSet.add(id);
      listedIds.push(id);
    };

    for (const node of primarySequence) pushListed(node.id);
    for (const node of chains.objectChain) pushListed(node.id);
    for (const node of chains.categoryChain) pushListed(node.id);
    if (chains.surprise) pushListed(chains.surprise.id);

    return {
      currentMemory: currentNode,
      chains: {
        upstream: chains.primary.upstream,
        downstream: chains.primary.downstream,
        objectChain: chains.objectChain,
        categoryChain: chains.categoryChain,
        surprise: chains.surprise,
      },
      primarySequenceIds: primarySequence.map((node) => node.id),
      listedIds,
    };
  }, [narrativeMemoryId, memoryNodes, embeddingsData]);

  // Fetch AI narrative text when narrative chain changes
  useEffect(() => {
    if (!narrativeContext) {
      setNarrativeText(null);
      return;
    }

    const spineNodes = [
      ...narrativeContext.chains.upstream,
      narrativeContext.currentMemory,
      ...narrativeContext.chains.downstream,
    ].sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
    });

    if (spineNodes.length === 0) return;

    // Look up full description/details from sortedRecords
    const recordMap = new Map(sortedRecords.map(r => [r.id, r]));
    const memories = spineNodes.map(node => {
      const rec = recordMap.get(node.id);
      return {
        id: node.id,
        key: node.key,
        description: rec?.description || node.text,
        details: rec?.details || '',
        createdAt: node.createdAt,
      };
    });

    let cancelled = false;
    setNarrativeLoading(true);

    fetch('/api/narrative-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memories, language: narrativeLanguage }),
    })
      .then(res => res.json())
      .then(data => {
        if (!cancelled && data.narrative) {
          setNarrativeText(data.narrative);
          setNarrativeKeyIdMap(data.keyIdMap || {});
        }
      })
      .catch(err => {
        console.error('[narrative-text] fetch error:', err);
      })
      .finally(() => {
        if (!cancelled) setNarrativeLoading(false);
      });

    return () => { cancelled = true; };
  }, [narrativeContext, sortedRecords, narrativeLanguage]);

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
          setDetailSource('stream');
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
    setSelectedRecord(toDisplayMemoryRecord(record));

    setConstellationFocusActive(true);
    setActiveEntity(null);
    setNarrativeMode('chain');
    setNarrativeMemoryId(nodeId);
    setShowDetails(false);
    setShowMetaMenu(false);
    setIsDetailDetached(false);
    setDetachedDetailPosition(null);
  }, [sortedRecords]);

  const handleConstellationMemoryClick = useCallback((memoryId: string) => {
    const record = sortedRecords.find(r => r.id === memoryId);
    if (!record) return;

    // Don't set selectedRecord — detail card only opens via narrative text click
    setConstellationFocusActive(true);
    setActiveEntity(null);
    setNarrativeMode('chain');
    setDetailSource('constellation');
    setNarrativeMemoryId(memoryId);
    setShowDetails(false);
    setShowMetaMenu(false);
    setIsDetailDetached(false);
    setDetachedDetailPosition(null);
  }, [sortedRecords]);

  const showDetailForMemory = useCallback((memId: string) => {
    const record = sortedRecords.find(r => r.id === memId);
    if (!record) return;

    setSelectedRecord(toDisplayMemoryRecord(record));
    setShowDetails(false);
    setShowMetaMenu(false);
    setIsDetailDetached(false);
    setDetachedDetailPosition(null);
  }, [sortedRecords]);

  const handlePersonMemoryClick = useCallback((memoryId: string) => {
    const record = sortedRecords.find((r) => r.id === memoryId);
    if (!record) return;
    setSelectedRecord(toDisplayMemoryRecord(record));
    setNarrativeMemoryId(memoryId);
    setConstellationFocusActive(true);
    setNarrativeMode('person');
    setDetailSource(viewMode === 'constellation' ? 'constellation' : 'stream');
    setShowDetails(false);
    setShowMetaMenu(false);
    setIsDetailDetached(false);
    setDetachedDetailPosition(null);
  }, [sortedRecords, viewMode]);

  const handleCopyNarrative = useCallback(() => {
    if (!narrativeContext) return;

    const recordMap = new Map(sortedRecords.map(r => [r.id, r]));

    const formatNode = (node: MemoryNode, label: string) => {
      const rec = recordMap.get(node.id);
      const lines = [`[${label}] ${node.object || node.key}`];
      lines.push(`  Time: ${node.createdAt}`);
      lines.push(`  Emotion: ${node.emotion} | Category: ${node.category}`);
      if (rec?.description) lines.push(`  Description: ${rec.description}`);
      if (rec?.details) lines.push(`  Details: ${rec.details}`);
      return lines.join('\n');
    };

    const sections: string[] = [];

    // Primary spine
    const spine = [
      ...narrativeContext.chains.upstream,
      narrativeContext.currentMemory,
      ...narrativeContext.chains.downstream,
    ].sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
    });

    sections.push('=== NARRATIVE SPINE ===');
    for (const node of spine) {
      const isCurrent = node.id === narrativeContext.currentMemory.id;
      sections.push(formatNode(node, isCurrent ? 'CURRENT' : 'SPINE'));
    }

    // Object chain
    if (narrativeContext.chains.objectChain.length > 0) {
      sections.push('\n=== OBJECT CHAIN ===');
      for (const node of narrativeContext.chains.objectChain) {
        sections.push(formatNode(node, 'OBJECT'));
      }
    }

    // Category chain
    if (narrativeContext.chains.categoryChain.length > 0) {
      sections.push('\n=== CATEGORY CHAIN ===');
      for (const node of narrativeContext.chains.categoryChain) {
        sections.push(formatNode(node, 'CATEGORY'));
      }
    }

    // Surprise
    if (narrativeContext.chains.surprise) {
      sections.push('\n=== SURPRISE ===');
      sections.push(formatNode(narrativeContext.chains.surprise, 'SURPRISE'));
    }

    navigator.clipboard.writeText(sections.join('\n'));
  }, [narrativeContext, sortedRecords]);

  const closeDetailCard = useCallback(() => {
    setSelectedRecord(null);
    setShowDetails(false);
    setShowMetaMenu(false);
    setIsDetailDetached(false);
    setDetachedDetailPosition(null);
  }, []);

  const closeNarrative = useCallback(() => {
    setSelectedRecord(null);
    setNarrativeMemoryId(null);
    setDetailSource(null);
    setConstellationFocusActive(false);
    setShowDetails(false);
    setShowMetaMenu(false);
    setIsDetailDetached(false);
    setDetachedDetailPosition(null);
    setNarrativeGraphOpen(false);
  }, []);

  const clearConstellationFocus = useCallback(() => {
    setConstellationFocusActive(false);
  }, []);

  const showNarrativeOverlay =
    viewMode === 'constellation' && !!narrativeMemoryId && detailSource === 'constellation';
  const showConstellationDetail = showNarrativeOverlay && !!selectedRecord;
  const showStreamDetail = selectedRecord && detailSource === 'stream';

  const usingPersonNarrative = narrativeMode === 'person' && !!activeEntity;
  const showUnifiedNarrativePanel =
    viewMode === 'constellation' &&
    (
      (usingPersonNarrative && (personNarrativeLoading || !!personNarrativeText)) ||
      (!usingPersonNarrative && showNarrativeOverlay && (narrativeLoading || !!narrativeText))
    );
  const unifiedNarrativeTitle = usingPersonNarrative ? activeEntity.name : 'Narrative';
  const unifiedNarrativeLoading = usingPersonNarrative ? personNarrativeLoading : narrativeLoading;
  const publicMemoryIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of sortedRecords) {
      if (r.isPublic) set.add(r.id);
    }
    return set;
  }, [sortedRecords]);

  const unifiedNarrativeHtml = usingPersonNarrative
    ? buildNarrativeHtml(personNarrativeText ?? '', personNarrativeKeyIdMap, publicMemoryIds)
    : buildNarrativeHtml(narrativeText ?? '', narrativeKeyIdMap, publicMemoryIds);

  useEffect(() => {
    if (showUnifiedNarrativePanel) {
      setNarrativePanelVisible(true);
      setNarrativePanelDetached(false);
      setNarrativePanelPosition(null);
    }
  }, [showUnifiedNarrativePanel, narrativeMemoryId, activeEntity?.name]);

  const handleFloatingDragStart = useCallback(
    (panel: 'people' | 'narrative', event: React.MouseEvent<HTMLElement>) => {
      if (!constellationMainRef.current) return;
      const panelEl = panel === 'people' ? peoplePanelRef.current : narrativePanelRef.current;
      if (!panelEl) return;

      event.preventDefault();

      const mainRect = constellationMainRef.current.getBoundingClientRect();
      const panelRect = panelEl.getBoundingClientRect();
      const offsetX = event.clientX - panelRect.left;
      const offsetY = event.clientY - panelRect.top;

      if (panel === 'people') setPeoplePanelDetached(true);
      if (panel === 'narrative') setNarrativePanelDetached(true);

      const onMove = (ev: MouseEvent) => {
        const sideSafe = 10;
        const topSafe = 54;
        const left = clamp(
          ev.clientX - mainRect.left - offsetX,
          sideSafe,
          Math.max(sideSafe, mainRect.width - panelRect.width - sideSafe),
        );
        const top = clamp(
          ev.clientY - mainRect.top - offsetY,
          topSafe,
          Math.max(topSafe, mainRect.height - panelRect.height - sideSafe),
        );

        const next = { left: Math.round(left), top: Math.round(top) };
        if (panel === 'people') setPeoplePanelPosition(next);
        if (panel === 'narrative') setNarrativePanelPosition(next);
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    []
  );

  const peoplePanelStyle = useMemo(() => {
    if (!peoplePanelDetached || !peoplePanelPosition || !constellationMainRef.current) return undefined;
    const main = constellationMainRef.current;
    const left = clamp(peoplePanelPosition.left, 10, Math.max(10, main.clientWidth - 360));
    const top = clamp(peoplePanelPosition.top, 54, Math.max(54, main.clientHeight - 220));
    return { left: `${left}px`, top: `${top}px` };
  }, [peoplePanelDetached, peoplePanelPosition]);

  const narrativePanelStyle = useMemo(() => {
    if (!narrativePanelDetached || !narrativePanelPosition || !constellationMainRef.current) return undefined;
    const main = constellationMainRef.current;
    const left = clamp(narrativePanelPosition.left, 10, Math.max(10, main.clientWidth - 340));
    const top = clamp(narrativePanelPosition.top, 54, Math.max(54, main.clientHeight - 180));
    return { left: `${left}px`, top: `${top}px` };
  }, [narrativePanelDetached, narrativePanelPosition]);

  const constellationHighlightedMemoryIds = useMemo(() => {
    if (showNarrativeOverlay && constellationFocusActive) return narrativeContext?.listedIds ?? [];
    return activePersonEntity?.memoryIds ?? [];
  }, [showNarrativeOverlay, constellationFocusActive, narrativeContext, activePersonEntity]);

  const constellationSequenceMemoryIds = useMemo(() => {
    if (showNarrativeOverlay && constellationFocusActive) return narrativeContext?.primarySequenceIds ?? [];
    return activePersonSequenceIds;
  }, [showNarrativeOverlay, constellationFocusActive, narrativeContext, activePersonSequenceIds]);

  const constellationDetailStyle = useMemo(() => {
    if (!showConstellationDetail || !constellationMainRef.current) return undefined;

    const cardW = 360;
    const topSafe = 58;
    const sideSafe = 12;
    const main = constellationMainRef.current;

    if (isDetailDetached && detachedDetailPosition) {
      const left = clamp(detachedDetailPosition.left, sideSafe, Math.max(sideSafe, main.clientWidth - cardW - sideSafe));
      const top = clamp(detachedDetailPosition.top, topSafe, Math.max(topSafe, main.clientHeight - 220));
      return { left: `${left}px`, top: `${top}px` };
    }

    const baseX = constellationDetailAnchor ? constellationDetailAnchor.x + 14 : main.clientWidth - cardW - 24;
    const baseY = constellationDetailAnchor ? constellationDetailAnchor.y + 10 : topSafe + 14;

    const left = clamp(baseX, sideSafe, Math.max(sideSafe, main.clientWidth - cardW - sideSafe));
    const top = clamp(baseY, topSafe, Math.max(topSafe, main.clientHeight - 220));
    return { left: `${left}px`, top: `${top}px` };
  }, [showConstellationDetail, constellationDetailAnchor, isDetailDetached, detachedDetailPosition]);

  const handleConstellationFocusAnchorChange = useCallback((anchor?: { clientX: number; clientY: number }) => {
    if (!showConstellationDetail || !constellationMainRef.current) return;
    if (isDetailDetached) return;
    if (!anchor) return;

    const rect = constellationMainRef.current.getBoundingClientRect();
    const localX = Math.round(anchor.clientX - rect.left);
    const localY = Math.round(anchor.clientY - rect.top);

    setConstellationDetailAnchor((prev) => {
      if (prev && Math.abs(prev.x - localX) < 1 && Math.abs(prev.y - localY) < 1) return prev;
      return { x: localX, y: localY };
    });
  }, [showConstellationDetail, isDetailDetached]);

  const handleDetailDragStart = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!showConstellationDetail || !constellationMainRef.current || !detailCardRef.current) return;

    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, textarea, select, .memory-detail-menu-popover')) return;

    event.preventDefault();
    setShowMetaMenu(false);

    const mainRect = constellationMainRef.current.getBoundingClientRect();
    const cardRect = detailCardRef.current.getBoundingClientRect();
    const offsetX = event.clientX - cardRect.left;
    const offsetY = event.clientY - cardRect.top;

    document.body.classList.add('memory-detail-dragging');
    setIsDetailDetached(true);

    const onMove = (ev: MouseEvent) => {
      const cardW = cardRect.width;
      const cardH = cardRect.height;
      const sideSafe = 12;
      const topSafe = 58;
      const nextLeft = clamp(
        ev.clientX - mainRect.left - offsetX,
        sideSafe,
        Math.max(sideSafe, mainRect.width - cardW - sideSafe),
      );
      const nextTop = clamp(
        ev.clientY - mainRect.top - offsetY,
        topSafe,
        Math.max(topSafe, mainRect.height - cardH - sideSafe),
      );
      setDetachedDetailPosition({ left: Math.round(nextLeft), top: Math.round(nextTop) });
    };

    const onUp = () => {
      document.body.classList.remove('memory-detail-dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [showConstellationDetail]);

  const detailCard = selectedRecord && (
    <article
      ref={detailCardRef}
      className={`memory-detail-card memory-detail-card-compact${showConstellationDetail ? ' memory-detail-card-floating' : ''}`}
      style={showConstellationDetail ? constellationDetailStyle : undefined}
      onMouseDown={showConstellationDetail ? handleDetailDragStart : undefined}
    >
      {showConstellationDetail && <div className="memory-detail-pointer" aria-hidden />}
      <header className="memory-detail-header">
        <div>
          <h3>{selectedRecord.keyText}</h3>
          <p>
            {selectedRecord.createdTimeText}
            <span className={`memory-detail-privacy ${selectedRecord.isPublic ? 'memory-detail-privacy--public' : 'memory-detail-privacy--private'}`}>
              {selectedRecord.isPublic ? 'Public' : '\u{1F512} Private'}
            </span>
          </p>
        </div>
      </header>

      {!showConstellationDetail && narrativeContext && (
        <NarrativeGraph
          currentMemory={narrativeContext.currentMemory}
          chains={narrativeContext.chains}
          onNodeClick={handleNarrativeNodeClick}
          onCopyAll={handleCopyNarrative}
        />
      )}
      <section className="memory-detail-section">
        <p>{selectedRecord.description}</p>
      </section>

      <button className="memory-detail-toggle" onClick={() => setShowDetails((v) => !v)}>
        {showDetails ? 'Hide Details' : 'Details'}
      </button>
      {showDetails && (
        <section className="memory-detail-section memory-detail-section-details">
          <p>{selectedRecord.details}</p>
        </section>
      )}

      <div className="memory-detail-controls">
        <button className="memory-detail-close memory-detail-close-danger" onClick={closeDetailCard}>
          Close
        </button>
        <div className="memory-detail-menu memory-detail-menu-corner" ref={metaMenuRef}>
          <button className="memory-detail-more" onClick={() => setShowMetaMenu((v) => !v)} aria-label="Open metadata menu">
            ...
          </button>
          {showMetaMenu && (
            <div className="memory-detail-menu-popover">
              <div><strong>Category:</strong> {selectedRecord.category}</div>
              <div><strong>Object:</strong> {selectedRecord.object}</div>
              <div><strong>Emotion:</strong> {selectedRecord.emotion}</div>
              <div><strong>Visibility:</strong> {selectedRecord.visibility}</div>
            </div>
          )}
        </div>
      </div>
    </article>
  );

  if (loading) {
    return <div className="memory-status">Loading memory data...</div>;
  }

  if (error) {
    return <div className="memory-status memory-error">{error}</div>;
  }

  return (
    <>
      <div className="memory-canvas-wrapper">
        <div className="memory-canvas-main" ref={constellationMainRef}>
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
              {displayRecords.length}/{sortedRecords.length} pills · {emotionSummary.length} emotions · {entitySummary.people.length} people
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
                onClearFocus={clearConstellationFocus}
                focusMemoryId={showNarrativeOverlay ? narrativeMemoryId : null}
                onFocusAnchorChange={handleConstellationFocusAnchorChange}
                highlightedMemoryIds={constellationHighlightedMemoryIds}
                sequenceMemoryIds={constellationSequenceMemoryIds}
              />
            )
          )}
          {viewMode === 'constellation' && !peoplePanelVisible && (
            <button className="memory-floating-reopen memory-people-reopen" onClick={() => setPeoplePanelVisible(true)}>
              People
            </button>
          )}
          {viewMode === 'constellation' && peoplePanelVisible && (
            <div
              ref={peoplePanelRef}
              className={`memory-people-floating${peoplePanelDetached ? ' memory-floating-detached' : ''}`}
              style={peoplePanelStyle}
            >
              <div className="memory-floating-header" onMouseDown={(e) => handleFloatingDragStart('people', e)}>
                <h3>People</h3>
                <div>
                  <span>{entitySummary.people.length}</span>
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPeoplePanelVisible(false);
                    }}
                    aria-label="Close people list"
                  >
                    ×
                  </button>
                </div>
              </div>
              <div className="memory-people-chip-list">
                {entitySummary.people.slice(0, 64).map((entity) => {
                  const isActive =
                    activeEntity?.type === 'person' && activeEntity.name.toLowerCase() === entity.name.toLowerCase();
                  return (
                    <button
                      key={`person-${entity.name}`}
                      className={`memory-entity-chip memory-entity-chip-person ${isActive ? 'active' : ''}`}
                      onClick={() => setActiveEntity(isActive ? null : { name: entity.name, type: 'person' })}
                      title={`Memories: ${entity.memoryIds.length}`}
                    >
                      {entity.name} ({entity.memoryIds.length})
                    </button>
                  );
                })}
              </div>
              {activeEntity && (
                <div className="memory-person-panel-inline">
                  <div className="memory-person-panel-header">
                    <h3>{activeEntity.name}</h3>
                    <div>
                      <span>{activePersonRecords.length} memories</span>
                      <button onClick={() => setPersonListOpen((v) => !v)}>
                        {personListOpen ? 'Hide list' : 'Show list'}
                      </button>
                    </div>
                  </div>
                  {personListOpen && (
                    <div className="memory-person-list">
                      {activePersonRecords.slice(0, 40).map((record) => (
                        <button
                          key={`person-memory-${record.id}`}
                          className="memory-person-list-item"
                          onClick={() => handlePersonMemoryClick(record.id)}
                        >
                          <strong>{normalizeValue(record.object || record.id)}</strong>
                          <span>{formatShortTime(record.time || record.createdAt)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {showNarrativeOverlay && narrativeContext && (
            <>
              <button
                className={`narrative-graph-handle${narrativeGraphOpen ? ' narrative-graph-handle--open' : ''}`}
                onClick={() => setNarrativeGraphOpen(v => !v)}
              >
                {narrativeGraphOpen ? '\u25C0' : '\u25B6'}
              </button>
              <div className={`narrative-graph-floating${narrativeGraphOpen ? ' narrative-graph-floating--open' : ' narrative-graph-floating--closed'}`}>
                <button className="narrative-graph-close" onClick={closeNarrative} aria-label="Close narrative">
                  \u2715
                </button>
                <NarrativeGraph
                  currentMemory={narrativeContext.currentMemory}
                  chains={narrativeContext.chains}
                  onNodeClick={handleNarrativeNodeClick}
                  onCopyAll={handleCopyNarrative}
                  resizable
                />
              </div>
            </>
          )}
          {showUnifiedNarrativePanel && !narrativePanelVisible && (
            <button className="memory-floating-reopen memory-narrative-reopen" onClick={() => setNarrativePanelVisible(true)}>
              Narrative
            </button>
          )}
          {showUnifiedNarrativePanel && narrativePanelVisible && (
            <div
              ref={narrativePanelRef}
              className={`narrative-text-floating${activeEntity ? ' person-narrative-floating' : ''}${narrativePanelDetached ? ' memory-floating-detached' : ''}`}
              style={narrativePanelStyle}
            >
              <div className="memory-floating-header" onMouseDown={(e) => handleFloatingDragStart('narrative', e)}>
                <h3>{unifiedNarrativeTitle}</h3>
                <div className="narrative-lang-controls">
                  <button
                    className={narrativeLanguage === 'zh' ? 'active' : ''}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setNarrativeLanguage('zh');
                    }}
                    aria-label="Switch narrative language to Chinese"
                  >
                    中文
                  </button>
                  <button
                    className={narrativeLanguage === 'en' ? 'active' : ''}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setNarrativeLanguage('en');
                    }}
                    aria-label="Switch narrative language to English"
                  >
                    EN
                  </button>
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setNarrativePanelVisible(false);
                    }}
                    aria-label="Close narrative text"
                  >
                    ×
                  </button>
                </div>
              </div>
              <div
                onClick={(e) => {
                  const target = e.target as HTMLElement;
                  const memId = target.dataset?.memId;
                  if (!memId) return;
                  if (usingPersonNarrative) {
                    handlePersonMemoryClick(memId);
                  } else {
                    showDetailForMemory(memId);
                  }
                }}
              >
                {unifiedNarrativeLoading ? (
                  <div className="narrative-text-loading">Generating narrative...</div>
                ) : (
                  <div
                    className="narrative-text-body"
                    dangerouslySetInnerHTML={{
                      __html: unifiedNarrativeHtml,
                    }}
                  />
                )}
              </div>
            </div>
          )}
          {showConstellationDetail && detailCard}
        </div>
      </div>

      {showStreamDetail && (
        <div className="memory-detail-backdrop" onClick={closeNarrative}>
          <div onClick={(event) => event.stopPropagation()}>
            {detailCard}
          </div>
        </div>
      )}
    </>
  );
}
