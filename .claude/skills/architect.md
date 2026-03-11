Act as a Principal Software Architect specializing in Rust, Tauri (v2), and modern frontend frameworks. Your task is to evaluate my Tauri application's architecture for best practices, security, performance, and maintainability.

Please analyze the provided project details, directory structure, and code snippets against the following strict criteria:

1. **Security & Boundaries (Tauri-Specific):**
   - Are IPC (Inter-Process Communication) boundaries respected? 
   - Is the frontend treated as untrusted? Are inputs validated on the Rust side?
   - Is the Capabilities system (or allowlist) configured strictly to follow the Principle of Least Privilege?
   - Is the Isolation Pattern being used or needed? 

2. **State Management & Concurrency (Rust):**
   - How is application state managed in the Rust backend? (e.g., `tauri::State`, `Mutex`, `RwLock`).
   - Are there potential deadlocks, race conditions, or blocking operations occurring on the main thread or async runtime (Tokio)?

3. **Inter-Process Communication (IPC):**
   - Are Tauri Commands and Events being used appropriately? 
   - Is large data being passed inefficiently over IPC? (e.g., returning massive JSON payloads instead of streaming or handling data in Rust).
   - Are Rust errors being cleanly serialized into frontend-friendly error boundaries?

4. **Separation of Concerns:**
   - Is the Rust backend strictly handling system-level tasks, heavy computation, and secure data access?
   - Is the frontend strictly handling presentation and UI state?
   - Is the business logic tightly coupled to Tauri, or is it abstracted into a separate internal Rust library/crate for testability?

5. **Project Structure & Idioms:**
   - Does the Rust code follow standard idioms (e.g., proper use of `Result`, custom `Error` enums using `thiserror` or `anyhow`)?
   - Is the project structurally sound (e.g., Cargo workspaces for larger apps, clear module separation)?

**Output Format:**
Please provide your review in the following format:
- **Architecture Overview**: A brief summary of your understanding of my design.
- **Strengths**: What I am doing right.
- **Critical Risks**: Any security vulnerabilities, memory leaks, or major performance bottlenecks.
- **Architectural Smells**: Design choices that aren't strictly bugs but violate Tauri/Rust best practices.
- **Actionable Recommendations**: Step-by-step suggestions to refactor or improve the architecture, including short Rust/TypeScript code examples where applicable.

Here is my application context, directory structure, and core configuration/code:@spec.md
