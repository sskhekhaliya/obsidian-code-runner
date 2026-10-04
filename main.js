"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => CodeRunnerPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_child_process = require("child_process");
var import_fs = require("fs");
var import_os = require("os");
var import_path = require("path");
var VIEW_TYPE_CODE_RUNNER = "obsidian-code-runner";
var DEFAULT_TIMEOUT_MS = 1e4;
var AUTHOR_URL = "https://www.sskhekhaliya.in/";
var CodeRunnerPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.data = { tests: {}, history: {} };
    this.clickedBlockLines = /* @__PURE__ */ new Map();
  }
  async onload() {
    this.data = Object.assign({ tests: {}, history: {} }, await this.loadData());
    this.registerView(VIEW_TYPE_CODE_RUNNER, (leaf) => new CodeRunnerView(leaf, this));
    this.registerView("obsidian-java-ide", (leaf) => new CodeRunnerView(leaf, this));
    this.addRibbonIcon("terminal-square", "Open Code Runner", () => void this.openIde());
    this.addCommand({ id: "open-code-runner", name: "Open Code Runner", callback: () => void this.openIde() });
    this.addCommand({ id: "run-active-code-block", name: "Run active code block", callback: () => void this.openIde(true) });
    this.addCommand({ id: "open-java-ide", name: "Open Code Runner (legacy)", callback: () => void this.openIde() });
    this.addCommand({ id: "run-active-java-block", name: "Run active code block (legacy)", callback: () => void this.openIde(true) });
    this.registerMarkdownPostProcessor((element, context) => {
      element.querySelectorAll("pre > code").forEach((code) => {
        if (!/language-(java|python|py|javascript|js)/i.test(code.className)) return;
        const section = context.getSectionInfo(code);
        if (!section) return;
        code.addEventListener("mousedown", () => this.clickedBlockLines.set(context.sourcePath, section.lineStart));
      });
    });
  }
  async openIde(run = false) {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODE_RUNNER)[0] ?? this.app.workspace.getLeavesOfType("obsidian-java-ide")[0] ?? this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_CODE_RUNNER, active: true });
    this.app.workspace.revealLeaf(leaf);
    if (run) await leaf.view.run();
  }
  async remember(path, result2) {
    const entries = this.data.history[path] ?? [];
    entries.unshift({ at: (/* @__PURE__ */ new Date()).toISOString(), ok: result2.ok, durationMs: result2.durationMs });
    this.data.history[path] = entries.slice(0, 20);
    await this.saveData(this.data);
  }
};
var CodeRunnerView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.stdin = "";
    this.output = "Select a note containing a supported fenced code block, then press Run.";
    this.status = "Ready";
    this.tests = [];
    this.selectedBlock = 0;
    this.sourceCount = 0;
    this.blockClickListening = false;
    this.lastRunResult = "";
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_CODE_RUNNER;
  }
  getDisplayText() {
    return "Code Runner";
  }
  getIcon() {
    return "terminal-square";
  }
  async onOpen() {
    this.registerEvent(this.app.workspace.on("file-open", () => {
      this.tests = [];
      void this.refreshBlocks(true);
    }));
    this.registerEvent(this.app.workspace.on("editor-change", () => this.queueSourceRefresh()));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.path === this.activeFile()?.path) this.queueSourceRefresh();
    }));
    if (!this.blockClickListening) {
      this.blockClickListening = true;
      this.registerDomEvent(document, "mouseup", (event) => void this.pickClickedBlock(event), { capture: true });
    }
    await this.refreshBlocks(true);
  }
  async onClose() {
    this.running?.kill();
    window.clearTimeout(this.refreshTimer);
  }
  activeFile() {
    return this.app.workspace.getActiveFile();
  }
  noteKey() {
    return `${this.activeFile()?.path ?? "__no_note__"}#block-${this.selectedBlock}`;
  }
  async getSources() {
    const file = this.activeFile();
    if (!file || file.extension !== "md") return [];
    const text = await this.app.vault.read(file);
    return Array.from(text.matchAll(/^(`{3,})[ \t]*(java|python|py|javascript|js)(?:[ \t]+[^\r\n]*)?[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/gim), (match, index) => {
      const declaredLanguage = match[2].toLowerCase();
      const language = declaredLanguage === "py" ? "python" : declaredLanguage === "js" ? "javascript" : declaredLanguage;
      const code = match[3].trim();
      const publicClass = /public\s+(?:final\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(code)?.[1];
      const anyClass = /(?:public\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(code)?.[1];
      const startLine = text.slice(0, match.index ?? 0).split(/\r?\n/).length - 1;
      const endLine = startLine + match[0].split(/\r?\n/).length - 1;
      const name = language === "java" ? `${publicClass ?? anyClass ?? `Main${index + 1}`}.java` : language === "python" ? `main-${index + 1}.py` : `main-${index + 1}.js`;
      return { code, name, language, index, startLine, endLine };
    });
  }
  selectedCursorBlock(sources) {
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    const line = view?.editor?.getCursor().line;
    if (line !== void 0) {
      const cursorSource = sources.find((block) => line >= block.startLine && line <= block.endLine);
      if (cursorSource) return cursorSource.index;
    }
    const clickedLine = this.plugin.clickedBlockLines.get(this.activeFile()?.path ?? "");
    if (clickedLine !== void 0) {
      const clickedSource = sources.find((block) => clickedLine >= block.startLine && clickedLine <= block.endLine);
      if (clickedSource) return clickedSource.index;
    }
    const selectedText = window.getSelection()?.toString().trim();
    if (selectedText) {
      const normalized = selectedText.replace(/\r\n/g, "\n");
      const selectedSource = sources.find((block) => block.code.replace(/\r\n/g, "\n").includes(normalized));
      if (selectedSource) return selectedSource.index;
    }
    return this.selectedBlock;
  }
  async pickClickedBlock(event) {
    if (!(event.target instanceof HTMLElement)) return;
    const codeElement = event.target.closest("pre");
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view?.contentEl.contains(event.target)) return;
    const sources = await this.getSources();
    let source;
    if (codeElement) {
      const renderedRunnableBlocks = Array.from(view.contentEl.querySelectorAll("pre")).filter((pre) => {
        const classNames = pre.querySelector("code")?.className ?? "";
        return /language-(java|python|py|javascript|js)/i.test(classNames);
      });
      const clickedIndex = renderedRunnableBlocks.indexOf(codeElement);
      const clickedText = codeElement.innerText.trim().replace(/\s+/g, " ");
      source = clickedIndex >= 0 ? sources[clickedIndex] : sources.find((block) => block.code.replace(/\s+/g, " ").includes(clickedText));
    }
    if (!source) {
      const clickedLine = view.editor?.getCursor().line;
      source = sources.find((block) => clickedLine !== void 0 && clickedLine >= block.startLine && clickedLine <= block.endLine);
    }
    if (!source || source.index === this.selectedBlock) return;
    this.selectedBlock = source.index;
    this.tests = [];
    await this.ensureTests();
    this.status = `${source.language} block ${source.index + 1} selected. Press Run.`;
    this.render();
  }
  queueSourceRefresh() {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refreshBlocks(), 250);
  }
  async refreshBlocks(force = false) {
    const sourceCount = (await this.getSources()).length;
    const selectionChanged = this.selectedBlock >= sourceCount;
    if (!force && sourceCount === this.sourceCount && !selectionChanged) return;
    this.sourceCount = sourceCount;
    if (selectionChanged) this.selectedBlock = 0;
    if (selectionChanged || force) {
      this.tests = [];
      await this.ensureTests();
    }
    this.render();
  }
  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("code-runner-view");
    const hero = root.createDiv("code-runner-hero");
    const title = hero.createDiv();
    title.createEl("h2", { text: "Code Runner" });
    title.createEl("p", { text: this.activeFile()?.basename ?? "No active note", cls: "code-runner-subtitle" });
    title.createEl("p", { text: "Java \xB7 Python \xB7 JavaScript", cls: "code-runner-subtitle" });
    const actions = hero.createDiv("code-runner-actions");
    const run = actions.createEl("button", { text: "\u25B6 Run", cls: "mod-cta" });
    run.onclick = () => void this.run();
    const debug = actions.createEl("button", { text: "\u{1F41B} Debug" });
    debug.onclick = () => void this.run(true);
    const insert = actions.createEl("button", { text: "\u21B3 Insert result" });
    insert.onclick = () => void this.insertResult();
    const stop = actions.createEl("button", { text: "\u25A0 Stop" });
    stop.onclick = () => this.stop();
    root.createEl("label", { text: "Standard input", cls: "code-runner-label" });
    const input = root.createEl("textarea", { cls: "code-runner-input", attr: { placeholder: "Input passed to stdin" } });
    input.value = this.stdin;
    input.oninput = () => this.stdin = input.value;
    const toolbar = root.createDiv("code-runner-toolbar");
    if (this.sourceCount > 1) {
      const select = toolbar.createEl("select", { attr: { "aria-label": "Code block" } });
      for (let i = 0; i < this.sourceCount; i++) select.createEl("option", { text: `Code block ${i + 1}`, value: String(i) });
      select.value = String(this.selectedBlock);
      select.onchange = () => {
        this.selectedBlock = Number(select.value);
        this.tests = [];
        void this.ensureTests().then(() => this.render());
      };
      toolbar.createEl("button", { text: "Run all" }).onclick = () => void this.runAllBlocks();
    }
    toolbar.createEl("button", { text: "Run test cases" }).onclick = () => void this.runTests();
    toolbar.createEl("button", { text: "+ Add test case" }).onclick = () => {
      this.tests.push({ input: "", expected: "" });
      void this.saveTests();
      this.render();
    };
    toolbar.createEl("button", { text: "Clear console" }).onclick = () => {
      this.output = "";
      this.status = "Ready";
      this.render();
    };
    this.renderTests(root);
    root.createEl("label", { text: "Output console", cls: "code-runner-label" });
    root.createEl("pre", { text: this.output || "(no output)", cls: "code-runner-console" });
    root.createEl("div", { text: this.status, cls: `code-runner-status ${this.status.startsWith("Error") ? "code-runner-error" : ""}` });
    const credit = root.createDiv("code-runner-credit");
    credit.appendText("Developed by ");
    credit.createEl("a", {
      text: "SSKhekhaliya",
      href: AUTHOR_URL,
      attr: { target: "_blank", rel: "noopener noreferrer" }
    });
  }
  renderTests(root) {
    const section = root.createDiv("code-runner-tests");
    section.createEl("label", { text: "Test cases", cls: "code-runner-label" });
    if (!this.tests.length) {
      section.createDiv({ text: "Add inputs and expected outputs to check your solution automatically.", cls: "code-runner-subtitle" });
    }
    this.tests.forEach((test, index) => {
      const row = section.createDiv("code-runner-test");
      const input = row.createEl("input", { attr: { placeholder: `Case ${index + 1} input` } });
      input.value = test.input;
      input.oninput = () => {
        test.input = input.value;
        void this.saveTests();
      };
      const expected = row.createEl("input", { attr: { placeholder: "Expected output" } });
      expected.value = test.expected;
      expected.oninput = () => {
        test.expected = expected.value;
        void this.saveTests();
      };
      row.createEl("button", { text: "\xD7", attr: { "aria-label": "Remove test" } }).onclick = () => {
        this.tests.splice(index, 1);
        void this.saveTests();
        this.render();
      };
    });
  }
  async ensureTests() {
    const key = this.noteKey();
    if (!this.tests.length && this.plugin.data.tests[key]) {
      this.tests = this.plugin.data.tests[key].map((t) => ({ ...t }));
    }
  }
  async saveTests() {
    this.plugin.data.tests[this.noteKey()] = this.tests;
    await this.plugin.saveData(this.plugin.data);
  }
  async run(debug = false, input = this.stdin, blockIndex) {
    const sources = await this.getSources();
    const targetBlock = blockIndex ?? this.selectedCursorBlock(sources);
    this.selectedBlock = targetBlock;
    await this.ensureTests();
    const source = sources[targetBlock];
    if (!source) {
      this.output = "Error: the active Markdown note does not contain a supported code fence.";
      this.status = "Error: no supported code block found";
      this.render();
      return null;
    }
    if (debug) {
      if (source.language === "java") {
        this.status = `Debug server starting for block ${targetBlock + 1} on port 5005\u2026`;
      } else if (source.language === "javascript") {
        this.status = `Node inspector starting for block ${targetBlock + 1} on port 9229\u2026`;
      } else {
        this.status = `Running ${source.language} block ${targetBlock + 1}\u2026`;
      }
    } else {
      this.status = `Running ${source.language} block ${targetBlock + 1}\u2026`;
    }
    this.output = `${source.language === "java" ? "Compiling" : "Starting"} ${source.language} block ${targetBlock + 1}\u2026`;
    this.render();
    const result2 = await runCode(this.app, this.activeFile(), source, input, debug, (child) => this.running = child);
    this.running = void 0;
    this.output = result2.output + (result2.error ? `${result2.output ? "\n" : ""}${result2.error}` : "");
    this.lastRunBlock = targetBlock;
    this.lastRunResult = this.output;
    this.status = result2.ok ? `Completed ${source.language} in ${result2.durationMs} ms${source.language === "java" ? " \xB7 Java heap limit: 256 MB" : ""}` : `Error after ${result2.durationMs} ms`;
    await this.plugin.remember(this.noteKey(), result2);
    await this.saveTests();
    this.render();
    return result2;
  }
  async insertResult() {
    const note = this.activeFile();
    const sources = await this.getSources();
    const targetBlock = this.selectedCursorBlock(sources);
    const source = sources[targetBlock];
    if (!note || !source) {
      new import_obsidian.Notice("Select a supported code block first.");
      return;
    }
    if (this.lastRunBlock !== targetBlock) {
      new import_obsidian.Notice("Run this code block before inserting its result.");
      return;
    }
    const text = await this.app.vault.read(note);
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const longestBacktickRun = Math.max(0, ...(this.lastRunResult.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
    const cleanResult = this.lastRunResult.replace(/(?:\r?\n)+$/, "");
    const resultLines = cleanResult ? cleanResult.replace(/\r\n/g, "\n").split("\n") : ["(no output)"];
    lines.splice(source.endLine + 1, 0, "", `${fence}output`, ...resultLines, fence);
    await this.app.vault.modify(note, lines.join(eol));
    new import_obsidian.Notice(`Inserted the result below code block ${targetBlock + 1}.`);
  }
  async runAllBlocks() {
    const sources = await this.getSources();
    if (!sources.length) {
      new import_obsidian.Notice("No supported code blocks found in this note.");
      return;
    }
    const originalBlock = this.selectedBlock;
    const reports = [];
    for (const source of sources) {
      this.selectedBlock = source.index;
      const result2 = await this.run(false, this.stdin, source.index);
      reports.push(`=== ${source.language} block ${source.index + 1}: ${result2?.ok ? "passed" : "failed"} ===
${result2?.output ?? "No result"}`);
    }
    this.selectedBlock = originalBlock;
    this.output = reports.join("\n\n");
    this.status = `Finished ${sources.length} code block(s)`;
    this.render();
  }
  stop() {
    this.running?.kill();
    this.status = "Stopped";
    this.output += "\nProcess stopped.";
    this.render();
  }
  async runTests() {
    await this.ensureTests();
    if (!this.tests.length) {
      new import_obsidian.Notice("Add at least one test case first.");
      return;
    }
    const lines = [];
    let passed = 0;
    for (let i = 0; i < this.tests.length; i++) {
      const test = this.tests[i];
      const result2 = await this.run(false, test.input);
      if (!result2) return;
      const actual = result2.output.trim();
      const ok = result2.ok && actual === test.expected.trim();
      if (ok) passed++;
      lines.push(`${ok ? "\u2713" : "\u2717"} Case ${i + 1}${ok ? " passed" : ` failed
  expected: ${test.expected}
  actual: ${actual}`}`);
    }
    this.output = `${lines.join("\n")}

${passed}/${this.tests.length} test cases passed.`;
    this.status = passed === this.tests.length ? "All tests passed" : `${this.tests.length - passed} test case(s) failed`;
    this.render();
  }
};
async function runCode(app, note, source, input, debug, onProcess) {
  const started = performance.now();
  const directory = await import_fs.promises.mkdtemp((0, import_path.join)((0, import_os.tmpdir)(), "obsidian-code-runner-"));
  try {
    await import_fs.promises.writeFile((0, import_path.join)(directory, source.name), source.code, "utf8");
    if (app.vault.adapter instanceof import_obsidian.FileSystemAdapter) {
      const noteBase = (0, import_path.parse)(note.path).name;
      const langExt = source.language === "java" ? "java" : source.language === "python" ? "py" : "js";
      const basePath = app.vault.adapter.getBasePath();
      const noteDir = (0, import_path.dirname)(note.path);
      for (const folder of [`${noteBase}.${langExt}`, `${noteBase}.files`, `${noteBase}.java`]) {
        const extras = (0, import_path.join)(basePath, noteDir, folder);
        try {
          await import_fs.promises.cp(extras, directory, { recursive: true });
        } catch {
        }
      }
    }
    if (source.language === "python") {
      const executed2 = await invoke("python", [source.name], input, directory, onProcess);
      return result(executed2.code === 0, executed2.stdout, executed2.stderr, started, source.name);
    }
    if (source.language === "javascript") {
      const args2 = debug ? ["--inspect=9229", source.name] : [source.name];
      const executed2 = await invoke("node", args2, input, directory, onProcess);
      return result(executed2.code === 0, executed2.stdout, executed2.stderr, started, source.name);
    }
    const files = await collectJavaFiles(directory);
    const compiled = await invoke("javac", ["-encoding", "UTF-8", "-d", directory, ...files], "", directory, onProcess);
    if (compiled.code !== 0) return result(false, "", compiled.stderr || compiled.stdout, started, source.name);
    const args = ["-Xmx256m", "-cp", directory];
    if (debug) args.push("-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005");
    args.push((0, import_path.basename)(source.name, ".java"));
    const executed = await invoke("java", args, input, directory, onProcess);
    return result(executed.code === 0, executed.stdout, executed.stderr, started, source.name);
  } catch (e) {
    const executable = source.language === "python" ? "Python" : source.language === "javascript" ? "Node.js" : "a Java JDK";
    return result(false, "", `Could not start ${source.language}. Ensure ${executable} is installed and available on PATH.
${String(e)}`, started);
  } finally {
    try {
      await import_fs.promises.rm(directory, { recursive: true, force: true });
    } catch {
    }
  }
}
function result(ok, output, error, started, sourceName) {
  return { ok, output, error, durationMs: Math.round(performance.now() - started), sourceName };
}
async function collectJavaFiles(folder) {
  const files = [];
  async function visit(path) {
    for (const entry of await import_fs.promises.readdir(path, { withFileTypes: true })) {
      const target = (0, import_path.join)(path, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name.endsWith(".java")) files.push(target);
    }
  }
  await visit(folder);
  return files;
}
function invoke(command, args, input, cwd, onProcess) {
  return new Promise((resolve, reject) => {
    const child = (0, import_child_process.spawn)(command, args, { cwd, shell: false, windowsHide: true });
    onProcess(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.on("data", (d) => stdout += d);
    child.stderr?.on("data", (d) => stderr += d);
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
    }, DEFAULT_TIMEOUT_MS);
    const finish = (code, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ code, stdout, stderr });
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {
    });
    if (input) {
      child.stdin?.write(input);
    }
    child.stdin?.end();
  });
}
