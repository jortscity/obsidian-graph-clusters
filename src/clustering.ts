import { NoteEmbedding, cosineSimilarity } from "./embeddings";

export interface Cluster {
  members: NoteEmbedding[];
  centroidNote: NoteEmbedding;
  name: string;
}

// Union-Find for connected-component grouping.
function makeUF(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(x: number, y: number) {
    parent[find(x)] = find(y);
  }
  return { find, union };
}

// Single-linkage: two clusters merge as soon as ANY cross-pair meets the
// threshold. Fast (O(n²)) but susceptible to chaining — loosely-related
// notes can end up in the same cluster if they share an intermediary.
function singleLinkageGroups(
  notes: NoteEmbedding[],
  threshold: number
): number[][] {
  const n = notes.length;
  const { find, union } = makeUF(n);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosineSimilarity(notes[i].vector, notes[j].vector) >= threshold) {
        union(i, j);
      }
    }
  }

  const map = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!map.has(r)) map.set(r, []);
    map.get(r)!.push(i);
  }
  return Array.from(map.values());
}

// Complete-linkage: two clusters merge only if ALL cross-pairs meet the
// threshold. Produces tighter clusters with no chaining, but at the same
// threshold value will yield more (smaller) clusters than single-linkage.
function completeLinkageGroups(
  notes: NoteEmbedding[],
  threshold: number
): number[][] {
  const n = notes.length;
  // Start with each note in its own cluster (by index list).
  let clusters: number[][] = notes.map((_, i) => [i]);

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        // Check all pairs across the two candidate clusters.
        let canMerge = true;
        for (const i of clusters[a]) {
          for (const j of clusters[b]) {
            if (cosineSimilarity(notes[i].vector, notes[j].vector) < threshold) {
              canMerge = false;
              break;
            }
            if (!canMerge) break;
          }
          if (!canMerge) break;
        }
        if (canMerge) {
          clusters[a] = clusters[a].concat(clusters[b]);
          clusters.splice(b, 1);
          merged = true;
          break outer; // restart scan after any merge
        }
      }
    }
  }
  return clusters;
}

function computeCentroid(vecs: number[][]): number[] {
  const dim = vecs[0].length;
  const centroid = new Array<number>(dim).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) centroid[i] += v[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= vecs.length;
  return centroid;
}

function closestToCentroid(members: NoteEmbedding[], centroid: number[]): NoteEmbedding {
  let best = members[0];
  let bestSim = cosineSimilarity(members[0].vector, centroid);
  for (let i = 1; i < members.length; i++) {
    const sim = cosineSimilarity(members[i].vector, centroid);
    if (sim > bestSim) {
      bestSim = sim;
      best = members[i];
    }
  }
  return best;
}

export function buildClusters(
  notes: NoteEmbedding[],
  threshold: number,
  method: "single" | "complete"
): Cluster[] {
  if (notes.length === 0) return [];

  const groups =
    method === "complete"
      ? completeLinkageGroups(notes, threshold)
      : singleLinkageGroups(notes, threshold);

  return groups.map((indices) => {
    const members = indices.map((i) => notes[i]);
    const centroid = computeCentroid(members.map((m) => m.vector));
    const centroidNote = closestToCentroid(members, centroid);
    return {
      members,
      centroidNote,
      name: `Cluster — ${centroidNote.title}`,
    };
  });
}

// Best-effort: ask Ollama to generate a short topic label for the cluster.
// Returns null on any failure so the caller falls back to the centroid title.
// Called only when ollamaClusterNaming is true; on large vaults this is one
// HTTP round-trip per cluster, so callers should gate it behind that setting.
export async function tryOllamaClusterName(
  members: NoteEmbedding[],
  endpoint: string
): Promise<string | null> {
  try {
    const titles = members
      .slice(0, 12)
      .map((m) => m.title)
      .join(", ");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let res: Response;
    try {
      res = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama3.2",
          messages: [
            {
              role: "user",
              content: `Give a short 2–4 word topic label for a group of notes titled: ${titles}. Reply with only the label.`,
            },
          ],
          stream: false,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data = await res.json();
    const label = (data.message?.content ?? "").trim();
    return label.length > 0 && label.length < 80
      ? `Cluster — ${label}`
      : null;
  } catch {
    return null;
  }
}
