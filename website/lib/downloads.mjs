// The installer buttons of the download page, from the release snapshot. Each button is a plain link to the asset on
// GitHub Releases, so the page needs no script and no API call to offer a download.
import { PLATFORMS } from "./release-data.mjs";
import { esc, formatSize } from "./render.mjs";

/**
 * Download helpers for one language. `t` holds its words: kinds (package names), arch (architecture names),
 * download (a function of kind and arch), checksum, unavailable (a function of OS and arch).
 */
export function createDownloads({ release, downloads, t }) {
  const card = (a) => `<div class="installer" data-installer="${a.os}-${a.arch}-${a.kind}">
<p class="installer-kind">${esc(t.kinds[a.kind])}</p>
<a class="button button-primary" href="${esc(a.url)}">${esc(t.download(a.kind, a.arch))}</a>
<p class="installer-meta"><span class="installer-file">${esc(a.name)}</span> <span class="installer-size">${formatSize(a.size)}</span></p>
${a.sha256 ? `<details class="checksum"><summary>${esc(t.checksum)}</summary><code>${a.sha256}</code></details>` : ""}
</div>`;

  /** Every installer for one OS, grouped by architecture, with a line for each architecture that has none. */
  const forOs = (os) => {
    const parts = [];
    for (const p of PLATFORMS.filter((x) => x.os === os)) {
      const list = downloads.byPlatform.get(`${p.os}-${p.arch}`) ?? [];
      if (!list.length) {
        parts.push(`<p class="unavailable" data-unavailable="${p.os}-${p.arch}">${t.unavailable(p.os, p.arch)}</p>`);
        continue;
      }
      parts.push(`<div class="arch-group" data-arch-group="${p.os}-${p.arch}"><h4 class="arch-title">${esc(t.arch[p.os][p.arch])}</h4><div class="installers">${list.map(card).join("")}</div></div>`);
    }
    return parts.join("\n");
  };

  return { forOs, version: release?.version ?? null, hasAny: (os) => PLATFORMS.some((p) => p.os === os && (downloads.byPlatform.get(`${p.os}-${p.arch}`) ?? []).length) };
}
