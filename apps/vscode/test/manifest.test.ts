// The extension's manifest (apps/vscode/package.json), as VS Code and the Marketplace read it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("extension manifest", () => {
  const ext = join(import.meta.dirname, "..");
  const manifest = JSON.parse(readFileSync(join(ext, "package.json"), "utf8"));
  const root = JSON.parse(readFileSync(join(ext, "..", "..", "package.json"), "utf8"));

  it("is a desktop workspace extension that stays off in Restricted Mode and virtual workspaces", () => {
    expect(manifest.engines.vscode).toBe("^1.95.0");
    expect(manifest.extensionKind).toEqual(["workspace"]);
    expect(manifest.browser).toBeUndefined();
    expect(manifest.main).toBe("./dist/extension.cjs");
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(false);
    expect(manifest.capabilities.virtualWorkspaces.supported).toBe(false);
    expect(manifest.version).toBe(root.version);
    expect(manifest.contributes.configuration.properties["agentduo.nodePath"].scope).toBe("machine");
    expect(manifest.dependencies).toBeUndefined();
  });

  it("registers every command it declares, and declares every command it registers", () => {
    const declared = manifest.contributes.commands.map((c: { command: string }) => c.command).sort();
    const registered = [...readFileSync(join(ext, "src", "extension.ts"), "utf8").matchAll(/registerCommand\("([^"]+)"/g)].map((m) => m[1]).sort();
    expect(registered).toEqual(declared);
    expect(declared).toEqual(expect.arrayContaining(["agentduo.openChat", "agentduo.stop", "agentduo.resume", "agentduo.newTask", "agentduo.openPlan",
      "agentduo.openChanges", "agentduo.openReport", "agentduo.doctor", "agentduo.openConfiguration"]));
  });

  it("wears the app's icon: a 256 px PNG on the Marketplace, and every icon it names in the extension", () => {
    expect(manifest.icon).toBe("media/icon.png");
    const png = readFileSync(join(ext, manifest.icon));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([256, 256]);
    const { viewsContainers, views, commands } = manifest.contributes;
    const named = [...viewsContainers.activitybar, ...Object.values(views).flat(), ...commands]
      .map((c) => (c as { icon?: string }).icon)
      .filter((icon): icon is string => !!icon && !icon.startsWith("$("));
    expect(named.length).toBeGreaterThan(0);
    for (const icon of named) expect(existsSync(join(ext, icon)), icon).toBe(true);
  });
});
