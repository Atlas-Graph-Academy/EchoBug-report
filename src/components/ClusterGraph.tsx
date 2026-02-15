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

function subNodeBaseScreenPx(
  viewMin: number,
  cameraScale: number,
  boundaryWorldR: number,
  nodeCount: number
): number {
  const safeCount = Math.max(1, nodeCount);
  const boundaryScreenR = Math.max(1, boundaryWorldR * cameraScale);
  // Domain-aware baseline: larger cluster on screen + lower density => larger nodes.
  const densityBase = boundaryScreenR / (14 + Math.sqrt(safeCount) * 0.9);
  const viewportFloor = viewMin * 0.006;
  const zoomBoost = Math.max(0.95, Math.min(1.9, Math.pow(Math.max(0.08, cameraScale), 0.2)));
  return Math.max(5.2, Math.min(28, Math.max(viewportFloor, densityBase) * zoomBoost));
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

  (force as unknown as { center: (x: number, y: number) => unknown }).center = (x: number, y: number) => {
    cx = x;
    cy = y;
    return force;
  };

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
  importance: number;
  targetR: number;
}

interface MemSubLink extends SimulationLinkDatum<MemSubNode> {
  similarity: number;
}

interface ExpandInfo {
  clusterId: number;
  cx: number;
  cy: number;
  boundaryR: number;
  nodeWorldR: number;
  memberCount: number;
}

interface Props {
  memories: MemoryNode[];
  embeddingsData: EmbeddingsData;
  onMemoryClick: (memoryId: string) => void;
}

interface WebGLScene {
  gl: WebGLRenderingContext;
  pointProgram: WebGLProgram;
  lineProgram: WebGLProgram;
  pointPosBuffer: WebGLBuffer;
  pointColorBuffer: WebGLBuffer;
  pointImportanceBuffer: WebGLBuffer;
  linePosBuffer: WebGLBuffer;
  lineColorBuffer: WebGLBuffer;
  pointPosLoc: number;
  pointColorLoc: number;
  pointImportanceLoc: number;
  linePosLoc: number;
  lineColorLoc: number;
  pointCameraLoc: WebGLUniformLocation | null;
  pointViewportLoc: WebGLUniformLocation | null;
  pointSizeLoc: WebGLUniformLocation | null;
  lineCameraLoc: WebGLUniformLocation | null;
  lineViewportLoc: WebGLUniformLocation | null;
}

function parseHexColor(hex: string): [number, number, number] {
  const raw = hex.trim();
  const m = raw.match(/^#([0-9a-f]{6})$/i);
  if (!m) return [1, 0.62, 0.26];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function createShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const p = gl.createProgram();
  if (!p) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    gl.deleteProgram(p);
    return null;
  }
  return p;
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export default function ClusterGraph({ memories, embeddingsData, onMemoryClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation<ClusterNode>> | null>(null);
  const simNodesRef = useRef<ClusterNode[]>([]);
  const subSimRef = useRef<ReturnType<typeof forceSimulation<MemSubNode>> | null>(null);
  const clusterNodesRef = useRef<ClusterNode[]>([]);
  const clusterLinksRef = useRef<ClusterLink[]>([]);
  const subNodesRef = useRef<MemSubNode[]>([]);
  const subLinksRef = useRef<MemSubLink[]>([]);
  const subRenderLinksRef = useRef<MemSubLink[]>([]);
  const hoveredNodeRef = useRef<number | null>(null);
  const hoveredMemRef = useRef<string | null>(null);
  const canvasMetricsRef = useRef<{ vw: number; vh: number; dpr: number }>({ vw: 0, vh: 0, dpr: 0 });
  const rafRef = useRef<number | null>(null);
  const labelsRef = useRef<Map<number, string>>(new Map());
  const expandInfoRef = useRef<ExpandInfo | null>(null);
  const expandedClusterRef = useRef<number | null>(null);
  const subTickLastCommitRef = useRef<number>(0);
  const expandBuildTokenRef = useRef<number>(0);
  const subSimStartTimerRef = useRef<number | null>(null);
  const webglSceneRef = useRef<WebGLScene | null>(null);
  const webglDataVersionRef = useRef<number>(0);
  const webglUploadedVersionRef = useRef<number>(-1);

  // Camera
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const cameraTargetRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const cameraStartRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const animStartRef = useRef<number>(0);
  const animDurationRef = useRef<number>(0);

  const [clusterNodes, setClusterNodes] = useState<ClusterNode[]>([]);
  const [clusterLinks, setClusterLinks] = useState<ClusterLink[]>([]);
  const [expandedCluster, setExpandedCluster] = useState<number | null>(null);

  useEffect(() => {
    expandedClusterRef.current = expandedCluster;
  }, [expandedCluster]);

  useEffect(() => {
    const canvas = glCanvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
    if (!gl) return;

    const pointVs = `
      attribute vec2 a_pos;
      attribute vec4 a_color;
      attribute float a_importance;
      uniform vec3 u_camera;
      uniform vec2 u_viewport;
      uniform float u_pointSize;
      varying vec4 v_color;
      varying float v_importance;
      void main() {
        vec2 screen = vec2(a_pos.x * u_camera.z + u_camera.x, a_pos.y * u_camera.z + u_camera.y);
        vec2 clip = vec2(screen.x / (u_viewport.x * 0.5) - 1.0, 1.0 - screen.y / (u_viewport.y * 0.5));
        gl_Position = vec4(clip, 0.0, 1.0);
        gl_PointSize = u_pointSize * (0.78 + a_importance * 1.9);
        v_color = a_color;
        v_importance = a_importance;
      }
    `;
    const pointFs = `
      precision mediump float;
      varying vec4 v_color;
      varying float v_importance;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float d = length(p);
        if (d > 1.0) discard;
        float core = smoothstep(0.68, 0.0, d);
        float halo = smoothstep(1.0, 0.22, d);
        float alpha = v_color.a * (core * 0.92 + halo * (0.36 + 0.24 * v_importance));
        vec3 color = mix(v_color.rgb * 0.85, vec3(1.0), 0.06 + v_importance * 0.1);
        gl_FragColor = vec4(color, alpha);
      }
    `;
    const lineVs = `
      attribute vec2 a_pos;
      attribute vec4 a_color;
      uniform vec3 u_camera;
      uniform vec2 u_viewport;
      varying vec4 v_color;
      void main() {
        vec2 screen = vec2(a_pos.x * u_camera.z + u_camera.x, a_pos.y * u_camera.z + u_camera.y);
        vec2 clip = vec2(screen.x / (u_viewport.x * 0.5) - 1.0, 1.0 - screen.y / (u_viewport.y * 0.5));
        gl_Position = vec4(clip, 0.0, 1.0);
        v_color = a_color;
      }
    `;
    const lineFs = `
      precision mediump float;
      varying vec4 v_color;
      void main() { gl_FragColor = v_color; }
    `;

    const pointProgram = createProgram(gl, pointVs, pointFs);
    const lineProgram = createProgram(gl, lineVs, lineFs);
    if (!pointProgram || !lineProgram) return;

    const pointPosBuffer = gl.createBuffer();
    const pointColorBuffer = gl.createBuffer();
    const pointImportanceBuffer = gl.createBuffer();
    const linePosBuffer = gl.createBuffer();
    const lineColorBuffer = gl.createBuffer();
    if (!pointPosBuffer || !pointColorBuffer || !pointImportanceBuffer || !linePosBuffer || !lineColorBuffer) return;

    const scene: WebGLScene = {
      gl,
      pointProgram,
      lineProgram,
      pointPosBuffer,
      pointColorBuffer,
      pointImportanceBuffer,
      linePosBuffer,
      lineColorBuffer,
      pointPosLoc: gl.getAttribLocation(pointProgram, 'a_pos'),
      pointColorLoc: gl.getAttribLocation(pointProgram, 'a_color'),
      pointImportanceLoc: gl.getAttribLocation(pointProgram, 'a_importance'),
      linePosLoc: gl.getAttribLocation(lineProgram, 'a_pos'),
      lineColorLoc: gl.getAttribLocation(lineProgram, 'a_color'),
      pointCameraLoc: gl.getUniformLocation(pointProgram, 'u_camera'),
      pointViewportLoc: gl.getUniformLocation(pointProgram, 'u_viewport'),
      pointSizeLoc: gl.getUniformLocation(pointProgram, 'u_pointSize'),
      lineCameraLoc: gl.getUniformLocation(lineProgram, 'u_camera'),
      lineViewportLoc: gl.getUniformLocation(lineProgram, 'u_viewport'),
    };
    webglSceneRef.current = scene;

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    return () => {
      webglSceneRef.current = null;
      gl.deleteBuffer(pointPosBuffer);
      gl.deleteBuffer(pointColorBuffer);
      gl.deleteBuffer(pointImportanceBuffer);
      gl.deleteBuffer(linePosBuffer);
      gl.deleteBuffer(lineColorBuffer);
      gl.deleteProgram(pointProgram);
      gl.deleteProgram(lineProgram);
    };
  }, []);

  // Interaction refs
  const dragRef = useRef<{ type: 'pan' } | null>(null);
  const isPanningRef = useRef<boolean>(false);
  const suppressClickRef = useRef<boolean>(false);
  const freezeGestureRef = useRef<boolean>(false);
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

  const syncCameraNow = useCallback(() => {
    const dur = animDurationRef.current;
    if (dur > 0) {
      const now = performance.now();
      const t = Math.min(1, Math.max(0, (now - animStartRef.current) / dur));
      cameraRef.current = lerpCamera(cameraStartRef.current, cameraTargetRef.current, t);
      animDurationRef.current = 0;
    }
    cameraStartRef.current = { ...cameraRef.current };
    cameraTargetRef.current = { ...cameraRef.current };
  }, []);

  const markWebGLDirty = useCallback(() => {
    webglDataVersionRef.current += 1;
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
    clusterNodesRef.current = nodes;
    clusterLinksRef.current = links;
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

      // Keep expanded sub-graph rigidly attached to its parent cluster.
      const expand = expandInfoRef.current;
      const currentExpandedId = expandedClusterRef.current;
      if (expand && currentExpandedId !== null && expand.clusterId === currentExpandedId && subNodesRef.current.length > 0) {
        const parent = simNodes.find((n) => n.id === currentExpandedId);
        if (parent && parent.x != null && parent.y != null) {
          const dx = parent.x - expand.cx;
          const dy = parent.y - expand.cy;
          if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
            const subSim = subSimRef.current;
            const subSimNodes = subSim ? (subSim.nodes() as MemSubNode[]) : subNodesRef.current;
            for (const n of subSimNodes) {
              if (n.x != null) n.x += dx;
              if (n.y != null) n.y += dy;
              if (n.fx != null) n.fx += dx;
              if (n.fy != null) n.fy += dy;
            }

            if (subSim) {
              const centerForce = subSim.force('center') as { x?: (v: number) => unknown; y?: (v: number) => unknown } | null;
              if (centerForce?.x) centerForce.x(parent.x);
              if (centerForce?.y) centerForce.y(parent.y);
              const radialForce = subSim.force('radial') as { x?: (v: number) => unknown; y?: (v: number) => unknown } | null;
              if (radialForce?.x) radialForce.x(parent.x);
              if (radialForce?.y) radialForce.y(parent.y);

              const boundaryForce = subSim.force('boundary') as
                | { center?: (x: number, y: number) => unknown }
                | null;
              if (boundaryForce?.center) boundaryForce.center(parent.x, parent.y);
            }

            expand.cx = parent.x;
            expand.cy = parent.y;
            subNodesRef.current = subSimNodes;
            markWebGLDirty();
          }
        }
      }
      clusterNodesRef.current = simNodes;
    });
    return () => { sim.stop(); simRef.current = null; };
  }, [clusterNodes.length, clusterLinks.length, markWebGLDirty]);

  // ── Expand cluster ──
  const expandCluster = useCallback((clusterId: number) => {
    if (expandedCluster === clusterId) { collapseCluster(); return; }
    if (subSimRef.current) subSimRef.current.stop();
    subSimRef.current = null;
    if (subSimStartTimerRef.current !== null) {
      window.clearTimeout(subSimStartTimerRef.current);
      subSimStartTimerRef.current = null;
    }

    const cluster = clusterNodesRef.current.find((n) => n.id === clusterId);
    if (!cluster || cluster.x == null || cluster.y == null) return;

    const container = containerRef.current;
    if (!container) return;
    const vw = container.clientWidth;
    const vh = container.clientHeight;
    const viewMin = Math.min(vw, vh);

    setExpandedCluster(clusterId);
    const buildToken = ++expandBuildTokenRef.current;

    const memberCount = cluster.memberIds.length;
    const clusterR = cluster.radius;
    const cx = cluster.x;
    const cy = cluster.y;

    // ── Sizing: domain-aware baseline (screen boundary + count) ──
    // Zoom: cluster circle fills 75% of viewport
    const zoomScale = (viewMin * 0.375) / clusterR;
    const boundaryR = clusterR * 0.88; // keep inside the dashed circle
    const boundaryScreenR = boundaryR * zoomScale;
    const densityScreenR = boundaryScreenR / (14 + Math.sqrt(Math.max(1, memberCount)) * 0.9);
    const nodeScreenR = Math.max(viewMin * 0.006, Math.min(22, densityScreenR));
    // World-space node radius at this zoom
    const nodeWorldR = nodeScreenR / zoomScale;
    // Collide radius tracks the new readable node size.
    const collideR = nodeWorldR * 2.45;

    expandInfoRef.current = { clusterId, cx, cy, boundaryR: clusterR, nodeWorldR, memberCount };

    animateCamera({
      x: vw / 2 - cx * zoomScale,
      y: vh / 2 - cy * zoomScale,
      scale: zoomScale,
    }, 500);

    // Build sub-nodes
    const memberIds = cluster.memberIds;
    const memberSet = new Set(memberIds);
    const idxByMemId = new Map<string, number>();

    const nodes: MemSubNode[] = memberIds.map((id) => {
      const mem = memById.get(id);
      const emotion = mem?.emotion || 'Unknown';
      const style = eStyle(emotion);
      idxByMemId.set(id, idxByMemId.size);
      return {
        memId: id,
        label: (mem?.key || id).slice(0, 30),
        color: style.color, glow: style.glow, emotion,
        importance: 0.3,
        targetR: clusterR * 0.5,
      };
    });

    let links: MemSubLink[] = [];
    const seen = new Set<string>();
    const similarityThreshold = memberCount > 320 ? 0.4 : memberCount > 180 ? 0.35 : 0.3;
    const maxNeighborsPerNode = memberCount > 320 ? 6 : memberCount > 180 ? 8 : 12;
    for (const id of memberIds) {
      const neighbors = embeddingsData.neighbors[id] || [];
      let accepted = 0;
      for (const n of neighbors) {
        if (accepted >= maxNeighborsPerNode) break;
        if (!memberSet.has(n.id)) continue;
        if (n.similarity < similarityThreshold) continue;
        const key = id < n.id ? `${id}|${n.id}` : `${n.id}|${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const source = idxByMemId.get(id);
        const target = idxByMemId.get(n.id);
        if (source == null || target == null) continue;
        links.push({ source, target, similarity: n.similarity });
        accepted += 1;
      }
    }
    const edgeBudget = memberCount > 320 ? memberCount * 3 : memberCount > 180 ? memberCount * 4 : memberCount * 6;
    if (links.length > edgeBudget) {
      links = links.sort((a, b) => b.similarity - a.similarity).slice(0, edgeBudget);
    }

    // Structural importance: weighted by relationship strength + degree.
    const weightedDegree = new Array(nodes.length).fill(0);
    const degree = new Array(nodes.length).fill(0);
    for (const l of links) {
      const s = Number(l.source);
      const t = Number(l.target);
      if (!Number.isFinite(s) || !Number.isFinite(t)) continue;
      weightedDegree[s] += l.similarity;
      weightedDegree[t] += l.similarity;
      degree[s] += 1;
      degree[t] += 1;
    }
    const maxWeighted = Math.max(1e-6, ...weightedDegree);
    const maxDegree = Math.max(1, ...degree);
    for (let i = 0; i < nodes.length; i++) {
      const wNorm = weightedDegree[i] / maxWeighted;
      const dNorm = degree[i] / maxDegree;
      const importance = Math.max(0.08, Math.min(1, 0.68 * wNorm + 0.32 * dNorm));
      nodes[i].importance = importance;
    }

    // ── Structured seeded sub-layout (frozen; no runtime simulation) ──
    const simNodes = nodes.map((n) => ({ ...n }));
    const adj: Array<Array<{ to: number; sim: number }>> = Array.from({ length: simNodes.length }, () => []);
    for (const l of links) {
      const s = Number(l.source);
      const t = Number(l.target);
      if (!Number.isFinite(s) || !Number.isFinite(t) || s < 0 || t < 0 || s >= simNodes.length || t >= simNodes.length) continue;
      adj[s].push({ to: t, sim: l.similarity });
      adj[t].push({ to: s, sim: l.similarity });
    }

    const rankedIdx = Array.from({ length: simNodes.length }, (_, i) => i)
      .sort((a, b) => simNodes[b].importance - simNodes[a].importance);
    const hubCount = Math.max(3, Math.min(10, Math.round(Math.sqrt(simNodes.length) / 2)));
    const hubIdx = rankedIdx.slice(0, hubCount);
    const hubSet = new Set(hubIdx);

    const groups = new Map<number, number[]>();
    for (const h of hubIdx) groups.set(h, []);
    for (let i = 0; i < simNodes.length; i++) {
      if (hubSet.has(i)) {
        groups.get(i)!.push(i);
        continue;
      }
      let bestHub = -1;
      let bestScore = -1;
      for (const e of adj[i]) {
        if (!hubSet.has(e.to)) continue;
        const score = e.sim * (0.75 + simNodes[e.to].importance * 0.6);
        if (score > bestScore) {
          bestScore = score;
          bestHub = e.to;
        }
      }
      if (bestHub === -1) bestHub = hubIdx[hash(simNodes[i].memId) % hubIdx.length];
      groups.get(bestHub)!.push(i);
    }

    const fullTurn = Math.PI * 2;
    const hubSpacing = fullTurn / hubIdx.length;
    for (let hPos = 0; hPos < hubIdx.length; hPos++) {
      const hub = hubIdx[hPos];
      const members = groups.get(hub) || [];
      members.sort((a, b) => simNodes[b].importance - simNodes[a].importance);
      const baseAngle = hPos * hubSpacing + (hash(simNodes[hub].memId + ':hub') % 1000) / 1000 * 0.08;
      const sectorWidth = Math.max(0.5, Math.min(1.2, hubSpacing * 0.92));

      for (let rank = 0; rank < members.length; rank++) {
        const idx = members[rank];
        const n = simNodes[idx];
        const isHub = idx === hub;
        const imp = n.importance;

        const ring = Math.floor(rank / 10);
        const ringOffset = ring * boundaryR * 0.07;
        const radialBias = isHub ? 0.14 : 0.24 + (1 - imp) * 0.58;
        n.targetR = Math.min(boundaryR * 0.94, boundaryR * radialBias + ringOffset);

        const slot = rank % 10;
        const slotsInRing = Math.min(10, members.length - ring * 10);
        const t = slotsInRing <= 1 ? 0.5 : slot / (slotsInRing - 1);
        const angleOffset = (t - 0.5) * sectorWidth;
        const jitterA = (((hash(n.memId + ':a') % 1000) / 1000) - 0.5) * 0.06;
        const jitterR = (((hash(n.memId + ':r') % 1000) / 1000) - 0.5) * boundaryR * 0.02;
        const angle = baseAngle + angleOffset + jitterA;
        const r = Math.max(boundaryR * 0.08, Math.min(boundaryR * 0.96, n.targetR + jitterR));
        n.x = cx + Math.cos(angle) * r;
        n.y = cy + Math.sin(angle) * r;
      }
    }

    const minDistBase = collideR * 0.95;
    for (let iter = 0; iter < 3; iter++) {
      for (let i = 0; i < simNodes.length; i++) {
        const a = simNodes[i];
        if (a.x == null || a.y == null) continue;
        for (let j = i + 1; j < simNodes.length; j++) {
          const b = simNodes[j];
          if (b.x == null || b.y == null) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;
          const minDist = minDistBase * (0.85 + (a.importance + b.importance) * 0.25);
          if (dist >= minDist) continue;
          const push = (minDist - dist) * 0.5;
          const ux = dx / dist;
          const uy = dy / dist;
          a.x -= ux * push; a.y -= uy * push;
          b.x += ux * push; b.y += uy * push;
        }
      }
      for (const n of simNodes) {
        if (n.x == null || n.y == null) continue;
        const dx = n.x - cx;
        const dy = n.y - cy;
        const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        if (d > boundaryR * 0.96) {
          n.x = cx + (dx / d) * boundaryR * 0.96;
          n.y = cy + (dy / d) * boundaryR * 0.96;
        }
      }
    }

    // Paint seeded positions immediately, then start simulation after zoom settles.
    subNodesRef.current = simNodes;
    subLinksRef.current = links;
    if (simNodes.length > 60) {
      const sorted = [...links].sort((a, b) => b.similarity - a.similarity);
      subRenderLinksRef.current = sorted.slice(0, Math.min(sorted.length, simNodes.length * 2));
    } else {
      subRenderLinksRef.current = links;
    }
    markWebGLDirty();

    // Keep the first seeded frame as final layout (no sub-force simulation).
    subSimRef.current = null;
  }, [expandedCluster, embeddingsData, memById, animateCamera, markWebGLDirty]);

  const collapseCluster = useCallback(() => {
    if (subSimRef.current) subSimRef.current.stop();
    subSimRef.current = null;
    if (subSimStartTimerRef.current !== null) {
      window.clearTimeout(subSimStartTimerRef.current);
      subSimStartTimerRef.current = null;
    }
    setExpandedCluster(null);
    subNodesRef.current = [];
    subLinksRef.current = [];
    subRenderLinksRef.current = [];
    markWebGLDirty();
    hoveredMemRef.current = null;
    expandInfoRef.current = null;
    animateCamera({ x: 0, y: 0, scale: 1 }, 400);
  }, [animateCamera, markWebGLDirty]);

  // ── Canvas rendering ──
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const render = () => {
      const vw = container.clientWidth;
      const vh = container.clientHeight;
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      // Resize only when metrics change; rebuilding canvas every frame is expensive.
      if (
        canvasMetricsRef.current.vw !== vw ||
        canvasMetricsRef.current.vh !== vh ||
        canvasMetricsRef.current.dpr !== dpr
      ) {
        canvasMetricsRef.current = { vw, vh, dpr };
        canvas.width = Math.floor(vw * dpr);
        canvas.height = Math.floor(vh * dpr);
        canvas.style.width = `${vw}px`;
        canvas.style.height = `${vh}px`;
      }

      const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, vw, vh);

      const drawWebGLSubgraph = () => {
        const scene = webglSceneRef.current;
        const glCanvas = glCanvasRef.current;
        if (!scene || !glCanvas) return false;

        if (glCanvas.width !== Math.floor(vw * dpr) || glCanvas.height !== Math.floor(vh * dpr)) {
          glCanvas.width = Math.floor(vw * dpr);
          glCanvas.height = Math.floor(vh * dpr);
          glCanvas.style.width = `${vw}px`;
          glCanvas.style.height = `${vh}px`;
        }

        const { gl } = scene;
        gl.viewport(0, 0, glCanvas.width, glCanvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        const currentExpandedId = expandedClusterRef.current;
        const nodes = subNodesRef.current;
        const edges = subRenderLinksRef.current;
        if (currentExpandedId == null || nodes.length === 0) return true;

        if (webglUploadedVersionRef.current !== webglDataVersionRef.current) {
          const pointPos = new Float32Array(nodes.length * 2);
          const pointColor = new Float32Array(nodes.length * 4);
          const pointImportance = new Float32Array(nodes.length);
          for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            pointPos[i * 2] = n.x || 0;
            pointPos[i * 2 + 1] = n.y || 0;
            const [r, g, b] = parseHexColor(n.color);
            const imp = Math.max(0, Math.min(1, n.importance || 0));
            pointImportance[i] = imp;
            pointColor[i * 4] = r * (0.82 + imp * 0.24);
            pointColor[i * 4 + 1] = g * (0.82 + imp * 0.24);
            pointColor[i * 4 + 2] = b * (0.82 + imp * 0.24);
            pointColor[i * 4 + 3] = 0.8 + imp * 0.2;
          }

          const linePos = new Float32Array(edges.length * 4);
          const lineColor = new Float32Array(edges.length * 8);
          for (let i = 0; i < edges.length; i++) {
            const link = edges[i];
            const si = typeof link.source === 'number' ? link.source : -1;
            const ti = typeof link.target === 'number' ? link.target : -1;
            const s = si >= 0 ? nodes[si] : null;
            const t = ti >= 0 ? nodes[ti] : null;
            if (!s || !t) {
              linePos[i * 4] = 0;
              linePos[i * 4 + 1] = 0;
              linePos[i * 4 + 2] = 0;
              linePos[i * 4 + 3] = 0;
              continue;
            }
            linePos[i * 4] = s.x || 0;
            linePos[i * 4 + 1] = s.y || 0;
            linePos[i * 4 + 2] = t.x || 0;
            linePos[i * 4 + 3] = t.y || 0;
            const impAvg = ((s.importance || 0.3) + (t.importance || 0.3)) * 0.5;
            const sim = Math.max(0, Math.min(1, link.similarity));
            const a = 0.02 + sim * 0.13 + impAvg * 0.09;
            const r = 0.56 + sim * 0.22 + impAvg * 0.1;
            const g = 0.68 + sim * 0.16 + impAvg * 0.1;
            const b = 0.9 + sim * 0.08;
            for (let k = 0; k < 2; k++) {
              const base = i * 8 + k * 4;
              lineColor[base] = Math.min(1, r);
              lineColor[base + 1] = Math.min(1, g);
              lineColor[base + 2] = Math.min(1, b);
              lineColor[base + 3] = a;
            }
          }

          gl.bindBuffer(gl.ARRAY_BUFFER, scene.pointPosBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, pointPos, gl.DYNAMIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, scene.pointColorBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, pointColor, gl.DYNAMIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, scene.pointImportanceBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, pointImportance, gl.DYNAMIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, scene.linePosBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, linePos, gl.DYNAMIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, scene.lineColorBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, lineColor, gl.DYNAMIC_DRAW);
          webglUploadedVersionRef.current = webglDataVersionRef.current;
        }

        const camNow = cameraRef.current;
        const viewMin = Math.min(vw, vh);
        const expand = expandInfoRef.current;
        const boundaryWorldR = (expand?.boundaryR || (viewMin * 0.33) / Math.max(0.1, camNow.scale)) * 0.88;
        const pointPx = subNodeBaseScreenPx(viewMin, camNow.scale, boundaryWorldR, nodes.length);

        if (edges.length > 0) {
          gl.useProgram(scene.lineProgram);
          gl.uniform3f(scene.lineCameraLoc, camNow.x, camNow.y, camNow.scale);
          gl.uniform2f(scene.lineViewportLoc, vw, vh);
          gl.bindBuffer(gl.ARRAY_BUFFER, scene.linePosBuffer);
          gl.enableVertexAttribArray(scene.linePosLoc);
          gl.vertexAttribPointer(scene.linePosLoc, 2, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, scene.lineColorBuffer);
          gl.enableVertexAttribArray(scene.lineColorLoc);
          gl.vertexAttribPointer(scene.lineColorLoc, 4, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.LINES, 0, edges.length * 2);
        }

        gl.useProgram(scene.pointProgram);
        gl.uniform3f(scene.pointCameraLoc, camNow.x, camNow.y, camNow.scale);
        gl.uniform2f(scene.pointViewportLoc, vw, vh);
        gl.uniform1f(scene.pointSizeLoc, pointPx);
        gl.bindBuffer(gl.ARRAY_BUFFER, scene.pointPosBuffer);
        gl.enableVertexAttribArray(scene.pointPosLoc);
        gl.vertexAttribPointer(scene.pointPosLoc, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, scene.pointColorBuffer);
        gl.enableVertexAttribArray(scene.pointColorLoc);
        gl.vertexAttribPointer(scene.pointColorLoc, 4, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, scene.pointImportanceBuffer);
        gl.enableVertexAttribArray(scene.pointImportanceLoc);
        gl.vertexAttribPointer(scene.pointImportanceLoc, 1, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, nodes.length);
        return true;
      };

      // Background
      const bg = ctx.createLinearGradient(0, 0, vw, vh);
      bg.addColorStop(0, '#070a14');
      bg.addColorStop(1, '#080e1f');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, vw, vh);

      // Animate camera
      const now = performance.now();
      const dur = animDurationRef.current;
      if (!isPanningRef.current && dur > 0 && now < animStartRef.current + dur) {
        const t = Math.min(1, (now - animStartRef.current) / dur);
        cameraRef.current = lerpCamera(cameraStartRef.current, cameraTargetRef.current, t);
      } else if (!isPanningRef.current && dur > 0) {
        cameraRef.current = { ...cameraTargetRef.current };
        animDurationRef.current = 0;
      }

      const cam = cameraRef.current;
      const useWebGLSub = drawWebGLSubgraph();

      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.scale, cam.scale);

      const currentExpandedId = expandedClusterRef.current;
      const isExpMode = currentExpandedId !== null;
      const invS = 1 / cam.scale;
      const viewMin = Math.min(vw, vh);
      const clusterNodesNow = clusterNodesRef.current;
      const clusterLinksNow = clusterLinksRef.current;
      const subNodesNow = subNodesRef.current;
      const hoveredNode = hoveredNodeRef.current;
      const hoveredMem = hoveredMemRef.current;
      const clusterById = new Map<number, ClusterNode>();
      for (const n of clusterNodesNow) clusterById.set(n.id, n);
      const worldLeft = -cam.x * invS;
      const worldTop = -cam.y * invS;
      const worldRight = (vw - cam.x) * invS;
      const worldBottom = (vh - cam.y) * invS;
      const truncateLabel = (text: string, maxChars = 28) => (
        text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}\u2026`
      );
      const drawMemLabel = (sn: MemSubNode, anchorR: number, variant: 'hover' | 'auto' = 'hover') => {
        if (sn.x == null || sn.y == null) return;
        const txt = truncateLabel(sn.label || sn.memId, variant === 'hover' ? 28 : 22);
        const fs = (variant === 'hover' ? 12 : 10.5) * invS;
        const px = (variant === 'hover' ? 7 : 6) * invS;
        const py = (variant === 'hover' ? 4 : 3.2) * invS;
        const radius = (variant === 'hover' ? 7 : 6) * invS;
        const yGap = (variant === 'hover' ? 8 : 6) * invS;

        ctx.save();
        ctx.font = `${variant === 'hover' ? 600 : 560} ${fs}px "Avenir Next", "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(txt).width;
        const bw = tw + px * 2;
        const bh = fs + py * 2;

        const minX = worldLeft + bw / 2 + 6 * invS;
        const maxX = worldRight - bw / 2 - 6 * invS;
        const cx = Math.max(minX, Math.min(maxX, sn.x));

        let by = sn.y - anchorR - yGap - bh;
        if (by < worldTop + 4 * invS) {
          by = sn.y + anchorR + yGap;
        }
        if (by + bh > worldBottom - 4 * invS) {
          by = worldBottom - 4 * invS - bh;
        }

        ctx.shadowBlur = (variant === 'hover' ? 10 : 7) * invS;
        ctx.shadowColor = variant === 'hover' ? 'rgba(12,18,32,0.45)' : 'rgba(10,14,24,0.28)';
        ctx.fillStyle = variant === 'hover' ? 'rgba(10,16,30,0.93)' : 'rgba(8,14,24,0.74)';
        roundedRectPath(ctx, cx - bw / 2, by, bw, bh, radius);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.strokeStyle = variant === 'hover' ? 'rgba(195,220,255,0.5)' : 'rgba(170,196,230,0.34)';
        ctx.lineWidth = Math.max(0.8 * invS, 0.8 / cam.scale);
        roundedRectPath(ctx, cx - bw / 2, by, bw, bh, radius);
        ctx.stroke();

        ctx.fillStyle = variant === 'hover' ? '#f3f9ff' : '#ddeeff';
        ctx.fillText(txt, cx, by + bh / 2 + 0.2 * invS);
        ctx.restore();
      };
      const pendingEdgeEndLabels: Array<{ x: number; y: number; text: string; color: string }> = [];

      // ── Cluster edges ──
      let hasExpandedEdgeClip = false;
      if (isExpMode && currentExpandedId !== null) {
        const expandedNode = clusterById.get(currentExpandedId);
        if (expandedNode && expandedNode.x != null && expandedNode.y != null) {
          const expand = expandInfoRef.current;
          const exclusionR = Math.max(
            expandedNode.radius + 2 * invS,
            (expand?.boundaryR || expandedNode.radius) * 0.88
          );
          const worldLeft = (-cam.x) / cam.scale;
          const worldTop = (-cam.y) / cam.scale;
          const worldW = vw / cam.scale;
          const worldH = vh / cam.scale;

          // Exclude the expanded region so no cluster edge is drawn inside it.
          ctx.save();
          ctx.beginPath();
          ctx.rect(worldLeft, worldTop, worldW, worldH);
          ctx.arc(expandedNode.x, expandedNode.y, exclusionR, 0, Math.PI * 2, true);
          ctx.clip('evenodd');
          hasExpandedEdgeClip = true;
        }
      }

      for (const link of clusterLinksNow) {
        const s = typeof link.source === 'object' ? link.source : clusterById.get(Number(link.source));
        const t = typeof link.target === 'object' ? link.target : clusterById.get(Number(link.target));
        if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) continue;
        const sourceId = typeof link.source === 'object' ? (link.source as ClusterNode).id : Number(link.source);
        const targetId = typeof link.target === 'object' ? (link.target as ClusterNode).id : Number(link.target);

        let sx = s.x;
        let sy = s.y;
        let tx = t.x;
        let ty = t.y;

        const connectsExpanded = isExpMode && (
          sourceId === currentExpandedId ||
          targetId === currentExpandedId
        );
        if (isExpMode && connectsExpanded && currentExpandedId !== null) {
          const expandedNode = sourceId === currentExpandedId ? s : t;
          const externalNode = sourceId === currentExpandedId ? t : s;
          if (
            expandedNode.x == null ||
            expandedNode.y == null ||
            externalNode.x == null ||
            externalNode.y == null
          ) continue;
          const expandedX = expandedNode.x;
          const expandedY = expandedNode.y;
          const externalX = externalNode.x;
          const externalY = externalNode.y;
          const ddx = externalX - expandedX;
          const ddy = externalY - expandedY;
          const dist = Math.hypot(ddx, ddy);
          if (dist < 1e-6) continue;
          const ux = ddx / dist;
          const uy = ddy / dist;
          const edgePad = 1.5 * invS;
          sx = expandedX + ux * (expandedNode.radius + edgePad);
          sy = expandedY + uy * (expandedNode.radius + edgePad);
          tx = externalX - ux * (externalNode.radius + edgePad);
          ty = externalY - uy * (externalNode.radius + edgePad);

          const labelOffset = Math.min(externalNode.radius * 0.58, Math.max(12 * invS, externalNode.radius * 0.42));
          const lx = tx + ux * labelOffset;
          const ly = ty + uy * labelOffset;
          pendingEdgeEndLabels.push({
            x: lx,
            y: ly,
            text: externalNode.label,
            color: externalNode.color,
          });
        }

        const mx = (sx + tx) / 2;
        const my = (sy + ty) / 2;
        const dx = tx - sx;
        const dy = ty - sy;
        const cpx = mx - dy * 0.15;
        const cpy = my + dx * 0.15;
        const baseWidth = Math.max(0.5, Math.min(2.5, link.weight * 0.08));

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(cpx, cpy, tx, ty);
        if (isExpMode) {
          if (connectsExpanded) {
            ctx.strokeStyle = 'rgba(215,232,255,0.52)';
            ctx.lineWidth = (baseWidth * 1.45 + 0.35) * invS;
          } else {
            ctx.strokeStyle = 'rgba(190,210,238,0.015)';
            ctx.lineWidth = Math.max(0.3, baseWidth * 0.55) * invS;
          }
        } else {
          ctx.strokeStyle = 'rgba(200,220,255,0.06)';
          ctx.lineWidth = baseWidth * invS;
        }
        ctx.stroke();
      }
      if (hasExpandedEdgeClip) ctx.restore();

      // ── Sub-graph edges ──
      if (!useWebGLSub && isExpMode && subNodesNow.length > 0) {
        const subEdgesNow = subRenderLinksRef.current;
        for (const link of subEdgesNow) {
          const si = typeof link.source === 'number' ? link.source : (link.source as MemSubNode);
          const ti = typeof link.target === 'number' ? link.target : (link.target as MemSubNode);
          const s = typeof si === 'number' ? subNodesNow[si] : si;
          const t = typeof ti === 'number' ? subNodesNow[ti] : ti;
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
      for (const node of clusterNodesNow) {
        if (node.x == null || node.y == null) continue;
        const isExpanded = currentExpandedId === node.id;
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

      if (pendingEdgeEndLabels.length > 0) {
        for (const label of pendingEdgeEndLabels) {
          ctx.save();
          const fs = 11 * invS;
          const px = 6 * invS;
          const py = 3.5 * invS;
          const rr = 6 * invS;
          ctx.font = `600 ${fs}px "Avenir Next", "Segoe UI", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const tw = ctx.measureText(label.text).width;
          const bw = tw + px * 2;
          const bh = fs + py * 2;
          const cx = Math.max(worldLeft + bw / 2 + 4 * invS, Math.min(worldRight - bw / 2 - 4 * invS, label.x));
          const cy = Math.max(worldTop + bh / 2 + 4 * invS, Math.min(worldBottom - bh / 2 - 4 * invS, label.y));

          ctx.shadowBlur = 8 * invS;
          ctx.shadowColor = 'rgba(10,16,28,0.5)';
          ctx.fillStyle = 'rgba(8,14,26,0.88)';
          roundedRectPath(ctx, cx - bw / 2, cy - bh / 2, bw, bh, rr);
          ctx.fill();

          ctx.shadowBlur = 0;
          ctx.strokeStyle = 'rgba(205,223,246,0.42)';
          ctx.lineWidth = Math.max(0.8 * invS, 0.8 / cam.scale);
          roundedRectPath(ctx, cx - bw / 2, cy - bh / 2, bw, bh, rr);
          ctx.stroke();

          ctx.fillStyle = label.color;
          ctx.fillText(label.text, cx, cy + 0.2 * invS);
          ctx.restore();
        }
      }

      // ── Sub-nodes: screen-relative sizing ──
      if (!useWebGLSub && isExpMode) {
        const expand = expandInfoRef.current;
        const boundaryWorldR = (expand?.boundaryR || (viewMin * 0.33) / Math.max(0.1, cam.scale)) * 0.88;
        const nodeScreenR = subNodeBaseScreenPx(viewMin, cam.scale, boundaryWorldR, subNodesNow.length);
        const nodeWorldR = nodeScreenR * invS;
        let hoveredNodeObj: MemSubNode | null = null;
        let hoveredNodeR = 0;

        for (const sn of subNodesNow) {
          if (sn.x == null || sn.y == null) continue;
          const isHov = hoveredMem === sn.memId;
          const baseR = nodeWorldR * (0.75 + (sn.importance || 0) * 1.3);
          const r = isHov ? baseR * 1.35 : baseR;

          ctx.save();
          ctx.shadowBlur = (isHov ? 14 : 5 + (sn.importance || 0) * 3) * invS;
          ctx.shadowColor = sn.glow;
          ctx.beginPath();
          ctx.arc(sn.x, sn.y, r, 0, Math.PI * 2);
          ctx.fillStyle = sn.color;
          ctx.globalAlpha = 0.9;
          ctx.fill();
          ctx.restore();
          if (isHov) {
            hoveredNodeObj = sn;
            hoveredNodeR = r;
          }
        }
        if (hoveredNodeObj) {
          drawMemLabel(hoveredNodeObj, hoveredNodeR, 'hover');
        }
      }

      if (useWebGLSub && isExpMode && hoveredMem) {
        const sn = subNodesNow.find((n) => n.memId === hoveredMem);
        if (sn && sn.x != null && sn.y != null) {
          const expand = expandInfoRef.current;
          const boundaryWorldR = (expand?.boundaryR || (viewMin * 0.33) / Math.max(0.1, cam.scale)) * 0.88;
          const nodeScreenR = subNodeBaseScreenPx(viewMin, cam.scale, boundaryWorldR, subNodesNow.length);
          const nodeWorldR = nodeScreenR * invS;
          const baseR = nodeWorldR * (0.75 + (sn.importance || 0) * 1.3);
          drawMemLabel(sn, baseR * 1.35, 'hover');
        }
      }

      // ── Auto labels for key sub-nodes in expanded/highlight mode ──
      if (isExpMode && subNodesNow.length > 0) {
        const expand = expandInfoRef.current;
        const boundaryWorldR = (expand?.boundaryR || (viewMin * 0.33) / Math.max(0.1, cam.scale)) * 0.88;
        const nodeScreenR = subNodeBaseScreenPx(viewMin, cam.scale, boundaryWorldR, subNodesNow.length);
        const nodeWorldR = nodeScreenR * invS;
        const viewportPad = nodeWorldR * 2.2;
        const inViewport = (sn: MemSubNode) => {
          if (sn.x == null || sn.y == null) return false;
          return (
            sn.x >= worldLeft - viewportPad &&
            sn.x <= worldRight + viewportPad &&
            sn.y >= worldTop - viewportPad &&
            sn.y <= worldBottom + viewportPad
          );
        };
        const viewportNodes = subNodesNow
          .filter((sn) => inViewport(sn) && (sn.label || sn.memId) && sn.memId !== hoveredMem)
          .sort((a, b) => (b.importance || 0) - (a.importance || 0));

        const viewportCount = viewportNodes.length;
        const viewportShowAllThreshold = 20;
        const minLabelBudget = 5;
        const maxLabelBudget = 20;
        const zoomRange = 6; // 从默认尺度逐步增长到满配 label 数量
        const zoomT = Math.max(0, Math.min(1, (cam.scale - 1) / zoomRange));
        const zoomBudget = Math.round(minLabelBudget + (maxLabelBudget - minLabelBudget) * zoomT);
        const targetLabelCount = viewportCount <= viewportShowAllThreshold
          ? viewportCount
          : Math.min(maxLabelBudget, Math.max(minLabelBudget, zoomBudget), viewportCount);

        // 视窗内节点较少时直接全显；节点较多时保留距离约束，减少拥挤与重叠。
        const enforceSpacing = viewportCount > viewportShowAllThreshold;
        const minAnchorDistWorld = Math.max(24, 54 - zoomT * 24) * invS;

        const selected: MemSubNode[] = [];
        for (const sn of viewportNodes) {
          if (selected.length >= targetLabelCount) break;
          if (!enforceSpacing) {
            selected.push(sn);
            continue;
          }

          let tooClose = false;
          for (const picked of selected) {
            const dx = (sn.x as number) - (picked.x as number);
            const dy = (sn.y as number) - (picked.y as number);
            if (dx * dx + dy * dy < minAnchorDistWorld * minAnchorDistWorld) {
              tooClose = true;
              break;
            }
          }
          if (!tooClose) selected.push(sn);
        }

        // 若距离约束导致数量不足，按重要性补齐至预算上限。
        if (enforceSpacing && selected.length < targetLabelCount) {
          for (const sn of viewportNodes) {
            if (selected.length >= targetLabelCount) break;
            if (!selected.includes(sn)) selected.push(sn);
          }
        }

        for (const sn of selected) {
          const baseR = nodeWorldR * (0.75 + (sn.importance || 0) * 1.3);
          drawMemLabel(sn, baseR, 'auto');
        }
      }

      ctx.restore(); // pop camera

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, []);

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
      if (expandedClusterRef.current !== null) {
        const metrics = canvasMetricsRef.current;
        const viewMin = Math.max(1, Math.min(metrics.vw || 1, metrics.vh || 1));
        const camScale = cameraRef.current.scale;
        const expand = expandInfoRef.current;
        const boundaryWorldR = (expand?.boundaryR || (viewMin * 0.33) / Math.max(0.1, camScale)) * 0.88;
        const nodeScreenBase = subNodeBaseScreenPx(viewMin, camScale, boundaryWorldR, subNodesRef.current.length);
        let bestHit: MemSubNode | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        const hitPaddingPx = 4;
        for (const sn of subNodesRef.current) {
          if (sn.x == null || sn.y == null) continue;
          const dx = wx - sn.x; const dy = wy - sn.y;
          const nodeScreenR = nodeScreenBase * (0.75 + (sn.importance || 0) * 1.3);
          const hitR = (nodeScreenR + hitPaddingPx) / camScale;
          const dist2 = dx * dx + dy * dy;
          if (dist2 <= hitR * hitR && dist2 < bestDist) {
            bestHit = sn;
            bestDist = dist2;
          }
        }
        if (bestHit) {
          return { type: 'mem', node: bestHit };
        }
      }
      for (const cn of clusterNodesRef.current) {
        if (cn.x == null || cn.y == null) continue;
        const dx = wx - cn.x; const dy = wy - cn.y;
        if (dx * dx + dy * dy < cn.radius * cn.radius) return { type: 'cluster', node: cn };
      }
      return null;
    },
    []
  );

  const getWorldPos = useCallback((e: React.MouseEvent | MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  }, [screenToWorld]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const now = performance.now();
    const isAnimating =
      animDurationRef.current > 0 && now < animStartRef.current + animDurationRef.current;
    suppressClickRef.current = isAnimating;

    if (isAnimating) {
      // During zoom animation, first click only freezes the viewport.
      // This gesture is consumed and should not start pan/click actions.
      syncCameraNow();
      stopCameraAnim();
      freezeGestureRef.current = true;
      dragRef.current = null;
      isPanningRef.current = false;
      mouseDownScreenRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = 'grab';
      return;
    }

    freezeGestureRef.current = false;
    mouseDownScreenRef.current = { x: e.clientX, y: e.clientY };
    // Commit animated camera state before pan starts; avoids jumping to stale pre-zoom camera.
    syncCameraNow();
    stopCameraAnim();
    dragRef.current = { type: 'pan' };
    isPanningRef.current = true;
    panStartCamRef.current = { x: cameraRef.current.x, y: cameraRef.current.y };
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'grabbing';
  }, [stopCameraAnim, syncCameraNow]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (freezeGestureRef.current) return;
    const drag = dragRef.current;

    if (drag) {
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
    const hit = findNode(x, y);
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = hit ? 'pointer' : 'grab';

    if (hit?.type === 'cluster') {
      hoveredNodeRef.current = (hit.node as ClusterNode).id;
      hoveredMemRef.current = null;
    } else if (hit?.type === 'mem') {
      hoveredMemRef.current = (hit.node as MemSubNode).memId;
      hoveredNodeRef.current = null;
    } else {
      hoveredNodeRef.current = null;
      hoveredMemRef.current = null;
    }
  }, [findNode, getWorldPos]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (freezeGestureRef.current) {
      freezeGestureRef.current = false;
      suppressClickRef.current = false;
      dragRef.current = null;
      isPanningRef.current = false;
      mouseDownScreenRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = 'grab';
      return;
    }

    const drag = dragRef.current;
    if (!drag) return;

    const downPos = mouseDownScreenRef.current;
    const wasDrag = downPos && (
      (e.clientX - downPos.x) ** 2 + (e.clientY - downPos.y) ** 2 > 25
    );

    if (!wasDrag && !suppressClickRef.current) {
      const { x, y } = getWorldPos(e);
      const hit = findNode(x, y);

      if (!hit) {
        if (expandedClusterRef.current !== null) {
          const expand = expandInfoRef.current;
          if (expand) {
            const dx = x - expand.cx;
            const dy = y - expand.cy;
            const boundaryWorldR = expand.boundaryR * 0.88;
            if (dx * dx + dy * dy <= boundaryWorldR * boundaryWorldR) {
              dragRef.current = null;
              isPanningRef.current = false;
              suppressClickRef.current = false;
              freezeGestureRef.current = false;
              mouseDownScreenRef.current = null;
              const canvas = canvasRef.current;
              if (canvas) canvas.style.cursor = 'grab';
              return;
            }
          }
          collapseCluster();
        }
      } else if (hit.type === 'cluster') {
        const hitId = (hit.node as ClusterNode).id;
        // Clicking inside the already expanded cluster should be a no-op, not a collapse toggle.
        if (expandedClusterRef.current !== null && hitId === expandedClusterRef.current) {
          // no-op
        } else {
          expandCluster(hitId);
        }
      } else {
        onMemoryClick((hit.node as MemSubNode).memId);
      }
    }

    dragRef.current = null;
    isPanningRef.current = false;
    suppressClickRef.current = false;
    freezeGestureRef.current = false;
    mouseDownScreenRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'grab';
  }, [findNode, getWorldPos, expandCluster, collapseCluster, onMemoryClick]);

  const handleMouseLeave = useCallback(() => {
    freezeGestureRef.current = false;
    suppressClickRef.current = false;
    const drag = dragRef.current;
    if (drag) {
      dragRef.current = null;
      isPanningRef.current = false;
      suppressClickRef.current = false;
      mouseDownScreenRef.current = null;
    }
    hoveredNodeRef.current = null;
    hoveredMemRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (subSimStartTimerRef.current !== null) {
        window.clearTimeout(subSimStartTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onWindowMouseUp = () => {
      freezeGestureRef.current = false;
      if (!dragRef.current) return;
      dragRef.current = null;
      isPanningRef.current = false;
      suppressClickRef.current = false;
      mouseDownScreenRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = 'grab';
    };
    window.addEventListener('mouseup', onWindowMouseUp);
    return () => window.removeEventListener('mouseup', onWindowMouseUp);
  }, []);

  if (memories.length === 0) {
    return <div className="memory-status">No memory data for constellation view</div>;
  }

  return (
    <div ref={containerRef} className="cluster-graph-container">
      <canvas
        ref={glCanvasRef}
        className="cluster-graph-webgl"
        aria-hidden
      />
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
