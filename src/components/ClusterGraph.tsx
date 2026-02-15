'use client';

import { memo, useEffect, useRef, useState, useCallback, useMemo } from 'react';
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

interface BundlePathPoint {
  x: number;
  y: number;
}

interface SubBundlePath {
  points: BundlePathPoint[];
  similarity: number;
  intensity: number;
  color: [number, number, number];
  coreIntrusion: number;
  sourceIdx: number;
  targetIdx: number;
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
  highlightedMemoryIds?: string[];
  sequenceMemoryIds?: string[];
}

function sameIdList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  const left = a || [];
  const right = b || [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function arePropsEqual(prev: Props, next: Props): boolean {
  if (prev.onMemoryClick !== next.onMemoryClick) return false;
  if (prev.embeddingsData !== next.embeddingsData) return false;
  if (!sameIdList(prev.highlightedMemoryIds, next.highlightedMemoryIds)) return false;
  if (!sameIdList(prev.sequenceMemoryIds, next.sequenceMemoryIds)) return false;
  if (prev.memories === next.memories) return true;
  if (prev.memories.length !== next.memories.length) return false;
  if (prev.memories.length === 0) return true;
  const p0 = prev.memories[0]?.id;
  const n0 = next.memories[0]?.id;
  const pLast = prev.memories[prev.memories.length - 1]?.id;
  const nLast = next.memories[next.memories.length - 1]?.id;
  return p0 === n0 && pLast === nLast;
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function unitVec(dx: number, dy: number): { x: number; y: number } {
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: 1, y: 0 };
  return { x: dx / d, y: dy / d };
}

function drawSmoothBundle(ctx: CanvasRenderingContext2D, points: BundlePathPoint[]) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y);
    return;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const n = points[i + 1];
    const mx = (p.x + n.x) * 0.5;
    const my = (p.y + n.y) * 0.5;
    ctx.quadraticCurveTo(p.x, p.y, mx, my);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
}

function ClusterGraph({
  memories,
  embeddingsData,
  onMemoryClick,
  highlightedMemoryIds = [],
  sequenceMemoryIds = [],
}: Props) {
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
  const subBundlePathsRef = useRef<SubBundlePath[]>([]);
  const selectedMemRef = useRef<string | null>(null);
  const subLinesVisibleAfterRef = useRef<number>(0);
  const highlightedMemoryIdsRef = useRef<string[]>([]);
  const sequenceMemoryIdsRef = useRef<string[]>([]);
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
    highlightedMemoryIdsRef.current = highlightedMemoryIds;
  }, [highlightedMemoryIds]);

  useEffect(() => {
    sequenceMemoryIdsRef.current = sequenceMemoryIds;
  }, [sequenceMemoryIds]);

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
        .id((d) => d.id).distance(160).strength((l) => Math.min(0.3, (l as ClusterLink).weight * 0.015)))
      .force('charge', forceManyBody<ClusterNode>().strength(-520))
      .force('center', forceCenter(w / 2, h / 2))
      .force('collide', forceCollide<ClusterNode>().radius((d) => d.radius + 24))
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
            // Keep bundled routes rigidly attached while parent cluster drifts.
            for (const path of subBundlePathsRef.current) {
              for (const p of path.points) {
                p.x += dx;
                p.y += dy;
              }
            }
            // During visible motion, defer line display slightly to avoid jittered mismatch.
            if (Math.hypot(dx, dy) > 0.2) {
              subLinesVisibleAfterRef.current = Math.max(subLinesVisibleAfterRef.current, performance.now() + 140);
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
    subBundlePathsRef.current = [];
    subLinesVisibleAfterRef.current = performance.now() + 380;
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
    const nodeHub = new Array<number>(simNodes.length).fill(-1);
    for (const h of hubIdx) groups.set(h, []);
    for (let i = 0; i < simNodes.length; i++) {
      if (hubSet.has(i)) {
        groups.get(i)!.push(i);
        nodeHub[i] = i;
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
      nodeHub[i] = bestHub;
    }

    const fullTurn = Math.PI * 2;
    const hubSpacing = fullTurn / hubIdx.length;
    const hubDir = new Map<number, { ux: number; uy: number; px: number; py: number }>();
    for (let hPos = 0; hPos < hubIdx.length; hPos++) {
      const hub = hubIdx[hPos];
      const members = groups.get(hub) || [];
      members.sort((a, b) => simNodes[b].importance - simNodes[a].importance);
      const baseAngle = hPos * hubSpacing + (((hash(simNodes[hub].memId + ':hub') % 1000) / 1000) - 0.5) * 0.2;
      const ux = Math.cos(baseAngle);
      const uy = Math.sin(baseAngle);
      const px = -uy;
      const py = ux;
      hubDir.set(hub, { ux, uy, px, py });

      for (let rank = 0; rank < members.length; rank++) {
        const idx = members[rank];
        const n = simNodes[idx];
        const isHub = idx === hub;
        const imp = n.importance;
        const branch = Math.floor(rank / 8);
        const branchSlots = Math.min(8, members.length - branch * 8);
        const slot = rank % 8;
        const t = branchSlots <= 1 ? 0.5 : slot / (branchSlots - 1);

        // Keep hubs and high-importance nodes closer to center; push peripheral nodes outward.
        let targetR = boundaryR * (isHub ? 0.2 : 0.34 + (1 - imp) * 0.42 + branch * 0.065);
        targetR = clamp(targetR, boundaryR * 0.14, boundaryR * 0.95);
        n.targetR = targetR;

        const baseSpread = boundaryR * (0.06 + (1 - imp) * 0.06 + branch * 0.02);
        const side = (t - 0.5) * 2 * baseSpread;
        const jitterAlong = ((((hash(n.memId + ':ar') % 1000) / 1000) - 0.5)) * boundaryR * 0.04;
        const jitterSide = ((((hash(n.memId + ':as') % 1000) / 1000) - 0.5)) * baseSpread * 0.45;
        const along = targetR + jitterAlong;
        n.x = cx + ux * along + px * (side + jitterSide);
        n.y = cy + uy * along + py * (side + jitterSide);
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

    const hubRoutes = new Map<number, {
      ux: number;
      uy: number;
      px: number;
      py: number;
      trunkMid: BundlePathPoint;
      trunkOuter: BundlePathPoint;
    }>();
    for (const h of hubIdx) {
      const dir = hubDir.get(h);
      if (!dir) continue;
      hubRoutes.set(h, {
        ...dir,
        trunkMid: { x: cx + dir.ux * boundaryR * 0.33, y: cy + dir.uy * boundaryR * 0.33 },
        trunkOuter: { x: cx + dir.ux * boundaryR * 0.57, y: cy + dir.uy * boundaryR * 0.57 },
      });
    }

    const branchPoint = (idx: number): BundlePathPoint => {
      const n = simNodes[idx];
      if (n.x == null || n.y == null) return { x: cx, y: cy };
      const hub = nodeHub[idx];
      const route = hubRoutes.get(hub);
      if (!route) return { x: n.x, y: n.y };
      const relX = n.x - cx;
      const relY = n.y - cy;
      const along = clamp(relX * route.ux + relY * route.uy, boundaryR * 0.22, boundaryR * 0.84);
      // Quantized lanes keep branch merges visually tidy.
      const laneSlots = 5;
      const laneIdx = hash(n.memId + ':lane') % laneSlots;
      const laneT = laneSlots <= 1 ? 0 : (laneIdx / (laneSlots - 1)) * 2 - 1;
      const lane = laneT * boundaryR * 0.028;
      return {
        x: cx + route.ux * along + route.px * lane,
        y: cy + route.uy * along + route.py * lane,
      };
    };

    const bundlePaths: SubBundlePath[] = [];
    const clonePt = (p: BundlePathPoint): BundlePathPoint => ({ x: p.x, y: p.y });
    for (const l of subRenderLinksRef.current) {
      const sIdx = Number(l.source);
      const tIdx = Number(l.target);
      if (!Number.isFinite(sIdx) || !Number.isFinite(tIdx)) continue;
      const s = simNodes[sIdx];
      const t = simNodes[tIdx];
      if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) continue;
      const hs = nodeHub[sIdx];
      const ht = nodeHub[tIdx];
      const rs = hubRoutes.get(hs);
      const rt = hubRoutes.get(ht);
      if (!rs || !rt) continue;

      const sb = branchPoint(sIdx);
      const tb = branchPoint(tIdx);
      const points: BundlePathPoint[] = [{ x: s.x, y: s.y }, sb];

      if (hs === ht) {
        points.push(clonePt(rs.trunkOuter), tb, { x: t.x, y: t.y });
      } else {
        const jcDir = unitVec(rs.ux + rt.ux, rs.uy + rt.uy);
        const lo = Math.min(hs, ht);
        const hi = Math.max(hs, ht);
        const pairKey = `${lo}|${hi}:j`;
        const laneSlots = 3;
        const laneIdx = hash(pairKey) % laneSlots;
        const laneT = laneSlots <= 1 ? 0 : (laneIdx / (laneSlots - 1)) * 2 - 1;
        const jLane = laneT * boundaryR * 0.026;
        const jPerp = { x: -jcDir.y, y: jcDir.x };
        const sourceGate = {
          x: cx + rs.ux * boundaryR * 0.24 + rs.px * jLane * 0.7,
          y: cy + rs.uy * boundaryR * 0.24 + rs.py * jLane * 0.7,
        };
        const targetGate = {
          x: cx + rt.ux * boundaryR * 0.24 + rt.px * jLane * 0.7,
          y: cy + rt.uy * boundaryR * 0.24 + rt.py * jLane * 0.7,
        };
        const junction = {
          x: cx + jcDir.x * boundaryR * 0.2 + jPerp.x * jLane,
          y: cy + jcDir.y * boundaryR * 0.2 + jPerp.y * jLane,
        };
        points.push(
          clonePt(rs.trunkOuter),
          sourceGate,
          junction,
          targetGate,
          clonePt(rt.trunkOuter),
          tb,
          { x: t.x, y: t.y }
        );
      }
      const avgImp = ((s.importance || 0.3) + (t.importance || 0.3)) * 0.5;
      const [sr, sg, sbc] = parseHexColor(s.color);
      const [tr, tg, tbc] = parseHexColor(t.color);
      const mixR = (sr + tr) * 0.5;
      const mixG = (sg + tg) * 0.5;
      const mixB = (sbc + tbc) * 0.5;
      // Keep bundles dark and cool while still echoing endpoint hues.
      const tone: [number, number, number] = [
        clamp(mixR * 0.58 + 0.16, 0, 1),
        clamp(mixG * 0.62 + 0.2, 0, 1),
        clamp(mixB * 0.72 + 0.28, 0, 1),
      ];
      bundlePaths.push({
        points,
        similarity: l.similarity,
        intensity: clamp(0.35 + l.similarity * 0.45 + avgImp * 0.35, 0.2, 1.2),
        color: tone,
        coreIntrusion: clamp(
          1 - Math.min(...points.map((p) => Math.hypot(p.x - cx, p.y - cy))) / (boundaryR * 0.28),
          0,
          1
        ),
        sourceIdx: sIdx,
        targetIdx: tIdx,
      });
    }
    subBundlePathsRef.current = bundlePaths;
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
    subBundlePathsRef.current = [];
    selectedMemRef.current = null;
    subLinesVisibleAfterRef.current = 0;
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
        if (currentExpandedId == null || nodes.length === 0) return true;
        const highlightedNow = highlightedMemoryIdsRef.current;
        const focusModeNow = highlightedNow.length > 0;
        const highlightedSetNow = focusModeNow ? new Set(highlightedNow) : null;
        const nowMs = performance.now();

        if (webglUploadedVersionRef.current !== webglDataVersionRef.current || focusModeNow) {
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
            const baseMul = 0.82 + imp * 0.24;
            if (focusModeNow && highlightedSetNow) {
              const isHighlighted = highlightedSetNow.has(n.memId);
              const blink = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(nowMs * 0.011 + hash(n.memId) * 0.0008));
              const lum = isHighlighted ? (0.96 + 0.26 * blink) : 0.66;
              pointColor[i * 4] = Math.min(1, r * baseMul * lum);
              pointColor[i * 4 + 1] = Math.min(1, g * baseMul * lum);
              pointColor[i * 4 + 2] = Math.min(1, b * baseMul * lum);
              pointColor[i * 4 + 3] = isHighlighted ? (0.8 + 0.2 * blink) : 0.12;
            } else {
              pointColor[i * 4] = r * baseMul;
              pointColor[i * 4 + 1] = g * baseMul;
              pointColor[i * 4 + 2] = b * baseMul;
              pointColor[i * 4 + 3] = 0.8 + imp * 0.2;
            }
          }

          gl.bindBuffer(gl.ARRAY_BUFFER, scene.pointPosBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, pointPos, gl.DYNAMIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, scene.pointColorBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, pointColor, gl.DYNAMIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, scene.pointImportanceBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, pointImportance, gl.DYNAMIC_DRAW);
          if (!focusModeNow) webglUploadedVersionRef.current = webglDataVersionRef.current;
        }

        const camNow = cameraRef.current;
        const viewMin = Math.min(vw, vh);
        const expand = expandInfoRef.current;
        const boundaryWorldR = (expand?.boundaryR || (viewMin * 0.33) / Math.max(0.1, camNow.scale)) * 0.88;
        const pointPx = subNodeBaseScreenPx(viewMin, camNow.scale, boundaryWorldR, nodes.length);

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
      const useWebGLSubRaw = drawWebGLSubgraph();

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
      const selectedMem = selectedMemRef.current;
      const highlightedMemoryIdsNow = highlightedMemoryIdsRef.current;
      const sequenceMemoryIdsNow = sequenceMemoryIdsRef.current;
      const highlightedSet = new Set(highlightedMemoryIdsNow);
      const focusMode = highlightedSet.size > 0;
      const useWebGLSub = useWebGLSubRaw;
      const clusterById = new Map<number, ClusterNode>();
      for (const n of clusterNodesNow) clusterById.set(n.id, n);
      const highlightedByCluster = new Map<number, string[]>();
      if (focusMode) {
        for (const cluster of clusterNodesNow) {
          const relatedIds = cluster.memberIds.filter((id) => highlightedSet.has(id));
          if (relatedIds.length > 0) highlightedByCluster.set(cluster.id, relatedIds);
        }
      }
      const subNodeByMemId = new Map<string, MemSubNode>();
      for (const sn of subNodesNow) subNodeByMemId.set(sn.memId, sn);
      const focusPointByMemId = new Map<string, { x: number; y: number; virtual: boolean }>();
      if (focusMode) {
        for (const cluster of clusterNodesNow) {
          if (cluster.x == null || cluster.y == null) continue;
          const relatedIds = highlightedByCluster.get(cluster.id);
          if (!relatedIds || relatedIds.length === 0) continue;
          for (const memId of relatedIds) {
            const sn = subNodeByMemId.get(memId);
            if (sn && sn.x != null && sn.y != null) {
              focusPointByMemId.set(memId, { x: sn.x, y: sn.y, virtual: false });
              continue;
            }
            const seed = hash(`${cluster.id}:${memId}:focus-point`);
            const angle = ((seed % 1000) / 1000) * Math.PI * 2;
            const radial = cluster.radius * (0.22 + (((seed >>> 10) % 1000) / 1000) * 0.6);
            focusPointByMemId.set(memId, {
              x: cluster.x + Math.cos(angle) * radial,
              y: cluster.y + Math.sin(angle) * radial,
              virtual: true,
            });
          }
        }
      }
      const worldLeft = -cam.x * invS;
      const worldTop = -cam.y * invS;
      const worldRight = (vw - cam.x) * invS;
      const worldBottom = (vh - cam.y) * invS;
      const truncateLabel = (text: string, maxChars = 28) => (
        text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}\u2026`
      );
      const rectsOverlap = (
        a: { x: number; y: number; w: number; h: number },
        b: { x: number; y: number; w: number; h: number },
        pad: number
      ) => (
        a.x < b.x + b.w + pad &&
        a.x + a.w + pad > b.x &&
        a.y < b.y + b.h + pad &&
        a.y + a.h + pad > b.y
      );
      const measureMemLabel = (sn: MemSubNode, anchorR: number, variant: 'hover' | 'auto') => {
        if (sn.x == null || sn.y == null) return null;
        const nodeScreenR = anchorR * cam.scale;
        const sizeScale = clamp(nodeScreenR / (variant === 'hover' ? 12 : 10), 0.88, 1.35);
        const txt = truncateLabel(sn.label || sn.memId, variant === 'hover' ? 30 : 24);
        const fs = (variant === 'hover' ? 11.8 : 10.3) * sizeScale * invS;
        const px = (variant === 'hover' ? 8.2 : 6.8) * sizeScale * invS;
        const py = (variant === 'hover' ? 4.4 : 3.5) * sizeScale * invS;
        const radius = (variant === 'hover' ? 8.2 : 6.8) * sizeScale * invS;
        const yGap = (variant === 'hover' ? 2.6 : 1.8) * invS;
        const chipR = (variant === 'hover' ? 2.9 : 2.4) * invS;
        const chipGap = 6 * invS;

        ctx.font = `${variant === 'hover' ? 620 : 560} ${fs}px "Avenir Next", "Segoe UI", sans-serif`;
        const tw = ctx.measureText(txt).width;
        const bw = tw + px * 2 + chipR * 2 + chipGap;
        const bh = fs + py * 2;
        const minX = worldLeft + bw / 2 + 6 * invS;
        const maxX = worldRight - bw / 2 - 6 * invS;
        const cx = Math.max(minX, Math.min(maxX, sn.x));
        let by = sn.y - anchorR - yGap - bh;
        if (by < worldTop + 4 * invS) by = sn.y + anchorR + yGap;
        if (by + bh > worldBottom - 4 * invS) by = worldBottom - 4 * invS - bh;
        return { txt, fs, px, py, radius, chipR, chipGap, tw, bw, bh, cx, by };
      };
      const drawMemLabel = (sn: MemSubNode, anchorR: number, variant: 'hover' | 'auto' = 'hover') => {
        if (sn.x == null || sn.y == null) return;
        const layout = measureMemLabel(sn, anchorR, variant);
        if (!layout) return;
        const { txt, fs, px, radius, chipR, chipGap, tw, bw, bh, cx, by } = layout;
        const [nr, ng, nb] = parseHexColor(sn.color);
        const accentR = Math.round((nr * 0.9 + 0.1) * 255);
        const accentG = Math.round((ng * 0.9 + 0.1) * 255);
        const accentB = Math.round((nb * 0.9 + 0.1) * 255);
        const textColor = variant === 'hover' ? '#f6fbff' : '#e4f0ff';

        ctx.save();
        ctx.font = `${variant === 'hover' ? 620 : 560} ${fs}px "Avenir Next", "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const grad = ctx.createLinearGradient(cx, by, cx, by + bh);
        if (variant === 'hover') {
          grad.addColorStop(0, 'rgba(14,23,42,0.94)');
          grad.addColorStop(1, 'rgba(8,14,28,0.9)');
        } else {
          grad.addColorStop(0, 'rgba(13,20,36,0.84)');
          grad.addColorStop(1, 'rgba(8,13,25,0.78)');
        }

        ctx.shadowBlur = (variant === 'hover' ? 12 : 8) * invS;
        ctx.shadowColor = variant === 'hover'
          ? `rgba(${accentR},${accentG},${accentB},0.22)`
          : 'rgba(10,14,24,0.24)';
        ctx.fillStyle = grad;
        roundedRectPath(ctx, cx - bw / 2, by, bw, bh, radius);
        ctx.fill();

        // Subtle top highlight for "glass" look.
        ctx.shadowBlur = 0;
        const hi = ctx.createLinearGradient(cx, by, cx, by + bh * 0.6);
        hi.addColorStop(0, 'rgba(255,255,255,0.16)');
        hi.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = hi;
        roundedRectPath(ctx, cx - bw / 2 + 0.2 * invS, by + 0.2 * invS, bw - 0.4 * invS, bh * 0.58, radius * 0.84);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.strokeStyle = variant === 'hover'
          ? `rgba(${accentR},${accentG},${accentB},0.52)`
          : `rgba(${accentR},${accentG},${accentB},0.34)`;
        ctx.lineWidth = Math.max((variant === 'hover' ? 0.95 : 0.78) * invS, 0.72 / cam.scale);
        roundedRectPath(ctx, cx - bw / 2, by, bw, bh, radius);
        ctx.stroke();

        const chipX = cx - bw / 2 + px + chipR;
        const textX = chipX + chipR + chipGap + (tw / 2);
        const textY = by + bh / 2 + 0.2 * invS;

        ctx.shadowBlur = 6 * invS;
        ctx.shadowColor = `rgba(${accentR},${accentG},${accentB},0.5)`;
        ctx.beginPath();
        ctx.arc(chipX, by + bh / 2, chipR, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${accentR},${accentG},${accentB},0.92)`;
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.fillStyle = textColor;
        ctx.fillText(txt, textX, textY);
        ctx.restore();
      };
      const pendingEdgeEndLabels: Array<{ x: number; y: number; text: string; color: string }> = [];
      const pendingClusterLabels: Array<{ node: ClusterNode; alpha: number; hovered: boolean }> = [];
      const pendingMemLabels: Array<{ sn: MemSubNode; anchorR: number; variant: 'hover' | 'auto' }> = [];
      const pendingFocusNodeLabels: Array<{ x: number; y: number; text: string; color: string }> = [];

      // ── Cluster edges ──
      let hasExpandedEdgeClip = false;
      if (!focusMode && isExpMode && currentExpandedId !== null) {
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
        if (focusMode) continue;
        const s = typeof link.source === 'object' ? link.source : clusterById.get(Number(link.source));
        const t = typeof link.target === 'object' ? link.target : clusterById.get(Number(link.target));
        if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) continue;
        const sourceId = typeof link.source === 'object' ? (link.source as ClusterNode).id : Number(link.source);
        const targetId = typeof link.target === 'object' ? (link.target as ClusterNode).id : Number(link.target);
        const sourceRelated = highlightedByCluster.has(sourceId);
        const targetRelated = highlightedByCluster.has(targetId);
        if (focusMode && (!sourceRelated || !targetRelated)) continue;

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

      // ── Narrative sequence path (from side narrative graph) ──
      if (sequenceMemoryIdsNow.length > 1 && highlightedSet.size > 0) {
        const resolvePoint = (memId: string): { x: number; y: number } | null => {
          const focusPoint = focusPointByMemId.get(memId);
          if (focusPoint) return { x: focusPoint.x, y: focusPoint.y };
          const subNode = subNodeByMemId.get(memId);
          if (subNode && subNode.x != null && subNode.y != null) {
            return { x: subNode.x, y: subNode.y };
          }
          for (const cluster of clusterNodesNow) {
            if (cluster.x == null || cluster.y == null) continue;
            if (cluster.memberIds.includes(memId)) {
              return { x: cluster.x, y: cluster.y };
            }
          }
          return null;
        };

        const seqPoints: Array<{ x: number; y: number }> = [];
        let lastKey = '';
        for (const memId of sequenceMemoryIdsNow) {
          const point = resolvePoint(memId);
          if (!point) continue;
          const key = `${Math.round(point.x * 10)}|${Math.round(point.y * 10)}`;
          if (key === lastKey) continue;
          seqPoints.push(point);
          lastKey = key;
        }

        if (seqPoints.length > 1) {
          type SeqSegment = {
            from: { x: number; y: number };
            to: { x: number; y: number };
            cx: number;
            cy: number;
            arrowX: number;
            arrowY: number;
            tx: number;
            ty: number;
          };
          const segments: SeqSegment[] = [];

          for (let i = 0; i < seqPoints.length - 1; i += 1) {
            const from = seqPoints[i];
            const to = seqPoints[i + 1];
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 1e-3) continue;

            const ux = dx / dist;
            const uy = dy / dist;
            const px = -uy;
            const py = ux;
            const bendSign = (i % 2 === 0) ? 1 : -1;
            const bend = Math.min(56 * invS, dist * 0.22) * bendSign;
            const cx = (from.x + to.x) * 0.5 + px * bend;
            const cy = (from.y + to.y) * 0.5 + py * bend;

            const t = 0.9;
            const mt = 1 - t;
            const arrowX = mt * mt * from.x + 2 * mt * t * cx + t * t * to.x;
            const arrowY = mt * mt * from.y + 2 * mt * t * cy + t * t * to.y;
            let tx = 2 * mt * (cx - from.x) + 2 * t * (to.x - cx);
            let ty = 2 * mt * (cy - from.y) + 2 * t * (to.y - cy);
            const td = Math.hypot(tx, ty);
            if (td < 1e-6) {
              tx = ux;
              ty = uy;
            } else {
              tx /= td;
              ty /= td;
            }

            segments.push({ from, to, cx, cy, arrowX, arrowY, tx, ty });
          }

          if (segments.length > 0) {
            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            for (const pass of [0, 1] as const) {
              ctx.strokeStyle = pass === 0 ? 'rgba(94, 234, 212, 0.2)' : 'rgba(94, 234, 212, 0.76)';
              ctx.lineWidth = (pass === 0 ? 7.2 : 2.1) * invS;
              for (const seg of segments) {
                ctx.beginPath();
                ctx.moveTo(seg.from.x, seg.from.y);
                ctx.quadraticCurveTo(seg.cx, seg.cy, seg.to.x, seg.to.y);
                ctx.stroke();
              }
            }

            ctx.fillStyle = 'rgba(94, 234, 212, 0.94)';
            for (const seg of segments) {
              const arrowLen = 9.2 * invS;
              const arrowHalfW = 4.8 * invS;
              const nx = -seg.ty;
              const ny = seg.tx;
              const tipX = seg.arrowX + seg.tx * (2.4 * invS);
              const tipY = seg.arrowY + seg.ty * (2.4 * invS);
              const baseX = tipX - seg.tx * arrowLen;
              const baseY = tipY - seg.ty * arrowLen;
              ctx.beginPath();
              ctx.moveTo(tipX, tipY);
              ctx.lineTo(baseX + nx * arrowHalfW, baseY + ny * arrowHalfW);
              ctx.lineTo(baseX - nx * arrowHalfW, baseY - ny * arrowHalfW);
              ctx.closePath();
              ctx.fill();
            }
            ctx.restore();
          }
        }
      }

      // ── Sub-graph bundled routes ──
      if (!focusMode && isExpMode && subNodesNow.length > 0) {
        const bundlePaths = subBundlePathsRef.current;
        const linesReady = now >= subLinesVisibleAfterRef.current;
        if (bundlePaths.length > 0 && linesReady) {
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          for (const path of bundlePaths) {
            const s = subNodesNow[path.sourceIdx];
            const t = subNodesNow[path.targetIdx];
            if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) continue;
            if (focusMode && (!highlightedSet.has(s.memId) || !highlightedSet.has(t.memId))) continue;
            const centerFade = 1 - path.coreIntrusion * 0.84;
            const width = (0.48 + path.intensity * 0.78) * invS * (1 - path.coreIntrusion * 0.6);
            const alpha = (0.012 + path.similarity * 0.045 + path.intensity * 0.028) * centerFade;
            const [r, g, b] = path.color;
            const r255 = Math.round(r * 255);
            const g255 = Math.round(g * 255);
            const b255 = Math.round(b * 255);
            ctx.strokeStyle = `rgba(${r255},${g255},${b255},${alpha * 0.5})`;
            ctx.lineWidth = width * 2.05;
            drawSmoothBundle(ctx, path.points);
            ctx.stroke();

            ctx.strokeStyle = `rgba(${r255},${g255},${b255},${alpha})`;
            ctx.lineWidth = width;
            drawSmoothBundle(ctx, path.points);
            ctx.stroke();
          }

          const expand = expandInfoRef.current;
          if (expand) {
            const coreR = expand.boundaryR * 0.34;
            const coreMask = ctx.createRadialGradient(expand.cx, expand.cy, coreR * 0.04, expand.cx, expand.cy, coreR);
            coreMask.addColorStop(0, 'rgba(7,11,22,0.5)');
            coreMask.addColorStop(0.55, 'rgba(7,11,22,0.24)');
            coreMask.addColorStop(1, 'rgba(7,11,22,0)');
            ctx.fillStyle = coreMask;
            ctx.beginPath();
            ctx.arc(expand.cx, expand.cy, coreR, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (!useWebGLSub) {
          const subEdgesNow = subRenderLinksRef.current;
          for (const link of subEdgesNow) {
            const si = typeof link.source === 'number' ? link.source : (link.source as MemSubNode);
            const ti = typeof link.target === 'number' ? link.target : (link.target as MemSubNode);
            const s = typeof si === 'number' ? subNodesNow[si] : si;
            const t = typeof ti === 'number' ? subNodesNow[ti] : ti;
            if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) continue;
            if (focusMode && (!highlightedSet.has(s.memId) || !highlightedSet.has(t.memId))) continue;
            ctx.beginPath();
            ctx.moveTo(s.x, s.y);
            ctx.lineTo(t.x, t.y);
            ctx.strokeStyle = `rgba(200,220,255,${0.04 + link.similarity * 0.08})`;
            ctx.lineWidth = 0.3 * invS;
            ctx.stroke();
          }
        }
      }

      // ── Cluster nodes ──
      for (const node of clusterNodesNow) {
        if (node.x == null || node.y == null) continue;
        const isExpanded = currentExpandedId === node.id;
        const isHovered = hoveredNode === node.id;
        const dimmed = isExpMode && !isExpanded;
        const relatedMemIds = highlightedByCluster.get(node.id) || [];
        const isNarrativeRelated = relatedMemIds.length > 0;
        const blink = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(now * 0.009 + node.id * 0.6));
        const focusAlpha = isNarrativeRelated ? blink : 0.12;
        const alpha = focusMode ? focusAlpha : (dimmed ? 0.12 : 1);

        // Glow
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = isHovered ? 24 : 14;
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

        if (focusMode && isNarrativeRelated) {
          for (const memId of relatedMemIds) {
            const focusPoint = focusPointByMemId.get(memId);
            const mem = memById.get(memId);
            if (!focusPoint) continue;
            if (focusPoint.virtual) {
              const blinkNode = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(now * 0.011 + hash(memId) * 0.0008));
              const markerR = Math.max(1.8 * invS, node.radius * 0.045);
              ctx.save();
              ctx.globalAlpha = 0.5 + 0.35 * blinkNode;
              ctx.fillStyle = mem?.emotion ? eStyle(mem.emotion).color : 'rgba(94, 234, 212, 0.95)';
              ctx.shadowBlur = 6 * invS;
              ctx.shadowColor = 'rgba(94, 234, 212, 0.72)';
              ctx.beginPath();
              ctx.arc(focusPoint.x, focusPoint.y, markerR, 0, Math.PI * 2);
              ctx.fill();
              ctx.restore();
            }
            pendingFocusNodeLabels.push({
              x: focusPoint.x,
              y: focusPoint.y,
              text: mem?.key || mem?.object || memId,
              color: 'rgba(94, 234, 212, 0.98)',
            });
          }
        }

        pendingClusterLabels.push({ node, alpha, hovered: isHovered });

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
          const isSel = selectedMem === sn.memId;
          const isNarrativeRelated = highlightedSet.has(sn.memId);
          const blink = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(now * 0.011 + hash(sn.memId) * 0.0008));
          const focusAlpha = isNarrativeRelated ? blink : 0.12;
          const baseR = nodeWorldR * (0.75 + (sn.importance || 0) * 1.3);
          const r = focusMode
            ? baseR
            : (isHov ? baseR * 1.35 : isSel ? baseR * 1.28 : isNarrativeRelated ? baseR * 1.2 : baseR);

          ctx.save();
          const shadow = isHov ? 14 : isSel ? 12 : isNarrativeRelated ? 10 : 5 + (sn.importance || 0) * 3;
          ctx.shadowBlur = shadow * invS;
          ctx.shadowColor = sn.glow;
          ctx.beginPath();
          ctx.arc(sn.x, sn.y, r, 0, Math.PI * 2);
          ctx.fillStyle = sn.color;
          ctx.globalAlpha = focusMode ? focusAlpha : (isSel || isNarrativeRelated ? 1 : 0.9);
          ctx.fill();
          ctx.restore();
          if (isHov) {
            hoveredNodeObj = sn;
            hoveredNodeR = r;
          }
        }
        if (!hoveredNodeObj && selectedMem) {
          const selectedNode = subNodesNow.find((n) => n.memId === selectedMem && n.x != null && n.y != null);
          if (selectedNode) {
            const baseR = nodeWorldR * (0.75 + (selectedNode.importance || 0) * 1.3);
            pendingMemLabels.push({ sn: selectedNode, anchorR: baseR * 1.28, variant: 'hover' });
          }
        }
        if (hoveredNodeObj) {
          pendingMemLabels.push({ sn: hoveredNodeObj, anchorR: hoveredNodeR, variant: 'hover' });
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
          pendingMemLabels.push({ sn, anchorR: baseR * 1.35, variant: 'hover' });
        }
      }
      if (useWebGLSub && isExpMode && selectedMem && selectedMem !== hoveredMem) {
        const sn = subNodesNow.find((n) => n.memId === selectedMem);
        if (sn && sn.x != null && sn.y != null) {
          const expand = expandInfoRef.current;
          const boundaryWorldR = (expand?.boundaryR || (viewMin * 0.33) / Math.max(0.1, cam.scale)) * 0.88;
          const nodeScreenR = subNodeBaseScreenPx(viewMin, cam.scale, boundaryWorldR, subNodesNow.length);
          const nodeWorldR = nodeScreenR * invS;
          const baseR = nodeWorldR * (0.75 + (sn.importance || 0) * 1.3);

          ctx.save();
          ctx.shadowBlur = 14 * invS;
          ctx.shadowColor = sn.glow;
          ctx.beginPath();
          ctx.arc(sn.x, sn.y, baseR * 1.28, 0, Math.PI * 2);
          ctx.fillStyle = sn.color;
          ctx.globalAlpha = 0.34;
          ctx.fill();
          ctx.restore();

          pendingMemLabels.push({ sn, anchorR: baseR * 1.28, variant: 'hover' });
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
          .filter((sn) => !focusMode || highlightedSet.has(sn.memId))
          .sort((a, b) => (b.importance || 0) - (a.importance || 0));

        const viewportCount = viewportNodes.length;
        const minLabelBudget = 3;
        const maxLabelBudget = 10;
        const zoomRange = 6; // 从默认尺度逐步增长到满配 label 数量
        const zoomT = Math.max(0, Math.min(1, (cam.scale - 1) / zoomRange));
        const zoomBudget = Math.round(minLabelBudget + (maxLabelBudget - minLabelBudget) * zoomT);
        const targetLabelCount = Math.min(maxLabelBudget, Math.max(minLabelBudget, zoomBudget), viewportCount);

        const selected: MemSubNode[] = [];
        const occupied: Array<{ x: number; y: number; w: number; h: number }> = [];
        for (const sn of viewportNodes) {
          if (selected.length >= targetLabelCount) break;
          const baseR = nodeWorldR * (0.75 + (sn.importance || 0) * 1.3);
          const layout = measureMemLabel(sn, baseR, 'auto');
          if (!layout) continue;
          const rect = { x: layout.cx - layout.bw / 2, y: layout.by, w: layout.bw, h: layout.bh };
          const padding = 4.2 * invS;
          let collides = false;
          for (const occ of occupied) {
            if (rectsOverlap(rect, occ, padding)) {
              collides = true;
              break;
            }
          }
          if (collides) continue;
          selected.push(sn);
          occupied.push(rect);
        }

        for (const sn of selected) {
          const baseR = nodeWorldR * (0.75 + (sn.importance || 0) * 1.3);
          pendingMemLabels.push({ sn, anchorR: baseR, variant: 'auto' });
        }
      }

      // ── All labels at top-most layer ──
      if (!focusMode && pendingClusterLabels.length > 0) {
        for (const entry of pendingClusterLabels) {
          const { node, alpha, hovered } = entry;
          if (node.x == null || node.y == null) continue;
          const nodeScreenR = node.radius * cam.scale;
          const labelScale = clamp(nodeScreenR / 44, 0.84, 1.32);
          const fontSize = (hovered ? 12.1 : 11.2) * labelScale * invS;
          // Keep title close to numeric center instead of floating outside.
          const yOff = Math.min(node.radius * 0.26, 14 * invS);
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.font = `${hovered ? 640 : 600} ${fontSize}px "Avenir Next", "Segoe UI", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowBlur = (hovered ? 11 : 7) * invS;
          ctx.shadowColor = node.glow;
          ctx.fillStyle = '#eaf5ff';
          ctx.fillText(node.label, node.x, node.y - yOff);
          ctx.shadowBlur = 0;
          ctx.restore();
        }
      }

      if (!focusMode && pendingEdgeEndLabels.length > 0) {
        for (const label of pendingEdgeEndLabels) {
          ctx.save();
          const fs = 10.8 * invS;
          const px = 6 * invS;
          const py = 3.2 * invS;
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
          ctx.shadowColor = 'rgba(10,16,28,0.48)';
          ctx.fillStyle = 'rgba(8,14,26,0.86)';
          roundedRectPath(ctx, cx - bw / 2, cy - bh / 2, bw, bh, rr);
          ctx.fill();

          ctx.shadowBlur = 0;
          ctx.strokeStyle = 'rgba(205,223,246,0.4)';
          ctx.lineWidth = Math.max(0.78 * invS, 0.75 / cam.scale);
          roundedRectPath(ctx, cx - bw / 2, cy - bh / 2, bw, bh, rr);
          ctx.stroke();

          ctx.fillStyle = label.color;
          ctx.fillText(label.text, cx, cy + 0.2 * invS);
          ctx.restore();
        }
      }

      if (!focusMode && pendingMemLabels.length > 0) {
        for (const item of pendingMemLabels) {
          drawMemLabel(item.sn, item.anchorR, item.variant);
        }
      }

      if (focusMode && pendingFocusNodeLabels.length > 0) {
        const drawnKeys = new Set<string>();
        for (const item of pendingFocusNodeLabels) {
          const key = `${Math.round(item.x * 2)}|${Math.round(item.y * 2)}`;
          if (drawnKeys.has(key)) continue;
          drawnKeys.add(key);
          const text = truncateLabel(item.text, 24);
          const fs = 9.8 * invS;
          const px = 6.2 * invS;
          const py = 3.2 * invS;
          ctx.save();
          ctx.font = `600 ${fs}px "Avenir Next", "Segoe UI", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const tw = ctx.measureText(text).width;
          const bw = tw + px * 2;
          const bh = fs + py * 2;
          const cx = item.x;
          const cy = item.y - 10 * invS - bh * 0.5;
          ctx.fillStyle = 'rgba(7, 17, 29, 0.92)';
          roundedRectPath(ctx, cx - bw / 2, cy - bh / 2, bw, bh, 6 * invS);
          ctx.fill();
          ctx.strokeStyle = 'rgba(94, 234, 212, 0.48)';
          ctx.lineWidth = Math.max(0.8 * invS, 0.75 / cam.scale);
          roundedRectPath(ctx, cx - bw / 2, cy - bh / 2, bw, bh, 6 * invS);
          ctx.stroke();
          ctx.fillStyle = item.color;
          ctx.fillText(text, cx, cy + 0.2 * invS);
          ctx.restore();
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
        selectedMemRef.current = null;
        // Clicking inside the already expanded cluster should be a no-op, not a collapse toggle.
        if (expandedClusterRef.current !== null && hitId === expandedClusterRef.current) {
          // no-op
        } else {
          expandCluster(hitId);
        }
      } else {
        const memNode = hit.node as MemSubNode;
        selectedMemRef.current = memNode.memId;
        hoveredMemRef.current = memNode.memId;
        const containerEl = containerRef.current;
        if (containerEl && memNode.x != null && memNode.y != null) {
          const camNow = cameraRef.current;
          animateCamera({
            x: containerEl.clientWidth / 2 - memNode.x * camNow.scale,
            y: containerEl.clientHeight / 2 - memNode.y * camNow.scale,
            scale: camNow.scale,
          }, 260);
        }
        onMemoryClick(memNode.memId);
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

export default memo(ClusterGraph, arePropsEqual);
