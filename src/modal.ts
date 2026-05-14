import { App, Modal } from "obsidian";

export class ConfirmModal extends Modal {
  private message: string;
  private onConfirm: () => void;

  constructor(app: App, message: string, onConfirm: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message });

    const row = contentEl.createDiv({ cls: "modal-button-container" });

    row
      .createEl("button", { text: "Cancel", cls: "mod-cancel" })
      .addEventListener("click", () => this.close());

    row
      .createEl("button", { text: "Continue", cls: "mod-cta" })
      .addEventListener("click", () => {
        this.close();
        this.onConfirm();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
