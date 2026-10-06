import { App, FileSystemAdapter, ItemView, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { ChildProcess, spawn } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, parse } from "path";

const VIEW_TYPE_CODE_RUNNER = "obsidian-code-runner";
const DEFAULT_TIMEOUT_MS = 10_000;
const AUTHOR_URL = "https://www.sskhekhaliya.in/";

export type TestCaseStatus = "Accepted" | "Wrong Answer" | "Runtime Error" | "Time Limit Exceeded";

export interface TestCaseResult {
  status: TestCaseStatus;
  output: string;
  error: string;
  durationMs: number;
}

export interface CodeTestCase {
  input: string;
  expected: string;
  lastResult?: TestCaseResult;
}

export interface BulkSuiteResult {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  failedIndices: { index: number; reason: string }[];
}

export interface SavedData {
  tests: Record<string, { input: string; expected: string }[]>;
  bulkTests?: Record<string, { input: string; expected: string }[]>;
  history: Record<string, RunSummary[]>;
}

export interface RunSummary {
  at: string;
  ok: boolean;
  durationMs: number;
}

export interface RunResult {
  ok: boolean;
  output: string;
  error: string;
  durationMs: number;
  sourceName?: string;
  timedOut?: boolean;
}

export type SupportedLanguage = "java" | "python" | "javascript";

export interface RunnableSource {
  code: string;
  name: string;
  language: SupportedLanguage;
  index: number;
  startLine: number;
  endLine: number;
}

export interface RunOptions {
  input?: string;
  debug?: boolean;
  interactive?: boolean;
  onData?: (chunk: string) => void;
  onProcess?: (child: ChildProcess) => void;
}

export function normalizeDsaOutput(val: string): string {
  return (val ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n");
}

export function parseBulkInput(raw: string): { input: string; expected: string }[] {
  const text = (raw ?? "").trim();
  if (!text) return [];

  // 1. Try JSON Array: [{"input": "...", "expected": "..."}]
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const results = parsed
          .filter(item => typeof item === "object" && item !== null)
          .map(item => ({
            input: String(item.input ?? item.in ?? item.stdin ?? "").replace(/\r\n/g, "\n"),
            expected: String(item.expected ?? item.output ?? item.out ?? item.stdout ?? "").replace(/\r\n/g, "\n")
          }));
        if (results.length > 0) return results;
      }
    } catch {
      // Fall through to delimited
    }
  }

  // 2. Delimited format:
  // === CASE === (or === INPUT ===)
  // ...
  // === EXPECTED === (or === OUTPUT ===)
  // ...
  if (/===\s*(?:CASE|INPUT)\s*===/i.test(text)) {
    const cases: { input: string; expected: string }[] = [];
    const chunks = text.split(/(?:^|\n)===\s*(?:CASE|INPUT)\s*===\s*\n/i).filter(c => c.trim().length > 0);
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

export function getDsaDiagnosticHint(error: string, inputProvided: boolean): string | null {
  if (!error) return null;
  if (/NoSuchElementException/i.test(error) || /EOFError/i.test(error)) {
    return inputProvided
      ? "Input ended before reading was complete. Ensure all required tokens or lines are provided in the input."
      : "Program expected input from standard input, but the input was empty. Provide test input before running.";
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

export default class CodeRunnerPlugin extends Plugin {
  data: SavedData = { tests: {}, bulkTests: {}, history: {} };
  clickedBlockLines = new Map<string, number>();

  async onload() {
    this.data = Object.assign({ tests: {}, bulkTests: {}, history: {} }, await this.loadData());
    this.registerView(VIEW_TYPE_CODE_RUNNER, (leaf) => new CodeRunnerView(leaf, this));
    // Backwards compatibility for existing workspace layouts
    this.registerView("obsidian-java-ide", (leaf) => new CodeRunnerView(leaf, this));

    this.addRibbonIcon("terminal-square", "Open Code Runner", () => void this.openIde());

    // Primary commands
    this.addCommand({ id: "open-code-runner", name: "Open Code Runner", callback: () => void this.openIde() });
    this.addCommand({ id: "run-active-code-block", name: "Run active code block", callback: () => void this.openIde(true) });

    // Legacy command IDs preserved for existing user hotkeys
    this.addCommand({ id: "open-java-ide", name: "Open Code Runner (legacy)", callback: () => void this.openIde() });
    this.addCommand({ id: "run-active-java-block", name: "Run active code block (legacy)", callback: () => void this.openIde(true) });

    this.registerMarkdownPostProcessor((element, context) => {
      element.querySelectorAll("pre > code").forEach((code) => {
        if (!/language-(java|python|py|javascript|js)/i.test(code.className)) return;
        const section = context.getSectionInfo(code as HTMLElement);
        if (!section) return;
        code.addEventListener("mousedown", () => this.clickedBlockLines.set(context.sourcePath, section.lineStart));
      });
    });
  }

  async openIde(run = false) {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODE_RUNNER)[0]
      ?? this.app.workspace.getLeavesOfType("obsidian-java-ide")[0]
      ?? this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_CODE_RUNNER, active: true });
    this.app.workspace.revealLeaf(leaf);
    if (run) await (leaf.view as CodeRunnerView).run();
  }

  async remember(path: string, result: RunResult) {
    const entries = this.data.history[path] ?? [];
    entries.unshift({ at: new Date().toISOString(), ok: result.ok, durationMs: result.durationMs });
    this.data.history[path] = entries.slice(0, 20);
    await this.saveData(this.data);
  }
}

class CodeRunnerView extends ItemView {
  plugin: CodeRunnerPlugin;
  output = "Select a note containing a supported code block, then press Run.";
  status = "Ready";
  diagnosticHint: string | null = null;
  tests: CodeTestCase[] = [];
  bulkTests: { input: string; expected: string }[] = [];
  bulkResult?: BulkSuiteResult;
  bulkEditorOpen = false;
  bulkPasteText = "";

  selectedBlock = 0;
  sourceCount = 0;
  cachedSources: RunnableSource[] = [];
  blockClickListening = false;
  lastRunBlock?: number;
  lastRunResult = "";
  refreshTimer?: number;
  running?: ChildProcess;

  // Streamlined 2-Mode Architecture
  activeMode: "terminal" | "tests" = "terminal";
  testSubMode: "sample" | "bulk" = "sample";
  activeTestTab = 0;
  isRunningTests = false;
  isRunningBulk = false;
  isProcessRunning = false;

  // DOM Elements for Live Terminal Updates
  consolePreEl?: HTMLPreElement;
  terminalInputEl?: HTMLInputElement;

  constructor(leaf: WorkspaceLeaf, plugin: CodeRunnerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_CODE_RUNNER; }
  getDisplayText() { return "Code Runner"; }
  getIcon() { return "terminal-square"; }

  async onOpen() {
    this.registerEvent(this.app.workspace.on("file-open", () => { this.tests = []; this.bulkTests = []; void this.refreshBlocks(true); }));
    this.registerEvent(this.app.workspace.on("editor-change", () => this.queueSourceRefresh()));
    this.registerEvent(this.app.vault.on("modify", (file) => { if (file.path === this.activeFile()?.path) this.queueSourceRefresh(); }));
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

  activeFile(): TFile | null { return this.app.workspace.getActiveFile(); }
  noteKey(): string { return `${this.activeFile()?.path ?? "__no_note__"}#block-${this.selectedBlock}`; }

  async getSources(): Promise<RunnableSource[]> {
    const file = this.activeFile();
    if (!file || file.extension !== "md") return [];
    const text = await this.app.vault.read(file);
    return Array.from(text.matchAll(/^(`{3,})[ \t]*(java|python|py|javascript|js)(?:[ \t]+[^\r\n]*)?[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/gim), (match, index) => {
      const declaredLanguage = match[2].toLowerCase();
      const language: SupportedLanguage = declaredLanguage === "py" ? "python" : declaredLanguage === "js" ? "javascript" : declaredLanguage as SupportedLanguage;
      const code = match[3].trim();
      const publicClass = /public\s+(?:final\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(code)?.[1];
      const anyClass = /(?:public\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(code)?.[1];
      const startLine = text.slice(0, match.index ?? 0).split(/\r?\n/).length - 1;
      const endLine = startLine + match[0].split(/\r?\n/).length - 1;
      const name = language === "java" ? `${publicClass ?? anyClass ?? `Main${index + 1}`}.java` : language === "python" ? `main-${index + 1}.py` : `main-${index + 1}.js`;
      return { code, name, language, index, startLine, endLine };
    });
  }

  selectedCursorBlock(sources: RunnableSource[]): number {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const line = view?.editor?.getCursor().line;
    if (line !== undefined) {
      const cursorSource = sources.find(block => line >= block.startLine && line <= block.endLine);
      if (cursorSource) return cursorSource.index;
    }

    const clickedLine = this.plugin.clickedBlockLines.get(this.activeFile()?.path ?? "");
    if (clickedLine !== undefined) {
      const clickedSource = sources.find(block => clickedLine >= block.startLine && clickedLine <= block.endLine);
      if (clickedSource) return clickedSource.index;
    }

    const selectedText = window.getSelection()?.toString().trim();
    if (selectedText) {
      const normalized = selectedText.replace(/\r\n/g, "\n");
      const selectedSource = sources.find(block => block.code.replace(/\r\n/g, "\n").includes(normalized));
      if (selectedSource) return selectedSource.index;
    }
    return this.selectedBlock;
  }

  async pickClickedBlock(event: MouseEvent) {
    if (!(event.target instanceof HTMLElement)) return;
    const codeElement = event.target.closest("pre");
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.contentEl.contains(event.target)) return;
    const sources = await this.getSources();
    let source: RunnableSource | undefined;
    if (codeElement) {
      const renderedRunnableBlocks = Array.from(view.contentEl.querySelectorAll("pre")).filter(pre => {
        const classNames = pre.querySelector("code")?.className ?? "";
        return /language-(java|python|py|javascript|js)/i.test(classNames);
      });
      const clickedIndex = renderedRunnableBlocks.indexOf(codeElement);
      const clickedText = codeElement.innerText.trim().replace(/\s+/g, " ");
      source = clickedIndex >= 0 ? sources[clickedIndex] : sources.find(block => block.code.replace(/\s+/g, " ").includes(clickedText));
    }
    if (!source) {
      const clickedLine = view.editor?.getCursor().line;
      source = sources.find(block => clickedLine !== undefined && clickedLine >= block.startLine && clickedLine <= block.endLine);
    }
    if (!source || source.index === this.selectedBlock) return;
    this.selectedBlock = source.index;
    this.tests = [];
    this.bulkTests = [];
    this.activeTestTab = 0;
    this.bulkResult = undefined;
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
      this.bulkResult = undefined;
      await this.ensureTests();
    }
    this.render();
  }

  async ensureTests() {
    const key = this.noteKey();
    if (!this.tests.length && this.plugin.data.tests[key]) {
      this.tests = this.plugin.data.tests[key].map(t => ({ input: t.input, expected: t.expected }));
    }
    if (!this.bulkTests.length && this.plugin.data.bulkTests?.[key]) {
      this.bulkTests = this.plugin.data.bulkTests[key].map(t => ({ input: t.input, expected: t.expected }));
    }
    if (this.activeTestTab >= this.tests.length) {
      this.activeTestTab = Math.max(0, this.tests.length - 1);
    }
  }

  async saveTests() {
    this.plugin.data.tests[this.noteKey()] = this.tests.map(t => ({ input: t.input, expected: t.expected }));
    await this.plugin.saveData(this.plugin.data);
  }

  async saveBulkTests() {
    if (!this.plugin.data.bulkTests) this.plugin.data.bulkTests = {};
    this.plugin.data.bulkTests[this.noteKey()] = this.bulkTests.map(t => ({ input: t.input, expected: t.expected }));
    await this.plugin.saveData(this.plugin.data);
  }

  appendConsole(text: string) {
    this.output += text;
    if (this.consolePreEl) {
      this.consolePreEl.textContent = this.output;
      this.consolePreEl.scrollTop = this.consolePreEl.scrollHeight;
    }
  }

  sendTerminalInput(text: string) {
    if (!this.running || !this.running.stdin || this.running.killed) return;
    const line = text;
    this.appendConsole(line + "\n");
    try {
      this.running.stdin.write(line + "\n");
    } catch {
      // Process might have exited
    }
  }

  sendEOF() {
    if (!this.running || !this.running.stdin || this.running.killed) return;
    try {
      this.running.stdin.end();
      this.appendConsole("\n[EOF]\n");
    } catch {}
  }

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("code-runner-view");

    // Hero Section
    const hero = root.createDiv("code-runner-hero");
    const titleArea = hero.createDiv("code-runner-title-area");
    
    const titleHeader = titleArea.createDiv("code-runner-title-header");
    titleHeader.createEl("h2", { text: "Code Runner" });
    const badge = titleHeader.createSpan({ cls: "code-runner-dsa-badge", text: "Interactive IDE" });
    badge.title = "Terminal & DSA Workbench";

    titleArea.createEl("p", { text: this.activeFile()?.basename ?? "No active note", cls: "code-runner-subtitle" });

    // Primary Action Buttons in Hero
    const actions = hero.createDiv("code-runner-actions");
    const hasSample = this.tests.length > 0 && this.tests.some(t => t.input.trim() || t.expected.trim());
    const hasBulk = this.bulkTests.length > 0;
    const runBtnText = this.activeMode === "terminal" ? "▶ Run in Terminal"
      : (hasSample && hasBulk) ? "▶ Run All Tests"
      : hasBulk ? "▶ Run Bulk Tests"
      : "▶ Run Tests";

    const runBtn = actions.createEl("button", {
      text: runBtnText,
      cls: "mod-cta code-runner-btn-primary"
    });
    runBtn.onclick = () => {
      if (this.activeMode === "terminal") {
        void this.run(false, "", undefined, true);
      } else {
        void this.runUnifiedTests();
      }
    };

    const debugBtn = actions.createEl("button", { text: "🐛 Debug", cls: "code-runner-btn" });
    debugBtn.onclick = () => void this.run(true);

    const insertBtn = actions.createEl("button", { text: "↳ Insert", cls: "code-runner-btn" });
    insertBtn.title = "Insert last output below the code fence in note";
    insertBtn.onclick = () => void this.insertResult();

    const stopBtn = actions.createEl("button", { text: "■ Stop", cls: "code-runner-btn mod-warning" });
    stopBtn.onclick = () => this.stop();

    // 1. Code Block Selector Toolbar (Placed ABOVE mode switch)
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
        this.bulkResult = undefined;
        void this.ensureTests().then(() => this.render());
      };
      blockToolbar.createEl("button", { text: "Run all blocks", cls: "code-runner-btn-sm" }).onclick = () => void this.runAllBlocks();
    }

    // 2. Streamlined Top-Level Switch (Clean & Minimal: Terminal vs Test Cases, no counts)
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

    // 3. Active Section: Test Cases Section (with clean borderless sub-switch) or Terminal
    if (this.activeMode === "tests") {
      this.renderTestCasesSection(root);
    }

    // 4. Terminal / Console Area
    this.renderConsoleSection(root);

    // Footer Credit
    const credit = root.createDiv("code-runner-credit");
    credit.appendText("Code Runner by ");
    credit.createEl("a", {
      text: "SSKhekhaliya",
      href: AUTHOR_URL,
      attr: { target: "_blank", rel: "noopener noreferrer" }
    });
  }

  renderTestCasesSection(root: HTMLElement) {
    const container = root.createDiv("code-runner-tests-section");

    // Option A: Clean Underline Sub-Switch (No emojis, no counts, no border)
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

  renderDsaTestWorkbench(container: HTMLElement) {
    const wrapper = container.createDiv("code-runner-dsa-container");

    // Tab Header
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

      // Status indicator icon
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

    // Add Tab Button
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

    // Active Test Case Card
    const activeTest = this.tests[this.activeTestTab];
    if (activeTest) {
      const card = wrapper.createDiv("code-runner-card");

      // Card Header with Case Actions
      const cardHeader = card.createDiv("code-runner-card-header");
      const titleSpan = cardHeader.createSpan({
        cls: "code-runner-card-title",
        text: `Case ${this.activeTestTab + 1} of ${this.tests.length}`
      });
      
      if (activeTest.lastResult) {
        const badgeCls = activeTest.lastResult.status === "Accepted" ? "verdict-accepted"
          : activeTest.lastResult.status === "Time Limit Exceeded" ? "verdict-tle"
          : "verdict-failed";
        titleSpan.createSpan({
          cls: `code-runner-verdict-badge ${badgeCls}`,
          text: `${activeTest.lastResult.status} (${activeTest.lastResult.durationMs} ms)`
        });
      }

      const caseActions = cardHeader.createDiv("code-runner-card-actions");

      // Run this single case
      const runCaseBtn = caseActions.createEl("button", { text: "▶ Run Case", cls: "code-runner-btn-sm" });
      runCaseBtn.onclick = () => void this.runSingleTestCase(this.activeTestTab);

      // Copy input to clipboard
      const copyInputBtn = caseActions.createEl("button", { text: "📋 Copy", cls: "code-runner-btn-sm" });
      copyInputBtn.title = "Copy case input to clipboard";
      copyInputBtn.onclick = async () => {
        await navigator.clipboard.writeText(activeTest.input);
        new Notice(`Case ${this.activeTestTab + 1} input copied to clipboard.`);
      };

      // Remove Case (if more than 1)
      if (this.tests.length > 1) {
        const deleteBtn = caseActions.createEl("button", { text: "🗑️", cls: "code-runner-btn-icon" });
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

      // Input (Clean label: "Input")
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

      // Expected Output
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

      // If test has run, show Actual Output
      if (activeTest.lastResult) {
        card.createEl("label", { text: "Your Output", cls: "code-runner-field-label" });
        card.createEl("pre", {
          cls: `code-runner-actual-box ${activeTest.lastResult.status === "Accepted" ? "is-passed" : "is-failed"}`,
          text: activeTest.lastResult.output || (activeTest.lastResult.error ? `Error: ${activeTest.lastResult.error}` : "(no output)")
        });
      }
    }
  }

  renderBulkSuiteSection(container: HTMLElement) {
    const wrapper = container.createDiv("code-runner-bulk-container");

    // Hidden native file input for bulk upload
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
          this.bulkResult = undefined;
          this.bulkEditorOpen = false;
          await this.saveBulkTests();
          new Notice(`Loaded ${cases.length} bulk test cases from ${file.name}!`);
          this.render();
        } else {
          new Notice("Could not parse test cases from file. Format should be JSON or === CASE === delimited.");
        }
      } catch (err) {
        new Notice(`Failed to read file: ${String(err)}`);
      }
    };

    // Header & Actions
    const header = wrapper.createDiv("code-runner-bulk-header");
    const titleArea = header.createDiv("code-runner-bulk-title-area");
    titleArea.createEl("span", { text: "Bulk Test Suite", cls: "code-runner-bulk-title" });
    if (this.bulkTests.length > 0) {
      titleArea.createSpan({ text: `${this.bulkTests.length} cases`, cls: "code-runner-bulk-count" });
    }

    const tools = header.createDiv("code-runner-bulk-tools");
    const uploadBtn = tools.createEl("button", { text: "📁 Upload File", cls: "code-runner-btn-sm" });
    uploadBtn.title = "Upload .json or .txt test file";
    uploadBtn.onclick = () => fileInput.click();

    const editBtn = tools.createEl("button", {
      text: this.bulkEditorOpen ? "Close Editor" : "📋 Paste / Edit",
      cls: "code-runner-btn-sm"
    });
    editBtn.onclick = () => {
      this.bulkEditorOpen = !this.bulkEditorOpen;
      this.render();
    };

    if (this.bulkTests.length > 0) {
      const clearBtn = tools.createEl("button", { text: "🗑️ Clear", cls: "code-runner-btn-icon" });
      clearBtn.title = "Clear bulk test cases";
      clearBtn.onclick = async () => {
        this.bulkTests = [];
        this.bulkResult = undefined;
        await this.saveBulkTests();
        this.render();
      };
    }

    // Empty state helper when no cases loaded
    if (this.bulkTests.length === 0 && !this.bulkEditorOpen) {
      const emptyState = wrapper.createDiv("code-runner-bulk-empty");
      emptyState.createEl("p", {
        text: "No bulk test cases loaded yet. Click '📁 Upload File' or '📋 Paste / Edit' to import your test cases.",
        cls: "code-runner-subtitle"
      });
    }

    // Editor / Paste Box
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
      const importBtn = editorActions.createEl("button", { text: "📥 Import Pasted Cases", cls: "mod-cta code-runner-btn-sm" });
      importBtn.onclick = async () => {
        const parsed = parseBulkInput(this.bulkPasteText);
        if (parsed.length > 0) {
          this.bulkTests = parsed;
          this.bulkResult = undefined;
          this.bulkEditorOpen = false;
          this.bulkPasteText = "";
          await this.saveBulkTests();
          new Notice(`Successfully imported ${parsed.length} bulk test cases!`);
          this.render();
        } else {
          new Notice("Could not parse test cases. Please check format.");
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

    // Bulk Test Results Banner (Clean summary)
    if (this.bulkResult) {
      const res = this.bulkResult;
      const isSuccess = res.failed === 0;

      const banner = wrapper.createDiv(`code-runner-bulk-banner ${isSuccess ? "is-success" : "is-failure"}`);
      const bannerTop = banner.createDiv("code-runner-bulk-banner-top");
      bannerTop.createEl("span", {
        text: isSuccess ? `✅ All ${res.total} Bulk Cases Passed!` : `⚠️ ${res.passed}/${res.total} Passed (${res.failed} Failed)`,
        cls: "code-runner-bulk-verdict"
      });
      bannerTop.createEl("span", {
        text: `⏱ ${res.durationMs} ms`,
        cls: "code-runner-bulk-time"
      });

      // Visual Progress Bar
      const progressTrack = banner.createDiv("code-runner-bulk-progress");
      const passPercent = res.total > 0 ? (res.passed / res.total) * 100 : 0;
      const fillBar = progressTrack.createDiv("code-runner-bulk-progress-fill");
      fillBar.style.width = `${passPercent}%`;

      // If failed cases exist, list only their indices/reasons
      if (res.failedIndices.length > 0) {
        const failedSection = banner.createDiv("code-runner-bulk-failed-section");
        failedSection.createEl("div", { text: `Failed Cases (${res.failed}):`, cls: "code-runner-field-label" });
        const chipsList = failedSection.createDiv("code-runner-bulk-chips-list");
        res.failedIndices.forEach(item => {
          const chip = chipsList.createSpan("code-runner-failed-chip");
          chip.setText(`Case #${item.index} (${item.reason})`);
        });
      }
    }
  }

  renderConsoleSection(root: HTMLElement) {
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

    const copyBtn = tools.createEl("button", { text: "📋 Copy", cls: "code-runner-btn-sm" });
    copyBtn.title = "Copy console output to clipboard";
    copyBtn.onclick = async () => {
      if (this.output) {
        await navigator.clipboard.writeText(this.output);
        new Notice("Console output copied to clipboard.");
      }
    };

    const clearBtn = tools.createEl("button", { text: "Clear", cls: "code-runner-btn-sm" });
    clearBtn.onclick = () => {
      this.output = "";
      this.status = "Ready";
      this.diagnosticHint = null;
      this.render();
    };

    // Diagnostic hint box if available
    if (this.diagnosticHint) {
      const diagBox = consoleContainer.createDiv("code-runner-diagnostic-box");
      diagBox.createSpan({ text: "⚠️ Diagnostic: ", cls: "code-runner-diag-title" });
      diagBox.createSpan({ text: this.diagnosticHint, cls: "code-runner-diag-message" });
    }

    // Terminal wrapper containing screen & interactive prompt
    const terminalWrapper = consoleContainer.createDiv("code-runner-terminal-wrapper");
    this.consolePreEl = terminalWrapper.createEl("pre", {
      text: this.output || "(no output)",
      cls: `code-runner-console ${this.diagnosticHint ? "has-diagnostic" : ""}`
    });

    // Interactive Terminal Input Bar
    const terminalBar = terminalWrapper.createDiv("code-runner-terminal-bar");
    terminalBar.createSpan({ text: ">", cls: "code-runner-terminal-prompt" });

    this.terminalInputEl = terminalBar.createEl("input", {
      type: "text",
      cls: "code-runner-terminal-input",
      attr: {
        placeholder: this.isProcessRunning
          ? "Type input and press Enter..."
          : "Click 'Run in Terminal' to start interactive session...",
        ...(this.isProcessRunning ? {} : { disabled: "true" })
      }
    });

    const sendBtn = terminalBar.createEl("button", {
      text: "Send ↵",
      cls: "code-runner-btn-sm code-runner-terminal-send",
      attr: { ...(this.isProcessRunning ? {} : { disabled: "true" }) }
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

    // Status bar
    const statusBar = consoleContainer.createDiv({
      cls: `code-runner-status ${this.status.startsWith("Error") || this.status.includes("failed") ? "code-runner-error" : ""}`
    });
    statusBar.createSpan({ text: this.status });
  }

  async runSingleTestCase(index: number) {
    const test = this.tests[index];
    if (!test) return;
    this.status = `Running Case ${index + 1}…`;
    this.render();

    const result = await this.run(false, test.input, undefined, false);
    if (!result) return;

    const normActual = normalizeDsaOutput(result.output);
    const normExpected = normalizeDsaOutput(test.expected);

    let status: TestCaseStatus = "Wrong Answer";
    if (result.timedOut) {
      status = "Time Limit Exceeded";
    } else if (!result.ok) {
      status = "Runtime Error";
    } else if (normActual === normExpected) {
      status = "Accepted";
    }

    test.lastResult = {
      status,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs
    };

    this.diagnosticHint = getDsaDiagnosticHint(result.error, Boolean(test.input.trim()));
    this.status = `Case ${index + 1}: ${status} in ${result.durationMs} ms`;
    this.render();
  }

  async runUnifiedTests() {
    const hasSample = this.tests.length > 0 && this.tests.some(t => t.input.trim() || t.expected.trim());
    const hasBulk = this.bulkTests.length > 0;

    if (!hasSample && !hasBulk) {
      new Notice("Add at least one sample test case or bulk test case first.");
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
    const samplePassed = this.tests.filter(t => t.lastResult?.status === "Accepted").length;
    const sampleTotal = this.tests.length;
    const bulkPassed = this.bulkResult?.passed ?? 0;
    const bulkTotal = this.bulkResult?.total ?? 0;
    const allPassed = samplePassed === sampleTotal && (!bulkTotal || bulkPassed === bulkTotal);

    this.status = allPassed
      ? `All tests passed! 🎉 (${samplePassed}/${sampleTotal} sample, ${bulkPassed}/${bulkTotal} bulk)`
      : `Tests: ${samplePassed}/${sampleTotal} sample passed, ${bulkPassed}/${bulkTotal} bulk passed`;

    const summary = [
      "================ Unified Test Suite ================",
      `Sample Cases: ${samplePassed}/${sampleTotal} Passed`,
      `Bulk Cases:   ${bulkPassed}/${bulkTotal} Passed`,
      "----------------------------------------------------",
      `Verdict: ${allPassed ? "ALL TESTS PASSED 🎉" : "SOME TESTS FAILED ✗"}`,
      "===================================================="
    ];
    this.output = summary.join("\n") + "\n\n" + this.output;
    this.render();
  }

  async run(
    debug = false,
    input = "",
    blockIndex?: number,
    interactive = (this.activeMode === "terminal")
  ): Promise<RunResult | null> {
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
        this.status = `Debug server starting for block ${targetBlock + 1} on port 5005…`;
      } else if (source.language === "javascript") {
        this.status = `Node inspector starting for block ${targetBlock + 1} on port 9229…`;
      } else {
        this.status = `Running ${source.language} block ${targetBlock + 1}…`;
      }
    } else {
      this.status = interactive
        ? `Running ${source.language} in interactive terminal…`
        : `Running ${source.language} block ${targetBlock + 1}…`;
    }

    this.output = `${source.language === "java" ? "Compiling" : "Starting"} ${source.language} block ${targetBlock + 1}…\n`;
    this.diagnosticHint = null;
    this.isProcessRunning = true;
    this.render();

    let hasReceivedRuntimeOutput = false;

    const result = await runCode(this.app, this.activeFile()!, source, {
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

    this.running = undefined;
    this.isProcessRunning = false;

    // Set complete output
    if (interactive) {
      // In interactive mode, this.output already contains the live transcript with inputs echoed in place
      this.output = this.output.replace(/^(?:Compiling|Starting)\s+[^\n]*block\s+\d+…\r?\n?/i, "");
      if (result.error && !this.output.includes(result.error)) {
        this.output += (this.output.endsWith("\n") ? "" : "\n") + result.error;
      }
    } else {
      this.output = result.output + (result.error ? `${result.output ? "\n" : ""}${result.error}` : "");
    }
    this.lastRunBlock = targetBlock;
    this.lastRunResult = this.output;
    this.diagnosticHint = getDsaDiagnosticHint(result.error, Boolean(input.trim()));

    if (result.timedOut) {
      this.status = `Time Limit Exceeded after ${result.durationMs} ms`;
    } else {
      this.status = result.ok
        ? `Completed ${source.language} in ${result.durationMs} ms${source.language === "java" ? " · Java heap: 256 MB" : ""}`
        : `Error after ${result.durationMs} ms`;
    }

    await this.plugin.remember(this.noteKey(), result);
    await this.saveTests();
    this.render();
    return result;
  }

  async runTests(isPart = false) {
    await this.ensureTests();
    if (!this.tests.length) {
      if (!isPart) new Notice("Add at least one test case first.");
      return;
    }

    this.isRunningTests = true;
    const lines: string[] = ["================ Sample Test Cases ================"];
    let passed = 0;
    let totalTime = 0;

    for (let i = 0; i < this.tests.length; i++) {
      const test = this.tests[i];
      this.status = `Running Case ${i + 1} of ${this.tests.length}…`;
      this.render();

      const result = await this.run(false, test.input, undefined, false);
      if (!result) {
        this.isRunningTests = false;
        return;
      }

      totalTime += result.durationMs;
      const normActual = normalizeDsaOutput(result.output);
      const normExpected = normalizeDsaOutput(test.expected);

      let status: TestCaseStatus = "Wrong Answer";
      if (result.timedOut) {
        status = "Time Limit Exceeded";
      } else if (!result.ok) {
        status = "Runtime Error";
      } else if (normActual === normExpected) {
        status = "Accepted";
        passed++;
      }

      test.lastResult = {
        status,
        output: result.output,
        error: result.error,
        durationMs: result.durationMs
      };

      const icon = status === "Accepted" ? "✓" : "✗";
      lines.push(`${icon} Case ${i + 1}: ${status} (${result.durationMs} ms)`);
      if (status !== "Accepted") {
        if (test.expected.trim()) {
          lines.push(`   Expected: ${test.expected.trim().replace(/\n/g, "\n             ")}`);
        }
        lines.push(`   Actual:   ${(result.output.trim() || result.error.trim()).replace(/\n/g, "\n             ")}`);
      }
    }

    this.isRunningTests = false;
    lines.push("--------------------------------------------------");
    lines.push(`Verdict: ${passed}/${this.tests.length} Passed | Total Time: ${totalTime} ms`);
    lines.push("==================================================");

    this.output = lines.join("\n");
    this.status = passed === this.tests.length
      ? `All ${this.tests.length} cases Accepted 🎉 (${totalTime} ms)`
      : `${this.tests.length - passed} failed, ${passed} passed (${totalTime} ms)`;

    const firstFailedIndex = this.tests.findIndex(t => t.lastResult?.status !== "Accepted");
    if (firstFailedIndex >= 0) {
      this.activeTestTab = firstFailedIndex;
    }

    this.render();
  }

  async runBulkTests(isPart = false) {
    if (!this.bulkTests.length) {
      if (!isPart) new Notice("No bulk test cases loaded.");
      return;
    }

    this.isRunningBulk = true;
    this.bulkResult = undefined;
    this.status = `Running 0/${this.bulkTests.length} bulk cases…`;
    this.render();

    let passed = 0;
    let failed = 0;
    let totalTime = 0;
    const failedIndices: { index: number; reason: string }[] = [];

    for (let i = 0; i < this.bulkTests.length; i++) {
      const test = this.bulkTests[i];
      this.status = `Running bulk case ${i + 1}/${this.bulkTests.length}…`;
      if (i % 5 === 0 || i === this.bulkTests.length - 1) {
        this.render();
      }

      const result = await this.run(false, test.input, undefined, false);
      if (!result) {
        this.isRunningBulk = false;
        return;
      }

      totalTime += result.durationMs;
      const normActual = normalizeDsaOutput(result.output);
      const normExpected = normalizeDsaOutput(test.expected);

      if (result.timedOut) {
        failed++;
        failedIndices.push({ index: i + 1, reason: "Time Limit Exceeded" });
      } else if (!result.ok) {
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

    const passRate = Math.round((passed / this.bulkTests.length) * 100);
    this.status = `Bulk: ${passed}/${this.bulkTests.length} passed (${passRate}%) in ${totalTime} ms`;

    // Clean summary for console without heavy text dumps
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
      consoleLines.push("Failed: " + failedIndices.map(f => `#${f.index} (${f.reason})`).join(", "));
    } else {
      consoleLines.push("All bulk cases passed successfully! 🎉");
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
    if (!note || !source) { new Notice("Select a supported code block first."); return; }
    if (this.lastRunBlock !== targetBlock) { new Notice("Run this code block before inserting its result."); return; }
    const text = await this.app.vault.read(note);
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const longestBacktickRun = Math.max(0, ...(this.lastRunResult.match(/`+/g) ?? []).map(run => run.length));
    const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
    const cleanResult = this.lastRunResult
      .replace(/(?:\r?\n)+$/, "")
      .replace(/^(?:Compiling|Starting)\s+[^\n]*block\s+\d+…\r?\n?/i, "");
    const resultLines = cleanResult ? cleanResult.replace(/\r\n/g, "\n").split("\n") : ["(no output)"];
    lines.splice(source.endLine + 1, 0, "", `${fence}output`, ...resultLines, fence);
    await this.app.vault.modify(note, lines.join(eol));
    new Notice(`Inserted the result below code block ${targetBlock + 1}.`);
  }

  async runAllBlocks() {
    const sources = await this.getSources();
    if (!sources.length) { new Notice("No supported code blocks found in this note."); return; }
    const originalBlock = this.selectedBlock;
    const reports: string[] = [];
    for (const source of sources) {
      this.selectedBlock = source.index;
      const result = await this.run(false, "", source.index, false);
      reports.push(`=== ${source.language} block ${source.index + 1}: ${result?.ok ? "passed" : "failed"} ===\n${result?.output ?? "No result"}`);
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
}

async function runCode(
  app: App,
  note: TFile,
  source: RunnableSource,
  options: RunOptions
): Promise<RunResult> {
  const started = performance.now();
  const directory = await fs.mkdtemp(join(tmpdir(), "obsidian-code-runner-"));
  try {
    await fs.writeFile(join(directory, source.name), source.code, "utf8");

    // Copy companion folder if exists (<Note>.<ext>, <Note>.files, or <Note>.java)
    if (app.vault.adapter instanceof FileSystemAdapter) {
      const noteBase = parse(note.path).name;
      const langExt = source.language === "java" ? "java" : source.language === "python" ? "py" : "js";
      const basePath = app.vault.adapter.getBasePath();
      const noteDir = dirname(note.path);
      for (const folder of [`${noteBase}.${langExt}`, `${noteBase}.files`, `${noteBase}.java`]) {
        const extras = join(basePath, noteDir, folder);
        try { await fs.cp(extras, directory, { recursive: true }); } catch { /* Ignore if missing */ }
      }
    }

    if (source.language === "python") {
      // -u ensures unbuffered stdout so interactive prompts stream instantly!
      const executed = await invoke("python", ["-u", source.name], directory, options);
      const isOk = executed.code === 0 && !executed.timedOut;
      const err = executed.timedOut
        ? "Time Limit Exceeded. Check for infinite loops or unconsumed stdin."
        : executed.stderr;
      return result(isOk, executed.stdout, err, started, source.name, executed.timedOut);
    }
    if (source.language === "javascript") {
      const args = options.debug ? ["--inspect=9229", source.name] : [source.name];
      const executed = await invoke("node", args, directory, options);
      const isOk = executed.code === 0 && !executed.timedOut;
      const err = executed.timedOut
        ? "Time Limit Exceeded. Check for infinite loops or unconsumed stdin."
        : executed.stderr;
      return result(isOk, executed.stdout, err, started, source.name, executed.timedOut);
    }

    // Java compilation and execution
    const files = await collectJavaFiles(directory);
    const compileOptions: RunOptions = { onProcess: options.onProcess };
    const compiled = await invoke("javac", ["-encoding", "UTF-8", "-d", directory, ...files], directory, compileOptions);
    if (compiled.code !== 0) return result(false, "", compiled.stderr || compiled.stdout || "Java compilation failed.", started, source.name);
    
    const args = ["-Xmx256m", "-cp", directory];
    if (options.debug) args.push("-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005");
    args.push(basename(source.name, ".java"));
    const executed = await invoke("java", args, directory, options);
    const isOk = executed.code === 0 && !executed.timedOut;
    const err = executed.timedOut
      ? "Time Limit Exceeded. Check for infinite loops or unconsumed stdin."
      : executed.stderr;
    return result(isOk, executed.stdout, err, started, source.name, executed.timedOut);
  } catch (e) {
    const executable = source.language === "python" ? "Python" : source.language === "javascript" ? "Node.js" : "a Java JDK";
    return result(false, "", `Could not start ${source.language}. Ensure ${executable} is installed and available on PATH.\n${String(e)}`, started);
  } finally {
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch {
      // Best effort cleanup if process hasn't fully released file handle on Windows
    }
  }
}

function result(ok: boolean, output: string, error: string, started: number, sourceName?: string, timedOut = false): RunResult {
  return { ok, output, error, durationMs: Math.round(performance.now() - started), sourceName, timedOut };
}

async function collectJavaFiles(folder: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(path: string) {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name.endsWith(".java")) files.push(target);
    }
  }
  await visit(folder);
  return files;
}

function invoke(
  command: string,
  args: string[],
  cwd: string,
  options: RunOptions
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    options.onProcess?.(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const isInteractive = Boolean(options.interactive);
    const timeoutDuration = isInteractive ? 180_000 : DEFAULT_TIMEOUT_MS;

    let timer: NodeJS.Timeout | undefined;
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

    child.stdout?.on("data", (d: Buffer) => {
      const str = d.toString();
      stdout += str;
      options.onData?.(str);
      resetTimer();
    });

    child.stderr?.on("data", (d: Buffer) => {
      const str = d.toString();
      stderr += str;
      options.onData?.(str);
      resetTimer();
    });

    const finish = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve({ code, stdout, stderr, timedOut });
    };

    child.on("error", err => finish(null, err));
    child.on("close", code => finish(code));

    child.stdin?.on("error", () => { /* Suppress EPIPE when child exits before reading stdin */ });

    if (options.input) {
      child.stdin?.write(options.input);
    }

    if (!isInteractive) {
      child.stdin?.end();
    }
  });
}
