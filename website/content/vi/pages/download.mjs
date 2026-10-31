export default ({ c, link, ext, code, p, ul, steps, note, date, table }, d) => {
  const r = d.release;
  const s = d.signing;
  const ch = d.channels;
  const runLink = s ? ext(s.evidence, "nhật ký của workflow phát hành") : "";
  const signed = (os) => {
    if (!s) return p(`Cách các trình cài đặt ${r ? r.tag : "mới nhất"} được ký chưa được kiểm tra.`);
    if (os === "mac") {
      return p(`Ứng dụng Mac ${r.tag} được <strong>ký ad-hoc</strong>, không ký bằng Apple Developer ID, và <strong>chưa được notarize</strong> (${runLink}, kiểm tra ngày ${date(s.checkedAt)}).`);
    }
    if (os === "windows") return p(`Trình cài đặt ${r.tag} <strong>chưa được ký mã</strong> (${runLink}, kiểm tra ngày ${date(s.checkedAt)}).`);
    return p(`AppImage và .deb ${r.tag} <strong>chưa được ký</strong>; electron-builder không ký gói Linux nào (${runLink}, kiểm tra ngày ${date(s.checkedAt)}).`);
  };
  const picker = `<div class="os-picker" hidden data-os-picker>
<p id="os-picker-label">Hiển thị trình cài đặt cho:</p>
<div class="os-picker-buttons" role="group" aria-labelledby="os-picker-label">
<button type="button" data-os="mac" aria-pressed="false">macOS</button><button type="button" data-os="windows" aria-pressed="false">Windows</button><button type="button" data-os="linux" aria-pressed="false">Linux</button><button type="button" data-os="all" aria-pressed="false">Mọi hệ thống</button>
</div>
<p class="os-suggestion" hidden data-os-suggestion data-template="Đang hiển thị {os}, hệ thống mà trình duyệt này báo cáo. Hãy chọn hệ thống khác nếu chưa đúng; kiến trúc phù hợp là do bạn chọn."></p>
</div>`;
  const panel = (os, name, body) => `<section class="os-panel" id="${os}" data-os-panel="${os}" aria-labelledby="${os}-title"><h3 id="${os}-title">${name}</h3>${d.dl.forOs(os)}<div class="panel-text">${body}</div></section>`;
  return {
    title: "Tải AgentDuo",
    description: "Tải ứng dụng desktop AgentDuo cho macOS, Windows hoặc Linux từ GitHub Releases, cài lệnh duo từ npm, hoặc thêm tiện ích VS Code.",
    lead: p(r
      ? `Ứng dụng desktop ${r.version} được phát hành trên GitHub ngày ${date(r.publishedAt)}. Gói dòng lệnh và tiện ích VS Code được phát hành riêng; mỗi phiên bản bên dưới lấy từ kênh của nó, kiểm tra ngày ${date(ch.checkedAt)}.`
      : `Chưa có bản phát hành desktop nào trên GitHub. Gói dòng lệnh và tiện ích VS Code được phát hành riêng; các phiên bản của chúng bên dưới được kiểm tra ngày ${date(ch.checkedAt)}.`),
    top: `<div class="channels">
<div class="channel"><h2 class="visually-hidden">Phiên bản theo kênh</h2><h3>Ứng dụng desktop</h3><p class="version">${ch.github.version ?? "chưa có"}</p><p class="meta">GitHub Releases${ch.github.publishedAt ? `, ${date(ch.github.publishedAt)}` : ""}</p></div>
<div class="channel"><h3>${c("duo")} trên npm</h3><p class="version">${ch.npm.version ?? "chưa xác minh"}</p><p class="meta">gói ${c("agentduo")}${ch.npm.publishedAt ? `, ${date(ch.npm.publishedAt)}` : ""}</p></div>
<div class="channel"><h3>Tiện ích VS Code</h3><p class="version">${ch.marketplace.version ?? "chưa xác minh"}</p><p class="meta">Visual Studio Marketplace${ch.marketplace.publishedAt ? `, ${date(ch.marketplace.publishedAt)}` : ""}</p></div>
</div>
${d.sourceVersion ? p(`Mã nguồn của repository đang ở phiên bản ${d.sourceVersion}. Một phiên bản trong mã nguồn chưa phải bản phát hành cho đến khi một kênh công bố nó.`) : ""}`,
    sections: [
      {
        id: "desktop",
        title: "Ứng dụng desktop",
        html: `${p("Các trình cài đặt lấy trực tiếp từ " + ext(r ? r.url : d.site.links.releases, "bản phát hành GitHub") + " của dự án; trang này không lưu trữ chúng. Ứng dụng cần Claude Code và Codex đã cài và đăng nhập, và không cần Node.js riêng.")}
${picker}
${panel("mac", "macOS", `${p("<strong>Chọn bản nào?</strong> Mở menu Apple, rồi <em>About This Mac</em>. Nếu mục <em>Chip</em> ghi Apple M1 trở lên, hãy tải bản Apple silicon. Nếu mục <em>Processor</em> ghi chip của Intel, hãy tải bản Intel.")}
${steps([
  ["Cài đặt", p("Mở tệp .dmg, kéo AgentDuo vào Applications, rồi mở nó từ Applications.")],
  ["Mở lần đầu", `${signed("mac")}${p("Vì vậy Gatekeeper chặn lần khởi động đầu tiên. Mở <em>System Settings → Privacy &amp; Security</em>, tìm thông báo về AgentDuo và chọn <em>Open Anyway</em>, rồi xác nhận. Chỉ làm vậy với tệp bạn tải từ bản phát hành GitHub của dự án.")}`],
  ["Cập nhật", p("Ứng dụng Mac không có chữ ký Developer ID không thể tự thay thế chính nó. AgentDuo kiểm tra GitHub và báo khi có phiên bản mới (<em>Get AgentDuo x.y.z</em> ở thanh bên và trong Settings → General); hãy tải .dmg mới và thay ứng dụng. Cài đặt và hội thoại của bạn không nằm trong ứng dụng nên vẫn được giữ. " + link("docs/desktop-updates", "Cập nhật hoạt động thế nào") + ".")],
])}`)}
${panel("windows", "Windows", `${p("Trình cài đặt là bản NSIS có hướng dẫn chứ không phải bản một cú nhấp: nó cho bạn chọn cài cho ai và vào thư mục nào.")}
${steps([
  ["Cài đặt", p("Chạy tệp .exe và làm theo trình cài đặt. AgentDuo xuất hiện trong menu Start.")],
  ["Nếu SmartScreen cảnh báo", `${signed("windows")}${p("Vì vậy Microsoft Defender SmartScreen có thể hiện <em>Windows protected your PC</em>. Chọn <em>More info</em>, kiểm tra tệp đúng là tệp bạn tải từ bản phát hành GitHub của dự án, rồi chọn <em>Run anyway</em>.")}`],
  ["Cập nhật", p("Ứng dụng đã cài tải phiên bản mới ở nền, kiểm tra checksum, và cài khi bạn chọn <em>Restart to update</em> hoặc khi thoát. " + link("docs/desktop-updates", "Cập nhật hoạt động thế nào") + ".")],
])}`)}
${panel("linux", "Linux", `${p("Hai gói cho x86_64: AppImage chạy từ thư mục bất kỳ, và .deb cho Debian, Ubuntu cùng các bản phái sinh. " + (s ? signed("linux").replace(/^<p>|<\/p>$/g, "") : ""))}
${steps([
  ["AppImage", `${p("Cấp quyền thực thi cho tệp, rồi chạy:")}${code(r ? `chmod +x AgentDuo-${r.version}-linux-x86_64.AppImage\n./AgentDuo-${r.version}-linux-x86_64.AppImage` : "chmod +x AgentDuo-*-linux-x86_64.AppImage\n./AgentDuo-*-linux-x86_64.AppImage", { lang: "sh", label: "Terminal" })}${p("Trên Ubuntu 24.04 trở lên, vốn hạn chế user namespace không đặc quyền, AppImage không thể khởi động sandbox của Chromium. Hãy cài .deb thay thế, hoặc thêm một profile AppArmor cho đường dẫn của AppImage. AgentDuo không bao giờ tự tắt sandbox của nó. " + link("troubleshooting#linux-sandbox", "Lỗi sandbox trên Linux") + ".")}`],
  [".deb", `${code(r ? `sudo apt install ./AgentDuo-${r.version}-linux-amd64.deb` : "sudo apt install ./AgentDuo-*-linux-amd64.deb", { lang: "sh", label: "Terminal" })}${p("Gói được cài vào " + c("/opt/AgentDuo") + " cùng một profile AppArmor, nên sandbox hoạt động trên Ubuntu 24.04 trở lên. Khởi động AgentDuo từ menu ứng dụng.")}`],
  ["Cập nhật", p("AppImage tải phiên bản mới ở nền và cài khi bạn khởi động lại vào nó hoặc thoát. Gói .deb cũng tải về, nhưng chỉ cài khi bạn chọn <em>Restart to update</em>, qua " + c("pkexec") + ", sẽ hỏi mật khẩu của bạn. " + link("docs/desktop-updates", "Cập nhật hoạt động thế nào") + ".")],
])}`)}
${note(p("Chưa phát hành bản cho Windows trên Arm và Linux arm64. Hãy build từ mã nguồn trên các hệ thống đó: " + link("docs/contributing#desktop", "build ứng dụng desktop") + "."))}`,
      },
      {
        id: "cli",
        title: "Dòng lệnh (npm)",
        html: `${p(`Gói ${c("agentduo")} cài lệnh ${c("duo")} (và ${c("agentduo")}, cùng một lệnh). Phiên bản mới nhất trên npm là ${ch.npm.version ?? "chưa xác minh"}${ch.npm.publishedAt ? `, phát hành ${date(ch.npm.publishedAt)}` : ""}.`)}
${code("npm i -g agentduo\nduo --version", { lang: "sh", label: "Terminal" })}
${ul([
  `Node.js 22.12 trở lên và npm (${ext(d.site.links.nodeDownload, "nodejs.org")}). Cần Git cho các lượt chạy pipeline.`,
  `Claude Code và Codex CLI đã cài và đăng nhập. ${c("duo doctor")} kiểm tra cả hai mà không gọi mô hình.`,
  `Cập nhật bằng cùng lệnh đó; ${c("npm i -g agentduo@latest")} lấy phiên bản mới nhất.`,
])}
${p(link("learn/cli", "Bắt đầu trong terminal") + " hoặc xem " + ext(d.site.links.npm, "gói trên npm") + ".")}`,
      },
      {
        id: "vscode",
        title: "Tiện ích VS Code",
        html: `${p(`Tiện ích là ${c(d.site.marketplaceId)} trên Visual Studio Marketplace, phiên bản ${ch.marketplace.version ?? "chưa xác minh"}${ch.marketplace.publishedAt ? `, cập nhật ${date(ch.marketplace.publishedAt)}` : ""}. Cài từ ${ext(d.site.links.marketplace, "trang Marketplace")}, từ khung Extensions (tìm agentduo), hoặc từ terminal:`)}
${code(`code --install-extension ${d.site.marketplaceId}`, { lang: "sh", label: "Terminal" })}
${ul([
  "VS Code desktop 1.95 trở lên, với một thư mục cục bộ hoặc không có thư mục. Remote SSH, WSL, container và bản web không được hỗ trợ.",
  `Node.js 22.12 trở lên trong ${c("PATH")} mà VS Code thấy, hoặc đặt ${c("agentduo.nodePath")}. Tiện ích tự mang engine; không cần gói npm.`,
])}
${p(link("learn/vscode", "Bắt đầu trong VS Code") + ".")}`,
      },
      {
        id: "verify",
        title: "Kiểm tra bản tải",
        html: `${p("Mỗi trình cài đặt ở trên liệt kê checksum SHA-256 mà GitHub ghi nhận cho tệp đã tải lên. Hãy tính checksum của bản bạn tải và so sánh:")}
${table({
  caption: "Các lệnh in checksum SHA-256",
  head: ["Hệ thống", "Lệnh"],
  rows: [
    ["macOS", c("shasum -a 256 ~/Downloads/AgentDuo-*.dmg")],
    ["Windows (PowerShell)", c("Get-FileHash $HOME\\Downloads\\AgentDuo-*.exe -Algorithm SHA256")],
    ["Linux", c("sha256sum AgentDuo-*")],
  ],
})}
${p("Checksum khớp cho thấy tệp đúng là tệp được tải lên bản phát hành. Nó không thay thế chữ ký mã: xem ghi chú về chữ ký cho hệ thống của bạn ở trên.")}`,
      },
      {
        id: "other-files",
        title: "Các tệp khác trong bản phát hành",
        html: `${p("Một bản phát hành còn chứa các tệp không phải trình cài đặt. Chúng được liệt kê trên " + ext(d.site.links.releases, "trang GitHub Releases") + " nhưng không được đưa ra ở trên:")}
${ul([
  `${c("AgentDuo-<version>-mac-<arch>.zip")}: ứng dụng Mac mà trình cập nhật tải về. Hãy dùng .dmg để cài.`,
  `Các tệp ${c(".blockmap")} và ${c("latest.yml")}, ${c("latest-mac.yml")}, ${c("latest-linux.yml")}: siêu dữ liệu cập nhật mà ứng dụng đã cài đọc.`,
])}
${p(link("releases", "Phát hành") + " liệt kê mọi phiên bản đã công bố cùng ghi chú.")}`,
      },
    ],
    scripts: ["download.js"],
    related: ["learn/prerequisites", "learn/desktop", "docs/desktop-updates", "troubleshooting"],
    next: p(link("learn/prerequisites", "Kiểm tra bạn cần gì") + " trước lần chạy đầu tiên: cả hai CLI, đã đăng nhập."),
  };
};
