/**
 * Narrative Chain Builder
 *
 * 基于预计算的 embedding 邻居 + Object/Category 精确匹配构建叙事链
 *
 * 三层叙事：
 *   1. 语义主线：embedding Top-K neighbors，按时间排序分上下游
 *   2. Object 链：同 object 的记忆，按时间排序
 *   3. Category 链：同 category 的记忆，按时间排序
 *   4. 意外连接：中等相似度 + 不同 object/category
 */

export interface MemoryNode {
  id: string;
  key: string;
  text: string;
  createdAt: string;
  object: string;
  category: string;
  emotion: string;
}

export interface NeighborEntry {
  id: string;
  similarity: number;
}

export interface EmbeddingsData {
  neighbors: Record<string, NeighborEntry[]>;
}

export interface NarrativeChain {
  upstream: (MemoryNode & { similarity: number })[];
  downstream: (MemoryNode & { similarity: number })[];
}

export interface NarrativeContext {
  primary: NarrativeChain;
  objectChain: MemoryNode[];
  categoryChain: MemoryNode[];
  surprise?: MemoryNode & { similarity: number };
}

function getTimestamp(dateStr: string): number {
  if (!dateStr) return 0;
  const date = new Date(dateStr);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}

/**
 * 构建叙事链（使用预计算的 embedding 邻居数据）
 */
export function buildNarrativeChains(
  currentMemory: MemoryNode,
  allMemories: MemoryNode[],
  embeddingsData: EmbeddingsData,
  options: {
    similarityThreshold?: number;
    upstreamCount?: number;
    downstreamCount?: number;
    objectCount?: number;
    categoryCount?: number;
    surpriseRange?: [number, number];
  } = {}
): NarrativeContext {
  const {
    similarityThreshold = 0.4,
    upstreamCount = 3,
    downstreamCount = 3,
    objectCount = 5,
    categoryCount = 5,
    surpriseRange = [0.25, 0.4],
  } = options;

  const currentTimestamp = getTimestamp(currentMemory.createdAt);

  // 建索引方便查找
  const memoryById = new Map<string, MemoryNode>();
  for (const m of allMemories) {
    memoryById.set(m.id, m);
  }

  // ── 1. 语义主线：从预计算邻居中取 ──
  const neighbors = embeddingsData.neighbors[currentMemory.id] || [];

  const semanticMatches = neighbors
    .filter(n => n.similarity >= similarityThreshold && memoryById.has(n.id))
    .map(n => ({
      ...memoryById.get(n.id)!,
      similarity: n.similarity,
      timestamp: getTimestamp(memoryById.get(n.id)!.createdAt),
    }));

  const upstream = semanticMatches
    .filter(m => m.timestamp < currentTimestamp)
    .sort((a, b) => b.timestamp - a.timestamp) // 最近的上游在前
    .slice(0, upstreamCount);

  const downstream = semanticMatches
    .filter(m => m.timestamp >= currentTimestamp)
    .sort((a, b) => a.timestamp - b.timestamp) // 最早的下游在前
    .slice(0, downstreamCount);

  // ── 2. Object 链：精确匹配 ──
  const objectChain = allMemories
    .filter(m => m.id !== currentMemory.id && m.object === currentMemory.object)
    .sort((a, b) => getTimestamp(a.createdAt) - getTimestamp(b.createdAt))
    .slice(0, objectCount);

  // ── 3. Category 链：精确匹配 ──
  const categoryChain = allMemories
    .filter(m => m.id !== currentMemory.id && m.category === currentMemory.category)
    .sort((a, b) => getTimestamp(a.createdAt) - getTimestamp(b.createdAt))
    .slice(0, categoryCount);

  // ── 4. 意外连接：中等相似度 + 不同上下文 ──
  const surpriseCandidate = neighbors.find(n => {
    if (n.similarity < surpriseRange[0] || n.similarity > surpriseRange[1]) return false;
    const mem = memoryById.get(n.id);
    if (!mem) return false;
    return mem.object !== currentMemory.object && mem.category !== currentMemory.category;
  });

  const surprise = surpriseCandidate
    ? { ...memoryById.get(surpriseCandidate.id)!, similarity: surpriseCandidate.similarity }
    : undefined;

  return {
    primary: { upstream, downstream },
    objectChain,
    categoryChain,
    surprise,
  };
}
