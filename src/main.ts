import { App, FileSystemAdapter, ItemView, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { ChildProcess, spawn } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, parse } from "path";

const VIEW_TYPE_CODE_RUNNER = "obsidian-code-runner";
const DEFAULT_TIMEOUT_MS = 10_000;
const AUTHOR_URL = "https://www.sskhekhaliya.in/";

interface CodeTestCase { input: string; expected: string; }
interface SavedData { tests: Record<string, CodeTestCase[]>; history: Record<string, RunSummary[]>; }
interface RunSummary { at: string; ok: boolean; durationMs: number; }
interface RunResult { ok: boolean; output: string; error: string; durationMs: number; sourceName?: string; }
type SupportedLanguage = "java" | "python" | "javascript";
interface RunnableSource { code: string; name: string; language: SupportedLanguage; index: number; startLine: number; endLine: number; }

export default class CodeRunnerPlugin extends Plugin {
  data: SavedData = { tests: {}, history: {} };
  clickedBlockLines = new Map<string, number>();

  async onload() {
    this.data = Object.assign({ tests: {}, history: {} }, await this.loadData());
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
  stdin = "";
  output = "Select a note containing a supported fenced code block, then press Run.";
  status = "Ready";
  tests: CodeTestCase[] = [];
  selectedBlock = 0;
  sourceCount = 0;
  blockClickListening = false;
  lastRunBlock?: number;
  lastRunResult = "";
  refreshTimer?: number;
  running?: ChildProcess;

  constructor(leaf: WorkspaceLeaf, plugin: CodeRunnerPlugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE_CODE_RUNNER; }
  getDisplayText() { return "Code Runner"; }
  getIcon() { return "terminal-square"; }

  async onOpen() {
    this.registerEvent(this.app.workspace.on("file-open", () => { this.tests = []; void this.refreshBlocks(true); }));
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
    if (selectionChanged || force) { this.tests = []; await this.ensureTests(); }
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
    title.createEl("p", { text: "Java · Python · JavaScript", cls: "code-runner-subtitle" });

    const actions = hero.createDiv("code-runner-actions");
    const run = actions.createEl("button", { text: "▶ Run", cls: "mod-cta" });
    run.onclick = () => void this.run();
    const debug = actions.createEl("button", { text: "🐛 Debug" });
    debug.onclick = () => void this.run(true);
    const insert = actions.createEl("button", { text: "↳ Insert result" });
    insert.onclick = () => void this.insertResult();
    const stop = actions.createEl("button", { text: "■ Stop" });
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

  renderTests(root: HTMLElement) {
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

      row.createEl("button", { text: "×", attr: { "aria-label": "Remove test" } }).onclick = () => {
        this.tests.splice(index, 1);
        void this.saveTests();
        this.render();
      };
    });
  }

  async ensureTests() {
    const key = this.noteKey();
    if (!this.tests.length && this.plugin.data.tests[key]) {
      this.tests = this.plugin.data.tests[key].map(t => ({ ...t }));
    }
  }

  async saveTests() {
    this.plugin.data.tests[this.noteKey()] = this.tests;
    await this.plugin.saveData(this.plugin.data);
  }

  async run(debug = false, input = this.stdin, blockIndex?: number): Promise<RunResult | null> {
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
        this.status = `Debug server starting for block ${targetBlock + 1} on port 5005…`;
      } else if (source.language === "javascript") {
        this.status = `Node inspector starting for block ${targetBlock + 1} on port 9229…`;
      } else {
        this.status = `Running ${source.language} block ${targetBlock + 1}…`;
      }
    } else {
      this.status = `Running ${source.language} block ${targetBlock + 1}…`;
    }

    this.output = `${source.language === "java" ? "Compiling" : "Starting"} ${source.language} block ${targetBlock + 1}…`;
    this.render();

    const result = await runCode(this.app, this.activeFile()!, source, input, debug, child => this.running = child);
    this.running = undefined;
    this.output = result.output + (result.error ? `${result.output ? "\n" : ""}${result.error}` : "");
    this.lastRunBlock = targetBlock;
    this.lastRunResult = this.output;
    this.status = result.ok ? `Completed ${source.language} in ${result.durationMs} ms${source.language === "java" ? " · Java heap limit: 256 MB" : ""}` : `Error after ${result.durationMs} ms`;
    await this.plugin.remember(this.noteKey(), result);
    await this.saveTests();
    this.render();
    return result;
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
    const cleanResult = this.lastRunResult.replace(/(?:\r?\n)+$/, "");
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
      const result = await this.run(false, this.stdin, source.index);
      reports.push(`=== ${source.language} block ${source.index + 1}: ${result?.ok ? "passed" : "failed"} ===\n${result?.output ?? "No result"}`);
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
    if (!this.tests.length) { new Notice("Add at least one test case first."); return; }
    const lines: string[] = [];
    let passed = 0;
    for (let i = 0; i < this.tests.length; i++) {
      const test = this.tests[i];
      const result = await this.run(false, test.input);
      if (!result) return;
      const actual = result.output.trim();
      const ok = result.ok && actual === test.expected.trim();
      if (ok) passed++;
      lines.push(`${ok ? "✓" : "✗"} Case ${i + 1}${ok ? " passed" : ` failed\n  expected: ${test.expected}\n  actual: ${actual}`}`);
    }
    this.output = `${lines.join("\n")}\n\n${passed}/${this.tests.length} test cases passed.`;
    this.status = passed === this.tests.length ? "All tests passed" : `${this.tests.length - passed} test case(s) failed`;
    this.render();
  }
}

async function runCode(app: App, note: TFile, source: RunnableSource, input: string, debug: boolean, onProcess: (child: ChildProcess) => void): Promise<RunResult> {
  const started = performance.now();
  const directory = await fs.mkdtemp(join(tmpdir(), "obsidian-code-runner-"));
  try {
    await fs.writeFile(join(directory, source.name), source.code, "utf8");

    // Copy helper files if companion folder exists (<Note>.<ext>, <Note>.files, or <Note>.java)
    if (app.vault.adapter instanceof FileSystemAdapter) {
      const noteBase = parse(note.path).name;
      const langExt = source.language === "java" ? "java" : source.language === "python" ? "py" : "js";
      const basePath = app.vault.adapter.getBasePath();
      const noteDir = dirname(note.path);
      for (const folder of [`${noteBase}.${langExt}`, `${noteBase}.files`, `${noteBase}.java`]) {
        const extras = join(basePath, noteDir, folder);
        try { await fs.cp(extras, directory, { recursive: true }); } catch { /* Ignore if directory doesn't exist */ }
      }
    }

    if (source.language === "python") {
      const executed = await invoke("python", [source.name], input, directory, onProcess);
      return result(executed.code === 0, executed.stdout, executed.stderr, started, source.name);
    }
    if (source.language === "javascript") {
      const args = debug ? ["--inspect=9229", source.name] : [source.name];
      const executed = await invoke("node", args, input, directory, onProcess);
      return result(executed.code === 0, executed.stdout, executed.stderr, started, source.name);
    }

    // Java compilation and execution
    const files = await collectJavaFiles(directory);
    const compiled = await invoke("javac", ["-encoding", "UTF-8", "-d", directory, ...files], "", directory, onProcess);
    if (compiled.code !== 0) return result(false, "", compiled.stderr || compiled.stdout, started, source.name);
    const args = ["-Xmx256m", "-cp", directory];
    if (debug) args.push("-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005");
    args.push(basename(source.name, ".java"));
    const executed = await invoke("java", args, input, directory, onProcess);
    return result(executed.code === 0, executed.stdout, executed.stderr, started, source.name);
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

function result(ok: boolean, output: string, error: string, started: number, sourceName?: string): RunResult {
  return { ok, output, error, durationMs: Math.round(performance.now() - started), sourceName };
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

function invoke(command: string, args: string[], input: string, cwd: string, onProcess: (child: ChildProcess) => void): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    onProcess(child);
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", d => stdout += d);
    child.stderr?.on("data", d => stderr += d);

    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
    }, DEFAULT_TIMEOUT_MS);

    const finish = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ code, stdout, stderr });
    };

    child.on("error", err => finish(null, err));
    child.on("close", code => finish(code));

    child.stdin?.on("error", () => { /* Suppress EPIPE when child exits before reading stdin */ });
    if (input) {
      child.stdin?.write(input);
    }
    child.stdin?.end();
  });
}
