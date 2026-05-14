import { App, PluginSettingTab, Setting } from "obsidian";
import type SemanticClusterPlugin from "./main";

export interface SemanticClusterSettings {
  pluginFolderName: string;
  embeddingBackend: "transformers" | "ollama";
  ollamaEndpoint: string;
  ollamaModel: string;
  similarityThreshold: number;
  // "single" can chain loosely-related notes through intermediaries; "complete"
  // requires every pair in a cluster to meet the threshold (tighter, no chaining).
  clusteringMethod: "single" | "complete";
  generateRootNote: boolean;
  // Gate the per-cluster Ollama chat call behind an explicit opt-in. On large
  // vaults this is one HTTP round-trip per cluster and will noticeably slow
  // regeneration if left on by default.
  ollamaClusterNaming: boolean;
}

export const DEFAULT_SETTINGS: SemanticClusterSettings = {
  pluginFolderName: "_semantic",
  embeddingBackend: "transformers",
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "nomic-embed-text",
  similarityThreshold: 0.8,
  clusteringMethod: "single",
  generateRootNote: false,
  ollamaClusterNaming: false,
};

export class SemanticClusterSettingsTab extends PluginSettingTab {
  plugin: SemanticClusterPlugin;

  constructor(app: App, plugin: SemanticClusterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Semantic Cluster Plugin" });

    new Setting(containerEl)
      .setName("Plugin folder name")
      .setDesc(
        "Root folder for all generated content. All cluster and folder notes live here."
      )
      .addText((text) =>
        text
          .setPlaceholder("_semantic")
          .setValue(this.plugin.settings.pluginFolderName)
          .onChange(async (value) => {
            this.plugin.settings.pluginFolderName = value.trim() || "_semantic";
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Embedding" });

    new Setting(containerEl)
      .setName("Embedding backend")
      .setDesc(
        "Transformers.js runs fully locally (no setup, downloads model on first use). Ollama requires a running local server."
      )
      .addDropdown((drop) =>
        drop
          .addOption("transformers", "Transformers.js (local, no setup)")
          .addOption("ollama", "Ollama (local HTTP API)")
          .setValue(this.plugin.settings.embeddingBackend)
          .onChange(async (value: string) => {
            this.plugin.settings.embeddingBackend = value as
              | "transformers"
              | "ollama";
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.embeddingBackend === "ollama") {
      new Setting(containerEl)
        .setName("Ollama endpoint")
        .setDesc("Base URL of your Ollama HTTP API")
        .addText((text) =>
          text
            .setPlaceholder("http://localhost:11434")
            .setValue(this.plugin.settings.ollamaEndpoint)
            .onChange(async (value) => {
              this.plugin.settings.ollamaEndpoint = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Ollama embedding model")
        .setDesc("Model to use for generating embeddings")
        .addText((text) =>
          text
            .setPlaceholder("nomic-embed-text")
            .setValue(this.plugin.settings.ollamaModel)
            .onChange(async (value) => {
              this.plugin.settings.ollamaModel = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Ollama cluster naming")
        .setDesc(
          "Use a chat-capable Ollama model to generate topic labels for each cluster. " +
            "Adds one HTTP call per cluster — disable on large vaults or when Ollama is slow."
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.ollamaClusterNaming)
            .onChange(async (value) => {
              this.plugin.settings.ollamaClusterNaming = value;
              await this.plugin.saveSettings();
            })
        );
    }

    containerEl.createEl("h3", { text: "Clustering" });

    new Setting(containerEl)
      .setName("Similarity threshold")
      .setDesc("Cosine similarity cutoff for cluster membership (0 – 1)")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.01)
          .setValue(this.plugin.settings.similarityThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.similarityThreshold = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Clustering method")
      .setDesc(
        "Single-linkage merges clusters when any two notes are similar enough — " +
          "fast but can chain loosely-related notes. " +
          "Complete-linkage requires every pair in a cluster to meet the threshold: " +
          "tighter clusters, no chaining, but more (smaller) clusters at the same threshold."
      )
      .addDropdown((drop) =>
        drop
          .addOption("single", "Single-linkage (any pair)")
          .addOption("complete", "Complete-linkage (all pairs)")
          .setValue(this.plugin.settings.clusteringMethod)
          .onChange(async (value: string) => {
            this.plugin.settings.clusteringMethod = value as "single" | "complete";
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Folder notes" });

    new Setting(containerEl)
      .setName("Generate root vault note")
      .setDesc(
        "Write _root.md in folder-notes/ linking to all top-level folders and notes"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.generateRootNote)
          .onChange(async (value) => {
            this.plugin.settings.generateRootNote = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
