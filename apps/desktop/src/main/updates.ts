// The app updating itself from the GitHub Releases that .github/workflows/release.yml publishes: electron-updater
// reads the release's feed (latest.yml, latest-mac.yml, latest-linux.yml), downloads the new version in the
// background, and installs it when the user restarts into it (or quits). A build that cannot replace itself (a Mac
// app without a Developer ID signature, a test run) only says a newer version is out; the user downloads it from the
// release page. No Electron import: the updater comes in as `Updater`, so this is tested as is.
import { execFile } from "node:child_process";
import type { UpdateState } from "../shared/protocol.js";

/** The part of electron-updater's AppUpdater used here. */
export interface Updater {
  autoDownload: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string }; downloadPromise?: Promise<unknown> | null } | null>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** How this build gets a new version: it installs it, it only tells (and why), or it never looks (and why). */
export type UpdateMode = { kind: "install" } | { kind: "notify"; reason: string } | { kind: "off"; reason: string };

export function updateMode(o: { packaged: boolean; platform: NodeJS.Platform; testProfile: boolean; testFeed: string | null; developerId: boolean }): UpdateMode {
  // Tests run with a profile of their own: they look only at a feed they name, and install nothing.
  if (o.testProfile) return o.testFeed ? { kind: "notify", reason: "This run checks a test feed and installs nothing." } : { kind: "off", reason: "Updates are off while AgentDuo runs with a test profile." };
  if (!o.packaged) return { kind: "off", reason: "This is a development build: updates come with an installed AgentDuo." };
  // Squirrel.Mac installs only an update signed by the same Developer ID as the running app.
  if (o.platform === "darwin" && !o.developerId) return { kind: "notify", reason: "This copy is not signed with a Developer ID, so macOS does not let it replace itself." };
  return { kind: "install" };
}

/** `codesign -dv` of a Mac app names a Developer ID authority only when it is signed with one (not ad hoc). */
export function developerIdSigned(codesignOutput: string): boolean {
  return /^Authority=Developer ID Application: /m.test(codesignOutput);
}

/** Whether the Mac app bundle at `bundle` is signed with a Developer ID (false when codesign cannot tell). */
export function macDeveloperId(bundle: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/codesign", ["-dv", "--verbose=2", bundle], { timeout: 5000 }, (error, stdout, stderr) => resolve(!error && developerIdSigned(`${stdout}\n${stderr}`)));
  });
}

/** What the user reads when a check or a download fails: electron-updater's errors carry stacks and HTTP headers. */
export function updateErrorText(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  const message = e instanceof Error ? e.message : String(e);
  // GitHub answers a repository with no release yet in several ways; the feed's error wraps the lookup's.
  if (code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS" || code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" || /No published versions on GitHub|Unable to find latest version on GitHub/.test(message)) return "No AgentDuo release is published on GitHub yet.";
  if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND") return "The latest release has no installer for this system yet.";
  if (/net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_\w+|TIMED_OUT|ADDRESS_UNREACHABLE)|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(message)) return "Could not reach GitHub. Check your connection.";
  if (/rate limit/i.test(message)) return "GitHub is limiting requests for now. Try again later.";
  const first = message.split("\n")[0]!.trim() || "Unknown error";
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

/** The first check comes a little after the app starts, then one every few hours while it runs. */
export const FIRST_CHECK_MS = 15_000;
export const CHECK_PERIOD_MS = 4 * 60 * 60 * 1000;

export interface UpdatesOptions {
  mode: UpdateMode;
  /** electron-updater's updater; null when the mode is off. */
  updater: Updater | null;
  /** The state changed: the window shows it. */
  post(state: UpdateState): void;
  log(line: string): void;
  /** Asks the app to quit; at quit, once its work is settled, it calls `installAtQuit`. */
  quit(): void;
  now?(): Date;
}

export class Updates {
  private current: UpdateState;
  private checking: Promise<UpdateState> | null = null;
  private first: NodeJS.Timeout | null = null;
  private period: NodeJS.Timeout | null = null;
  private restart = false;
  private errors = 0;

  constructor(private readonly o: UpdatesOptions) {
    this.current = o.mode.kind === "off" || !o.updater ? { status: "off", reason: o.mode.kind === "off" ? o.mode.reason : "This build does not update itself." } : { status: "idle" };
    const u = o.updater;
    if (!u || o.mode.kind === "off") return;
    // Downloads only where the build can install; it installs when the user restarts into it, or quits.
    u.autoDownload = o.mode.kind === "install";
    u.on("download-progress", (p) => {
      const percent = Math.floor(p.percent);
      if (this.current.status === "downloading" && percent !== this.current.percent) this.set({ ...this.current, percent });
    });
    // An EventEmitter without an error listener throws. A check's error is its promise's; one after it (a download,
    // Squirrel.Mac taking the update) is the state's.
    u.on("error", (e) => {
      this.errors++;
      o.log(`update: ${updateErrorText(e)}`);
      if (this.current.status === "downloading" || this.current.status === "ready") this.fail(e);
    });
  }

  get state(): UpdateState {
    return this.current;
  }

  /** Checks on a timer while `auto` is on (the preference); a check can always be asked for. */
  setAuto(auto: boolean): void {
    this.stopTimers();
    if (!auto || this.current.status === "off") return;
    this.first = setTimeout(() => void this.check(), FIRST_CHECK_MS);
    this.period = setInterval(() => void this.check(), CHECK_PERIOD_MS);
    this.first.unref?.();
    this.period.unref?.();
  }

  /** Looks for a newer version now (one check at a time); while one downloads or waits to be installed, says so. */
  check(): Promise<UpdateState> {
    const u = this.o.updater;
    if (!u || this.current.status === "off" || this.current.status === "downloading" || this.current.status === "ready") return Promise.resolve(this.current);
    this.checking ??= this.run(u).finally(() => (this.checking = null));
    return this.checking;
  }

  private async run(u: Updater): Promise<UpdateState> {
    this.set({ status: "checking" });
    try {
      const r = await u.checkForUpdates();
      if (!r) return this.set({ status: "off", reason: "This copy of AgentDuo cannot update itself: it was not installed by an AgentDuo installer." });
      const at = (this.o.now?.() ?? new Date()).toISOString();
      if (!r.isUpdateAvailable) return this.set({ status: "latest", checkedAt: at });
      const version = r.updateInfo.version;
      this.o.log(`update: AgentDuo ${version} is out`);
      if (this.o.mode.kind !== "install" || !r.downloadPromise) return this.set({ status: "manual", version, reason: this.o.mode.kind === "notify" ? this.o.mode.reason : "This build does not download updates." });
      r.downloadPromise.then(() => {
        this.o.log(`update: AgentDuo ${version} downloaded`);
        this.set({ status: "ready", version });
      }, (e) => this.fail(e));
      return this.set({ status: "downloading", version, percent: 0 });
    } catch (e) {
      return this.fail(e);
    }
  }

  /** Restart into the downloaded version: the app quits as usual (its work settled), then `installAtQuit` installs. */
  install(): void {
    if (this.current.status !== "ready") throw new Error("No update is ready to install.");
    this.restart = true;
    this.o.log(`update: restarting into ${this.current.version}`);
    this.o.quit();
  }

  /**
   * At quit, once the workers are settled: when the user asked to restart into the update, hands over to its installer
   * (which starts the new version) and answers true; false when nothing was asked or the installer refused (the app
   * then quits as usual). Quitting without asking still installs a downloaded update (autoInstallOnAppQuit).
   */
  installAtQuit(): boolean {
    const u = this.o.updater;
    if (!this.restart || !u) return false;
    this.restart = false;
    const before = this.errors;
    u.quitAndInstall(true, true);
    return this.errors === before;
  }

  dispose(): void {
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.first) clearTimeout(this.first);
    if (this.period) clearInterval(this.period);
    this.first = this.period = null;
  }

  private fail(e: unknown): UpdateState {
    return this.set({ status: "error", message: updateErrorText(e), checkedAt: (this.o.now?.() ?? new Date()).toISOString() });
  }

  private set(state: UpdateState): UpdateState {
    this.current = state;
    this.o.post(state);
    return state;
  }
}
