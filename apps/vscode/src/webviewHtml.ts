import { randomBytes } from "node:crypto";

export function makeNonce(): string {
  return randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "");
}

/** Only our own bundled script (by nonce), stylesheets and icon font; no inline code, no remote content, no frames. */
export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The sidebar's page: an empty shell; webview/main.ts builds everything with DOM APIs and textContent. */
/** `iconsUri`: the Codicons stylesheet (VS Code's own icon font), before ours so our rules win. */
export function webviewHtml(o: { cspSource: string; scriptUri: string; styleUri: string; iconsUri: string; nonce: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${attr(contentSecurityPolicy(o.cspSource, o.nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(o.iconsUri)}">
<link rel="stylesheet" href="${attr(o.styleUri)}">
<title>agentduo</title>
</head>
<body>
<div id="app" class="app" aria-busy="true"></div>
<script nonce="${attr(o.nonce)}" src="${attr(o.scriptUri)}"></script>
</body>
</html>
`;
}
