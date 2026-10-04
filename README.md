# Code Runner

A high-performance desktop plugin for **[Obsidian](https://obsidian.md)** developed by **[SSKhekhaliya](https://www.sskhekhaliya.in/)** that lets you execute, test, debug, and inspect **Java**, **Python**, and **JavaScript** code fences directly inside your notes.

Perfect for Data Structures & Algorithms (DSA), competitive programming, note-taking, educational walkthroughs, and rapid prototyping.

---

## ✨ Features

- **🚀 Multi-Language Support**:
  - **Java**: Compiles and executes Java 17+ code using local `javac` and `java` runtimes with a 256 MB memory ceiling (`-Xmx256m`).
  - **Python**: Runs Python 3 scripts with the local `python` interpreter.
  - **JavaScript**: Executes modern JavaScript using local `node`.
- **🖱️ Smart Block Detection**:
  - Click any code fence in **Live Preview** or **Reading View**, or simply place your cursor inside a block in the editor to select it.
  - Supports 3-backtick and 4-backtick fences (`java`, `python`/`py`, `javascript`/`js`), case-insensitively with optional fence attributes.
- **📥 Standard Input (stdin) Console**:
  - Send custom standard input (`System.in`, `sys.stdin`, `process.stdin`) directly via the integrated input panel.
- **🧪 Built-in DSA Test-Case Runner**:
  - Add multiple input and expected output test cases.
  - Run all test cases in batch with pass/fail badges, expected vs. actual output diffs, and aggregate summaries.
  - **Persistent**: Test cases and execution history are automatically saved per note and per code block.
- **🗂️ Multi-File Project Support**:
  - Organize complex code into helper files! Create a companion folder named `<Note-Name>.<ext>/` (e.g. `MyNote.java/`, `MyNote.py/`, `MyNote.js/`) or `<Note-Name>.files/` alongside your note, and the runner will automatically copy helper modules and compile/include them at runtime.
- **🐛 Interactive Debugging**:
  - Start Java code with **Debug** mode to enable JDWP socket debugging on port `5005` (`-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005`).
  - Start JavaScript code with **Debug** mode to enable Node.js Inspector on port `9229` (`--inspect=9229`).
- **↳ Insert Output into Note**:
  - Automatically insert execution results beneath your code fence as a formatted ```` ```output ```` block with a single click.
- **⚡ Multiple Code Blocks in One Note**:
  - Switch between different code fences via a dropdown selector, or click **Run all** to sequentially execute every runnable block in the note.
- **🛡️ Process Control & Safety Guard**:
  - One-click **Stop** button to terminate running processes.
  - Built-in 10-second timeout prevents infinite loops from hanging your system.

---

## 📋 Prerequisites

Because Obsidian Code Runner runs your code locally on your machine, you must have the relevant runtimes installed and added to your system `PATH`:

| Language | Required Runtime | Verification Command |
| :--- | :--- | :--- |
| **Java** | JDK 17 or higher (`javac` & `java`) | `javac -version` and `java -version` |
| **Python** | Python 3.x (`python`) | `python --version` |
| **JavaScript** | Node.js (`node`) | `node -v` |

> [!NOTE]
> This plugin is **Desktop only** (Windows, macOS, Linux) as it invokes local runtime processes.

---

## 🚀 Getting Started

### 1. Opening the Runner Pane

You can open the Code Runner sidebar in three ways:
1. **Ribbon Icon**: Click the terminal icon (`terminal-square`) in the left ribbon.
2. **Command Palette**: Press `Ctrl+P` (or `Cmd+P` on macOS) and run `Code Runner: Open Code Runner`.
3. **Quick Run**: Run `Code Runner: Run active code block` to open the view and execute the block immediately.

### 2. Supported Code Fences

Add standard Markdown code fences to your note:

#### Java Example
````markdown
```java
import java.util.Scanner;

public class Solution {
    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        int n = scanner.nextInt();
        System.out.println("Fibonacci(" + n + ") = " + fib(n));
    }

    private static int fib(int n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
    }
}
```
````

#### Python Example
````markdown
```python
import sys

def main():
    lines = sys.stdin.read().split()
    if lines:
        print(f"Processed: {[int(x) * 2 for x in lines]}")
    else:
        print("Hello from Python in Obsidian!")

if __name__ == "__main__":
    main()
```
````

#### JavaScript Example
````markdown
```javascript
const fs = require('fs');

const input = fs.readFileSync(0, 'utf-8').trim();
if (input) {
  const nums = input.split(/\s+/).map(Number);
  console.log("Sum:", nums.reduce((a, b) => a + b, 0));
} else {
  console.log("Hello from Node.js in Obsidian!");
}
```
````

---

## 💡 How-To Guides

### Using the Test Case Runner

1. Click **+ Add test case** in the toolbar.
2. Enter the input passed to standard input and the expected output.
3. Click **Run test cases**.
4. The output console displays each test case result:
   - `✓ Case 1 passed`
   - `✗ Case 2 failed` with side-by-side expected and actual output.
5. All test cases are saved automatically in plugin storage for that specific note and code block.

### Multi-File Projects

When solving complex problems or building modular examples, you don't have to cram everything into a single Markdown code fence:

1. Suppose your note is named `Algorithms.md`.
2. Create a companion folder right next to it:
   - For Java: `Algorithms.java/` (e.g. `Algorithms.java/Helper.java`)
   - For Python: `Algorithms.py/` (e.g. `Algorithms.py/utils.py`)
   - For JavaScript: `Algorithms.js/` (e.g. `Algorithms.js/helpers.js`)
   - Or universally: `Algorithms.files/`
3. Write your main entry point in the Markdown note's code block.
4. When you click **Run**, Code Runner copies companion files into the temporary sandbox, compiles auxiliary Java files if applicable, and executes your code cleanly.

### Connecting an External Debugger

1. Click **🐛 Debug** instead of Run.
2. For **Java**: The JVM launches with JDWP listening on port `5005`:
   ```bash
   -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005
   ```
   Attach VS Code or IntelliJ IDEA via a remote JVM debug configuration on `localhost:5005`.
3. For **JavaScript**: Node.js launches with the V8 Inspector listening on port `9229`:
   ```bash
   --inspect=9229
   ```
   Attach Chrome DevTools (`chrome://inspect`) or VS Code's Node debugger.

### Inserting Output Directly into Your Note

After running your code, click the **↳ Insert result** button. The plugin automatically inserts the output beneath your code block as:
````markdown
```output
Fibonacci(10) = 55
```
````
It even handles output containing backticks by dynamically sizing outer fence delimiters.

---

## 🛠️ Development & Building

To build the plugin from source:

```bash
# 1. Clone the repository
git clone https://github.com/SSKhekhaliya/obsidian-code-runner.git

# 2. Install dependencies
npm install

# 3. Build for development (watch mode)
npm run dev

# 4. Or produce a production bundle
npm run build

# 5. Type-check TypeScript
npm run check
```

### Installing into an Obsidian Vault

1. Ensure you have built the plugin with `npm run build`.
2. Locate your vault's plugin directory:
   `<vault>/.obsidian/plugins/obsidian-code-runner/`
3. Copy the following files into that directory:
   - `manifest.json`
   - `main.js`
   - `styles.css`
4. In Obsidian, go to **Settings > Community plugins**, reload installed plugins, and toggle on **Code Runner**.

---

## 🔍 Troubleshooting

- **`Could not start python / node / java. Ensure ... is installed and available on PATH.`**:
  - Verify your runtime executable is in your system's global `PATH` environment variable.
  - On macOS/Linux, if you launch Obsidian from a GUI launcher, your user shell profile (`~/.zshrc`, `~/.bashrc`) might not be sourced. Ensure standard paths like `/usr/local/bin` or `/opt/homebrew/bin` are accessible.
- **Process times out**:
  - The plugin stops execution after 10 seconds to safeguard against infinite loops or blocking stdin. You can also press **■ Stop** at any time.
- **Class naming in Java**:
  - If your Java fence defines a public class (e.g. `public class Solution`), Code Runner names the file `Solution.java`.
  - If no public class is specified, it uses any class declared or defaults to `Main<N>.java`.

---

## 📄 License & Credits

- **Author**: [SSKhekhaliya](https://www.sskhekhaliya.in/)
- Built for the [Obsidian](https://obsidian.md) community.
