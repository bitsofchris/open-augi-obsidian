import { Plugin, TFile, Notice, PluginSettingTab, App, Setting } from 'obsidian';

interface TranscriptParserSettings {
  apiKey: string;
}

const DEFAULT_SETTINGS: TranscriptParserSettings = {
  apiKey: ''
};

export default class TranscriptParserPlugin extends Plugin {
  settings: TranscriptParserSettings;

  async onload() {
    await this.loadSettings();
    
    // Ensure output directories exist
    await this.ensureDirectoriesExist();
    
    this.watchFolder("transcripts");
    
    // Add a command to manually parse a transcript file
    this.addCommand({
      id: 'parse-transcript',
      name: 'Parse Transcript',
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
          try {
            const content = await this.app.vault.read(activeFile);
            await this.parseAndOutput(activeFile.basename, content);
            new Notice(`Successfully parsed transcript: ${activeFile.basename}`);
          } catch (error) {
            console.error('Failed to parse transcript:', error);
            new Notice('Failed to parse transcript. Check console for details.');
          }
        } else {
          new Notice('Please open a markdown transcript file first');
        }
      }
    });

    // Add settings tab
    this.addSettingTab(new TranscriptParserSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async ensureDirectoriesExist() {
    const dirs = [
      "Parsed_Notes",
      "Parsed_Notes/summaries",
      "Parsed_Notes/notes"
    ];
    
    for (const dir of dirs) {
      const exists = await this.app.vault.adapter.exists(dir);
      if (!exists) {
        await this.app.vault.createFolder(dir);
      }
    }
  }

  watchFolder(folderPath: string) {
    this.registerEvent(this.app.vault.on('create', async (file: TFile) => {
      if (file.path.startsWith(folderPath)) {
        const content = await this.app.vault.read(file);
        await this.parseAndOutput(file.basename, content);
      }
    }));
  }

  async parseAndOutput(filename: string, content: string) {
    // Ensure output directories exist
    await this.ensureDirectoriesExist();
    
    if (!this.settings.apiKey) {
      new Notice('Please set your OpenAI API key in the plugin settings');
      throw new Error('OpenAI API key not set');
    }
    
    const prompt = `You will receive a raw transcript from voice notes. Identify all commands that start with the special token "AUGI" and parse them clearly.

Example commands:
- "AUGI create note titled XYZ" → Create a new note with title XYZ.
- "AUGI summarize this" → Summarize preceding context.
- "AUGI add task ABC" → Create a new task item.

Return strictly JSON:
{
  "summary": "Short summary (ignoring commands)",
  "notes": [{"title": "Note Title", "content": "Content"}],
  "tasks": ["task 1", "task 2"]
}

Transcript:\n${content}`;

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.settings.apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4-turbo',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`OpenAI API error: ${response.status} ${errorData.error?.message || response.statusText}`);
      }

      const responseData = await response.json();
      const messageContent = responseData.choices[0].message.content;
      
      if (!messageContent) {
        throw new Error('No response content received from OpenAI');
      }
      
      // Clean up the response content in case it contains markdown formatting
      let cleanedContent = messageContent;
      
      // Remove markdown code blocks if present (```json or just ```)
      const codeBlockMatch = cleanedContent.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        cleanedContent = codeBlockMatch[1].trim();
      }
      
      // Parse the JSON
      let structuredData;
      try {
        structuredData = JSON.parse(cleanedContent);
      } catch (parseError) {
        console.error('Failed to parse JSON response:', cleanedContent);
        throw new Error(`Failed to parse JSON response: ${parseError.message}`);
      }

      // Output Summary
      await this.app.vault.create(`Parsed_Notes/summaries/${filename}_summary.md`, structuredData.summary);

      // Output Notes
      for (const note of structuredData.notes) {
        await this.app.vault.create(`Parsed_Notes/notes/${note.title}.md`, note.content);
      }

      // Append Tasks
      const tasksFile = this.app.vault.getAbstractFileByPath("Parsed_Notes/tasks.md");
      if (tasksFile instanceof TFile) {
        let existingTasks = await this.app.vault.read(tasksFile);
        existingTasks += '\n' + structuredData.tasks.map((task: string) => `- [ ] ${task}`).join('\n');
        await this.app.vault.modify(tasksFile, existingTasks);
      } else {
        await this.app.vault.create("Parsed_Notes/tasks.md", structuredData.tasks.map((task: string) => `- [ ] ${task}`).join('\n'));
      }
    } catch (error) {
      console.error('Error calling OpenAI API:', error);
      throw error;
    }
  }
}

class TranscriptParserSettingTab extends PluginSettingTab {
  plugin: TranscriptParserPlugin;

  constructor(app: App, plugin: TranscriptParserPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const {containerEl} = this;

    containerEl.empty();

    containerEl.createEl('h2', {text: 'OpenAugi Settings'});

    new Setting(containerEl)
      .setName('OpenAI API Key')
      .setDesc('Your OpenAI API key')
      .addText(text => text
        .setPlaceholder('sk-...')
        .setValue(this.plugin.settings.apiKey)
        .onChange(async (value) => {
          this.plugin.settings.apiKey = value;
          await this.plugin.saveSettings();
        })
      );
  }
}