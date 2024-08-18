import { App, Notice, PluginSettingTab, Setting, DropdownComponent, requestUrl, Modal } from "obsidian";
import { DEFAULT_SETTINGS } from "data/defaultSettings";
import { OllamaCommand } from "model/OllamaCommand";
import { Ollama } from "Ollama";

export class OllamaSettingTab extends PluginSettingTab {
  plugin: Ollama;

  constructor(app: App, plugin: Ollama) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("Ollama URL")
      .setDesc("URL of the Ollama server (e.g. http://localhost:11434)")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(this.plugin.settings?.ollamaUrl)
          .onChange(async (value) => {
            this.plugin.settings.ollamaUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default Model")
      .setDesc("Set the default Ollama model to use for completions")
      .addDropdown(async (dropdown: DropdownComponent) => {
        dropdown.addOption(this.plugin.settings?.defaultModel, this.plugin.settings?.defaultModel);
        dropdown.onChange(async (value: string) => {
          this.plugin.settings.defaultModel = value;
          await this.plugin.saveSettings();
        });

        await this.fetchAndPopulateModels(dropdown);
      });

    const setting = new Setting(this.containerEl)
      .setName("Refresh Models")
      .setDesc("Refresh the list of available Ollama models")
      .addButton((button) => {
        button.setButtonText("Refresh");
        button.onClick(async () => {
          const buttonEl = this.containerEl.querySelector('.setting-item-control button') as HTMLButtonElement;
          if (buttonEl) {
            buttonEl.disabled = true;
          }

          const selectEl = setting.controlEl.querySelector('select');
          const dropdownComponent = (selectEl as any).obsidianComponent as DropdownComponent;

          if (dropdownComponent) {
            new Notice("Model list refreshing...");
            await this.fetchAndPopulateModels(dropdownComponent);
          } else {
            new Notice("Dropdown not found. Please try again.");
          }

          if (buttonEl) {
            buttonEl.disabled = false;
          }
        });
      });

    containerEl.createEl("h3", { text: "Commands" });

    const newCommand: OllamaCommand = {
      name: "",
      prompt: "",
      model: this.plugin.settings?.defaultModel || "",
      temperature: undefined,
    };

    new Setting(containerEl).setName("New command name").addText((text) => {
      text.setPlaceholder("e.g. Summarize selection");
      text.onChange(async (value) => {
        newCommand.name = value;
      });
    });

    new Setting(containerEl)
      .setName("New command prompt")
      .addTextArea((text) => {
        text.setPlaceholder(
          "e.g. Act as a writer. Summarize the text in a view sentences highlighting the key takeaways. Output only the text and nothing else, do not chat, no preamble, get to the point."
        );
        text.onChange(async (value) => {
          newCommand.prompt = value;
        });
      });

    // New command model setting with dropdown and "Default" option
    new Setting(containerEl)
      .setName("New command model")
      .setDesc("Select the Ollama model to use for this command. Choose 'Default' to use the default model.")
      .addDropdown(async (dropdown: DropdownComponent) => {
        // Add "Default" option first
        dropdown.addOption("Default", "Default");

        // Fetch and populate the rest of the models
        await this.fetchAndPopulateModels(dropdown);

        // Ensure "Default" is selected initially if newCommand.model is undefined
        if (!newCommand.model) {
          dropdown.setValue("Default");
        } else {
          // Type assertion to ensure newCommand.model is a string
          dropdown.setValue(newCommand.model as string);
        }

        dropdown.onChange(async (value: string) => {
          if (value === "Default") {
            delete newCommand.model;
          } else {
            newCommand.model = value;
          }
        });
      });

    new Setting(containerEl)
      .setName("New command temperature")
      .addSlider((slider) => {
        slider.setLimits(0, 1, 0.01);
        slider.setValue(0.2);
        slider.onChange(async (value) => {
          newCommand.temperature = value;
        });
      });

    new Setting(containerEl)
      .setDesc("This requires a reload of obsidian to take effect.")
      .addButton((button) =>
        button.setButtonText("Add Command").onClick(async () => {
          if (!newCommand.name) {
            new Notice("Please enter a name for the command.");
            return;
          }

          if (
            this.plugin.settings?.commands.find(
              (command) => command.name === newCommand.name
            )
          ) {
            new Notice(
              `A command with the name "${newCommand.name}" already exists.`
            );
            return;
          }

          if (!newCommand.prompt) {
            new Notice("Please enter a prompt for the command.");
            return;
          }

          // Check if a model is selected or default is used
          if (!newCommand.model && !this.plugin.settings?.defaultModel) {
            new Notice("Please select a model or set a default model.");
            return;
          }

          this.plugin.settings.commands.push(newCommand);
          await this.plugin.saveSettings();
          this.display();
        })
      );

    containerEl.createEl("h4", { text: "Existing Commands" });

    this.plugin.settings?.commands.forEach(async (command: OllamaCommand) => {
      new Setting(containerEl)
        .setName(command.name)
        .setDesc(`${command.prompt} - ${command.model || "Default"}`)
        .addButton((button) =>
          button
            .setButtonText("Remove")
            .onClick(async () => {
              this.plugin.settings.commands = this.plugin.settings?.commands.filter(
                (c: OllamaCommand) => c.name !== command.name
              );
              await this.plugin.saveSettings();
              this.display();
            })
        )
        .addButton((button) =>
          button
            .setButtonText("Meta-Bind Button")
            .onClick(async () => {
              const commandName = command.name.toLowerCase().replace(/\s+/g, '-');
              const buttonCode = `\`BUTTON[${commandName}]\`\n\`\`\`meta-bind-button
label: "${command.name}"
icon: ""
hidden: true
class: ""
tooltip: ""
id: "${commandName}"
style: default

actions:
 - type: command
   command: ollama:${commandName}
\`\`\`
`;
              navigator.clipboard.writeText(buttonCode).then(() => {
                new Notice("Button code copied to clipboard!");
              });
            })
        )
        // Add the new "Edit" button
        .addButton((button) =>
          button
            .setButtonText("Edit")
            .onClick(async () => {
              this.openEditCommandModal(command); // Open the edit modal
            })
        );
    });

    containerEl.createEl("h4", { text: "Reset Commands" });

    new Setting(containerEl)
      .setName("Update Commands")
      .setDesc(
        "Update commands to the default commands. This cannot be undone and will overwrite some commands by matching names. This requires a reload of obsidian to take effect."
      )
      .addButton((button) => {
        button.setWarning();
        return button.setButtonText("Update").onClick(async () => {
          DEFAULT_SETTINGS.commands.forEach((command) => {
            const existingCommand = this.plugin.settings?.commands.find(
              (c) => c.name === command.name
            );

            if (existingCommand) {
              existingCommand.prompt = command.prompt;
              existingCommand.model = command.model;
              existingCommand.temperature = command.temperature;
            } else {
              this.plugin.settings?.commands.push(command);
            }
          });
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Reset Commands")
      .setDesc(
        "Reset all commands to the default commands. This cannot be undone and will delete all your custom commands. This requires a reload of obsidian to take effect."
      )
      .addButton((button) => {
        button.setWarning();
        return button.setButtonText("Reset").onClick(async () => {
          this.plugin.settings.commands = DEFAULT_SETTINGS.commands;
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }

  public async fetchAndPopulateModels(dropdown: DropdownComponent) { 
    try {
      const response = await requestUrl({
        url: `${this.plugin.settings?.ollamaUrl}/api/tags`,
        method: 'GET',
      });

      if (!response || response.status < 200 || response.status >= 300) {
        throw new Error(`Failed to fetch models. Status: ${response.status}`);
      }

      const data = JSON.parse(await response.text) as { models: { name: string }[] };
      const models = data.models;

      if (Array.isArray(models)) {
        if (dropdown.selectEl) {
          dropdown.selectEl.innerHTML = '';

          // Add "Default" option to the beginning of the models array
          models.unshift({ name: "Default" });

          const optgroup = document.createElement('optgroup');
          optgroup.label = 'Ollama Models';

          for (const modelObj of models) {
            const option = document.createElement('option');
            option.value = modelObj.name;
            option.text = modelObj.name;
            optgroup.appendChild(option);
          }

          dropdown.selectEl.appendChild(optgroup);
          new Notice("Models refreshed successfully!");
        }
      } else {
        console.error("Unexpected response from Ollama server:", models);
        new Notice("Failed to refresh models. Unexpected server response.");
      }

    } catch (error) {
      console.error("Error fetching models:", error);
      new Notice("Failed to refresh models. Please check your Ollama URL and try again.");
    }
  }

  private openEditCommandModal(command: OllamaCommand) {
    new EditCommandModal(this.app, this.plugin, command, this, async (updatedCommand) => {
      const commandIndex = this.plugin.settings.commands.findIndex(c => c.name === command.name);

      if (commandIndex !== -1) {
        this.plugin.settings.commands[commandIndex] = updatedCommand;
        await this.plugin.saveSettings();
        this.display(); 
      }
    }).open();
  }
}

class EditCommandModal extends Modal {
  command: OllamaCommand;
  onSave: (updatedCommand: OllamaCommand) => void;
  settingsTab: OllamaSettingTab;

  constructor(app: App, plugin: Ollama, command: OllamaCommand, settingsTab: OllamaSettingTab, onSave: (updatedCommand: OllamaCommand) => void) {
    super(app);
    this.command = command;
    this.onSave = onSave;
    this.settingsTab = settingsTab;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: `Edit Command: ${this.command.name}` });

    new Setting(contentEl)
      .setName("Prompt")
      .addTextArea((text) => {
        text.setValue(this.command.prompt);
        text.onChange(async (value) => { this.command.prompt = value; });
      });

    new Setting(contentEl)
      .setName("Model")
      .setDesc("Select the Ollama model or 'Default'")
      .addDropdown(async (dropdown: DropdownComponent) => {
        dropdown.addOption("Default", "Default");
        await this.settingsTab.fetchAndPopulateModels(dropdown);

        dropdown.setValue(this.command.model || "Default");
        dropdown.onChange(async (value: string) => {
          if (value === "Default") { delete this.command.model; } 
          else { this.command.model = value; }
        });
      });

    new Setting(contentEl)
      .setName("Temperature")
      .addSlider((slider) => {
        slider.setLimits(0, 1, 0.01);
        slider.setValue(this.command.temperature || 0.2); 
        slider.onChange(async (value) => { this.command.temperature = value; });
      });

    new Setting(contentEl)
      .addButton((btn) => 
        btn.setButtonText("Save")
          .setCta()
          .onClick(async () => { 
            this.onSave(this.command);
            this.close();
          })
      );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
