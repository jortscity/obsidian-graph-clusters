import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import {
  SemanticClusterSettings,
  DEFAULT_SETTINGS,
  SemanticClusterSettingsTab,
} from "./settings";
import { EmbeddingManager, NoteEmbedding } from "./embeddings";
import {
  buildClusters,
  clusterCountHistogram,
  HistogramRow,
  tryOllamaClusterName,
} from "./clustering";
import { writeClusterNotes } from "./cluster-notes";
import { writeFolderNotes } from "./folder-notes";
import { ConfirmModal } from "./modal";

export default class SemanticClusterPlugin extends Plugin {
  settings: SemanticClusterSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SemanticClusterSettingsTab(this.app, this));

    this.addCommand({
      id: "re-embed-vault",
      name: "Re-embed vault (update cache only)",
      callback: () => this.reEmbedVault(),
    });

    this.addCommand({
      id: "regenerate-cluster-notes",
      name: "Regenerate cluster notes",
      callback: () => this.promptRegenerateClusters(),
    });

    this.addCommand({
      id: "regenerate-folder-notes",
      name: "Regenerate folder notes",
      callback: () => this.promptRegenerateFolderNotes(),
    });

    this.addCommand({
      id: "show-cluster-histogram",
      name: "Show cluster histogram",
      callback: () => this.showClusterHistogram(),
    });
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async ensurePluginFolders(): Promise<void> {
    const base = this.settings.pluginFolderName;
    for (const sub of ["", "/clusters", "/folder-notes"]) {
      const p = normalizePath(base + sub);
      if (!(await this.app.vault.adapter.exists(p))) {
        await this.app.vault.createFolder(p);
      }
    }
  }

  private async clearFolder(folderPath: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(
      normalizePath(folderPath)
    );
    if (!(folder instanceof TFolder)) return;
    const children = [...folder.children];
    for (const child of children) {
      if (child instanceof TFile) {
        await this.app.vault.delete(child);
      }
    }
  }

  private newEmbedManager(): EmbeddingManager {
    return new EmbeddingManager(this.app, this.settings, this.manifest.id);
  }

  // ── Histogram persistence ────────────────────────────────────────────────

  private histogramPath(): string {
    return normalizePath(
      `${this.app.vault.configDir}/plugins/${this.manifest.id}/histogram.json`
    );
  }

  async loadSavedHistogram(): Promise<{
    computedAt: number;
    method: "single" | "complete";
    rows: HistogramRow[];
  } | null> {
    try {
      const raw = await this.app.vault.adapter.read(this.histogramPath());
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.rows)) return null;
      // Older saves predate the method field; default to single-linkage since
      // that's what the old sweep always used.
      if (parsed.method !== "complete") parsed.method = "single";
      return parsed;
    } catch {
      return null;
    }
  }

  private async saveHistogram(
    rows: HistogramRow[],
    method: "single" | "complete"
  ): Promise<void> {
    await this.app.vault.adapter.write(
      this.histogramPath(),
      JSON.stringify({ computedAt: Date.now(), method, rows })
    );
  }

  // Computes the histogram from the given embeddings using the configured
  // clustering method and persists it. Called from any code path that has just
  // produced fresh embeddings — no point re-doing the O(n²) sim matrix when
  // the caller already has the vectors.
  private async refreshHistogram(
    embeddings: NoteEmbedding[]
  ): Promise<HistogramRow[]> {
    const method = this.settings.clusteringMethod;
    const rows = clusterCountHistogram(
      embeddings,
      SemanticClusterPlugin.HISTOGRAM_THRESHOLDS,
      method
    );
    await this.saveHistogram(rows, method);
    return rows;
  }

  // ── Public actions (also called from settings buttons) ───────────────────

  async reEmbedVault(): Promise<void> {
    try {
      const embedManager = this.newEmbedManager();
      if (this.settings.embeddingBackend === "ollama") {
        await embedManager.checkOllamaReachable();
      }
      new Notice("Semantic Cluster: Re-embedding all notes…");
      const embeddings = await embedManager.embedAllNotes(true);
      await this.refreshHistogram(embeddings);
      new Notice(
        `Semantic Cluster: Re-embedding complete. ${embeddings.length} notes embedded.`
      );
    } catch (e) {
      new Notice(`Semantic Cluster: Error — ${(e as Error).message}`);
      console.error("[SemanticCluster] Re-embed failed:", e);
    }
  }

  promptRegenerateClusters(): void {
    const folder = `${this.settings.pluginFolderName}/clusters`;
    new ConfirmModal(
      this.app,
      `This will delete and recreate all cluster notes in "${folder}". This cannot be undone. Continue?`,
      () => this.regenerateClusters()
    ).open();
  }

  async regenerateClusters(): Promise<void> {
    try {
      const embedManager = this.newEmbedManager();
      if (this.settings.embeddingBackend === "ollama") {
        await embedManager.checkOllamaReachable();
      }

      await this.ensurePluginFolders();
      await this.clearFolder(`${this.settings.pluginFolderName}/clusters`);

      new Notice("Semantic Cluster: Embedding notes…");
      const embeddings = await embedManager.embedAllNotes(false);
      await this.refreshHistogram(embeddings);

      new Notice("Semantic Cluster: Clustering…");
      const clusters = buildClusters(
        embeddings,
        this.settings.similarityThreshold,
        this.settings.clusteringMethod
      );

      if (
        this.settings.embeddingBackend === "ollama" &&
        this.settings.ollamaClusterNaming
      ) {
        for (const cluster of clusters) {
          const name = await tryOllamaClusterName(
            cluster.members,
            this.settings.ollamaEndpoint
          );
          if (name) cluster.name = name;
        }
      }

      await writeClusterNotes(this.app, this.settings, clusters);
      new Notice(
        `Semantic Cluster: ${clusters.length} cluster notes written.`
      );
    } catch (e) {
      new Notice(`Semantic Cluster: Error — ${(e as Error).message}`);
      console.error("[SemanticCluster] Cluster regen failed:", e);
    }
  }

  promptRegenerateFolderNotes(): void {
    const folder = `${this.settings.pluginFolderName}/folder-notes`;
    new ConfirmModal(
      this.app,
      `This will delete and recreate all folder notes in "${folder}". This cannot be undone. Continue?`,
      () => this.regenerateFolderNotes()
    ).open();
  }

  async regenerateFolderNotes(): Promise<void> {
    try {
      await this.ensurePluginFolders();
      await this.clearFolder(`${this.settings.pluginFolderName}/folder-notes`);
      new Notice("Semantic Cluster: Writing folder notes…");
      const count = await writeFolderNotes(this.app, this.settings);
      new Notice(`Semantic Cluster: ${count} folder notes written.`);
    } catch (e) {
      new Notice(`Semantic Cluster: Error — ${(e as Error).message}`);
      console.error("[SemanticCluster] Folder-note regen failed:", e);
    }
  }

  // ── Histogram ────────────────────────────────────────────────────────────

  // Sweep the full 0.00 .. 1.00 range (matches the similarity slider) in 0.05
  // steps. Single-linkage, since the histogram is meant as a quick
  // "where does the knee live?" view; complete-linkage at many thresholds is
  // too slow on large vaults. The 21 rows fit comfortably in the settings UI.
  static HISTOGRAM_THRESHOLDS: number[] = Array.from(
    { length: 21 },
    (_, i) => Math.round(i * 5) / 100
  );

  async computeHistogram(): Promise<HistogramRow[]> {
    const embedManager = this.newEmbedManager();
    if (this.settings.embeddingBackend === "ollama") {
      await embedManager.checkOllamaReachable();
    }
    const embeddings: NoteEmbedding[] = await embedManager.embedAllNotes(false);
    return this.refreshHistogram(embeddings);
  }

  private async showClusterHistogram(): Promise<void> {
    try {
      new Notice("Semantic Cluster: Computing histogram…");
      const rows = await this.computeHistogram();
      const lines = rows.map(
        (r) =>
          `  ${r.threshold.toFixed(2)}  clusters=${r.clusters}  largest=${r.largest}  covered=${r.covered}`
      );
      new Notice(
        `Semantic Cluster: Histogram (single-linkage):\n${lines.join("\n")}`,
        20000
      );
      console.log("[SemanticCluster] Histogram:", rows);
    } catch (e) {
      new Notice(`Semantic Cluster: Error — ${(e as Error).message}`);
      console.error("[SemanticCluster] Histogram failed:", e);
    }
  }
}
