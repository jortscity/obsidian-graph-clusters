import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import {
  SemanticClusterSettings,
  DEFAULT_SETTINGS,
  SemanticClusterSettingsTab,
} from "./settings";
import { EmbeddingManager } from "./embeddings";
import { buildClusters, tryOllamaClusterName } from "./clustering";
import { writeClusterNotes } from "./cluster-notes";
import { writeFolderNotes } from "./folder-notes";
import { ConfirmModal } from "./modal";

export default class SemanticClusterPlugin extends Plugin {
  settings: SemanticClusterSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SemanticClusterSettingsTab(this.app, this));

    this.addCommand({
      id: "regenerate-everything",
      name: "Regenerate everything",
      callback: () => this.promptRegenerate(),
    });

    this.addCommand({
      id: "re-embed-vault",
      name: "Re-embed vault (update cache only)",
      callback: () => this.reEmbedVault(),
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

  // ── Commands ─────────────────────────────────────────────────────────────

  private promptRegenerate(): void {
    const folder = this.settings.pluginFolderName;
    new ConfirmModal(
      this.app,
      `This will delete and recreate all cluster notes and folder notes in "${folder}". This cannot be undone. Continue?`,
      () => this.runRegenerate()
    ).open();
  }

  private async runRegenerate(): Promise<void> {
    try {
      const embedManager = new EmbeddingManager(
        this.app,
        this.settings,
        this.manifest.id
      );

      if (this.settings.embeddingBackend === "ollama") {
        await embedManager.checkOllamaReachable();
      }

      await this.ensurePluginFolders();

      const base = this.settings.pluginFolderName;
      await this.clearFolder(`${base}/clusters`);
      await this.clearFolder(`${base}/folder-notes`);

      new Notice("Semantic Cluster: Embedding notes…");
      const embeddings = await embedManager.embedAllNotes(false);

      new Notice("Semantic Cluster: Clustering…");
      const clusters = buildClusters(
        embeddings,
        this.settings.similarityThreshold,
        this.settings.clusteringMethod
      );

      // Optional per-cluster Ollama naming — gated behind the setting because
      // it adds one HTTP call per cluster and is noticeable on large vaults.
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
      const folderNoteCount = await writeFolderNotes(this.app, this.settings);

      new Notice(
        `Semantic Cluster: Regeneration complete. ${clusters.length} clusters, ${folderNoteCount} folder notes.`
      );
    } catch (e) {
      new Notice(`Semantic Cluster: Error — ${(e as Error).message}`);
      console.error("[SemanticCluster] Regeneration failed:", e);
    }
  }

  private async reEmbedVault(): Promise<void> {
    try {
      const embedManager = new EmbeddingManager(
        this.app,
        this.settings,
        this.manifest.id
      );

      if (this.settings.embeddingBackend === "ollama") {
        await embedManager.checkOllamaReachable();
      }

      new Notice("Semantic Cluster: Re-embedding all notes…");
      const embeddings = await embedManager.embedAllNotes(true);
      new Notice(
        `Semantic Cluster: Re-embedding complete. ${embeddings.length} notes embedded.`
      );
    } catch (e) {
      new Notice(`Semantic Cluster: Error — ${(e as Error).message}`);
      console.error("[SemanticCluster] Re-embed failed:", e);
    }
  }
}
