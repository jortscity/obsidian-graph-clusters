import { App, normalizePath } from "obsidian";
import { SemanticClusterSettings } from "./settings";

interface CacheEntry {
  mtime: number;
  vector: number[];
}

interface EmbeddingCache {
  [path: string]: CacheEntry;
}

export interface NoteEmbedding {
  path: string;
  title: string;
  vector: number[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  return content.slice(end + 4).trimStart();
}

export class EmbeddingManager {
  private app: App;
  private settings: SemanticClusterSettings;
  private pluginId: string;
  private cache: EmbeddingCache = {};
  private transformersPipeline: any = null;

  constructor(app: App, settings: SemanticClusterSettings, pluginId: string) {
    this.app = app;
    this.settings = settings;
    this.pluginId = pluginId;
  }

  private cachePath(): string {
    return normalizePath(
      `${this.app.vault.configDir}/plugins/${this.pluginId}/embeddings.json`
    );
  }

  async loadCache(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(this.cachePath());
      this.cache = JSON.parse(raw);
    } catch {
      this.cache = {};
    }
  }

  async saveCache(): Promise<void> {
    await this.app.vault.adapter.write(
      this.cachePath(),
      JSON.stringify(this.cache)
    );
  }

  private async getTransformersPipeline(): Promise<any> {
    if (this.transformersPipeline) return this.transformersPipeline;

    // Dynamic import so the heavy ONNX runtime loads only when first needed.
    const { pipeline, env } = await import("@xenova/transformers");
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    // Point the ONNX WASM runtime at a CDN so the plugin doesn't need to ship
    // its own .wasm copies. Internet connectivity is already required for the
    // initial model download, so this adds no new dependency.
    env.backends.onnx.wasm.wasmPaths =
      "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/";

    this.transformersPipeline = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
    return this.transformersPipeline;
  }

  private async embedWithTransformers(text: string): Promise<number[]> {
    const pipe = await this.getTransformersPipeline();
    const output = await pipe(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
  }

  private async embedWithOllama(text: string): Promise<number[]> {
    const res = await fetch(`${this.settings.ollamaEndpoint}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.settings.ollamaModel,
        prompt: text,
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embeddings failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!Array.isArray(data.embedding)) {
      throw new Error("Ollama returned unexpected response format");
    }
    return data.embedding as number[];
  }

  async checkOllamaReachable(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${this.settings.ollamaEndpoint}/api/tags`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      throw new Error(
        `Ollama is not reachable at ${this.settings.ollamaEndpoint}: ${
          (e as Error).message
        }`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async embedText(text: string): Promise<number[]> {
    return this.settings.embeddingBackend === "ollama"
      ? this.embedWithOllama(text)
      : this.embedWithTransformers(text);
  }

  async embedAllNotes(forceAll = false): Promise<NoteEmbedding[]> {
    await this.loadCache();

    const prefix = `${this.settings.pluginFolderName}/`;
    const files = this.app.vault.getMarkdownFiles().filter(
      (f) => !f.path.startsWith(prefix) && !f.path.startsWith(".obsidian/")
    );

    const results: NoteEmbedding[] = [];
    const livePaths = new Set(files.map((f) => f.path));

    for (const file of files) {
      const { mtime } = file.stat;
      const cached = this.cache[file.path];

      if (!forceAll && cached && cached.mtime === mtime) {
        results.push({
          path: file.path,
          title: file.basename,
          vector: cached.vector,
        });
        continue;
      }

      try {
        const content = await this.app.vault.cachedRead(file);
        const body = stripFrontmatter(content);
        if (!body.trim()) continue;

        const vector = await this.embedText(body);
        this.cache[file.path] = { mtime, vector };
        results.push({ path: file.path, title: file.basename, vector });
      } catch (e) {
        console.warn(`[SemanticCluster] Skipping ${file.path}:`, e);
      }
    }

    // Evict deleted files from cache
    for (const path of Object.keys(this.cache)) {
      if (!livePaths.has(path)) delete this.cache[path];
    }

    await this.saveCache();
    return results;
  }
}
