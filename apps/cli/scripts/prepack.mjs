// `npm pack` / `npm publish` run this first: the package's README (the repository's own, whose links are relative to
// the repository root, as package.json's repository says), its Vietnamese translation and the licence are the root's.
// They are copies, ignored by git; the schemas come with the build (tsup.config.ts).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("..", import.meta.url));
const root = join(cli, "..", "..");
for (const file of ["README.md", "docs/README.vi.md", "LICENSE"]) {
  mkdirSync(dirname(join(cli, file)), { recursive: true });
  copyFileSync(join(root, file), join(cli, file));
}
if (!existsSync(join(cli, "schemas"))) throw new Error("apps/cli/schemas is missing: run `npm run build` first");
