/**
 * Label Propagation Clustering
 *
 * 基于 EmbeddingsData.neighbors 构建语义聚类
 * - 过滤 similarity < threshold 的边
 * - Label propagation 迭代至收敛
 * - 合并小聚类，控制总数在 maxClusters 以内
 * - 计算聚类间边权重
 */

import type { EmbeddingsData, MemoryNode } from './narrative';

export interface SemanticCluster {
  id: number;
  memberIds: string[];
  dominantEmotion: string;
  label?: string;
}

export interface ClusterEdge {
  source: number;
  target: number;
  weight: number;
}

export interface ClusteringResult {
  clusters: SemanticCluster[];
  edges: ClusterEdge[];
  nodeClusterMap: Map<string, number>;
}

/** JSON-safe version for localStorage caching */
export interface CachedClustering {
  fingerprint: string;
  clusters: SemanticCluster[];
  edges: ClusterEdge[];
}

/** Compute a fingerprint from record count + first/last IDs for cache invalidation */
export function clusterFingerprint(memoryCount: number, firstId: string, lastId: string): string {
  return `v1:${memoryCount}:${firstId}:${lastId}`;
}

export function buildClusters(
  memories: MemoryNode[],
  embeddingsData: EmbeddingsData,
  options: {
    similarityThreshold?: number;
    maxIterations?: number;
    maxClusters?: number;
  } = {}
): ClusteringResult {
  const {
    similarityThreshold = 0.35,
    maxIterations = 20,
    maxClusters = 12,
  } = options;

  const ids = memories.map(m => m.id);
  const idSet = new Set(ids);

  // Build adjacency: only edges above threshold
  const adj = new Map<string, { id: string; sim: number }[]>();
  for (const id of ids) {
    const neighbors = (embeddingsData.neighbors[id] || [])
      .filter(n => n.similarity >= similarityThreshold && idSet.has(n.id));
    adj.set(id, neighbors.map(n => ({ id: n.id, sim: n.similarity })));
  }

  // Label propagation: each node starts as its own label
  const label = new Map<string, string>();
  for (const id of ids) label.set(id, id);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;

    // Deterministic order: sort by degree descending, then by id for stability
    const ordered = [...ids].sort((a, b) => {
      const da = (adj.get(a) || []).length;
      const db = (adj.get(b) || []).length;
      return db - da || a.localeCompare(b);
    });

    for (const id of ordered) {
      const neighbors = adj.get(id);
      if (!neighbors || neighbors.length === 0) continue;

      const votes = new Map<string, number>();
      for (const n of neighbors) {
        const nLabel = label.get(n.id)!;
        votes.set(nLabel, (votes.get(nLabel) || 0) + n.sim);
      }

      let bestLabel = label.get(id)!;
      let bestScore = -1;
      for (const [lbl, score] of votes) {
        if (score > bestScore) {
          bestScore = score;
          bestLabel = lbl;
        }
      }

      if (bestLabel !== label.get(id)) {
        label.set(id, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Group by label, sort by size descending
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const lbl = label.get(id)!;
    if (!groups.has(lbl)) groups.set(lbl, []);
    groups.get(lbl)!.push(id);
  }

  let sortedGroups = [...groups.values()].sort((a, b) => b.length - a.length);

  // Keep top maxClusters, merge the rest into nearest large cluster
  const largeGroups = sortedGroups.slice(0, maxClusters);
  const smallNodes: string[] = [];
  for (const g of sortedGroups.slice(maxClusters)) {
    smallNodes.push(...g);
  }

  const largeSets = largeGroups.map(g => new Set(g));

  // Assign small/overflow nodes to nearest large cluster by edge similarity
  for (const id of smallNodes) {
    const neighbors = adj.get(id) || [];
    let bestCluster = 0;
    let bestSim = -1;

    for (let ci = 0; ci < largeGroups.length; ci++) {
      for (const n of neighbors) {
        if (largeSets[ci].has(n.id) && n.sim > bestSim) {
          bestSim = n.sim;
          bestCluster = ci;
        }
      }
    }

    largeGroups[bestCluster].push(id);
    largeSets[bestCluster].add(id);
  }

  // Build memory lookup
  const memById = new Map<string, MemoryNode>();
  for (const m of memories) memById.set(m.id, m);

  // Build clusters with dominant emotion
  const nodeClusterMap = new Map<string, number>();
  const clusters: SemanticCluster[] = largeGroups.map((members, i) => {
    for (const id of members) nodeClusterMap.set(id, i);

    const emotionCount = new Map<string, number>();
    for (const id of members) {
      const emotion = memById.get(id)?.emotion || 'Unknown';
      emotionCount.set(emotion, (emotionCount.get(emotion) || 0) + 1);
    }

    let dominantEmotion = 'Unknown';
    let maxCount = 0;
    for (const [emotion, count] of emotionCount) {
      if (count > maxCount) {
        maxCount = count;
        dominantEmotion = emotion;
      }
    }

    return { id: i, memberIds: members, dominantEmotion };
  });

  // Compute inter-cluster edge weights
  const edgeWeights = new Map<string, number>();
  for (const id of ids) {
    const ci = nodeClusterMap.get(id)!;
    const neighbors = adj.get(id) || [];
    for (const n of neighbors) {
      const cj = nodeClusterMap.get(n.id);
      if (cj === undefined || ci === cj) continue;
      const key = ci < cj ? `${ci}-${cj}` : `${cj}-${ci}`;
      edgeWeights.set(key, (edgeWeights.get(key) || 0) + n.sim);
    }
  }

  const edges: ClusterEdge[] = [];
  for (const [key, weight] of edgeWeights) {
    const [s, t] = key.split('-').map(Number);
    edges.push({ source: s, target: t, weight });
  }

  return { clusters, edges, nodeClusterMap };
}
