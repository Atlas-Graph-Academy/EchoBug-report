'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import {
  buildClusters,
  clusterFingerprint,
  type SemanticCluster,
  type CachedClustering,
  type ClusterEdge,
} from '@/lib/clustering';
import type { MemoryNode, EmbeddingsData } from '@/lib/narrative';

const CACHE_KEY_CLUSTERS = 'echo-cluster-cache';
const CACHE_KEY_LABELS = 'echo-cluster-labels';

/* ── palette ── */
const PALETTE = [
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

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','it','its','this','that','was','are','were','been','be','have',
  'has','had','do','does','did','will','would','could','should','may','might',
  'can','shall','not','no','so','if','then','than','when','what','which','who',
  'how','all','each','every','both','few','more','most','other','some','such',
  'only','own','same','very','just','about','into','over','after','before',
  "i'm","i","my","me","we","our","you","your","he","she","they","them","his",
  "her","there","here","also","still","even","much","many","like","get","got",
  "one","two","three","new","old","big","small","up","down","out","back",
]);

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function eStyle(emotion: string) {
  return PALETTE[hash((emotion || '').trim().toLowerCase() || 'x') % PALETTE.length];
}

/* ── camera ── */
interface Camera { x: number; y: number; scale: number }

function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return {
    x: a.x + (b.x - a.x) * ease,
    y: a.y + (b.y - a.y) * ease,
    scale: a.scale + (b.scale - a.scale) * ease,
  };
}

/* ── custom d3-force: soft circular boundary ──
 * Applies increasing inward pressure as nodes approach the boundary.
 * Unlike hard clamping, this lets force-directed layout find natural equilibrium INSIDE the circle.
 */
function forceBoundary(cx: number, cy: number, maxR: number) {
  let nodes: MemSubNode[] = [];
  const softStart = 0.5; // pressure starts at 50% of radius

  function force(alpha: number) {
    for (const n of nodes) {
      const dx = (n.x || 0) - cx;
      const dy = (n.y || 0) - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > maxR * softStart && dist > 0) {
        // Quadratic pressure: 0 at softStart, very strong at boundary
        const t = (dist - maxR * softStart) / (maxR * (1 - softStart));
        const pressure = t * t * 0.6 * alpha;
        n.vx! -= (dx / dist) * pressure * dist;
        n.vy! -= (dy / dist) * pressure * dist;
      }
    }
  }

  force.initialize = (_nodes: MemSubNode[]) => { nodes = _nodes; };
  return force;
}

/* ── types ── */
interface ClusterNode extends SimulationNodeDatum {
  id: number;
  label: string;
  size: number;
  radius: number;
  color: string;
  glow: string;
  emotion: string;
  memberIds: string[];
}

interface ClusterLink extends SimulationLinkDatum<ClusterNode> {
  weight: number;
}

interface MemSubNode extends SimulationNodeDatum {
  memId: string;
  label: string;
  color: string;
  glow: string;
  emotion: string;
}

interface MemSubLink extends SimulationLinkDatum<MemSubNode> {
  similarity: number;
}

interface ExpandInfo {
  cx: number;
  cy: number;
  boundaryR: number;
  nodeWorldR: number;
}

interface Props {
  memories: MemoryNode[];
  embeddingsData: EmbeddingsData;
  onMemoryClick: (memoryId: string) => void;
}

export default function ClusterGraph({ memories, embeddingsData, onMemoryClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation<ClusterNode>> | null>(null);
  const simNodesRef = useRef<ClusterNode[]>([]);
  const subSimRef = useRef<ReturnType<typeof forceSimulation<MemSubNode>> | null>(null);
  const rafRef = useRef<number | null>(null);
  const labelsRef = useRef<Map<number, string>>(new Map());
  const expandInfoRef = useRef<ExpandInfo | null>(null);

  // Camera
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const cameraTargetRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const cameraStartRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const animStartRef = useRef<number>(0);
  const animDurationRef = useRef<number>(0);

  const [clusterNodes, setClusterNodes] = useState<ClusterNode[]>([]);
  const [clusterLinks, setClusterLinks] = useState<ClusterLink[]>([]);
  const [expandedCluster, setExpandedCluster] = useState<number | null>(null);
  const [subNodes, setSubNodes] = useState<MemSubNode[]>([]);
  const [subLinks, setSubLinks] = useState<MemSubLink[]>([]);
  const [hoveredNode, setHoveredNode] = useState<number | null>(null);
  const [hoveredMem, setHoveredMem] = useState<string | null>(null);

  // Interaction refs
  const dragRef = useRef<{ type: 'cluster' | 'mem' | 'pan'; id?: number | string } | null>(null);
  const mouseDownScreenRef = useRef<{ x: number; y: number } | null>(null);
  const panStartCamRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const memById = useMemo(() => {
    const m = new Map<string, MemoryNode>();
    for (const mem of memories) m.set(mem.id, mem);
    return m;
  }, [memories]);

  const animateCamera = useCallback((target: Camera, duration = 600) => {
    cameraStartRef.current = { ...cameraRef.current };
    cameraTargetRef.current = target;
    animStartRef.current = performance.now();
    animDurationRef.current = duration;
  }, []);

  const stopCameraAnim = useCallback(() => {
    animDurationRef.current = 0;
  }, []);

  // ── Clustering + caching ──

  const fp = useMemo(() => {
    if (memories.length === 0) return '';
    return clusterFingerprint(memories.length, memories[0].id, memories[memories.length - 1].id);
  }, [memories]);

  const clusterData = useMemo<{ clusters: SemanticCluster[]; edges: ClusterEdge[] } | null>(() => {
    if (!fp) return null;
    try {
      const raw = localStorage.getItem(CACHE_KEY_CLUSTERS);
      if (raw) {
        const cached: CachedClustering = JSON.parse(raw);
        if (cached.fingerprint === fp) return { clusters: cached.clusters, edges: cached.edges };
      }
    } catch { /* miss */ }
    const result = buildClusters(memories, embeddingsData, { maxClusters: 12 });
    try {
      localStorage.setItem(CACHE_KEY_CLUSTERS, JSON.stringify({
        fingerprint: fp, clusters: result.clusters, edges: result.edges,
      } as CachedClustering));
    } catch { /* ignore */ }
    return { clusters: result.clusters, edges: result.edges };
  }, [fp, memories, embeddingsData]);

  const cachedLabels = useMemo<Map<number, string>>(() => {
    const map = new Map<number, string>();
    try {
      const raw = localStorage.getItem(CACHE_KEY_LABELS);
      if (raw) {
        const parsed = JSON.parse(raw) as { fingerprint: string; labels: Record<string, string> };
        if (parsed.fingerprint === fp) {
          for (const [k, v] of Object.entries(parsed.labels)) map.set(Number(k), v);
        }
      }
    } catch { /* ignore */ }
    return map;
  }, [fp]);

  useEffect(() => {
    if (!clusterData) return;
    const { clusters, edges } = clusterData;
    const hasCache = cachedLabels.size > 0;
    labelsRef.current = new Map(cachedLabels);

    const nodes: ClusterNode[] = clusters.map((c) => {
      const style = eStyle(c.dominantEmotion);
      return {
        id: c.id, label: cachedLabels.get(c.id) || '...',
        size: c.memberIds.length,
        radius: Math.max(22, Math.sqrt(c.memberIds.length) * 6),
        color: style.color, glow: style.glow,
        emotion: c.dominantEmotion, memberIds: c.memberIds,
      };
    });
    const links: ClusterLink[] = edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight }));
    setClusterNodes(nodes);
    setClusterLinks(links);
    if (!hasCache) fetchClusterNames(clusters);
  }, [clusterData, cachedLabels]);

  const applyLabelsToSim = useCallback((labelMap: Map<number, string>) => {
    for (const [id, lbl] of labelMap) labelsRef.current.set(id, lbl);
    for (const n of simNodesRef.current) { const lbl = labelMap.get(n.id); if (lbl) n.label = lbl; }
    if (simRef.current) simRef.current.alpha(0.01).restart();
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of labelsRef.current) obj[String(k)] = v;
      localStorage.setItem(CACHE_KEY_LABELS, JSON.stringify({ fingerprint: fp, labels: obj }));
    } catch { /* ignore */ }
  }, [fp]);

  const fetchClusterNames = useCallback(async (clusters: SemanticCluster[]) => {
    try {
      const summaries = clusters.map((c) => ({
        id: c.id, dominantEmotion: c.dominantEmotion, size: c.memberIds.length,
        texts: c.memberIds.slice(0, 15).map((id) => memById.get(id)?.text || '').filter(Boolean),
      }));
      const resp = await fetch('/api/cluster-names', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusters: summaries }),
      });
      if (resp.ok) {
        const { labels } = await resp.json();
        if (Array.isArray(labels) && labels.length > 0) {
          const labelMap = new Map<number, string>();
          for (const l of labels as { id: number; label: string }[]) labelMap.set(l.id, l.label);
          applyLabelsToSim(labelMap);
          return;
        }
      }
      applyFallbackLabels(clusters);
    } catch { applyFallbackLabels(clusters); }
  }, [memById, applyLabelsToSim]);

  const applyFallbackLabels = useCallback((clusters: SemanticCluster[]) => {
    const labelMap = new Map<number, string>();
    for (const cluster of clusters) {
      const objectCount = new Map<string, number>();
      const categoryCount = new Map<string, number>();
      for (const id of cluster.memberIds) {
        const mem = memById.get(id); if (!mem) continue;
        const obj = (mem.object || '').trim().toLowerCase();
        const cat = (mem.category || '').trim().toLowerCase();
        if (obj && obj !== 'unknown') objectCount.set(obj, (objectCount.get(obj) || 0) + 1);
        if (cat && cat !== 'unknown') categoryCount.set(cat, (categoryCount.get(cat) || 0) + 1);
      }
      let bestLabel = cluster.dominantEmotion; let bestCount = 0;
      for (const [w, c] of objectCount) { if (c > bestCount && !STOP_WORDS.has(w)) { bestCount = c; bestLabel = w; } }
      if (bestCount < 3) { for (const [w, c] of categoryCount) { if (c > bestCount && !STOP_WORDS.has(w)) { bestCount = c; bestLabel = w; } } }
      bestLabel = bestLabel.charAt(0).toUpperCase() + bestLabel.slice(1);
      labelMap.set(cluster.id, bestLabel.slice(0, 12));
    }
    applyLabelsToSim(labelMap);
  }, [memById, applyLabelsToSim]);

  // ── Main force simulation ──
  useEffect(() => {
    if (clusterNodes.length === 0) return;
    const container = containerRef.current;
    if (!container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;

    const simNodes = clusterNodes.map((n) => ({ ...n }));
    simNodesRef.current = simNodes;
    const simLinks = clusterLinks.map((l) => ({
      ...l,
      source: typeof l.source === 'number' ? l.source : (l.source as ClusterNode).id,
      target: typeof l.target === 'number' ? l.target : (l.target as ClusterNode).id,
    }));

    const sim = forceSimulation<ClusterNode>(simNodes)
      .force('link', forceLink<ClusterNode, ClusterLink>(simLinks as ClusterLink[])
        .id((d) => d.id).distance(140).strength((l) => Math.min(0.3, (l as ClusterLink).weight * 0.015)))
      .force('charge', forceManyBody<ClusterNode>().strength(-400))
      .force('center', forceCenter(w / 2, h / 2))
      .force('collide', forceCollide<ClusterNode>().radius((d) => d.radius + 16))
      .alphaDecay(0.02);

    simRef.current = sim;
    sim.on('tick', () => {
      const labels = labelsRef.current;
      if (labels.size > 0) { for (const n of simNodes) { const lbl = labels.get(n.id); if (lbl) n.label = lbl; } }
      setClusterNodes([...simNodes]);
    });
    return () => { sim.stop(); simRef.current = null; };
  }, [clusterNodes.length, clusterLinks.length]);

  // ── Expand cluster ──
  const expandCluster = useCallback((clusterId: number) => {
    if (expandedCluster === clusterId) { collapseCluster(); return; }
    if (subSimRef.current) subSimRef.current.stop();

    const cluster = clusterNodes.find((n) => n.id === clusterId);
    if (!cluster || cluster.x == null || cluster.y == null) return;

    const container = containerRef.current;
    if (!container) return;
    const vw = container.clientWidth;
    const vh = container.clientHeight;
    const viewMin = Math.min(vw, vh);

    setExpandedCluster(clusterId);

    const memberCount = cluster.memberIds.length;
    const clusterR = cluster.radius;
    const cx = cluster.x;
    const cy = cluster.y;

    // ── Sizing: all relative to viewport ──
    // Target: node appears as 0.25% of viewMin on screen (~2px on 800px viewport)
    const nodeScreenR = viewMin * 0.0025;
    // Zoom: cluster circle fills 75% of viewport
    const zoomScale = (viewMin * 0.375) / clusterR;
    // World-space node radius at this zoom
    const nodeWorldR = nodeScreenR / zoomScale;
    // Collide: center-to-center >= 4 * nodeWorldR → gap between edges >= 2 * nodeWorldR = 1 diameter
    const collideR = nodeWorldR * 2;

    expandInfoRef.current = { cx, cy, boundaryR: clusterR, nodeWorldR };

    animateCamera({
      x: vw / 2 - cx * zoomScale,
      y: vh / 2 - cy * zoomScale,
      scale: zoomScale,
    }, 500);

    // Build sub-nodes
    const memberIds = cluster.memberIds;
    const memberSet = new Set(memberIds);

    const nodes: MemSubNode[] = memberIds.map((id) => {
      const mem = memById.get(id);
      const emotion = mem?.emotion || 'Unknown';
      const style = eStyle(emotion);
      return {
        memId: id,
        label: (mem?.text || id).slice(0, 30),
        color: style.color, glow: style.glow, emotion,
      };
    });

    const links: MemSubLink[] = [];
    const seen = new Set<string>();
    for (const id of memberIds) {
      const neighbors = embeddingsData.neighbors[id] || [];
      for (const n of neighbors) {
        if (!memberSet.has(n.id)) continue;
        const key = id < n.id ? `${id}-${n.id}` : `${n.id}-${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (n.similarity >= 0.3) {
          links.push({
            source: nodes.findIndex((nn) => nn.memId === id),
            target: nodes.findIndex((nn) => nn.memId === n.id),
            similarity: n.similarity,
          });
        }
      }
    }

    setSubNodes(nodes);
    setSubLinks(links);

    // ── Sub-force simulation ──
    const boundaryR = clusterR * 0.88; // keep inside the dashed circle
    const simNodes = nodes.map((n) => ({ ...n }));

    // Initialize positions randomly within boundary (avoid center explosion)
    for (const n of simNodes) {
      const angle = hash(n.memId) * 2.399 + (hash(n.memId + 'x') * 0.001); // deterministic scatter
      const r = (hash(n.memId + 'r') % 1000) / 1000 * boundaryR * 0.8;
      n.x = cx + Math.cos(angle) * r;
      n.y = cy + Math.sin(angle) * r;
    }

    const sim = forceSimulation<MemSubNode>(simNodes)
      .force('link', forceLink<MemSubNode, MemSubLink>(links as MemSubLink[])
        .distance(collideR * 3).strength((l) => (l as MemSubLink).similarity * 0.3))
      .force('charge', forceManyBody<MemSubNode>().strength(-collideR * 8))
      .force('center', forceCenter(cx, cy).strength(0.05))
      .force('collide', forceCollide<MemSubNode>().radius(collideR).strength(1))
      .force('boundary', forceBoundary(cx, cy, boundaryR) as unknown as ReturnType<typeof forceManyBody>)
      .alphaDecay(0.02);

    subSimRef.current = sim;
    sim.on('tick', () => {
      // Hard clamp as safety net (soft force should keep most nodes inside)
      for (const n of simNodes) {
        if (n.x == null || n.y == null) continue;
        const dx = n.x - cx;
        const dy = n.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > boundaryR) {
          n.x = cx + (dx / dist) * boundaryR;
          n.y = cy + (dy / dist) * boundaryR;
        }
      }
      setSubNodes([...simNodes]);
    });
  }, [clusterNodes, expandedCluster, embeddingsData, memById, animateCamera]);

  const collapseCluster = useCallback(() => {
    if (subSimRef.current) subSimRef.current.stop();
    subSimRef.current = null;
    setExpandedCluster(null);
    setSubNodes([]);
    setSubLinks([]);
    expandInfoRef.current = null;
    animateCamera({ x: 0, y: 0, scale: 1 }, 400);
  }, [animateCamera]);

  // ── Canvas rendering ──
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const render = () => {
      const vw = container.clientWidth;
      const vh = container.clientHeight;
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      canvas.width = Math.floor(vw * dpr);
      canvas.height = Math.floor(vh * dpr);
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, vw, vh);

      // Background
      const bg = ctx.createLinearGradient(0, 0, vw, vh);
      bg.addColorStop(0, '#070a14');
      bg.addColorStop(1, '#080e1f');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, vw, vh);

      // Animate camera
      const now = performance.now();
      const dur = animDurationRef.current;
      if (dur > 0 && now < animStartRef.current + dur) {
        const t = Math.min(1, (now - animStartRef.current) / dur);
        cameraRef.current = lerpCamera(cameraStartRef.current, cameraTargetRef.current, t);
      } else if (dur > 0) {
        cameraRef.current = { ...cameraTargetRef.current };
        animDurationRef.current = 0;
      }

      const cam = cameraRef.current;

      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.scale, cam.scale);

      const isExpMode = expandedCluster !== null;
      const invS = 1 / cam.scale;
      const viewMin = Math.min(vw, vh);

      // ── Cluster edges ──
      for (const link of clusterLinks) {
        const s = typeof link.source === 'object' ? link.source : clusterNodes.find((n) => n.id === link.source);
        const t = typeof link.target === 'object' ? link.target : clusterNodes.find((n) => n.id === link.target);
        if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) continue;

        const mx = (s.x + t.x) / 2;
        const my = (s.y + t.y) / 2;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const cpx = mx - dy * 0.15;
        const cpy = my + dx * 0.15;

        const connectsExpanded = isExpMode && (
          (typeof link.source === 'object' ? (link.source as ClusterNode).id : link.source) === expandedCluster ||
          (typeof link.target === 'object' ? (link.target as ClusterNode).id : link.target) === expandedCluster
        );

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.quadraticCurveTo(cpx, cpy, t.x, t.y);
        ctx.strokeStyle = isExpMode
          ? (connectsExpanded ? 'rgba(200,220,255,0.15)' : 'rgba(200,220,255,0.03)')
          : 'rgba(200,220,255,0.06)';
        ctx.lineWidth = Math.max(0.5, (connectsExpanded ? 1.5 : Math.min(2.5, link.weight * 0.08))) * invS;
        ctx.stroke();
      }

      // ── Sub-graph edges ──
      if (isExpMode && subNodes.length > 0) {
        let edgesToDraw = subLinks;
        if (subNodes.length > 60) {
          const sorted = [...subLinks].sort((a, b) => b.similarity - a.similarity);
          edgesToDraw = sorted.slice(0, Math.min(sorted.length, subNodes.length * 2));
        }

        for (const link of edgesToDraw) {
          const si = typeof link.source === 'number' ? link.source : (link.source as MemSubNode);
          const ti = typeof link.target === 'number' ? link.target : (link.target as MemSubNode);
          const s = typeof si === 'number' ? subNodes[si] : si;
          const t = typeof ti === 'number' ? subNodes[ti] : ti;
          if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) continue;

          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(t.x, t.y);
          ctx.strokeStyle = `rgba(200,220,255,${0.04 + link.similarity * 0.08})`;
          ctx.lineWidth = 0.3 * invS;
          ctx.stroke();
        }
      }

      // ── Cluster nodes ──
      for (const node of clusterNodes) {
        if (node.x == null || node.y == null) continue;
        const isExpanded = expandedCluster === node.id;
        const isHovered = hoveredNode === node.id;
        const dimmed = isExpMode && !isExpanded;
        const alpha = dimmed ? 0.12 : 1;

        // Glow
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = (isHovered ? 24 : 14);
        ctx.shadowColor = node.glow;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = isExpanded ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.04)';
        ctx.fill();
        ctx.restore();

        // Border
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.strokeStyle = node.color;
        ctx.lineWidth = isHovered ? 2 : isExpanded ? 1 : 1.2;
        if (isExpanded) ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Label
        const fontSize = isHovered ? 14 : 13;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = `600 ${fontSize * invS}px "Avenir Next", "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = node.color;
        ctx.fillText(node.label, node.x, node.y - node.radius - 10 * invS);
        ctx.restore();

        // Size count
        if (!isExpanded || !isExpMode) {
          ctx.save();
          ctx.globalAlpha = alpha * 0.7;
          ctx.font = `500 ${11 * invS}px "Avenir Next", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#cfe5f7';
          ctx.fillText(`${node.size}`, node.x, node.y);
          ctx.restore();
        }
      }

      // ── Sub-nodes: screen-relative sizing ──
      if (isExpMode) {
        // Node radius = 0.25% of viewport min dimension, in world coords
        const nodeScreenR = viewMin * 0.0025;
        const nodeWorldR = nodeScreenR * invS;

        for (const sn of subNodes) {
          if (sn.x == null || sn.y == null) continue;
          const isHov = hoveredMem === sn.memId;
          const r = isHov ? nodeWorldR * 1.8 : nodeWorldR;

          ctx.save();
          ctx.shadowBlur = (isHov ? 12 : 4) * invS;
          ctx.shadowColor = sn.glow;
          ctx.beginPath();
          ctx.arc(sn.x, sn.y, r, 0, Math.PI * 2);
          ctx.fillStyle = sn.color;
          ctx.globalAlpha = 0.9;
          ctx.fill();
          ctx.restore();

          // Tooltip on hover
          if (isHov) {
            ctx.save();
            const fs = 11 * invS;
            ctx.font = `500 ${fs}px "Avenir Next", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            const txt = sn.label;
            const tw = ctx.measureText(txt).width;
            const px = 4 * invS;
            const py = 2 * invS;
            ctx.fillStyle = 'rgba(8,14,31,0.85)';
            ctx.fillRect(sn.x - tw / 2 - px, sn.y - r - 14 * invS - py, tw + px * 2, 12 * invS + py * 2);
            ctx.fillStyle = '#f0f7ff';
            ctx.fillText(txt, sn.x, sn.y - r - 4 * invS);
            ctx.restore();
          }
        }
      }

      ctx.restore(); // pop camera

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [clusterNodes, clusterLinks, subNodes, subLinks, expandedCluster, hoveredNode, hoveredMem]);

  // Resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const obs = new ResizeObserver(() => {
      if (simRef.current) {
        const w = container.clientWidth; const h = container.clientHeight;
        simRef.current.force('center', forceCenter(w / 2, h / 2));
        simRef.current.alpha(0.3).restart();
      }
    });
    obs.observe(container);
    return () => obs.disconnect();
  }, []);

  // ── Free zoom via scroll wheel ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopCameraAnim();

      const cam = cameraRef.current;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const wx = (sx - cam.x) / cam.scale;
      const wy = (sy - cam.y) / cam.scale;

      const delta = -e.deltaY * 0.001;
      const factor = Math.pow(2, delta);
      const newScale = Math.min(50, Math.max(0.1, cam.scale * factor));

      cameraRef.current = {
        x: sx - wx * newScale,
        y: sy - wy * newScale,
        scale: newScale,
      };
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [stopCameraAnim]);

  // ── Interaction ──

  const screenToWorld = useCallback((sx: number, sy: number) => {
    const cam = cameraRef.current;
    return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
  }, []);

  const findNode = useCallback(
    (wx: number, wy: number): { type: 'cluster' | 'mem'; node: ClusterNode | MemSubNode } | null => {
      if (expandedCluster !== null) {
        for (const sn of subNodes) {
          if (sn.x == null || sn.y == null) continue;
          const dx = wx - sn.x; const dy = wy - sn.y;
          const hitR = 8 / cameraRef.current.scale + 4;
          if (dx * dx + dy * dy < hitR * hitR) return { type: 'mem', node: sn };
        }
      }
      for (const cn of clusterNodes) {
        if (cn.x == null || cn.y == null) continue;
        const dx = wx - cn.x; const dy = wy - cn.y;
        if (dx * dx + dy * dy < cn.radius * cn.radius) return { type: 'cluster', node: cn };
      }
      return null;
    },
    [clusterNodes, subNodes, expandedCluster]
  );

  const getWorldPos = useCallback((e: React.MouseEvent | MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  }, [screenToWorld]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    mouseDownScreenRef.current = { x: e.clientX, y: e.clientY };
    const { x, y } = getWorldPos(e);
    const hit = findNode(x, y);

    if (hit) {
      if (hit.type === 'cluster') {
        const node = hit.node as ClusterNode;
        node.fx = x; node.fy = y;
        dragRef.current = { type: 'cluster', id: node.id };
      } else {
        const node = hit.node as MemSubNode;
        node.fx = x; node.fy = y;
        dragRef.current = { type: 'mem', id: node.memId };
      }
    } else {
      stopCameraAnim();
      dragRef.current = { type: 'pan' };
      panStartCamRef.current = { x: cameraRef.current.x, y: cameraRef.current.y };
    }
  }, [findNode, getWorldPos, stopCameraAnim]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const drag = dragRef.current;

    if (drag) {
      if (drag.type === 'pan') {
        const downPos = mouseDownScreenRef.current;
        if (!downPos) return;
        const dx = e.clientX - downPos.x;
        const dy = e.clientY - downPos.y;
        cameraRef.current = {
          ...cameraRef.current,
          x: panStartCamRef.current.x + dx,
          y: panStartCamRef.current.y + dy,
        };
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = 'grabbing';
        return;
      }

      const { x, y } = getWorldPos(e);
      if (drag.type === 'cluster') {
        const node = clusterNodes.find((n) => n.id === drag.id);
        if (node && simRef.current) { node.fx = x; node.fy = y; simRef.current.alpha(0.3).restart(); }
      } else if (drag.type === 'mem') {
        const node = subNodes.find((n) => n.memId === drag.id);
        if (node && subSimRef.current) { node.fx = x; node.fy = y; subSimRef.current.alpha(0.3).restart(); }
      }
      return;
    }

    const { x, y } = getWorldPos(e);
    const hit = findNode(x, y);
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = hit ? 'pointer' : 'grab';

    if (hit?.type === 'cluster') { setHoveredNode((hit.node as ClusterNode).id); setHoveredMem(null); }
    else if (hit?.type === 'mem') { setHoveredMem((hit.node as MemSubNode).memId); setHoveredNode(null); }
    else { setHoveredNode(null); setHoveredMem(null); }
  }, [clusterNodes, subNodes, findNode, getWorldPos]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;

    if (drag.type === 'cluster') {
      const node = clusterNodes.find((n) => n.id === drag.id);
      if (node) { node.fx = null; node.fy = null; }
    } else if (drag.type === 'mem') {
      const node = subNodes.find((n) => n.memId === drag.id);
      if (node) { node.fx = null; node.fy = null; }
    }

    const downPos = mouseDownScreenRef.current;
    const wasDrag = downPos && (
      (e.clientX - downPos.x) ** 2 + (e.clientY - downPos.y) ** 2 > 25
    );

    if (!wasDrag) {
      const { x, y } = getWorldPos(e);
      const hit = findNode(x, y);

      if (!hit) {
        if (expandedCluster !== null) collapseCluster();
      } else if (hit.type === 'cluster') {
        expandCluster((hit.node as ClusterNode).id);
      } else {
        onMemoryClick((hit.node as MemSubNode).memId);
      }
    }

    dragRef.current = null;
    mouseDownScreenRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'grab';
  }, [clusterNodes, subNodes, findNode, getWorldPos, expandCluster, collapseCluster, expandedCluster, onMemoryClick]);

  const handleMouseLeave = useCallback(() => {
    const drag = dragRef.current;
    if (drag) {
      if (drag.type === 'cluster') {
        const node = clusterNodes.find((n) => n.id === drag.id);
        if (node) { node.fx = null; node.fy = null; }
      } else if (drag.type === 'mem') {
        const node = subNodes.find((n) => n.memId === drag.id);
        if (node) { node.fx = null; node.fy = null; }
      }
      dragRef.current = null;
      mouseDownScreenRef.current = null;
    }
    setHoveredNode(null);
    setHoveredMem(null);
  }, [clusterNodes, subNodes]);

  if (memories.length === 0) {
    return <div className="memory-status">No memory data for constellation view</div>;
  }

  return (
    <div ref={containerRef} className="cluster-graph-container">
      <canvas
        ref={canvasRef}
        style={{ cursor: 'grab' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
      {expandedCluster !== null && (
        <button className="cluster-collapse-btn" onClick={collapseCluster}>
          Back
        </button>
      )}
    </div>
  );
}
