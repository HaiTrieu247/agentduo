// The app's own updates with a fake electron-updater: what each kind of build does, the state the window is told
// through a check, a download and a restart into it, errors as the user reads them, and the timer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECK_PERIOD_MS, developerIdSigned, FIRST_CHECK_MS, updateErrorText, updateMode, Updates, type Updater, type UpdateMode } from "../src/main/updates.js";
import type { UpdateState } from "../src/shared/protocol.js";

type Result = Awaited<ReturnType<Updater["checkForUpdates"]>>;

class FakeUpdater implements Updater {
  autoDownload = true;
  checks = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  installFails = false;
  answer: () => Promise<Result> = async () => ({ isUpdateAvailable: false, updateInfo: { version: "0.7.3" } });
  private readonly listeners = new Map<string, Array<(x: never) => void>>();

  checkForUpdates(): Promise<Result> {
    this.checks++;
    return this.answer();
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
    if (this.installFails) this.emit("error", new Error("No update filepath provided, can't quit and install"));
  }

  on(event: string, listener: (x: never) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, arg: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(arg as never);
  }
}

const NOW = new Date("2026-10-31T12:00:00.000Z");

function setup(mode: UpdateMode = { kind: "install" }) {
  const updater = new FakeUpdater();
  const posted: UpdateState[] = [];
  const logs: string[] = [];
  const quit = vi.fn();
  const updates = new Updates({ mode, updater, post: (s) => posted.push(s), log: (l) => logs.push(l), quit, now: () => NOW });
  return { updater, updates, posted, logs, quit };
}

/** A check that finds `version`, with a download the test settles. */
function found(updater: FakeUpdater, version = "0.8.0") {
  const download: { resolve(): void; reject(e: unknown): void } = { resolve: () => undefined, reject: () => undefined };
  const downloadPromise = new Promise<unknown>((resolve, reject) => Object.assign(download, { resolve: () => resolve(["/tmp/x"]), reject }));
  updater.answer = async () => ({ isUpdateAvailable: true, updateInfo: { version }, downloadPromise: updater.autoDownload ? downloadPromise : null });
  return download;
}

afterEach(() => vi.useRealTimers());

describe("updateMode", () => {
  const base = { packaged: true, platform: "win32" as NodeJS.Platform, testProfile: false, testFeed: null, developerId: false };

  it("installs in a packaged Windows or Linux app, and in a Mac app signed with a Developer ID", () => {
    expect(updateMode(base)).toEqual({ kind: "install" });
    expect(updateMode({ ...base, platform: "linux" })).toEqual({ kind: "install" });
    expect(updateMode({ ...base, platform: "darwin", developerId: true })).toEqual({ kind: "install" });
  });

  it("only tells in a Mac app without a Developer ID, and in a test run with a feed of its own", () => {
    expect(updateMode({ ...base, platform: "darwin" })).toMatchObject({ kind: "notify", reason: expect.stringContaining("Developer ID") });
    expect(updateMode({ ...base, packaged: false, testProfile: true, testFeed: "/tmp/feed.yml" })).toMatchObject({ kind: "notify" });
    expect(updateMode({ ...base, platform: "darwin", developerId: true, testProfile: true, testFeed: "/tmp/feed.yml" })).toMatchObject({ kind: "notify" });
  });

  it("never looks in a development build, nor with a test profile and no feed", () => {
    expect(updateMode({ ...base, packaged: false })).toMatchObject({ kind: "off", reason: expect.stringContaining("development build") });
    expect(updateMode({ ...base, testProfile: true })).toMatchObject({ kind: "off", reason: expect.stringContaining("test profile") });
  });
});

describe("developerIdSigned", () => {
  it("reads codesign's authority: a Developer ID yes, ad hoc no", () => {
    const signed = "Executable=/Applications/AgentDuo.app/Contents/MacOS/AgentDuo\nIdentifier=io.github.haitrieu247.agentduo\nAuthority=Developer ID Application: Someone (ABCDE12345)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=ABCDE12345";
    const adhoc = "Executable=/Applications/AgentDuo.app/Contents/MacOS/AgentDuo\nIdentifier=io.github.haitrieu247.agentduo\nSignature=adhoc\nTeamIdentifier=not set";
    expect(developerIdSigned(signed)).toBe(true);
    expect(developerIdSigned(adhoc)).toBe(false);
    expect(developerIdSigned("")).toBe(false);
  });
});

describe("updateErrorText", () => {
  const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

  it("says what a missing release, a missing feed, no network or a rate limit mean", () => {
    expect(updateErrorText(coded("No published versions on GitHub", "ERR_UPDATER_NO_PUBLISHED_VERSIONS"))).toBe("No AgentDuo release is published on GitHub yet.");
    expect(updateErrorText(coded("Unable to find latest version on GitHub (…), please ensure a production release exists: HttpError: 404", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"))).toBe("No AgentDuo release is published on GitHub yet.");
    // What the real GitHub answers a repository with no release yet: the lookup's error, wrapped in the feed's.
    expect(updateErrorText(coded("Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/HaiTrieu247/agentduo/releases/latest), please ensure a production release exists: HttpError: 406 \n,\nXML:\n<feed/>", "ERR_UPDATER_INVALID_RELEASE_FEED"))).toBe("No AgentDuo release is published on GitHub yet.");
    expect(updateErrorText(coded("Cannot find latest-mac.yml in the latest release artifacts", "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"))).toBe("The latest release has no installer for this system yet.");
    expect(updateErrorText(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe("Could not reach GitHub. Check your connection.");
    expect(updateErrorText(new Error("getaddrinfo ENOTFOUND github.com"))).toBe("Could not reach GitHub. Check your connection.");
    expect(updateErrorText(new Error("HttpError: 403 Forbidden\nAPI rate limit exceeded"))).toBe("GitHub is limiting requests for now. Try again later.");
  });

  it("keeps the first line of anything else, cut short", () => {
    expect(updateErrorText(new Error("sha512 checksum mismatch\n    at Object.<anonymous> (/x.js:1:1)\nHeaders: {…}"))).toBe("sha512 checksum mismatch");
    expect(updateErrorText(new Error("x".repeat(500)))).toHaveLength(200);
    expect(updateErrorText("plain")).toBe("plain");
  });
});

describe("Updates", () => {
  it("is off without an updater or with the mode off, and never asks one", async () => {
    const off = new Updates({ mode: { kind: "off", reason: "dev" }, updater: null, post: () => undefined, log: () => undefined, quit: () => undefined });
    expect(off.state).toEqual({ status: "off", reason: "dev" });
    expect(await off.check()).toEqual({ status: "off", reason: "dev" });
    const { updater, updates } = setup({ kind: "off", reason: "dev" });
    expect(await updates.check()).toMatchObject({ status: "off" });
    expect(updater.checks).toBe(0);
  });

  it("says it is up to date, then downloads a newer version in the background and is ready to restart into it", async () => {
    const { updater, updates, posted, quit } = setup();
    expect(updates.state).toEqual({ status: "idle" });
    expect(updater.autoDownload).toBe(true);
    expect(await updates.check()).toEqual({ status: "latest", checkedAt: NOW.toISOString() });
    expect(posted.map((s) => s.status)).toEqual(["checking", "latest"]);

    const download = found(updater);
    expect(await updates.check()).toEqual({ status: "downloading", version: "0.8.0", percent: 0 });
    updater.emit("download-progress", { percent: 12.7 });
    updater.emit("download-progress", { percent: 12.9 });
    updater.emit("download-progress", { percent: 55 });
    expect(posted.filter((s) => s.status === "downloading").map((s) => (s as { percent: number }).percent)).toEqual([0, 12, 55]);
    // Asked again while it downloads: the download goes on, nothing is checked.
    expect(await updates.check()).toMatchObject({ status: "downloading", percent: 55 });
    expect(updater.checks).toBe(2);
    download.resolve();
    await vi.waitFor(() => expect(updates.state).toEqual({ status: "ready", version: "0.8.0" }));
    expect(await updates.check()).toEqual({ status: "ready", version: "0.8.0" });
    expect(updater.checks).toBe(2);

    // Restart: the app quits as usual, and at quit hands over to the installer, which starts the new version.
    expect(updates.installAtQuit()).toBe(false);
    updates.install();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(updates.installAtQuit()).toBe(true);
    expect(updater.installs).toEqual([[true, true]]);
    expect(updates.installAtQuit()).toBe(false);
  });

  it("only tells about a newer version where the build cannot install it, and downloads nothing", async () => {
    const { updater, updates } = setup({ kind: "notify", reason: "Not signed with a Developer ID." });
    expect(updater.autoDownload).toBe(false);
    found(updater, "0.9.0");
    expect(await updates.check()).toEqual({ status: "manual", version: "0.9.0", reason: "Not signed with a Developer ID." });
    expect(() => updates.install()).toThrow("No update is ready");
  });

  it("checks once at a time, and turns a failed check into an error the user can read", async () => {
    const { updater, updates, posted } = setup();
    let fail: (e: unknown) => void = () => undefined;
    updater.answer = () => new Promise((_, reject) => (fail = reject));
    const a = updates.check();
    const b = updates.check();
    expect(updater.checks).toBe(1);
    // electron-updater emits the error and rejects the check: the state is the check's, said once.
    const e = Object.assign(new Error("No published versions on GitHub"), { code: "ERR_UPDATER_NO_PUBLISHED_VERSIONS" });
    updater.emit("error", e);
    fail(e);
    const error = { status: "error", message: "No AgentDuo release is published on GitHub yet.", checkedAt: NOW.toISOString() };
    expect(await a).toEqual(error);
    expect(await b).toEqual(error);
    expect(posted.map((s) => s.status)).toEqual(["checking", "error"]);
    // The next check starts again.
    updater.answer = async () => ({ isUpdateAvailable: false, updateInfo: { version: "0.7.3" } });
    expect(await updates.check()).toMatchObject({ status: "latest" });
  });

  it("turns a failed download, or an error after it, into an error state", async () => {
    const { updater, updates, logs } = setup();
    const download = found(updater);
    await updates.check();
    download.reject(new Error("sha512 checksum mismatch\nexpected …"));
    await vi.waitFor(() => expect(updates.state).toMatchObject({ status: "error", message: "sha512 checksum mismatch" }));
    const again = found(updater);
    await updates.check();
    again.resolve();
    await vi.waitFor(() => expect(updates.state.status).toBe("ready"));
    updater.emit("error", new Error("Could not get code signature for running application"));
    expect(updates.state).toMatchObject({ status: "error", message: "Could not get code signature for running application" });
    expect(logs).toContain("update: Could not get code signature for running application");
  });

  it("answers false at quit when the installer refuses, so the app quits as usual", async () => {
    const { updater, updates } = setup();
    const download = found(updater);
    await updates.check();
    download.resolve();
    await vi.waitFor(() => expect(updates.state.status).toBe("ready"));
    updater.installFails = true;
    updates.install();
    expect(updates.installAtQuit()).toBe(false);
  });

  it("says a build the updater does not run in cannot update itself", async () => {
    const { updater, updates } = setup();
    updater.answer = async () => null;
    expect(await updates.check()).toMatchObject({ status: "off", reason: expect.stringContaining("cannot update itself") });
  });

  it("checks a little after it starts, then every few hours, while the preference is on", async () => {
    vi.useFakeTimers();
    const { updater, updates } = setup();
    updates.setAuto(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(updater.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS);
    expect(updater.checks).toBe(2);
    updates.setAuto(false);
    await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS * 3);
    expect(updater.checks).toBe(2);
    updates.setAuto(true);
    updates.dispose();
    await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS * 3);
    expect(updater.checks).toBe(2);
    const off = setup({ kind: "off", reason: "dev" });
    off.updates.setAuto(true);
    await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS);
    expect(off.updater.checks).toBe(0);
  });
});
