// electron-builder's afterPack hook: flips Electron's fuses on the packed executable, before it is signed (flipping
// changes the binary, so signing comes after; on Apple silicon the ad-hoc signature is reset so it still launches).
//   release (default): RunAsNode on (the engine worker is this executable run as Node, ELECTRON_RUN_AS_NODE=1, so the
//     app needs no Node installed); NODE_OPTIONS and --inspect off, so nobody turns the app into a debuggable Node.
//   test (AGENTDUO_FUSES=test, `npm run package -- --test-fuses`): the same, with the CLI inspector on, so
//     Playwright can attach to a packaged app. Never ship it.
// ASAR integrity validation stays off: it needs the integrity hash electron-builder writes only for some targets, and
// a mismatch makes the app refuse to start; OnlyLoadAppFromAsar on still keeps the app from loading loose files.
import { join } from "node:path";
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";

/** The fuses of a profile: "release" (default) or "test". Pure, for the tests. */
export function fuseConfig(profile = "release") {
  return {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: profile === "test",
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  };
}

export const fuseProfile = (env = process.env) => (env.AGENTDUO_FUSES === "test" ? "test" : "release");

/** The packed executable electron-builder just wrote. */
export function executableOf(context) {
  const name = context.packager.appInfo.productFilename;
  switch (context.electronPlatformName) {
    case "darwin":
    case "mas":
      return join(context.appOutDir, `${name}.app`);
    case "win32":
      return join(context.appOutDir, `${name}.exe`);
    default:
      return join(context.appOutDir, context.packager.executableName);
  }
}

export default async function afterPack(context) {
  const profile = fuseProfile();
  const file = executableOf(context);
  const darwin = context.electronPlatformName === "darwin" || context.electronPlatformName === "mas";
  // electron-builder's Arch enum: 1 is x64, 3 is arm64.
  const arm64 = context.arch === 3;
  await flipFuses(file, { ...fuseConfig(profile), resetAdHocDarwinSignature: darwin && arm64 });
  console.log(`  • fuses (${profile}) flipped on ${file}`);
}
