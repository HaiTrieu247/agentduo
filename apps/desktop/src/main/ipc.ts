// What main does for each renderer request. The request was checked by parseDesktopRequest (shared/protocol.ts) and
// its sender by trustedSender; here every id is resolved against what main handed out. Errors come back as answers,
// never as exceptions across IPC. No Electron import: the window's dialogs and the shell come in as `DesktopShell`.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { userConfigPath } from "../../../../src/core/config.js";
import { configFiles, type ConfigurationView } from "../../../../src/core/configuration.js";
import {
  LINKS, parseDesktopRequest, ProtocolError, trustedSender, type Answer, type AppSnapshot, type CliStatus, type DesktopRequest, type DesktopResults,
  type LauncherInfo, type SenderInfo, type UpdateState,
} from "../shared/protocol.js";
import { diagnosticsText, type LogBuffer } from "./diagnostics.js";
import type { PreferencesStore } from "./preferences.js";
import type { ProjectManager } from "./projects.js";
import { cliStatuses, clearSetting, readSettings, updateSetting, type Runner } from "./settings.js";
import { readAccountUsage } from "./usage.js";

export interface DesktopShell {
  chooseFolder(): Promise<string | null>;
  chooseBinary(backend: string): Promise<string | null>;
  saveFile(defaultName: string): Promise<string | null>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

export interface DispatcherOptions {
  projects: ProjectManager;
  prefs: PreferencesStore;
  shell: DesktopShell;
  logs: LogBuffer;
  env(): NodeJS.ProcessEnv;
  launcher(): LauncherInfo | null;
  snapshot(): AppSnapshot;
  userData: string;
  logsDir: string;
  run?: Runner;
  /** The app's own updates (main/updates.ts). */
  updates?: { check(): Promise<UpdateState>; install(): void };
  /** Preferences changed: the window's theme, the menu and the update timer follow. */
  prefsChanged?(): void;
}

export class Dispatcher {
  constructor(private readonly o: DispatcherOptions) {}

  /** One request from the renderer, from `sender`: refused unless both are what main expects. */
  async handle(sender: SenderInfo, raw: unknown): Promise<Answer<unknown>> {
    if (!trustedSender(sender)) return { ok: false, error: "refused: not the app's window" };
    let request: DesktopRequest;
    try {
      request = parseDesktopRequest(raw);
    } catch (e) {
      return { ok: false, error: e instanceof ProtocolError ? e.message : "refused: not a request" };
    }
    try {
      return { ok: true, result: await this.answer(request) };
    } catch (e) {
      this.o.logs.add(`${request.method} failed: ${(e as Error).message}`);
      return { ok: false, error: (e as Error).message };
    }
  }

  private target(projectId: string | null) {
    const workspace = projectId ? this.o.projects.path(projectId) : null;
    return { workspace, session: projectId ? this.o.projects.liveSession(projectId) : null, env: this.o.env() };
  }

  private async clis(projectId: string | null): Promise<{ clis: CliStatus[]; launcher: LauncherInfo }> {
    const t = this.target(projectId);
    let view: ConfigurationView | null = null;
    try {
      view = await readSettings(t);
    } catch {
      view = null; // a broken config: the CLIs are still checked, with their default names
    }
    const clis = await cliStatuses({ view, env: t.env, cwd: t.workspace ?? process.cwd(), run: this.o.run });
    return { clis, launcher: this.o.launcher() ?? { sources: ["the app's environment"], shellProblem: null, entries: 0 } };
  }

  private async answer(r: DesktopRequest): Promise<DesktopResults[keyof DesktopResults]> {
    const { projects, prefs } = this.o;
    switch (r.method) {
      case "app.state":
        return this.o.snapshot();
      case "prefs.set": {
        const next = prefs.setPrefs(r.patch);
        this.o.prefsChanged?.();
        return next;
      }
      case "project.open": {
        const folder = await this.o.shell.chooseFolder();
        return folder ? projects.open(folder) : null;
      }
      case "project.select":
        projects.select(r.projectId);
        return this.o.snapshot();
      case "project.forget":
        await projects.forget(r.projectId);
        return this.o.snapshot();
      case "project.restart":
        await projects.restart(r.projectId);
        return { restarted: true };
      case "project.runs":
        await projects.session(r.projectId).start();
        return projects.runs(r.projectId);
      case "conversation.new": {
        const conversationId = projects.newConversation(r.projectId);
        projects.openConversation(r.projectId, conversationId);
        return { conversationId };
      }
      case "conversation.open":
        projects.openConversation(r.projectId, r.conversationId);
        return { conversationId: r.conversationId, draft: projects.draft(r.projectId, r.conversationId) };
      case "conversation.select":
        projects.selectConversation(r.projectId, r.conversationId);
        return { selected: true };
      case "conversation.close":
        await projects.closeConversation(r.projectId, r.conversationId);
        return { closed: true };
      case "chat.message":
        return { accepted: projects.chatMessage(r.projectId, r.conversationId, r.view, r.message) };
      case "chat.draft":
        projects.saveDraft(r.projectId, r.conversationId, r.text);
        return { saved: true };
      case "run.inspect":
        return projects.session(r.projectId).request({ type: "inspectFocusedRun", conversation: r.conversationId });
      case "artifact.read":
        return projects.session(r.projectId).request({ type: "readArtifact", artifact: r.artifact, conversation: r.conversationId });
      case "changes.list": {
        const list = await projects.session(r.projectId).request({ type: "listChanges", conversation: r.conversationId });
        return { listId: projects.registerChanges(r.projectId, list), ...list };
      }
      case "changes.file": {
        const list = projects.changeList(r.projectId, r.listId);
        const change = list.changes[r.index];
        if (!change || !list.base || !list.snapshot) throw new Error("no such change in that list");
        const session = projects.session(r.projectId);
        const side = (s: "base" | "snapshot") => session.request({ type: "readSnapshotFile", runId: list.runId, base: list.base!, snapshot: list.snapshot!, side: s, path: change.path });
        const [before, after] = await Promise.all([side("base"), side("snapshot")]);
        return { path: change.path, status: change.status, before, after };
      }
      case "settings.read":
        return readSettings(this.target(r.projectId));
      case "settings.update": {
        const view = await updateSetting(this.target(r.projectId), r.scope, r.key, r.value);
        await projects.syncConfiguration(r.scope, r.projectId);
        if (r.projectId) projects.publishList(r.projectId);
        return view;
      }
      case "settings.clear": {
        const view = await clearSetting(this.target(r.projectId), r.scope, r.key);
        await projects.syncConfiguration(r.scope, r.projectId);
        return view;
      }
      case "settings.openFile": {
        const t = this.target(r.projectId);
        const files = configFiles({ workspace: t.workspace, configPath: null, env: t.env });
        const file = r.scope === "global" ? files.global : files.project;
        if (!file) throw new Error("no project is open");
        if (!existsSync(file)) {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, "# agentduo configuration (see README: Configuration)\n");
        }
        await this.o.shell.openPath(file);
        return { opened: file };
      }
      case "folder.open": {
        let folder: string | null;
        switch (r.folder) {
          case "userData":
            folder = this.o.userData;
            break;
          case "logs":
            folder = this.o.logsDir;
            break;
          case "project":
            folder = r.projectId ? projects.path(r.projectId) : null;
            break;
          case "runs":
            folder = r.projectId ? (await readSettings(this.target(r.projectId))).storage.runsDir : dirname(userConfigPath(this.o.env()));
            break;
        }
        if (!folder) throw new Error("that folder is not known yet");
        mkdirSync(folder, { recursive: true });
        await this.o.shell.openPath(folder);
        return { opened: folder };
      }
      case "cli.status":
        return this.clis(r.projectId);
      case "cli.pick": {
        const bin = await this.o.shell.chooseBinary(r.backend);
        if (!bin) return null;
        await updateSetting(this.target(null), "global", `${r.backend}.bin`, bin);
        await projects.syncConfiguration("global", null);
        return this.clis(null);
      }
      case "doctor.run":
        return projects.session(r.projectId).request({ type: "doctor" });
      case "account.usage":
        if (r.projectId) return projects.session(r.projectId).request({ type: "accountUsage" });
        return readAccountUsage(this.o.env());
      case "diagnostics.collect":
        return { text: await this.diagnostics(r.projectId) };
      case "diagnostics.export": {
        const text = await this.diagnostics(r.projectId);
        const file = await this.o.shell.saveFile(`agentduo-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`);
        if (!file) return null;
        writeFileSync(file, text);
        return { file };
      }
      case "link.open":
        await this.o.shell.openExternal(LINKS[r.link]);
        return { opened: true };
      case "update.check":
        return this.o.updates ? this.o.updates.check() : this.o.snapshot().update;
      case "update.install":
        if (!this.o.updates) throw new Error("No update is ready to install.");
        this.o.updates.install();
        return { restarting: true };
    }
  }

  private async diagnostics(projectId: string | null): Promise<string> {
    const snap = this.o.snapshot();
    let config: ConfigurationView | null = null;
    let configError: string | null = null;
    try {
      config = await readSettings(this.target(projectId));
    } catch (e) {
      configError = (e as Error).message;
    }
    const { clis, launcher } = await this.clis(projectId);
    return diagnosticsText({
      versions: snap.versions, platform: snap.platform, arch: process.arch, userData: this.o.userData,
      project: projectId ? this.o.projects.path(projectId) : null, launcher, clis, config, configError, log: this.o.logs.all,
    });
  }
}
