const { Plugin, Notice, SuggestModal } = require("obsidian");

class MentionSuggestModal extends SuggestModal {
    constructor(app, mentions, onChoose) {
        super(app);
        this.mentions = mentions;
        this.onChoose = onChoose;
    }

    getSuggestions(query) {
        return this.mentions.filter(m => m[0].toLowerCase().includes(query.toLowerCase()));
    }

    renderSuggestion(mention, el) {
        el.createEl("div", { text: mention[0] });
    }

    onChooseSuggestion(mention) {
        this.onChoose(mention[0]);
    }
}

class AutoLinkUpdater extends Plugin {
    async onload() {
        console.log("✅ Auto Linker Plugin Loaded");

        // Command: Update links
        this.addCommand({
            id: "update-links",
            name: "Update links in active note",
            callback: async () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    await this.updateLinks(activeFile);
                } else {
                    new Notice("❌ No active file open.");
                }
            },
        });

        // Command: Remove duplicate links
        this.addCommand({
            id: "remove-duplicate-links",
            name: "Remove duplicate links in active note",
            callback: async () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    await this.removeDuplicateLinks(activeFile);
                } else {
                    new Notice("❌ No active file open.");
                }
            },
        });

        // Command: Run both commands in sequence
        this.addCommand({
            id: "update-and-clean-links",
            name: "Update and clean links in active note",
            callback: async () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    await this.updateLinks(activeFile);
                    await this.removeDuplicateLinks(activeFile);
                    new Notice("✅ Links updated and cleaned in: " + activeFile.name);
                    console.log("🔗 Links updated and cleaned in:", activeFile.name);
                } else {
                    new Notice("❌ No active file open.");
                }
            },
        });

        // Command: Find and link unlinked mentions
        this.addCommand({
            id: "find-unlinked-mentions",
            name: "Find and link unlinked mentions",
            callback: async () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    await this.findUnlinkedMentions(activeFile);
                } else {
                    new Notice("❌ No active file open.");
                }
            },
        });

        console.log("✅ Commands Registered: Update Links, Remove Duplicate Links, Update & Clean Links");
    }
    async findUnlinkedMentions(file) {
        if (!file || !file.path.endsWith(".md")) return;

        let content = await this.app.vault.read(file);
        const allFiles = this.app.vault.getMarkdownFiles();
        let unlinkedMentions = new Map();
        let fileName = file.basename; // Avoid self-links

        let existingLinks = new Set();

        // 🔹 Extract and ignore YAML frontmatter (everything between --- and ---)
        let yamlMatch = content.match(/^---\s*[\s\S]*?---/);
        let yamlSection = yamlMatch ? yamlMatch[0] : "";
        let contentWithoutYaml = yamlMatch ? content.replace(yamlSection, "") : content;

        // 🔹 Collect all already linked notes & aliases in the file
        const linkRegex = /\[\[([^\]|#]+)(?:#([^\]]+))?(?:\|([^\]]+))?\]\]/g;
        let match;
        while ((match = linkRegex.exec(contentWithoutYaml)) !== null) {
            let linkedNote = match[1].trim();
            let alias = match[3] ? match[3].trim() : linkedNote;
            existingLinks.add(linkedNote.toLowerCase());
            existingLinks.add(alias.toLowerCase());
        }

        allFiles.forEach(noteFile => {
            let note = noteFile.basename;
            if (note === fileName) return; // Skip self-links

            let noteAliases = new Set([note]);

            // 🔹 Extract aliases from each file's frontmatter (if available)
            let metadata = this.app.metadataCache.getCache(noteFile.path);
            if (metadata?.frontmatter?.aliases && Array.isArray(metadata.frontmatter.aliases)) {
                metadata.frontmatter.aliases.forEach(alias => noteAliases.add(alias));
            }

            noteAliases.forEach(alias => {
                if (!alias || existingLinks.has(alias.toLowerCase()) || existingLinks.has(note.toLowerCase())) return; // 🔹 Skip already linked mentions

                let escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // Escape special characters
                const regex = new RegExp(`(?<!\\[\\[)\\b${escapedAlias}\\b(?!\\]\\])`, "gi");
                let match;
                while ((match = regex.exec(contentWithoutYaml.toLowerCase())) !== null) {
                    if (!unlinkedMentions.has(alias)) {
                        unlinkedMentions.set(alias, { note, index: match.index });
                    }
                }
            });
        });

        if (unlinkedMentions.size === 0) {
            new Notice("ℹ️ No unlinked mentions found.");
            return;
        }

        let mentionsArray = Array.from(unlinkedMentions.entries()).sort((a, b) => a[1].index - b[1].index);
        this.showMentionSelector(file, content, mentionsArray);
    }



    async showMentionSelector(file, content, mentionsArray) {
        let modal = new MentionSuggestModal(this.app, mentionsArray, async (selectedMention) => {
            await this.convertMentionToLink(file, content, selectedMention);
        });
        modal.open();
    }

    async convertMentionToLink(file, content, mention) {
        let allFiles = this.app.vault.getMarkdownFiles();
        let targetNote = null;
        let aliasToUse = mention;

        // 🔹 Find the correct note that corresponds to the alias
        for (let noteFile of allFiles) {
            let note = noteFile.basename;
            let metadata = this.app.metadataCache.getCache(noteFile.path);

            if (note.toLowerCase() === mention.toLowerCase()) {
                targetNote = note;
                break; // Direct match found
            }

            if (Array.isArray(metadata?.frontmatter?.aliases) &&
                metadata.frontmatter.aliases.some(a => typeof a === "string" && a.toLowerCase() === mention.toLowerCase())) {
                targetNote = note;
                break; // Stop checking once a match is found
            }

        }

        if (!targetNote) {
            new Notice(`❌ No matching note found for "${mention}"`);
            return;
        }

        // 🔹 Extract YAML section (if present) and separate the content
        let yamlMatch = content.match(/^---\s*[\s\S]*?---/);
        let yamlSection = yamlMatch ? yamlMatch[0] : "";
        let contentWithoutYaml = yamlMatch ? content.replace(yamlSection, "") : content;

        // 🔹 Replace the first occurrence of the mention **AFTER** the YAML
        let aliasPart = targetNote !== mention ? `|${mention}` : "";
        const regex = new RegExp(`(?<!\\[\\[)\\b${mention}\\b(?!\\]\\])`, "i"); // Remove "g" to replace only the first match
        let updatedContentWithoutYaml = contentWithoutYaml.replace(regex, `[[${targetNote}${aliasPart}]]`);

        // 🔹 Reconstruct the full note (YAML + modified content)
        let updatedContent = yamlSection + updatedContentWithoutYaml;

        await this.app.vault.modify(file, updatedContent);
        new Notice(`✅ Linked mention: [[${targetNote}${aliasPart}]]`);
        console.log(`🔗 Linked mention: [[${targetNote}${aliasPart}]]`);
    }



    async updateLinks(file) {
        if (!file || !file.path.endsWith(".md")) return;

        let content = await this.app.vault.read(file);

        // Ensure "links:" exists, replacing only the links, not the label
        if (content.match(/^links:.*$/m)) {
            content = content.replace(/^links:.*$/m, "links:");
        } else {
            content = `links:\n\n${content.trim()}`;
        }

        const linkRegex = /\[\[([^\]|#]+)(?:#([^\]]+))?(?:\|([^\]]+))?\]\]/g;
        let match;
        let links = new Set();

        while ((match = linkRegex.exec(content)) !== null) {
            let fullLink = match[1];
            let section = match[2] ? `#${match[2]}` : "";
            let alias = match[3] ? `|${match[3]}` : "";
            links.add(`[[${fullLink}${section}${alias}]]`);
        }

        if (links.size === 0) {
            new Notice("ℹ️ No links found in the note.");
            return;
        }

        // Append the new links to the "links:" line
        let formattedLinks = `links: ${[...links].join(", ")}`;
        content = content.replace(/^links:.*$/m, formattedLinks);

        await this.app.vault.modify(file, content);
        new Notice("✅ Links updated in: " + file.name);
        console.log("🔗 Links updated in:", file.name);
    }

    async removeDuplicateLinks(file) {
        if (!file || !file.path.endsWith(".md")) return;

        let content = await this.app.vault.read(file);
        let lines = content.split("\n");

        let insideContent = false; // Used to ignore `links:` at the top
        let seenLinks = new Set();

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            if (insideContent) {
                // Replace duplicate links with normal text, but keep aliases
                lines[i] = line.replace(/\[\[([^\]|#]+)(?:#([^\]]+))?(?:\|([^\]]+))?\]\]/g, (match, link, section, alias) => {
                    let uniqueLink = section ? `${link}#${section}` : link;

                    // Ignore links that start with '!'
                    if (match.startsWith("!")) return match;

                    if (seenLinks.has(uniqueLink)) {
                        return alias ? alias : link; // Keep alias if present, otherwise just the file name
                    } else {
                        seenLinks.add(uniqueLink);
                        return match; // Keep as a link
                    }
                });
            }

            // Detect when we're past the `links:` section
            if (line.startsWith("links:")) {
                insideContent = true;
            }
        }

        let updatedContent = lines.join("\n");

        if (updatedContent !== content) {
            await this.app.vault.modify(file, updatedContent);
            new Notice("✅ Duplicate links removed in: " + file.name);
            console.log("🔗 Duplicate links removed in:", file.name);
        } else {
            new Notice("ℹ️ No duplicate links found.");
        }
    }

    onunload() {
        console.log("❌ Auto Linker Plugin Unloaded");
    }
}

module.exports = AutoLinkUpdater;
