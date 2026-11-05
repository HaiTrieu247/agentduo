// The files the composer reads itself (pasted, dropped) on their way to the host. Each FileReader finishes when it
// does: a file goes to the host only after those given before it, so the files keep the order they were given in; and
// the composer waits for each until the host shows it (attaching, stored or failed), so a message sent meanwhile
// cannot go without it and leave it for the next one. Until then a file lives only in this page, so the page is
// reloaded (VS Code reloads a webview whose options change) only once the queue has let go of every file.

/** What the queue needs of a FileReader (a test gives it one it finishes by hand). */
export interface FileReading {
  readonly result: string | ArrayBuffer | null;
  // Their events are not read: `never` lets a FileReader's handlers, which take one, stand here.
  onload: ((event: never) => unknown) | null;
  onerror: ((event: never) => unknown) | null;
  readAsDataURL(file: Blob): void;
}

export interface QueuedFile {
  key: string;
  name: string;
  /** Gone to the host, which does not show it yet. */
  sent: boolean;
}

export interface FileQueueOptions {
  reader(): FileReading;
  /** A file read, in its turn: its bytes go to the host as base64. */
  send(file: { key: string; name: string; data: string }): void;
  /** A file read, its turn come or not (its preview). */
  read?(key: string, data: string): void;
  /** A file the webview could not read: it leaves the queue. */
  failed(name: string): void;
  /** The files waited for changed: one added, failed, removed, or shown by the host. */
  changed(): void;
}

export class FileQueue {
  private files: Array<QueuedFile & { data: string | null }> = [];
  /** The page is to be reloaded: called once no file is left here. */
  private leaving: (() => void) | null = null;
  /** The page said it may be reloaded: it may go any moment, so it takes no more files. */
  private left = false;

  constructor(private readonly o: FileQueueOptions) {}

  /** The files the composer waits for, in the order given. */
  get waiting(): QueuedFile[] {
    return this.files.map(({ key, name, sent }) => ({ key, name, sent }));
  }

  get size(): number {
    return this.files.length;
  }

  /** False when the page is about to be reloaded: the file is not taken (it would be lost with the page). */
  add(key: string, name: string, file: Blob): boolean {
    if (this.left) return false;
    const entry: QueuedFile & { data: string | null } = { key, name, sent: false, data: null };
    this.files.push(entry);
    const reader = this.o.reader();
    reader.onload = () => {
      if (!this.files.includes(entry)) return; // removed while it was read
      const url = String(reader.result ?? "");
      entry.data = url.slice(url.indexOf(",") + 1);
      this.o.read?.(key, entry.data);
      this.flush();
    };
    reader.onerror = () => {
      if (!this.drop(key)) return;
      this.o.failed(name);
      this.flush();
    };
    this.o.changed();
    reader.readAsDataURL(file);
    return true;
  }

  /**
   * The host is to reload the page: `done` is called once no file is left here, at once or when the host shows the
   * last one (or it is removed, or cannot be read). Files added meanwhile are waited for too; once `done` is called
   * the queue takes none.
   */
  release(done: () => void): void {
    this.leaving = done;
    this.check();
  }

  /** Removed with its ✕: true when the host has it already, and should let go of it too. */
  remove(key: string): boolean {
    const entry = this.files.find((f) => f.key === key);
    if (!entry) return false;
    this.drop(key);
    this.flush();
    return entry.sent;
  }

  /** The host shows these files now: the composer no longer waits for them. */
  settle(shown: ReadonlySet<string>): void {
    const before = this.files.length;
    this.files = this.files.filter((f) => !f.sent || !shown.has(f.key));
    if (this.files.length !== before) this.o.changed();
    this.check();
  }

  private drop(key: string): boolean {
    const before = this.files.length;
    this.files = this.files.filter((f) => f.key !== key);
    if (this.files.length === before) return false;
    this.o.changed();
    this.check();
    return true;
  }

  private check(): void {
    if (!this.leaving || this.files.length) return;
    const done = this.leaving;
    this.leaving = null;
    this.left = true;
    done();
  }

  private flush(): void {
    let sent = false;
    for (const f of this.files) {
      if (f.sent) continue;
      if (f.data === null) break; // still being read: those after it wait for it
      const data = f.data;
      f.data = "";
      f.sent = true;
      sent = true;
      this.o.send({ key: f.key, name: f.name, data });
    }
    if (sent) this.o.changed();
  }
}
