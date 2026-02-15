'use client';

import { useEffect, useRef, useCallback } from 'react';
import type { MemoryNode } from '@/lib/narrative';

type NodeWithSimilarity = MemoryNode & { similarity?: number };

/** A node placed on the narrative flow canvas */
interface FlowNode {
  id: string;
  label: string;
  dateLabel: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  glow: string;
  isCurrent: boolean;
  role: 'spine' | 'branch-up' | 'branch-down' | 'surprise';
  similarity?: number;
}

interface FlowEdge {
  fromId: string;
  toId: string;
  color: string;
  width: number;
  style: 'arrow' | 'dashed' | 'dotted';
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

/* ── Emotion palette ── */
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

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
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

function fmtTime(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d);
}

/* ─────────────────────────────────────────────
 * Build narrative flow layout v4
 *
 * Structure:
 *   - Spine = time axis (left→right), each node is a time point
 *     with date on axis and key text as pill above
 *   - Spine nodes connected with directional arrows (temporal flow)
 *   - Object chain: branch upward, each node connects ONLY to current (radial spoke)
 *   - Category chain: branch downward, each node connects ONLY to current (radial spoke)
 *   - No sibling-to-sibling edges on branches (they are "same-kind" not "development")
 *   - Surprise: floats detached with dotted connection
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

  const srcMap = new Map<string, MemoryNode & { similarity?: number }>();
  srcMap.set(currentMemory.id, currentMemory);
  for (const n of chains.upstream) srcMap.set(n.id, n);
  for (const n of chains.downstream) srcMap.set(n.id, n);
  for (const n of chains.objectChain) srcMap.set(n.id, n);
  for (const n of chains.categoryChain) srcMap.set(n.id, n);
  if (chains.surprise) srcMap.set(chains.surprise.id, chains.surprise);

  // ── 1. Build spine: upstream + current + downstream ──
  const spineIds: string[] = [];
  const seenSpine = new Set<string>();
  const addSpine = (id: string) => { if (!seenSpine.has(id)) { seenSpine.add(id); spineIds.push(id); } };
  for (const n of chains.upstream) addSpine(n.id);
  addSpine(currentMemory.id);
  for (const n of chains.downstream) addSpine(n.id);
  spineIds.sort((a, b) => toTs(srcMap.get(a)!.createdAt) - toTs(srcMap.get(b)!.createdAt));

  // Layout
  const padL = 60;
  const padR = 50;
  const spineY = height * 0.44;
  const branchUpBaseY = Math.max(56, height * 0.23);
  const branchDownBaseY = Math.min(height - 56, height * 0.74);
  const spineSpacing = spineIds.length > 1
    ? (width - padL - padR) / (spineIds.length - 1)
    : 0;

  const baseR = Math.min(13, Math.max(8, height * 0.035));
  const currentR = baseR + 5;

  let currentSpineX = width / 2;

  // Teal accent for spine (matches ClusterGraph sequence path)
  const SPINE_COLOR = '#5eead4';
  const SPINE_GLOW = 'rgba(94,234,212,0.5)';

  // Place spine nodes
  spineIds.forEach((id, i) => {
    const mem = srcMap.get(id)!;
    const isCur = id === currentMemory.id;
    const x = spineIds.length === 1 ? width / 2 : padL + spineSpacing * i;
    const y = spineY;

    if (isCur) currentSpineX = x;

    nodes.push({
      id,
      label: mem.object || mem.text,
      dateLabel: fmtDate(mem.createdAt) + ' ' + fmtTime(mem.createdAt),
      x, y,
      radius: isCur ? currentR : baseR,
      color: SPINE_COLOR,
      glow: SPINE_GLOW,
      isCurrent: isCur,
      role: 'spine',
      similarity: (mem as NodeWithSimilarity).similarity,
    });
    placed.add(id);
  });

  // Connect spine with directional arrows
  for (let i = 0; i < spineIds.length - 1; i++) {
    edges.push({
      fromId: spineIds[i],
      toId: spineIds[i + 1],
      color: 'rgba(94,234,212,0.5)',
      width: 2.2,
      style: 'arrow',
    });
  }

  // ── 2. Object chain (upward spokes from current, NO sibling links) ──
  const objNodes = chains.objectChain.filter(n => !placed.has(n.id));
  if (objNodes.length > 0) {
    const laneMinX = 80;
    const laneMaxX = width - 80;
    const maxLaneW = Math.max(0, laneMaxX - laneMinX);
    const spreadX = objNodes.length > 1
      ? Math.min(Math.min(spineSpacing * 0.6, 70), maxLaneW / (objNodes.length - 1))
      : 0;
    const totalW = (objNodes.length - 1) * spreadX;
    const startX = clamp(currentSpineX - totalW / 2, laneMinX, laneMaxX - totalW);

    objNodes.forEach((n, i) => {
      const mem = srcMap.get(n.id) || n;
      const style = eStyle(mem.emotion);
      const x = objNodes.length === 1 ? currentSpineX : startX + i * spreadX;
      // Fan out slightly in Y for visual rhythm
      const y = branchUpBaseY + (i % 2 === 0 ? 0 : 12);

      nodes.push({
        id: n.id,
        label: mem.object || mem.text,
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

      // Only connect to current node — spoke pattern
      edges.push({
        fromId: currentMemory.id,
        toId: n.id,
        color: 'rgba(255,159,67,0.3)',
        width: 1,
        style: 'dashed',
      });
    });
  }

  // ── 3. Category chain (downward spokes from current, NO sibling links) ──
  const catNodes = chains.categoryChain.filter(n => !placed.has(n.id));
  if (catNodes.length > 0) {
    const laneMinX = 80;
    const laneMaxX = width - 80;
    const maxLaneW = Math.max(0, laneMaxX - laneMinX);
    const spreadX = catNodes.length > 1
      ? Math.min(Math.min(spineSpacing * 0.6, 70), maxLaneW / (catNodes.length - 1))
      : 0;
    const totalW = (catNodes.length - 1) * spreadX;
    const startX = clamp(currentSpineX - totalW / 2, laneMinX, laneMaxX - totalW);

    catNodes.forEach((n, i) => {
      const mem = srcMap.get(n.id) || n;
      const style = eStyle(mem.emotion);
      const x = catNodes.length === 1 ? currentSpineX : startX + i * spreadX;
      const y = branchDownBaseY + (i % 2 === 0 ? 0 : -10);

      nodes.push({
        id: n.id,
        label: mem.object || mem.text,
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
        color: 'rgba(162,155,254,0.3)',
        width: 1,
        style: 'dashed',
      });
    });
  }

  // ── 4. Surprise node ──
  if (chains.surprise && !placed.has(chains.surprise.id)) {
    const mem = srcMap.get(chains.surprise.id) || chains.surprise;
    const style = eStyle(mem.emotion);
    nodes.push({
      id: chains.surprise.id,
      label: mem.object || mem.text,
      dateLabel: '?',
      x: Math.min(currentSpineX + spineSpacing * 1.5, width - padR - 20),
      y: branchUpBaseY - 4,
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
      color: 'rgba(254,202,87,0.3)',
      width: 1,
      style: 'dotted',
    });
  }

  return { nodes, edges };
}

/* ── Drawing helpers ── */

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  headLen: number,
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const angle = Math.atan2(dy, dx);

  // Bezier curve
  const cpOffset = Math.abs(dx) * 0.35;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(x1 + cpOffset, y1, x2 - cpOffset, y2, x2, y2);
  ctx.stroke();

  // Arrowhead at end
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 7), y2 - headLen * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 7), y2 - headLen * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

function drawDashedBezier(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  dashPattern: number[],
) {
  // Approximate bezier with line segments, then draw dashed
  const steps = 40;
  const cpOffsetX = Math.abs(x2 - x1) * 0.35;
  const cpOffsetY = (y2 - y1) * 0.15;
  const points: { x: number; y: number }[] = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    // Cubic bezier with two control points
    const cx1 = x1 + cpOffsetX;
    const cy1 = y1 + cpOffsetY;
    const cx2 = x2 - cpOffsetX;
    const cy2 = y2 - cpOffsetY;
    const px = mt * mt * mt * x1 + 3 * mt * mt * t * cx1 + 3 * mt * t * t * cx2 + t * t * t * x2;
    const py = mt * mt * mt * y1 + 3 * mt * mt * t * cy1 + 3 * mt * t * t * cy2 + t * t * t * y2;
    points.push({ x: px, y: py });
  }

  ctx.save();
  ctx.setLineDash(dashPattern);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
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

  // ── Draw time axis line (thin, subtle) ──
  const spineNodes = nodes.filter(n => n.role === 'spine');
  if (spineNodes.length > 1) {
    const sorted = [...spineNodes].sort((a, b) => a.x - b.x);
    const axisY = sorted[0].y;

    ctx.save();
    ctx.strokeStyle = 'rgba(94,234,212,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sorted[0].x - 20, axisY);
    ctx.lineTo(sorted[sorted.length - 1].x + 20, axisY);
    ctx.stroke();

    // Small arrow at the right end
    const endX = sorted[sorted.length - 1].x + 20;
    ctx.fillStyle = 'rgba(94,234,212,0.18)';
    ctx.beginPath();
    ctx.moveTo(endX, axisY);
    ctx.lineTo(endX - 6, axisY - 3);
    ctx.lineTo(endX - 6, axisY + 3);
    ctx.closePath();
    ctx.fill();

    // "TIME →" label
    ctx.font = '500 7px "Avenir Next", sans-serif';
    ctx.fillStyle = 'rgba(94,234,212,0.22)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('TIME →', sorted[sorted.length - 1].x + 18, axisY + 14);
    ctx.restore();
  }

  // ── Draw edges ──
  for (const edge of edges) {
    const from = nodeById.get(edge.fromId);
    const to = nodeById.get(edge.toId);
    if (!from || !to) continue;

    const hl = hoveredId === edge.fromId || hoveredId === edge.toId;
    const isSpineEdge = edge.style === 'arrow';

    ctx.save();
    ctx.globalAlpha = hl ? 1 : isSpineEdge ? 0.88 : 0.72;
    ctx.strokeStyle = edge.color;
    ctx.lineWidth = hl ? edge.width + 0.8 : edge.width;
    ctx.fillStyle = edge.color;

    if (edge.style === 'arrow') {
      // Directional arrow (spine → spine)
      // Offset start/end to node edge
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ux = dx / dist;
      const uy = dy / dist;
      const sx = from.x + ux * from.radius;
      const sy = from.y + uy * from.radius;
      const ex = to.x - ux * to.radius;
      const ey = to.y - uy * to.radius;
      drawArrow(ctx, sx, sy, ex, ey, 7);
    } else if (edge.style === 'dashed') {
      drawDashedBezier(ctx, from.x, from.y, to.x, to.y, [5, 4]);
    } else {
      // dotted
      drawDashedBezier(ctx, from.x, from.y, to.x, to.y, [2, 4]);
    }
    ctx.restore();
  }

  // ── Draw nodes ──
  for (const node of nodes) {
    const isHovered = hoveredId === node.id;
    const isSecondary = node.role !== 'spine';
    const r = isHovered ? node.radius + 3 : node.radius;

    // Outer glow
    ctx.save();
    ctx.shadowBlur = isHovered ? 22 : isSecondary ? 10 : 14;
    ctx.shadowColor = node.glow;

    // Circle fill
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    if (node.isCurrent) {
      ctx.fillStyle = node.color;
    } else if (isSecondary) {
      ctx.fillStyle = `${node.color}32`;
    } else {
      ctx.fillStyle = `${node.color}25`;
    }
    ctx.fill();

    // Circle border
    ctx.strokeStyle = isSecondary ? `${node.color}d0` : node.color;
    ctx.lineWidth = node.isCurrent ? 3 : isSecondary ? 1 : 1.5;
    ctx.stroke();

    if (!node.isCurrent) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = isSecondary ? `${node.color}f0` : node.color;
      ctx.fill();
    }
    ctx.restore();

    // ── For spine nodes: date below node on axis, label pill above ──
    if (node.role === 'spine') {
      // Date label BELOW the node (on the time axis)
      ctx.font = '500 8px "Avenir Next", sans-serif';
      ctx.fillStyle = 'rgba(180,200,225,0.55)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(node.dateLabel, node.x, node.y + r + 6);

      // Key text pill ABOVE the node
      ctx.font = `600 10px "Avenir Next", "Segoe UI", sans-serif`;
      const textW = ctx.measureText(node.label).width;
      const pillW = textW + 14;
      const pillH = 20;
      const pillX = node.x - pillW / 2;
      const pillY = node.y - r - 8 - pillH;

      // Pill background
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = node.isCurrent ? `${node.color}30` : '#151b2e';
      ctx.strokeStyle = node.isCurrent ? node.color : `${node.color}55`;
      ctx.lineWidth = node.isCurrent ? 1.2 : 0.7;

      const br = 6;
      ctx.beginPath();
      ctx.moveTo(pillX + br, pillY);
      ctx.lineTo(pillX + pillW - br, pillY);
      ctx.quadraticCurveTo(pillX + pillW, pillY, pillX + pillW, pillY + br);
      ctx.lineTo(pillX + pillW, pillY + pillH - br);
      ctx.quadraticCurveTo(pillX + pillW, pillY + pillH, pillX + pillW - br, pillY + pillH);
      ctx.lineTo(pillX + br, pillY + pillH);
      ctx.quadraticCurveTo(pillX, pillY + pillH, pillX, pillY + pillH - br);
      ctx.lineTo(pillX, pillY + br);
      ctx.quadraticCurveTo(pillX, pillY, pillX + br, pillY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Small vertical connector from pill to node
      ctx.strokeStyle = `${node.color}30`;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(node.x, pillY + pillH);
      ctx.lineTo(node.x, node.y - r);
      ctx.stroke();

      // Pill text
      ctx.font = `600 10px "Avenir Next", "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = node.isCurrent ? '#ffffff' : '#c8d8ee';
      ctx.fillText(node.label, node.x, pillY + pillH / 2);

      // "NOW" inside current node circle
      if (node.isCurrent) {
        ctx.font = 'bold 8px "Avenir Next", sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('NOW', node.x, node.y);
      }

      // Similarity % for non-current spine nodes
      if (node.similarity && !node.isCurrent) {
        ctx.font = 'bold 7px "Avenir Next", sans-serif';
        ctx.fillStyle = node.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(node.similarity * 100)}%`, node.x, node.y);
      }
    } else {
      // ── Branch nodes (secondary): label badge on far side, date small ──
      const isUp = node.role === 'branch-up' || node.role === 'surprise';
      const labelY = isUp ? node.y - r - 4 : node.y + r + 4;

      ctx.font = `600 9px "Avenir Next", "Segoe UI", sans-serif`;
      const textW = ctx.measureText(node.label).width;
      const badgeW = textW + 10;
      const badgeH = 16;
      const badgeX = clamp(node.x - badgeW / 2, 4, width - badgeW - 4);
      const badgeY = isUp ? labelY - badgeH : labelY;

      // Badge background
      ctx.save();
      ctx.globalAlpha = isHovered ? 0.95 : 0.82;
      ctx.fillStyle = '#131929';
      ctx.strokeStyle = isHovered ? 'rgba(194,212,230,0.72)' : 'rgba(178,197,216,0.5)';
      ctx.lineWidth = 0.6;

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
      ctx.font = `600 9px "Avenir Next", "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isHovered ? 'rgba(230,240,248,0.96)' : 'rgba(211,225,238,0.88)';
      ctx.fillText(node.label, badgeX + badgeW / 2, badgeY + badgeH / 2);

      // Date tiny
      if (node.dateLabel) {
        ctx.font = '400 7px "Avenir Next", sans-serif';
        ctx.fillStyle = 'rgba(173,199,224,0.65)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const dY = isUp ? badgeY - 10 : badgeY + badgeH + 2;
        ctx.fillText(node.dateLabel, badgeX + badgeW / 2, dY);
      }

      // Similarity inside node
      if (node.similarity) {
        ctx.font = 'bold 7px "Avenir Next", sans-serif';
        ctx.fillStyle = `${node.color}90`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(node.similarity * 100)}%`, node.x, node.y);
      }
    }
  }

  // ── Chain type labels ──
  const branchUp = nodes.filter(n => n.role === 'branch-up');
  const branchDown = nodes.filter(n => n.role === 'branch-down');

  ctx.font = '500 7px "Avenir Next", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  if (spineNodes.length > 0) {
    const leftmost = spineNodes.reduce((a, b) => a.x < b.x ? a : b);
    ctx.fillStyle = 'rgba(94,234,212,0.25)';
    ctx.fillText('NARRATIVE', leftmost.x - 50, leftmost.y);
  }
  if (branchUp.length > 0) {
    ctx.fillStyle = 'rgba(160,170,180,0.2)';
    ctx.fillText('OBJECT', 6, branchUp[0].y);
  }
  if (branchDown.length > 0) {
    ctx.fillStyle = 'rgba(160,170,180,0.2)';
    ctx.fillText('CATEGORY', 6, branchDown[0].y);
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
