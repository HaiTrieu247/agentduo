// The root's prepublishOnly: `npm publish` at the repository's root would publish the whole repository as
// agentduo-monorepo. The root is private, so npm refuses anyway, but its advice (remove "private") is the wrong one.
// This stops first and names the way each package is published. `npm publish -w agentduo` runs the CLI's own
// scripts, not this one.
process.stderr.write(`The repository's root is not a package: nothing was published.
  the CLI (npm package agentduo):  npm publish -w agentduo
  the VS Code extension:           npm run package:vscode, then publish its .vsix by hand
  the desktop app:                 push the v* tag (npm version makes it); .github/workflows/release.yml releases it
`);
process.exit(1);
