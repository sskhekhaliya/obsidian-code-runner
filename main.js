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
  default: () => CodeRunnerPlugin,
  getDsaDiagnosticHint: () => getDsaDiagnosticHint,
  normalizeDsaOutput: () => normalizeDsaOutput,
  parseBulkInput: () => parseBulkInput
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
function normalizeDsaOutput(val) {
  return (val ?? "").replace(/\r\n/g, "\n").trim().split("\n").map((line) => line.trimEnd()).join("\n");
}
function parseBulkInput(raw) {
  const text = (raw ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const results = parsed.filter((item) => typeof item === "object" && item !== null).map((item) => ({
          input: String(item.input ?? item.in ?? item.stdin ?? "").replace(/\r\n/g, "\n"),
          expected: String(item.expected ?? item.output ?? item.out ?? item.stdout ?? "").replace(/\r\n/g, "\n")
        }));
        if (results.length > 0) return results;
      }
    } catch {
    }
  }
  if (/===\s*(?:CASE|INPUT)\s*===/i.test(text)) {
    const cases = [];
    const chunks = text.split(/(?:^|\n)===\s*(?:CASE|INPUT)\s*===\s*\n/i).filter((c) => c.trim().length > 0);
    for (const chunk of chunks) {
      const parts = chunk.split(/\n===\s*(?:EXPECTED|OUTPUT)\s*===\s*\n/i);
      cases.push({
        input: parts[0] ? parts[0].trimEnd() : "",
        expected: parts[1] ? parts[1].trimEnd() : ""
      });
    }
    if (cases.length > 0) return cases;
  }
  return [];
}
function getDsaDiagnosticHint(error, inputProvided) {
  if (!error) return null;
  if (/NoSuchElementException/i.test(error) || /EOFError/i.test(error)) {
    return inputProvided ? "Input ended before reading was complete. Ensure all required tokens or lines are provided in the input." : "Program expected input from standard input, but the input was empty. Provide test input before running.";
  }
  if (/ArrayIndexOutOfBoundsException/i.test(error) || /IndexError:\s*list index out of range/i.test(error)) {
    return "Array/List index out of bounds! Verify loop bounds (< array.length), 0-indexing, and base conditions.";
  }
  if (/NullPointerException/i.test(error) || /AttributeError:\s*'NoneType'/i.test(error)) {
    return "Null pointer / None dereference! Check linked list next pointers, tree child nodes, or uninitialized objects.";
  }
  if (/StackOverflowError/i.test(error) || /RecursionError:\s*maximum recursion depth/i.test(error)) {
    return "Stack Overflow / Recursion limit reached! Ensure your recursive solution has proper base cases.";
  }
  if (/OutOfMemoryError/i.test(error) || /MemoryError/i.test(error)) {
    return "Memory limit exceeded! Check for infinite allocations or exponential state space in recursion/graphs.";
  }
  return null;
}
var CodeRunnerPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.data = { tests: {}, bulkTests: {}, history: {} };
    this.clickedBlockLines = /* @__PURE__ */ new Map();
  }
  async onload() {
    this.data = Object.assign({ tests: {}, bulkTests: {}, history: {} }, await this.loadData());
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
    this.output = "Select a note containing a supported code block, then press Run.";
    this.status = "Ready";
    this.diagnosticHint = null;
    this.tests = [];
    this.bulkTests = [];
    this.bulkEditorOpen = false;
    this.bulkPasteText = "";
    this.selectedBlock = 0;
    this.sourceCount = 0;
    this.cachedSources = [];
    this.blockClickListening = false;
    this.lastRunResult = "";
    // Streamlined 2-Mode Architecture
    this.activeMode = "terminal";
    this.testSubMode = "sample";
    this.activeTestTab = 0;
    this.isRunningTests = false;
    this.isRunningBulk = false;
    this.isProcessRunning = false;
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
      this.bulkTests = [];
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
    this.bulkTests = [];
    this.activeTestTab = 0;
    this.bulkResult = void 0;
    await this.ensureTests();
    this.status = `${source.language} block ${source.index + 1} selected.`;
    this.render();
  }
  queueSourceRefresh() {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refreshBlocks(), 250);
  }
  async refreshBlocks(force = false) {
    const sources = await this.getSources();
    this.cachedSources = sources;
    const sourceCount = sources.length;
    const selectionChanged = this.selectedBlock >= sourceCount;
    if (!force && sourceCount === this.sourceCount && !selectionChanged) return;
    this.sourceCount = sourceCount;
    if (selectionChanged) this.selectedBlock = 0;
    if (selectionChanged || force) {
      this.tests = [];
      this.bulkTests = [];
      this.activeTestTab = 0;
      this.bulkResult = void 0;
      await this.ensureTests();
    }
    this.render();
  }
  async ensureTests() {
    const key = this.noteKey();
    if (!this.tests.length && this.plugin.data.tests[key]) {
      this.tests = this.plugin.data.tests[key].map((t) => ({ input: t.input, expected: t.expected }));
    }
    if (!this.bulkTests.length && this.plugin.data.bulkTests?.[key]) {
      this.bulkTests = this.plugin.data.bulkTests[key].map((t) => ({ input: t.input, expected: t.expected }));
    }
    if (this.activeTestTab >= this.tests.length) {
      this.activeTestTab = Math.max(0, this.tests.length - 1);
    }
  }
  async saveTests() {
    this.plugin.data.tests[this.noteKey()] = this.tests.map((t) => ({ input: t.input, expected: t.expected }));
    await this.plugin.saveData(this.plugin.data);
  }
  async saveBulkTests() {
    if (!this.plugin.data.bulkTests) this.plugin.data.bulkTests = {};
    this.plugin.data.bulkTests[this.noteKey()] = this.bulkTests.map((t) => ({ input: t.input, expected: t.expected }));
    await this.plugin.saveData(this.plugin.data);
  }
  appendConsole(text) {
    this.output += text;
    if (this.consolePreEl) {
      this.consolePreEl.textContent = this.output;
      this.consolePreEl.scrollTop = this.consolePreEl.scrollHeight;
    }
  }
  sendTerminalInput(text) {
    if (!this.running || !this.running.stdin || this.running.killed) return;
    const line = text;
    this.appendConsole(line + "\n");
    try {
      this.running.stdin.write(line + "\n");
    } catch {
    }
  }
  sendEOF() {
    if (!this.running || !this.running.stdin || this.running.killed) return;
    try {
      this.running.stdin.end();
      this.appendConsole("\n[EOF]\n");
    } catch {
    }
  }
  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("code-runner-view");
    const hero = root.createDiv("code-runner-hero");
    const titleArea = hero.createDiv("code-runner-title-area");
    const titleHeader = titleArea.createDiv("code-runner-title-header");
    titleHeader.createEl("h2", { text: "Code Runner" });
    const badge = titleHeader.createSpan({ cls: "code-runner-dsa-badge", text: "Interactive IDE" });
    badge.title = "Terminal & DSA Workbench";
    titleArea.createEl("p", { text: this.activeFile()?.basename ?? "No active note", cls: "code-runner-subtitle" });
    const actions = hero.createDiv("code-runner-actions");
    const hasSample = this.tests.length > 0 && this.tests.some((t) => t.input.trim() || t.expected.trim());
    const hasBulk = this.bulkTests.length > 0;
    const runBtnText = this.activeMode === "terminal" ? "\u25B6 Run in Terminal" : hasSample && hasBulk ? "\u25B6 Run All Tests" : hasBulk ? "\u25B6 Run Bulk Tests" : "\u25B6 Run Tests";
    const runBtn = actions.createEl("button", {
      text: runBtnText,
      cls: "mod-cta code-runner-btn-primary"
    });
    runBtn.onclick = () => {
      if (this.activeMode === "terminal") {
        void this.run(false, "", void 0, true);
      } else {
        void this.runUnifiedTests();
      }
    };
    const debugBtn = actions.createEl("button", { text: "\u{1F41B} Debug", cls: "code-runner-btn" });
    debugBtn.onclick = () => void this.run(true);
    const insertBtn = actions.createEl("button", { text: "\u21B3 Insert", cls: "code-runner-btn" });
    insertBtn.title = "Insert last output below the code fence in note";
    insertBtn.onclick = () => void this.insertResult();
    const stopBtn = actions.createEl("button", { text: "\u25A0 Stop", cls: "code-runner-btn mod-warning" });
    stopBtn.onclick = () => this.stop();
    if (this.sourceCount > 1) {
      const blockToolbar = root.createDiv("code-runner-block-toolbar");
      blockToolbar.createSpan({ text: "Active Block:", cls: "code-runner-toolbar-label" });
      const select = blockToolbar.createEl("select", {
        cls: "dropdown code-runner-select",
        attr: { "aria-label": "Select code block" }
      });
      for (let i = 0; i < this.sourceCount; i++) {
        const src = this.cachedSources[i];
        const label = src ? `Block ${i + 1} (${src.language})` : `Block ${i + 1}`;
        select.createEl("option", { text: label, value: String(i) });
      }
      select.value = String(this.selectedBlock);
      select.onchange = () => {
        this.selectedBlock = Number(select.value);
        this.tests = [];
        this.bulkTests = [];
        this.activeTestTab = 0;
        this.bulkResult = void 0;
        void this.ensureTests().then(() => this.render());
      };
      blockToolbar.createEl("button", { text: "Run all blocks", cls: "code-runner-btn-sm" }).onclick = () => void this.runAllBlocks();
    }
    const modeSwitch = root.createDiv("code-runner-mode-switch");
    const terminalModeBtn = modeSwitch.createEl("button", {
      text: "Terminal",
      cls: `code-runner-mode-btn ${this.activeMode === "terminal" ? "is-active" : ""}`
    });
    terminalModeBtn.onclick = () => {
      this.activeMode = "terminal";
      this.render();
    };
    const testModeBtn = modeSwitch.createEl("button", {
      text: "Test Cases",
      cls: `code-runner-mode-btn ${this.activeMode === "tests" ? "is-active" : ""}`
    });
    testModeBtn.onclick = () => {
      this.activeMode = "tests";
      this.render();
    };
    if (this.activeMode === "tests") {
      this.renderTestCasesSection(root);
    }
    this.renderConsoleSection(root);
    const credit = root.createDiv("code-runner-credit");
    credit.appendText("Code Runner by ");
    credit.createEl("a", {
      text: "SSKhekhaliya",
      href: AUTHOR_URL,
      attr: { target: "_blank", rel: "noopener noreferrer" }
    });
  }
  renderTestCasesSection(root) {
    const container = root.createDiv("code-runner-tests-section");
    const subSwitch = container.createDiv("code-runner-sub-switch");
    const sampleSubBtn = subSwitch.createEl("button", {
      text: "Sample Cases",
      cls: `code-runner-sub-btn ${this.testSubMode === "sample" ? "is-active" : ""}`
    });
    sampleSubBtn.onclick = () => {
      this.testSubMode = "sample";
      this.render();
    };
    const bulkSubBtn = subSwitch.createEl("button", {
      text: "Bulk Suite",
      cls: `code-runner-sub-btn ${this.testSubMode === "bulk" ? "is-active" : ""}`
    });
    bulkSubBtn.onclick = () => {
      this.testSubMode = "bulk";
      this.render();
    };
    if (this.testSubMode === "sample") {
      this.renderDsaTestWorkbench(container);
    } else {
      this.renderBulkSuiteSection(container);
    }
  }
  renderDsaTestWorkbench(container) {
    const wrapper = container.createDiv("code-runner-dsa-container");
    const tabHeader = wrapper.createDiv("code-runner-tabs-header");
    const tabsList = tabHeader.createDiv("code-runner-tabs-list");
    if (this.tests.length === 0) {
      this.tests.push({ input: "", expected: "" });
      void this.saveTests();
    }
    const useCompactPills = this.tests.length > 5;
    if (useCompactPills) {
      tabsList.addClass("is-compact-grid");
    }
    this.tests.forEach((test, index) => {
      const tab = tabsList.createDiv({
        cls: `code-runner-tab ${useCompactPills ? "is-compact" : ""} ${this.activeTestTab === index ? "is-active" : ""}`
      });
      const statusDot = tab.createSpan("code-runner-tab-dot");
      if (test.lastResult) {
        if (test.lastResult.status === "Accepted") {
          statusDot.addClass("dot-accepted");
          statusDot.title = `Accepted (${test.lastResult.durationMs}ms)`;
        } else if (test.lastResult.status === "Time Limit Exceeded") {
          statusDot.addClass("dot-tle");
          statusDot.title = "Time Limit Exceeded";
        } else {
          statusDot.addClass("dot-failed");
          statusDot.title = test.lastResult.status;
        }
      }
      tab.createSpan({ text: useCompactPills ? String(index + 1) : `Case ${index + 1}` });
      tab.onclick = () => {
        this.activeTestTab = index;
        this.render();
      };
    });
    const addTabBtn = tabsList.createEl("button", {
      text: "+",
      cls: `code-runner-add-tab-btn ${useCompactPills ? "is-compact" : ""}`,
      attr: { title: "Add new test case" }
    });
    addTabBtn.onclick = () => {
      this.tests.push({ input: "", expected: "" });
      this.activeTestTab = this.tests.length - 1;
      void this.saveTests();
      this.render();
    };
    const activeTest = this.tests[this.activeTestTab];
    if (activeTest) {
      const card = wrapper.createDiv("code-runner-card");
      const cardHeader = card.createDiv("code-runner-card-header");
      const titleSpan = cardHeader.createSpan({
        cls: "code-runner-card-title",
        text: `Case ${this.activeTestTab + 1} of ${this.tests.length}`
      });
      if (activeTest.lastResult) {
        const badgeCls = activeTest.lastResult.status === "Accepted" ? "verdict-accepted" : activeTest.lastResult.status === "Time Limit Exceeded" ? "verdict-tle" : "verdict-failed";
        titleSpan.createSpan({
          cls: `code-runner-verdict-badge ${badgeCls}`,
          text: `${activeTest.lastResult.status} (${activeTest.lastResult.durationMs} ms)`
        });
      }
      const caseActions = cardHeader.createDiv("code-runner-card-actions");
      const runCaseBtn = caseActions.createEl("button", { text: "\u25B6 Run Case", cls: "code-runner-btn-sm" });
      runCaseBtn.onclick = () => void this.runSingleTestCase(this.activeTestTab);
      const copyInputBtn = caseActions.createEl("button", { text: "\u{1F4CB} Copy", cls: "code-runner-btn-sm" });
      copyInputBtn.title = "Copy case input to clipboard";
      copyInputBtn.onclick = async () => {
        await navigator.clipboard.writeText(activeTest.input);
        new import_obsidian.Notice(`Case ${this.activeTestTab + 1} input copied to clipboard.`);
      };
      if (this.tests.length > 1) {
        const deleteBtn = caseActions.createEl("button", { text: "\u{1F5D1}\uFE0F", cls: "code-runner-btn-icon" });
        deleteBtn.title = "Delete test case";
        deleteBtn.onclick = () => {
          this.tests.splice(this.activeTestTab, 1);
          if (this.activeTestTab >= this.tests.length) {
            this.activeTestTab = Math.max(0, this.tests.length - 1);
          }
          void this.saveTests();
          this.render();
        };
      }
      card.createEl("label", { text: "Input", cls: "code-runner-field-label" });
      const inputArea = card.createEl("textarea", {
        cls: "code-runner-textarea",
        attr: { placeholder: "e.g.\n5\n1 2 3 4 5", rows: "3" }
      });
      inputArea.value = activeTest.input;
      inputArea.oninput = () => {
        activeTest.input = inputArea.value;
        void this.saveTests();
      };
      card.createEl("label", { text: "Expected Output", cls: "code-runner-field-label" });
      const expectedArea = card.createEl("textarea", {
        cls: "code-runner-textarea",
        attr: { placeholder: "Expected output after execution", rows: "2" }
      });
      expectedArea.value = activeTest.expected;
      expectedArea.oninput = () => {
        activeTest.expected = expectedArea.value;
        void this.saveTests();
      };
      if (activeTest.lastResult) {
        card.createEl("label", { text: "Your Output", cls: "code-runner-field-label" });
        card.createEl("pre", {
          cls: `code-runner-actual-box ${activeTest.lastResult.status === "Accepted" ? "is-passed" : "is-failed"}`,
          text: activeTest.lastResult.output || (activeTest.lastResult.error ? `Error: ${activeTest.lastResult.error}` : "(no output)")
        });
      }
    }
  }
  renderBulkSuiteSection(container) {
    const wrapper = container.createDiv("code-runner-bulk-container");
    const fileInput = wrapper.createEl("input", {
      type: "file",
      attr: { accept: ".json,.txt", style: "display: none;" }
    });
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const content = await file.text();
        const cases = parseBulkInput(content);
        if (cases.length > 0) {
          this.bulkTests = cases;
          this.bulkResult = void 0;
          this.bulkEditorOpen = false;
          await this.saveBulkTests();
          new import_obsidian.Notice(`Loaded ${cases.length} bulk test cases from ${file.name}!`);
          this.render();
        } else {
          new import_obsidian.Notice("Could not parse test cases from file. Format should be JSON or === CASE === delimited.");
        }
      } catch (err) {
        new import_obsidian.Notice(`Failed to read file: ${String(err)}`);
      }
    };
    const header = wrapper.createDiv("code-runner-bulk-header");
    const titleArea = header.createDiv("code-runner-bulk-title-area");
    titleArea.createEl("span", { text: "Bulk Test Suite", cls: "code-runner-bulk-title" });
    if (this.bulkTests.length > 0) {
      titleArea.createSpan({ text: `${this.bulkTests.length} cases`, cls: "code-runner-bulk-count" });
    }
    const tools = header.createDiv("code-runner-bulk-tools");
    const uploadBtn = tools.createEl("button", { text: "\u{1F4C1} Upload File", cls: "code-runner-btn-sm" });
    uploadBtn.title = "Upload .json or .txt test file";
    uploadBtn.onclick = () => fileInput.click();
    const editBtn = tools.createEl("button", {
      text: this.bulkEditorOpen ? "Close Editor" : "\u{1F4CB} Paste / Edit",
      cls: "code-runner-btn-sm"
    });
    editBtn.onclick = () => {
      this.bulkEditorOpen = !this.bulkEditorOpen;
      this.render();
    };
    if (this.bulkTests.length > 0) {
      const clearBtn = tools.createEl("button", { text: "\u{1F5D1}\uFE0F Clear", cls: "code-runner-btn-icon" });
      clearBtn.title = "Clear bulk test cases";
      clearBtn.onclick = async () => {
        this.bulkTests = [];
        this.bulkResult = void 0;
        await this.saveBulkTests();
        this.render();
      };
    }
    if (this.bulkTests.length === 0 && !this.bulkEditorOpen) {
      const emptyState = wrapper.createDiv("code-runner-bulk-empty");
      emptyState.createEl("p", {
        text: "No bulk test cases loaded yet. Click '\u{1F4C1} Upload File' or '\u{1F4CB} Paste / Edit' to import your test cases.",
        cls: "code-runner-subtitle"
      });
    }
    if (this.bulkEditorOpen || this.bulkTests.length === 0) {
      const editorBox = wrapper.createDiv("code-runner-bulk-editor");
      editorBox.createEl("label", {
        text: "Paste bulk test cases in JSON or delimited format:",
        cls: "code-runner-field-label"
      });
      const textarea = editorBox.createEl("textarea", {
        cls: "code-runner-textarea code-runner-bulk-textarea",
        attr: {
          placeholder: 'JSON format:\n[\n  {"input": "5\\n1 2 3", "expected": "6"}\n]\n\nOR Delimited format:\n=== CASE ===\n5\n1 2 3\n=== EXPECTED ===\n6',
          rows: "6"
        }
      });
      textarea.value = this.bulkPasteText;
      textarea.oninput = () => this.bulkPasteText = textarea.value;
      const editorActions = editorBox.createDiv("code-runner-bulk-editor-actions");
      const importBtn = editorActions.createEl("button", { text: "\u{1F4E5} Import Pasted Cases", cls: "mod-cta code-runner-btn-sm" });
      importBtn.onclick = async () => {
        const parsed = parseBulkInput(this.bulkPasteText);
        if (parsed.length > 0) {
          this.bulkTests = parsed;
          this.bulkResult = void 0;
          this.bulkEditorOpen = false;
          this.bulkPasteText = "";
          await this.saveBulkTests();
          new import_obsidian.Notice(`Successfully imported ${parsed.length} bulk test cases!`);
          this.render();
        } else {
          new import_obsidian.Notice("Could not parse test cases. Please check format.");
        }
      };
      if (this.bulkTests.length > 0) {
        const cancelBtn = editorActions.createEl("button", { text: "Cancel", cls: "code-runner-btn-sm" });
        cancelBtn.onclick = () => {
          this.bulkEditorOpen = false;
          this.render();
        };
      }
    }
    if (this.bulkResult) {
      const res = this.bulkResult;
      const isSuccess = res.failed === 0;
      const banner = wrapper.createDiv(`code-runner-bulk-banner ${isSuccess ? "is-success" : "is-failure"}`);
      const bannerTop = banner.createDiv("code-runner-bulk-banner-top");
      bannerTop.createEl("span", {
        text: isSuccess ? `\u2705 All ${res.total} Bulk Cases Passed!` : `\u26A0\uFE0F ${res.passed}/${res.total} Passed (${res.failed} Failed)`,
        cls: "code-runner-bulk-verdict"
      });
      bannerTop.createEl("span", {
        text: `\u23F1 ${res.durationMs} ms`,
        cls: "code-runner-bulk-time"
      });
      const progressTrack = banner.createDiv("code-runner-bulk-progress");
      const passPercent = res.total > 0 ? res.passed / res.total * 100 : 0;
      const fillBar = progressTrack.createDiv("code-runner-bulk-progress-fill");
      fillBar.style.width = `${passPercent}%`;
      if (res.failedIndices.length > 0) {
        const failedSection = banner.createDiv("code-runner-bulk-failed-section");
        failedSection.createEl("div", { text: `Failed Cases (${res.failed}):`, cls: "code-runner-field-label" });
        const chipsList = failedSection.createDiv("code-runner-bulk-chips-list");
        res.failedIndices.forEach((item) => {
          const chip = chipsList.createSpan("code-runner-failed-chip");
          chip.setText(`Case #${item.index} (${item.reason})`);
        });
      }
    }
  }
  renderConsoleSection(root) {
    const consoleContainer = root.createDiv("code-runner-console-container");
    const header = consoleContainer.createDiv("code-runner-console-header");
    const headerLeft = header.createDiv("code-runner-console-header-left");
    headerLeft.createEl("label", { text: "Terminal Console", cls: "code-runner-field-label" });
    if (this.isProcessRunning) {
      const liveBadge = headerLeft.createSpan("code-runner-live-badge");
      liveBadge.createSpan("code-runner-pulse-dot");
      liveBadge.appendText(" LIVE");
    }
    const tools = header.createDiv("code-runner-console-tools");
    if (this.isProcessRunning) {
      const eofBtn = tools.createEl("button", { text: "Send EOF", cls: "code-runner-btn-sm" });
      eofBtn.title = "Send End-Of-File (Ctrl+D / Ctrl+Z) to close stdin";
      eofBtn.onclick = () => this.sendEOF();
    }
    const copyBtn = tools.createEl("button", { text: "\u{1F4CB} Copy", cls: "code-runner-btn-sm" });
    copyBtn.title = "Copy console output to clipboard";
    copyBtn.onclick = async () => {
      if (this.output) {
        await navigator.clipboard.writeText(this.output);
        new import_obsidian.Notice("Console output copied to clipboard.");
      }
    };
    const clearBtn = tools.createEl("button", { text: "Clear", cls: "code-runner-btn-sm" });
    clearBtn.onclick = () => {
      this.output = "";
      this.status = "Ready";
      this.diagnosticHint = null;
      this.render();
    };
    if (this.diagnosticHint) {
      const diagBox = consoleContainer.createDiv("code-runner-diagnostic-box");
      diagBox.createSpan({ text: "\u26A0\uFE0F Diagnostic: ", cls: "code-runner-diag-title" });
      diagBox.createSpan({ text: this.diagnosticHint, cls: "code-runner-diag-message" });
    }
    const terminalWrapper = consoleContainer.createDiv("code-runner-terminal-wrapper");
    this.consolePreEl = terminalWrapper.createEl("pre", {
      text: this.output || "(no output)",
      cls: `code-runner-console ${this.diagnosticHint ? "has-diagnostic" : ""}`
    });
    const terminalBar = terminalWrapper.createDiv("code-runner-terminal-bar");
    terminalBar.createSpan({ text: ">", cls: "code-runner-terminal-prompt" });
    this.terminalInputEl = terminalBar.createEl("input", {
      type: "text",
      cls: "code-runner-terminal-input",
      attr: {
        placeholder: this.isProcessRunning ? "Type input and press Enter..." : "Click 'Run in Terminal' to start interactive session...",
        ...this.isProcessRunning ? {} : { disabled: "true" }
      }
    });
    const sendBtn = terminalBar.createEl("button", {
      text: "Send \u21B5",
      cls: "code-runner-btn-sm code-runner-terminal-send",
      attr: { ...this.isProcessRunning ? {} : { disabled: "true" } }
    });
    const handleSend = () => {
      if (!this.terminalInputEl) return;
      const val = this.terminalInputEl.value;
      this.terminalInputEl.value = "";
      this.sendTerminalInput(val);
      this.terminalInputEl.focus();
    };
    this.terminalInputEl.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSend();
      }
    };
    sendBtn.onclick = handleSend;
    if (this.isProcessRunning) {
      window.setTimeout(() => this.terminalInputEl?.focus(), 60);
    }
    const statusBar = consoleContainer.createDiv({
      cls: `code-runner-status ${this.status.startsWith("Error") || this.status.includes("failed") ? "code-runner-error" : ""}`
    });
    statusBar.createSpan({ text: this.status });
  }
  async runSingleTestCase(index) {
    const test = this.tests[index];
    if (!test) return;
    this.status = `Running Case ${index + 1}\u2026`;
    this.render();
    const result2 = await this.run(false, test.input, void 0, false);
    if (!result2) return;
    const normActual = normalizeDsaOutput(result2.output);
    const normExpected = normalizeDsaOutput(test.expected);
    let status = "Wrong Answer";
    if (result2.timedOut) {
      status = "Time Limit Exceeded";
    } else if (!result2.ok) {
      status = "Runtime Error";
    } else if (normActual === normExpected) {
      status = "Accepted";
    }
    test.lastResult = {
      status,
      output: result2.output,
      error: result2.error,
      durationMs: result2.durationMs
    };
    this.diagnosticHint = getDsaDiagnosticHint(result2.error, Boolean(test.input.trim()));
    this.status = `Case ${index + 1}: ${status} in ${result2.durationMs} ms`;
    this.render();
  }
  async runUnifiedTests() {
    const hasSample = this.tests.length > 0 && this.tests.some((t) => t.input.trim() || t.expected.trim());
    const hasBulk = this.bulkTests.length > 0;
    if (!hasSample && !hasBulk) {
      new import_obsidian.Notice("Add at least one sample test case or bulk test case first.");
      return;
    }
    if (hasSample && hasBulk) {
      await this.runTests(true);
      await this.runBulkTests(true);
      this.combineUnifiedTestSummary();
    } else if (hasBulk) {
      await this.runBulkTests();
    } else {
      await this.runTests();
    }
  }
  combineUnifiedTestSummary() {
    const samplePassed = this.tests.filter((t) => t.lastResult?.status === "Accepted").length;
    const sampleTotal = this.tests.length;
    const bulkPassed = this.bulkResult?.passed ?? 0;
    const bulkTotal = this.bulkResult?.total ?? 0;
    const allPassed = samplePassed === sampleTotal && (!bulkTotal || bulkPassed === bulkTotal);
    this.status = allPassed ? `All tests passed! \u{1F389} (${samplePassed}/${sampleTotal} sample, ${bulkPassed}/${bulkTotal} bulk)` : `Tests: ${samplePassed}/${sampleTotal} sample passed, ${bulkPassed}/${bulkTotal} bulk passed`;
    const summary = [
      "================ Unified Test Suite ================",
      `Sample Cases: ${samplePassed}/${sampleTotal} Passed`,
      `Bulk Cases:   ${bulkPassed}/${bulkTotal} Passed`,
      "----------------------------------------------------",
      `Verdict: ${allPassed ? "ALL TESTS PASSED \u{1F389}" : "SOME TESTS FAILED \u2717"}`,
      "===================================================="
    ];
    this.output = summary.join("\n") + "\n\n" + this.output;
    this.render();
  }
  async run(debug = false, input = "", blockIndex, interactive = this.activeMode === "terminal") {
    const sources = await this.getSources();
    const targetBlock = blockIndex ?? this.selectedCursorBlock(sources);
    this.selectedBlock = targetBlock;
    await this.ensureTests();
    const source = sources[targetBlock];
    if (!source) {
      this.output = "Error: the active Markdown note does not contain a supported code fence.";
      this.status = "Error: no supported code block found";
      this.diagnosticHint = null;
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
      this.status = interactive ? `Running ${source.language} in interactive terminal\u2026` : `Running ${source.language} block ${targetBlock + 1}\u2026`;
    }
    this.output = `${source.language === "java" ? "Compiling" : "Starting"} ${source.language} block ${targetBlock + 1}\u2026
`;
    this.diagnosticHint = null;
    this.isProcessRunning = true;
    this.render();
    let hasReceivedRuntimeOutput = false;
    const result2 = await runCode(this.app, this.activeFile(), source, {
      debug,
      input: interactive ? "" : input,
      interactive,
      onProcess: (child) => {
        this.running = child;
      },
      onData: (chunk) => {
        if (!hasReceivedRuntimeOutput) {
          hasReceivedRuntimeOutput = true;
          this.output = "";
        }
        this.appendConsole(chunk);
      }
    });
    this.running = void 0;
    this.isProcessRunning = false;
    if (interactive) {
      this.output = this.output.replace(/^(?:Compiling|Starting)\s+[^\n]*block\s+\d+…\r?\n?/i, "");
      if (result2.error && !this.output.includes(result2.error)) {
        this.output += (this.output.endsWith("\n") ? "" : "\n") + result2.error;
      }
    } else {
      this.output = result2.output + (result2.error ? `${result2.output ? "\n" : ""}${result2.error}` : "");
    }
    this.lastRunBlock = targetBlock;
    this.lastRunResult = this.output;
    this.diagnosticHint = getDsaDiagnosticHint(result2.error, Boolean(input.trim()));
    if (result2.timedOut) {
      this.status = `Time Limit Exceeded after ${result2.durationMs} ms`;
    } else {
      this.status = result2.ok ? `Completed ${source.language} in ${result2.durationMs} ms${source.language === "java" ? " \xB7 Java heap: 256 MB" : ""}` : `Error after ${result2.durationMs} ms`;
    }
    await this.plugin.remember(this.noteKey(), result2);
    await this.saveTests();
    this.render();
    return result2;
  }
  async runTests(isPart = false) {
    await this.ensureTests();
    if (!this.tests.length) {
      if (!isPart) new import_obsidian.Notice("Add at least one test case first.");
      return;
    }
    this.isRunningTests = true;
    const lines = ["================ Sample Test Cases ================"];
    let passed = 0;
    let totalTime = 0;
    for (let i = 0; i < this.tests.length; i++) {
      const test = this.tests[i];
      this.status = `Running Case ${i + 1} of ${this.tests.length}\u2026`;
      this.render();
      const result2 = await this.run(false, test.input, void 0, false);
      if (!result2) {
        this.isRunningTests = false;
        return;
      }
      totalTime += result2.durationMs;
      const normActual = normalizeDsaOutput(result2.output);
      const normExpected = normalizeDsaOutput(test.expected);
      let status = "Wrong Answer";
      if (result2.timedOut) {
        status = "Time Limit Exceeded";
      } else if (!result2.ok) {
        status = "Runtime Error";
      } else if (normActual === normExpected) {
        status = "Accepted";
        passed++;
      }
      test.lastResult = {
        status,
        output: result2.output,
        error: result2.error,
        durationMs: result2.durationMs
      };
      const icon = status === "Accepted" ? "\u2713" : "\u2717";
      lines.push(`${icon} Case ${i + 1}: ${status} (${result2.durationMs} ms)`);
      if (status !== "Accepted") {
        if (test.expected.trim()) {
          lines.push(`   Expected: ${test.expected.trim().replace(/\n/g, "\n             ")}`);
        }
        lines.push(`   Actual:   ${(result2.output.trim() || result2.error.trim()).replace(/\n/g, "\n             ")}`);
      }
    }
    this.isRunningTests = false;
    lines.push("--------------------------------------------------");
    lines.push(`Verdict: ${passed}/${this.tests.length} Passed | Total Time: ${totalTime} ms`);
    lines.push("==================================================");
    this.output = lines.join("\n");
    this.status = passed === this.tests.length ? `All ${this.tests.length} cases Accepted \u{1F389} (${totalTime} ms)` : `${this.tests.length - passed} failed, ${passed} passed (${totalTime} ms)`;
    const firstFailedIndex = this.tests.findIndex((t) => t.lastResult?.status !== "Accepted");
    if (firstFailedIndex >= 0) {
      this.activeTestTab = firstFailedIndex;
    }
    this.render();
  }
  async runBulkTests(isPart = false) {
    if (!this.bulkTests.length) {
      if (!isPart) new import_obsidian.Notice("No bulk test cases loaded.");
      return;
    }
    this.isRunningBulk = true;
    this.bulkResult = void 0;
    this.status = `Running 0/${this.bulkTests.length} bulk cases\u2026`;
    this.render();
    let passed = 0;
    let failed = 0;
    let totalTime = 0;
    const failedIndices = [];
    for (let i = 0; i < this.bulkTests.length; i++) {
      const test = this.bulkTests[i];
      this.status = `Running bulk case ${i + 1}/${this.bulkTests.length}\u2026`;
      if (i % 5 === 0 || i === this.bulkTests.length - 1) {
        this.render();
      }
      const result2 = await this.run(false, test.input, void 0, false);
      if (!result2) {
        this.isRunningBulk = false;
        return;
      }
      totalTime += result2.durationMs;
      const normActual = normalizeDsaOutput(result2.output);
      const normExpected = normalizeDsaOutput(test.expected);
      if (result2.timedOut) {
        failed++;
        failedIndices.push({ index: i + 1, reason: "Time Limit Exceeded" });
      } else if (!result2.ok) {
        failed++;
        failedIndices.push({ index: i + 1, reason: "Runtime Error" });
      } else if (normActual === normExpected) {
        passed++;
      } else {
        failed++;
        failedIndices.push({ index: i + 1, reason: "Wrong Answer" });
      }
    }
    this.isRunningBulk = false;
    this.bulkResult = {
      total: this.bulkTests.length,
      passed,
      failed,
      durationMs: totalTime,
      failedIndices
    };
    const passRate = Math.round(passed / this.bulkTests.length * 100);
    this.status = `Bulk: ${passed}/${this.bulkTests.length} passed (${passRate}%) in ${totalTime} ms`;
    const consoleLines = [
      "================ Bulk Suite Results ================",
      `Total Cases: ${this.bulkTests.length}`,
      `Passed:      ${passed}`,
      `Failed:      ${failed}`,
      `Pass Rate:   ${passRate}%`,
      `Total Time:  ${totalTime} ms`,
      "----------------------------------------------------"
    ];
    if (failedIndices.length > 0) {
      consoleLines.push("Failed: " + failedIndices.map((f) => `#${f.index} (${f.reason})`).join(", "));
    } else {
      consoleLines.push("All bulk cases passed successfully! \u{1F389}");
    }
    consoleLines.push("====================================================");
    this.output = consoleLines.join("\n");
    this.render();
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
    const cleanResult = this.lastRunResult.replace(/(?:\r?\n)+$/, "").replace(/^(?:Compiling|Starting)\s+[^\n]*block\s+\d+…\r?\n?/i, "");
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
      const result2 = await this.run(false, "", source.index, false);
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
    this.isProcessRunning = false;
    this.status = "Stopped";
    this.output += "\n[Process stopped by user]";
    this.render();
  }
};
async function runCode(app, note, source, options) {
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
      const executed2 = await invoke("python", ["-u", source.name], directory, options);
      const isOk2 = executed2.code === 0 && !executed2.timedOut;
      const err2 = executed2.timedOut ? "Time Limit Exceeded. Check for infinite loops or unconsumed stdin." : executed2.stderr;
      return result(isOk2, executed2.stdout, err2, started, source.name, executed2.timedOut);
    }
    if (source.language === "javascript") {
      const args2 = options.debug ? ["--inspect=9229", source.name] : [source.name];
      const executed2 = await invoke("node", args2, directory, options);
      const isOk2 = executed2.code === 0 && !executed2.timedOut;
      const err2 = executed2.timedOut ? "Time Limit Exceeded. Check for infinite loops or unconsumed stdin." : executed2.stderr;
      return result(isOk2, executed2.stdout, err2, started, source.name, executed2.timedOut);
    }
    const files = await collectJavaFiles(directory);
    const compileOptions = { onProcess: options.onProcess };
    const compiled = await invoke("javac", ["-encoding", "UTF-8", "-d", directory, ...files], directory, compileOptions);
    if (compiled.code !== 0) return result(false, "", compiled.stderr || compiled.stdout || "Java compilation failed.", started, source.name);
    const args = ["-Xmx256m", "-cp", directory];
    if (options.debug) args.push("-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005");
    args.push((0, import_path.basename)(source.name, ".java"));
    const executed = await invoke("java", args, directory, options);
    const isOk = executed.code === 0 && !executed.timedOut;
    const err = executed.timedOut ? "Time Limit Exceeded. Check for infinite loops or unconsumed stdin." : executed.stderr;
    return result(isOk, executed.stdout, err, started, source.name, executed.timedOut);
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
function result(ok, output, error, started, sourceName, timedOut = false) {
  return { ok, output, error, durationMs: Math.round(performance.now() - started), sourceName, timedOut };
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
function invoke(command, args, cwd, options) {
  return new Promise((resolve, reject) => {
    const child = (0, import_child_process.spawn)(command, args, { cwd, shell: false, windowsHide: true });
    options.onProcess?.(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const isInteractive = Boolean(options.interactive);
    const timeoutDuration = isInteractive ? 18e4 : DEFAULT_TIMEOUT_MS;
    let timer;
    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!child.killed) {
          timedOut = true;
          child.kill();
        }
      }, timeoutDuration);
    };
    resetTimer();
    child.stdout?.on("data", (d) => {
      const str = d.toString();
      stdout += str;
      options.onData?.(str);
      resetTimer();
    });
    child.stderr?.on("data", (d) => {
      const str = d.toString();
      stderr += str;
      options.onData?.(str);
      resetTimer();
    });
    const finish = (code, err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve({ code, stdout, stderr, timedOut });
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {
    });
    if (options.input) {
      child.stdin?.write(options.input);
    }
    if (!isInteractive) {
      child.stdin?.end();
    }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getDsaDiagnosticHint,
  normalizeDsaOutput,
  parseBulkInput
});
