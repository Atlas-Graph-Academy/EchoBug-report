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

  const [clusterNodes, setClusterNodes] = useState<ClusterNode[]>([]);
  const [clusterLinks, setClusterLinks] = useState<ClusterLink[]>([]);
  const [expandedCluster, setExpandedCluster] = useState<number | null>(null);
  const [subNodes, setSubNodes] = useState<MemSubNode[]>([]);
  const [subLinks, setSubLinks] = useState<MemSubLink[]>([]);
  const [hoveredNode, setHoveredNode] = useState<number | null>(null);
  const [hoveredMem, setHoveredMem] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<{ type: 'cluster' | 'mem'; id: number | string } | null>(null);

  const memById = useMemo(() => {
    const m = new Map<string, MemoryNode>();
    for (const mem of memories) m.set(mem.id, mem);
    return m;
  }, [memories]);

  // Fingerprint for cache invalidation: changes when memory set changes
  const fp = useMemo(() => {
    if (memories.length === 0) return '';
    return clusterFingerprint(memories.length, memories[0].id, memories[memories.length - 1].id);
  }, [memories]);

  // Build or load cached clusters
  const clusterData = useMemo<{ clusters: SemanticCluster[]; edges: ClusterEdge[] } | null>(() => {
    if (!fp) return null;

    // Try localStorage cache first
    try {
      const raw = localStorage.getItem(CACHE_KEY_CLUSTERS);
      if (raw) {
        const cached: CachedClustering = JSON.parse(raw);
        if (cached.fingerprint === fp) {
          return { clusters: cached.clusters, edges: cached.edges };
        }
      }
    } catch { /* cache miss */ }

    // Compute fresh
    const result = buildClusters(memories, embeddingsData, { maxClusters: 12 });

    // Save to cache
    try {
      const toCache: CachedClustering = {
        fingerprint: fp,
        clusters: result.clusters,
        edges: result.edges,
      };
      localStorage.setItem(CACHE_KEY_CLUSTERS, JSON.stringify(toCache));
    } catch { /* quota exceeded, ignore */ }

    return { clusters: result.clusters, edges: result.edges };
  }, [fp, memories, embeddingsData]);

  // Try loading cached labels
  const cachedLabels = useMemo<Map<number, string>>(() => {
    const map = new Map<number, string>();
    try {
      const raw = localStorage.getItem(CACHE_KEY_LABELS);
      if (raw) {
        const parsed = JSON.parse(raw) as { fingerprint: string; labels: Record<string, string> };
        if (parsed.fingerprint === fp) {
          for (const [k, v] of Object.entries(parsed.labels)) {
            map.set(Number(k), v);
          }
        }
      }
    } catch { /* ignore */ }
    return map;
  }, [fp]);

  // Initialize nodes + load or fetch names
  useEffect(() => {
    if (!clusterData) return;
    const { clusters, edges } = clusterData;

    const hasCache = cachedLabels.size > 0;
    labelsRef.current = new Map(cachedLabels);

    const nodes: ClusterNode[] = clusters.map((c) => {
      const style = eStyle(c.dominantEmotion);
      return {
        id: c.id,
        label: cachedLabels.get(c.id) || '...',
        size: c.memberIds.length,
        radius: Math.max(22, Math.sqrt(c.memberIds.length) * 6),
        color: style.color,
        glow: style.glow,
        emotion: c.dominantEmotion,
        memberIds: c.memberIds,
      };
    });

    const links: ClusterLink[] = edges.map((e) => ({
      source: e.source,
      target: e.target,
      weight: e.weight,
    }));

    setClusterNodes(nodes);
    setClusterLinks(links);

    // Only call Gemini if we don't have cached labels
    if (!hasCache) {
      fetchClusterNames(clusters);
    }
  }, [clusterData, cachedLabels]);

  const applyLabelsToSim = useCallback((labelMap: Map<number, string>) => {
    for (const [id, lbl] of labelMap) {
      labelsRef.current.set(id, lbl);
    }
    for (const n of simNodesRef.current) {
      const lbl = labelMap.get(n.id);
      if (lbl) n.label = lbl;
    }
    if (simRef.current) {
      simRef.current.alpha(0.01).restart();
    }

    // Persist labels to localStorage
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of labelsRef.current) obj[String(k)] = v;
      localStorage.setItem(CACHE_KEY_LABELS, JSON.stringify({ fingerprint: fp, labels: obj }));
    } catch { /* ignore */ }
  }, [fp]);

  const fetchClusterNames = useCallback(async (clusters: SemanticCluster[]) => {
    try {
      const summaries = clusters.map((c) => ({
        id: c.id,
        dominantEmotion: c.dominantEmotion,
        size: c.memberIds.length,
        texts: c.memberIds
          .slice(0, 15)
          .map((id) => memById.get(id)?.text || '')
          .filter(Boolean),
      }));

      const resp = await fetch('/api/cluster-names', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusters: summaries }),
      });

      if (resp.ok) {
        const { labels } = await resp.json();
        if (Array.isArray(labels) && labels.length > 0) {
          const labelMap = new Map<number, string>();
          for (const l of labels as { id: number; label: string }[]) {
            labelMap.set(l.id, l.label);
          }
          applyLabelsToSim(labelMap);
          return;
        }
      }
      console.warn('[ClusterGraph] Gemini naming failed, using fallback');
      applyFallbackLabels(clusters);
    } catch (err) {
      console.warn('[ClusterGraph] Gemini naming error:', err);
      applyFallbackLabels(clusters);
    }
  }, [memById, applyLabelsToSim]);

  const applyFallbackLabels = useCallback((clusters: SemanticCluster[]) => {
    const labelMap = new Map<number, string>();
    for (const cluster of clusters) {
      const objectCount = new Map<string, number>();
      const categoryCount = new Map<string, number>();
      for (const id of cluster.memberIds) {
        const mem = memById.get(id);
        if (!mem) continue;
        const obj = (mem.object || '').trim().toLowerCase();
        const cat = (mem.category || '').trim().toLowerCase();
        if (obj && obj !== 'unknown') objectCount.set(obj, (objectCount.get(obj) || 0) + 1);
        if (cat && cat !== 'unknown') categoryCount.set(cat, (categoryCount.get(cat) || 0) + 1);
      }

      let bestLabel = cluster.dominantEmotion;
      let bestCount = 0;

      for (const [w, c] of objectCount) {
        if (c > bestCount && !STOP_WORDS.has(w)) {
          bestCount = c;
          bestLabel = w;
        }
      }
      if (bestCount < 3) {
        for (const [w, c] of categoryCount) {
          if (c > bestCount && !STOP_WORDS.has(w)) {
            bestCount = c;
            bestLabel = w;
          }
        }
      }

      bestLabel = bestLabel.charAt(0).toUpperCase() + bestLabel.slice(1);
      labelMap.set(cluster.id, bestLabel.slice(0, 12));
    }
    applyLabelsToSim(labelMap);
  }, [memById, applyLabelsToSim]);

  // Main force simulation
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
      .force(
        'link',
        forceLink<ClusterNode, ClusterLink>(simLinks as ClusterLink[])
          .id((d) => d.id)
          .distance(140)
          .strength((l) => Math.min(0.3, (l as ClusterLink).weight * 0.015))
      )
      .force('charge', forceManyBody<ClusterNode>().strength(-400))
      .force('center', forceCenter(w / 2, h / 2))
      .force('collide', forceCollide<ClusterNode>().radius((d) => d.radius + 16))
      .alphaDecay(0.02);

    simRef.current = sim;

    sim.on('tick', () => {
      const labels = labelsRef.current;
      if (labels.size > 0) {
        for (const n of simNodes) {
          const lbl = labels.get(n.id);
          if (lbl) n.label = lbl;
        }
      }
      setClusterNodes([...simNodes]);
    });

    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [clusterNodes.length, clusterLinks.length]);

  // Expand cluster sub-graph
  const expandCluster = useCallback(
    (clusterId: number) => {
      if (expandedCluster === clusterId) {
        collapseCluster();
        return;
      }
      if (subSimRef.current) subSimRef.current.stop();

      const cluster = clusterNodes.find((n) => n.id === clusterId);
      if (!cluster) return;

      setExpandedCluster(clusterId);

      const memberIds = cluster.memberIds;
      const memberSet = new Set(memberIds);

      const nodes: MemSubNode[] = memberIds.map((id) => {
        const mem = memById.get(id);
        const emotion = mem?.emotion || 'Unknown';
        const style = eStyle(emotion);
        return {
          memId: id,
          label: (mem?.text || id).slice(0, 14),
          color: style.color,
          glow: style.glow,
          emotion,
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

      const container = containerRef.current;
      if (!container) return;
      const cx = cluster.x ?? container.clientWidth / 2;
      const cy = cluster.y ?? container.clientHeight / 2;

      const simNodes = nodes.map((n) => ({ ...n }));
      const sim = forceSimulation<MemSubNode>(simNodes)
        .force(
          'link',
          forceLink<MemSubNode, MemSubLink>(links as MemSubLink[])
            .distance(40)
            .strength((l) => (l as MemSubLink).similarity * 0.5)
        )
        .force('charge', forceManyBody<MemSubNode>().strength(-80))
        .force('center', forceCenter(cx, cy))
        .force('collide', forceCollide<MemSubNode>().radius(10))
        .alphaDecay(0.03);

      subSimRef.current = sim;
      sim.on('tick', () => {
        setSubNodes([...simNodes]);
      });
    },
    [clusterNodes, expandedCluster, embeddingsData, memById]
  );

  const collapseCluster = useCallback(() => {
    if (subSimRef.current) subSimRef.current.stop();
    subSimRef.current = null;
    setExpandedCluster(null);
    setSubNodes([]);
    setSubLinks([]);
  }, []);

  // Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const render = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Background
      const bg = ctx.createLinearGradient(0, 0, w, h);
      bg.addColorStop(0, '#070a14');
      bg.addColorStop(1, '#080e1f');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Draw cluster edges
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

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.quadraticCurveTo(cpx, cpy, t.x, t.y);
        ctx.strokeStyle = 'rgba(200,220,255,0.06)';
        ctx.lineWidth = Math.min(2.5, Math.max(0.5, link.weight * 0.08));
        ctx.stroke();
      }

      // Draw sub-graph edges
      if (expandedCluster !== null && subNodes.length > 0) {
        for (const link of subLinks) {
          const si = typeof link.source === 'number' ? link.source : (link.source as MemSubNode);
          const ti = typeof link.target === 'number' ? link.target : (link.target as MemSubNode);
          const s = typeof si === 'number' ? subNodes[si] : si;
          const t = typeof ti === 'number' ? subNodes[ti] : ti;
          if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) continue;

          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(t.x, t.y);
          ctx.strokeStyle = `rgba(200,220,255,${0.05 + link.similarity * 0.15})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }

      // Draw cluster nodes
      for (const node of clusterNodes) {
        if (node.x == null || node.y == null) continue;
        const isExpanded = expandedCluster === node.id;
        const isHovered = hoveredNode === node.id;
        const dimmed = expandedCluster !== null && !isExpanded;
        const alpha = dimmed ? 0.2 : 1;

        // Glow
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = isHovered ? 24 : 14;
        ctx.shadowColor = node.glow;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = isExpanded ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.04)';
        ctx.fill();
        ctx.restore();

        // Border
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.strokeStyle = node.color;
        ctx.lineWidth = isHovered ? 2 : 1.2;
        ctx.stroke();
        ctx.restore();

        // Label above node
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = '600 13px "Avenir Next", "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = node.color;
        ctx.fillText(node.label, node.x, node.y - node.radius - 10);
        ctx.restore();

        // Size inside node
        ctx.save();
        ctx.globalAlpha = alpha * 0.7;
        ctx.font = '500 11px "Avenir Next", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#cfe5f7';
        ctx.fillText(`${node.size}`, node.x, node.y);
        ctx.restore();
      }

      // Draw sub-nodes
      if (expandedCluster !== null) {
        for (const sn of subNodes) {
          if (sn.x == null || sn.y == null) continue;
          const isHov = hoveredMem === sn.memId;
          const r = isHov ? 7 : 5;

          ctx.save();
          ctx.shadowBlur = isHov ? 16 : 8;
          ctx.shadowColor = sn.glow;
          ctx.beginPath();
          ctx.arc(sn.x, sn.y, r, 0, Math.PI * 2);
          ctx.fillStyle = sn.color;
          ctx.globalAlpha = 0.85;
          ctx.fill();
          ctx.restore();

          if (isHov) {
            ctx.save();
            ctx.font = '500 11px "Avenir Next", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillStyle = '#f0f7ff';
            ctx.fillText(sn.label, sn.x, sn.y - 12);
            ctx.restore();
          }
        }
      }

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [clusterNodes, clusterLinks, subNodes, subLinks, expandedCluster, hoveredNode, hoveredMem]);

  // Resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const obs = new ResizeObserver(() => {
      if (simRef.current) {
        const w = container.clientWidth;
        const h = container.clientHeight;
        simRef.current.force('center', forceCenter(w / 2, h / 2));
        simRef.current.alpha(0.3).restart();
      }
    });
    obs.observe(container);
    return () => obs.disconnect();
  }, []);

  // Interaction
  const findNode = useCallback(
    (x: number, y: number): { type: 'cluster' | 'mem'; node: ClusterNode | MemSubNode } | null => {
      if (expandedCluster !== null) {
        for (const sn of subNodes) {
          if (sn.x == null || sn.y == null) continue;
          const dx = x - sn.x;
          const dy = y - sn.y;
          if (dx * dx + dy * dy < 10 * 10) return { type: 'mem', node: sn };
        }
      }
      for (const cn of clusterNodes) {
        if (cn.x == null || cn.y == null) continue;
        const dx = x - cn.x;
        const dy = y - cn.y;
        if (dx * dx + dy * dy < cn.radius * cn.radius) return { type: 'cluster', node: cn };
      }
      return null;
    },
    [clusterNodes, subNodes, expandedCluster]
  );

  const getCanvasPos = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const { x, y } = getCanvasPos(e);

      if (dragTarget) {
        if (dragTarget.type === 'cluster') {
          const node = clusterNodes.find((n) => n.id === dragTarget.id);
          if (node && simRef.current) {
            node.fx = x;
            node.fy = y;
            simRef.current.alpha(0.3).restart();
          }
        } else {
          const node = subNodes.find((n) => n.memId === dragTarget.id);
          if (node && subSimRef.current) {
            node.fx = x;
            node.fy = y;
            subSimRef.current.alpha(0.3).restart();
          }
        }
        return;
      }

      const hit = findNode(x, y);
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = hit ? 'pointer' : 'default';

      if (hit?.type === 'cluster') {
        setHoveredNode((hit.node as ClusterNode).id);
        setHoveredMem(null);
      } else if (hit?.type === 'mem') {
        setHoveredMem((hit.node as MemSubNode).memId);
        setHoveredNode(null);
      } else {
        setHoveredNode(null);
        setHoveredMem(null);
      }
    },
    [dragTarget, clusterNodes, subNodes, findNode, getCanvasPos]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const { x, y } = getCanvasPos(e);
      const hit = findNode(x, y);
      if (!hit) return;

      if (hit.type === 'cluster') {
        const node = hit.node as ClusterNode;
        node.fx = x;
        node.fy = y;
        setDragTarget({ type: 'cluster', id: node.id });
      } else {
        const node = hit.node as MemSubNode;
        node.fx = x;
        node.fy = y;
        setDragTarget({ type: 'mem', id: node.memId });
      }
    },
    [findNode, getCanvasPos]
  );

  const handleMouseUp = useCallback(() => {
    if (dragTarget) {
      if (dragTarget.type === 'cluster') {
        const node = clusterNodes.find((n) => n.id === dragTarget.id);
        if (node) { node.fx = null; node.fy = null; }
      } else {
        const node = subNodes.find((n) => n.memId === dragTarget.id);
        if (node) { node.fx = null; node.fy = null; }
      }
      setDragTarget(null);
    }
  }, [dragTarget, clusterNodes, subNodes]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (dragTarget) return;
      const { x, y } = getCanvasPos(e);
      const hit = findNode(x, y);

      if (!hit) {
        if (expandedCluster !== null) collapseCluster();
        return;
      }

      if (hit.type === 'cluster') {
        expandCluster((hit.node as ClusterNode).id);
      } else {
        onMemoryClick((hit.node as MemSubNode).memId);
      }
    },
    [dragTarget, findNode, getCanvasPos, expandCluster, collapseCluster, expandedCluster, onMemoryClick]
  );

  if (memories.length === 0) {
    return <div className="memory-status">No memory data for constellation view</div>;
  }

  return (
    <div ref={containerRef} className="cluster-graph-container">
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
      />
      {expandedCluster !== null && (
        <button className="cluster-collapse-btn" onClick={collapseCluster}>
          Back
        </button>
      )}
    </div>
  );
}
