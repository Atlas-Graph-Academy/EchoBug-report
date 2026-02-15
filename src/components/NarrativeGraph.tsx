'use client';

import { useEffect, useRef, useCallback } from 'react';
import type { MemoryNode } from '@/lib/narrative';

type NodeWithSimilarity = MemoryNode & { similarity?: number };

/** A node placed on the narrative flow canvas */
interface FlowNode {
  id: string;
  label: string;           // key text (object name)
  dateLabel: string;        // short date
  x: number;
  y: number;
  radius: number;
  color: string;
  glow: string;
  isCurrent: boolean;
  /** Which chain placed this node on the spine vs branch */
  role: 'spine' | 'branch-up' | 'branch-down' | 'surprise';
  similarity?: number;
}

interface FlowEdge {
  fromId: string;
  toId: string;
  color: string;
  width: number;
}

interface NarrativeGraphProps {
  currentMemory: MemoryNode;
  chains: {
    upstream: NodeWithSimilarity[];
    downstream: NodeWithSimilarity[];
    objectChain: MemoryNode[];
    categoryChain: MemoryNode[];
    surprise?: NodeWithSimilarity;
  };
  onNodeClick: (nodeId: string) => void;
}

/* ── Emotion palette (matches pill canvas) ── */
const PALETTE = [
  { color: '#ff9f43', glow: 'rgba(255,159,67,0.5)' },
  { color: '#f368e0', glow: 'rgba(243,104,224,0.5)' },
  { color: '#00d2d3', glow: 'rgba(0,210,211,0.5)' },
  { color: '#54a0ff', glow: 'rgba(84,160,255,0.5)' },
  { color: '#feca57', glow: 'rgba(254,202,87,0.5)' },
  { color: '#a29bfe', glow: 'rgba(162,155,254,0.5)' },
  { color: '#1dd1a1', glow: 'rgba(29,209,161,0.5)' },
  { color: '#ff6b81', glow: 'rgba(255,107,129,0.5)' },
  { color: '#7bed9f', glow: 'rgba(123,237,159,0.5)' },
  { color: '#70a1ff', glow: 'rgba(112,161,255,0.5)' },
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function eStyle(emotion: string) {
  return PALETTE[hash((emotion || '').trim().toLowerCase() || 'x') % PALETTE.length];
}

function trunc(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '\u2026';
}

function toTs(dateStr: string): number {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d);
}

/* ─────────────────────────────────────────────
 * Build narrative flow layout
 *
 * The "spine" is the semantic main chain:
 *   upstream nodes → [current] → downstream nodes
 * sorted by time, placed left-to-right with even spacing.
 *
 * Branches fork off the spine:
 *   - object chain nodes → branch upward from current
 *   - category chain nodes → branch downward from current
 *   - surprise → floats above-right
 *
 * This creates the organic "narrative path" feel.
 * ───────────────────────────────────────────── */

function buildFlowData(
  currentMemory: MemoryNode,
  chains: NarrativeGraphProps['chains'],
  width: number,
  height: number,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const placed = new Set<string>();

  // Gather all source nodes for lookup
  const srcMap = new Map<string, MemoryNode & { similarity?: number }>();
  srcMap.set(currentMemory.id, currentMemory);
  for (const n of chains.upstream) srcMap.set(n.id, n);
  for (const n of chains.downstream) srcMap.set(n.id, n);
  for (const n of chains.objectChain) srcMap.set(n.id, n);
  for (const n of chains.categoryChain) srcMap.set(n.id, n);
  if (chains.surprise) srcMap.set(chains.surprise.id, chains.surprise);

  // ── 1. Build spine: upstream + current + downstream, sorted by time ──
  const spineIds: string[] = [];
  const seenSpine = new Set<string>();
  const addSpine = (id: string) => { if (!seenSpine.has(id)) { seenSpine.add(id); spineIds.push(id); } };
  for (const n of chains.upstream) addSpine(n.id);
  addSpine(currentMemory.id);
  for (const n of chains.downstream) addSpine(n.id);

  spineIds.sort((a, b) => toTs(srcMap.get(a)!.createdAt) - toTs(srcMap.get(b)!.createdAt));

  // Layout params
  const padL = 50;
  const padR = 40;
  const spineY = height * 0.45; // main spine slightly above center to leave room for labels below
  const branchUpY = height * 0.14;
  const branchDownY = height * 0.76;
  const spineSpacing = spineIds.length > 1
    ? (width - padL - padR) / (spineIds.length - 1)
    : 0;

  const baseR = Math.min(14, Math.max(9, height * 0.04));
  const currentR = baseR + 4;

  // Find current index on spine for branch attachment
  let currentSpineX = width / 2;

  // Place spine nodes
  spineIds.forEach((id, i) => {
    const mem = srcMap.get(id)!;
    const isCur = id === currentMemory.id;
    const style = eStyle(mem.emotion);
    const x = spineIds.length === 1 ? width / 2 : padL + spineSpacing * i;
    const y = spineY;

    if (isCur) currentSpineX = x;

    nodes.push({
      id,
      label: trunc(mem.object || mem.text, 14),
      dateLabel: fmtDate(mem.createdAt),
      x, y,
      radius: isCur ? currentR : baseR,
      color: style.color,
      glow: style.glow,
      isCurrent: isCur,
      role: 'spine',
      similarity: (mem as NodeWithSimilarity).similarity,
    });
    placed.add(id);
  });

  // Connect spine sequentially
  for (let i = 0; i < spineIds.length - 1; i++) {
    edges.push({
      fromId: spineIds[i],
      toId: spineIds[i + 1],
      color: 'rgba(200,220,255,0.35)',
      width: 2,
    });
  }

  // ── 2. Object chain branches (upward from current) ──
  const objNodes = chains.objectChain.filter(n => !placed.has(n.id)).slice(0, 4);
  if (objNodes.length > 0) {
    const spreadX = Math.min(spineSpacing * 0.7, 80);
    const startX = currentSpineX - ((objNodes.length - 1) * spreadX) / 2;

    objNodes.forEach((n, i) => {
      const mem = srcMap.get(n.id) || n;
      const style = eStyle(mem.emotion);
      const x = startX + i * spreadX;
      // Stagger y slightly for visual interest
      const y = branchUpY + (i % 2 === 0 ? 0 : 14);

      nodes.push({
        id: n.id,
        label: trunc(mem.object || mem.text, 12),
        dateLabel: fmtDate(mem.createdAt),
        x, y,
        radius: baseR - 1,
        color: style.color,
        glow: style.glow,
        isCurrent: false,
        role: 'branch-up',
        similarity: (mem as NodeWithSimilarity).similarity,
      });
      placed.add(n.id);

      // Edge from current to this branch node
      edges.push({
        fromId: currentMemory.id,
        toId: n.id,
        color: 'rgba(255,159,67,0.35)',
        width: 1.2,
      });
    });

    // Connect branch nodes among themselves (in time order)
    const branchUpSorted = [...objNodes].sort((a, b) => toTs(a.createdAt) - toTs(b.createdAt));
    for (let i = 0; i < branchUpSorted.length - 1; i++) {
      edges.push({
        fromId: branchUpSorted[i].id,
        toId: branchUpSorted[i + 1].id,
        color: 'rgba(255,159,67,0.25)',
        width: 1,
      });
    }
  }

  // ── 3. Category chain branches (downward from current) ──
  const catNodes = chains.categoryChain.filter(n => !placed.has(n.id)).slice(0, 4);
  if (catNodes.length > 0) {
    const spreadX = Math.min(spineSpacing * 0.7, 80);
    const startX = currentSpineX - ((catNodes.length - 1) * spreadX) / 2;

    catNodes.forEach((n, i) => {
      const mem = srcMap.get(n.id) || n;
      const style = eStyle(mem.emotion);
      const x = startX + i * spreadX;
      const y = branchDownY + (i % 2 === 0 ? 0 : -12);

      nodes.push({
        id: n.id,
        label: trunc(mem.object || mem.text, 12),
        dateLabel: fmtDate(mem.createdAt),
        x, y,
        radius: baseR - 1,
        color: style.color,
        glow: style.glow,
        isCurrent: false,
        role: 'branch-down',
        similarity: (mem as NodeWithSimilarity).similarity,
      });
      placed.add(n.id);

      edges.push({
        fromId: currentMemory.id,
        toId: n.id,
        color: 'rgba(162,155,254,0.35)',
        width: 1.2,
      });
    });

    const branchDownSorted = [...catNodes].sort((a, b) => toTs(a.createdAt) - toTs(b.createdAt));
    for (let i = 0; i < branchDownSorted.length - 1; i++) {
      edges.push({
        fromId: branchDownSorted[i].id,
        toId: branchDownSorted[i + 1].id,
        color: 'rgba(162,155,254,0.25)',
        width: 1,
      });
    }
  }

  // ── 4. Surprise node (upper-right, detached) ──
  if (chains.surprise && !placed.has(chains.surprise.id)) {
    const mem = srcMap.get(chains.surprise.id) || chains.surprise;
    const style = eStyle(mem.emotion);
    nodes.push({
      id: chains.surprise.id,
      label: trunc(mem.object || mem.text, 12),
      dateLabel: '?',
      x: Math.min(currentSpineX + spineSpacing * 1.5, width - padR - 20),
      y: branchUpY - 6,
      radius: baseR - 2,
      color: style.color,
      glow: style.glow,
      isCurrent: false,
      role: 'surprise',
      similarity: chains.surprise.similarity,
    });
    edges.push({
      fromId: currentMemory.id,
      toId: chains.surprise.id,
      color: 'rgba(254,202,87,0.35)',
      width: 1,
    });
  }

  return { nodes, edges };
}

/* ── Drawing ── */

function drawBezierEdge(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
) {
  const dx = x2 - x1;
  const cpOffset = Math.abs(dx) * 0.4;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(x1 + cpOffset, y1, x2 - cpOffset, y2, x2, y2);
  ctx.stroke();
}

function drawFlow(
  ctx: CanvasRenderingContext2D,
  nodes: FlowNode[],
  edges: FlowEdge[],
  width: number,
  height: number,
  hoveredId: string | null,
) {
  ctx.clearRect(0, 0, width, height);

  // Background
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#090d18');
  bg.addColorStop(1, '#0b1122');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  if (nodes.length === 0) return;

  const nodeById = new Map<string, FlowNode>();
  for (const n of nodes) nodeById.set(n.id, n);

  // ── Draw edges (bezier curves) ──
  for (const edge of edges) {
    const from = nodeById.get(edge.fromId);
    const to = nodeById.get(edge.toId);
    if (!from || !to) continue;

    const hl = hoveredId === edge.fromId || hoveredId === edge.toId;

    ctx.save();
    ctx.globalAlpha = hl ? 1 : 0.8;
    ctx.strokeStyle = edge.color;
    ctx.lineWidth = hl ? edge.width + 1 : edge.width;

    drawBezierEdge(ctx, from.x, from.y, to.x, to.y);
    ctx.restore();
  }

  // ── Draw nodes ──
  for (const node of nodes) {
    const isHovered = hoveredId === node.id;
    const r = isHovered ? node.radius + 3 : node.radius;

    // Outer glow
    ctx.save();
    ctx.shadowBlur = isHovered ? 22 : 14;
    ctx.shadowColor = node.glow;

    // Circle fill
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    if (node.isCurrent) {
      ctx.fillStyle = node.color;
    } else {
      ctx.fillStyle = `${node.color}30`;
    }
    ctx.fill();

    // Circle border
    ctx.strokeStyle = node.color;
    ctx.lineWidth = node.isCurrent ? 3 : 1.5;
    ctx.stroke();

    // Inner ring for non-current
    if (!node.isCurrent) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();
    }

    ctx.restore();

    // ── Label: tooltip-style badge above/below ──
    const labelBelow = node.role === 'branch-up' || node.role === 'surprise';
    const labelY = labelBelow ? node.y + r + 4 : node.y - r - 4;

    ctx.font = `600 10px "Avenir Next", "Segoe UI", sans-serif`;
    const textW = ctx.measureText(node.label).width;
    const badgeW = textW + 12;
    const badgeH = 18;
    const badgeX = node.x - badgeW / 2;
    const badgeY = labelBelow ? labelY : labelY - badgeH;

    // Badge background
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#151b2e';
    ctx.strokeStyle = `${node.color}55`;
    ctx.lineWidth = 0.8;

    // Rounded rect
    const br = 4;
    ctx.beginPath();
    ctx.moveTo(badgeX + br, badgeY);
    ctx.lineTo(badgeX + badgeW - br, badgeY);
    ctx.quadraticCurveTo(badgeX + badgeW, badgeY, badgeX + badgeW, badgeY + br);
    ctx.lineTo(badgeX + badgeW, badgeY + badgeH - br);
    ctx.quadraticCurveTo(badgeX + badgeW, badgeY + badgeH, badgeX + badgeW - br, badgeY + badgeH);
    ctx.lineTo(badgeX + br, badgeY + badgeH);
    ctx.quadraticCurveTo(badgeX, badgeY + badgeH, badgeX, badgeY + badgeH - br);
    ctx.lineTo(badgeX, badgeY + br);
    ctx.quadraticCurveTo(badgeX, badgeY, badgeX + br, badgeY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Badge text
    ctx.font = `600 10px "Avenir Next", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = node.isCurrent ? '#ffffff' : '#c8d8ee';
    ctx.fillText(node.label, node.x, badgeY + badgeH / 2);

    // Small connector line from badge to node
    ctx.strokeStyle = `${node.color}40`;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    if (labelBelow) {
      ctx.moveTo(node.x, node.y + r);
      ctx.lineTo(node.x, badgeY);
    } else {
      ctx.moveTo(node.x, node.y - r);
      ctx.lineTo(node.x, badgeY + badgeH);
    }
    ctx.stroke();

    // Date label (tiny, under badge)
    if (node.dateLabel) {
      ctx.font = '400 8px "Avenir Next", sans-serif';
      ctx.fillStyle = 'rgba(160,188,218,0.5)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const dateY = labelBelow ? badgeY + badgeH + 2 : badgeY - 11;
      ctx.fillText(node.dateLabel, node.x, dateY);
    }

    // Similarity percentage inside badge area for branch nodes
    if (node.similarity && !node.isCurrent) {
      ctx.font = 'bold 8px "Avenir Next", sans-serif';
      ctx.fillStyle = node.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.round(node.similarity * 100)}%`, node.x, node.y);
    }

    // "NOW" marker for current
    if (node.isCurrent) {
      ctx.font = 'bold 9px "Avenir Next", sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NOW', node.x, node.y);
    }
  }

  // ── Subtle labels for chain types ──
  const spineNodes = nodes.filter(n => n.role === 'spine');
  const branchUp = nodes.filter(n => n.role === 'branch-up');
  const branchDown = nodes.filter(n => n.role === 'branch-down');

  ctx.font = '500 8px "Avenir Next", sans-serif';
  ctx.fillStyle = 'rgba(160,188,218,0.3)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  if (spineNodes.length > 0) {
    const leftmost = spineNodes.reduce((a, b) => a.x < b.x ? a : b);
    ctx.fillText('SEMANTIC', leftmost.x - 40, leftmost.y);
  }
  if (branchUp.length > 0) {
    ctx.fillText('OBJECT', 8, branchUp[0].y);
  }
  if (branchDown.length > 0) {
    ctx.fillText('CATEGORY', 8, branchDown[0].y);
  }
}

/* ── Component ── */

export default function NarrativeGraph({
  currentMemory,
  chains,
  onNodeClick,
}: NarrativeGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<{ nodes: FlowNode[]; edges: FlowEdge[] }>({ nodes: [], edges: [] });
  const hoveredRef = useRef<string | null>(null);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = canvas.parentElement;
    if (!container) return;

    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const data = buildFlowData(currentMemory, chains, w, h);
    dataRef.current = data;
    drawFlow(ctx, data.nodes, data.edges, w, h, hoveredRef.current);
  }, [currentMemory, chains]);

  useEffect(() => {
    const id = requestAnimationFrame(() => paint());
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    let obs: ResizeObserver | null = null;
    if (container) {
      obs = new ResizeObserver(() => paint());
      obs.observe(container);
    }
    return () => { cancelAnimationFrame(id); obs?.disconnect(); };
  }, [paint]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    let found: string | null = null;
    for (const node of dataRef.current.nodes) {
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy <= (node.radius + 8) * (node.radius + 8)) {
        found = node.id;
        break;
      }
    }
    if (found !== hoveredRef.current) {
      hoveredRef.current = found;
      canvas.style.cursor = found ? 'pointer' : 'default';
      paint();
    }
  }, [paint]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    for (const node of dataRef.current.nodes) {
      if (node.isCurrent) continue;
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy <= (node.radius + 8) * (node.radius + 8)) {
        onNodeClick(node.id);
        return;
      }
    }
  }, [onNodeClick]);

  return (
    <div className="narrative-graph-container">
      <canvas
        ref={canvasRef}
        className="narrative-graph-canvas"
        onMouseMove={handleMouseMove}
        onClick={handleClick}
      />
    </div>
  );
}
