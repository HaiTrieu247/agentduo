import { releaseNotesHtml, untaggedBase } from "../../../lib/release-notes.mjs";

export default ({ c, link, ext, p, ul, table, date }, d) => {
  const ch = d.channels;
  const pub = d.releases.releases;
  const releaseBlock = (r) => {
    const base = untaggedBase(r, pub);
    const installers = r.assets.filter((a) => /\.(dmg|exe|AppImage|deb)$/.test(a.name)).length;
    return `<article class="release" aria-labelledby="release-${r.version.replace(/\./g, "-")}">
<h3 id="release-${r.version.replace(/\./g, "-")}">${r.name}</h3>
<p>Phát hành ${date(r.publishedAt)}${r.prerelease ? " dưới dạng bản tiền phát hành" : ""}, với ${installers} trình cài đặt trong tổng số ${r.assets.length} tệp. ${ext(r.url, `Xem ${r.tag} trên GitHub`)}.</p>
<div class="release-notes"><p class="release-notes-title">Ghi chú phát hành, như đã công bố:</p>${releaseNotesHtml(r.notes)}</div>
${base ? p(`Ghi chú so sánh với ${c(base)}, phiên bản không có bản phát hành công khai trên GitHub. Liên kết so sánh không có nghĩa là phiên bản đó đã được phát hành.`) : ""}
</article>`;
  };
  return {
    title: "Phát hành",
    description: "Các phiên bản đã công bố của ứng dụng desktop AgentDuo trên GitHub Releases, gói npm agentduo và tiện ích VS Code, lấy từ dữ liệu công khai của từng kênh.",
    lead: p(`Những gì mỗi kênh đã công bố, đọc từ API công khai của kênh ngày ${date(ch.checkedAt)}. Ứng dụng desktop, gói npm và tiện ích VS Code được phát hành riêng, nên phiên bản của chúng có thể khác nhau.`),
    sections: [
      {
        id: "latest",
        title: "Các phiên bản mới nhất",
        html: table({
          caption: "Phiên bản mới nhất theo kênh",
          head: ["Kênh", "Phiên bản", "Ngày phát hành", "Ở đâu"],
          rows: [
            ["Ứng dụng desktop", ch.github.version ?? "chưa có bản phát hành", ch.github.publishedAt ? date(ch.github.publishedAt) : "–", ext(ch.github.url, "GitHub Releases")],
            [`${c("agentduo")} trên npm`, ch.npm.version ?? "chưa xác minh", ch.npm.publishedAt ? date(ch.npm.publishedAt) : "–", ext(ch.npm.url, "npm")],
            ["Tiện ích VS Code", ch.marketplace.version ?? "chưa xác minh", ch.marketplace.publishedAt ? date(ch.marketplace.publishedAt) : "–", ext(ch.marketplace.url, "Visual Studio Marketplace")],
          ],
        }),
      },
      {
        id: "desktop",
        title: "Ứng dụng desktop trên GitHub Releases",
        html: `${pub.length ? pub.map(releaseBlock).join("\n") : p("Chưa có bản phát hành công khai nào của ứng dụng desktop.")}
${p("Bản nháp không được liệt kê: một bản phát hành chỉ công khai khi workflow phát hành đã build xong trình cài đặt cho cả ba hệ thống. " + ext(d.site.links.releases, "Mọi bản phát hành trên GitHub") + ".")}`,
      },
      {
        id: "npm",
        title: "Gói agentduo trên npm",
        html: `${p(`Các phiên bản của ${c("agentduo")} trong registry npm, mới nhất trước, kèm thời điểm npm ghi nhận cho từng bản.`)}
${table({
  caption: "Các phiên bản npm",
  head: ["Phiên bản", "Ngày phát hành"],
  rows: (ch.npm.history ?? []).map((v) => [v.version, date(v.publishedAt)]),
})}`,
      },
      {
        id: "vscode",
        title: "Tiện ích VS Code",
        html: p(`Marketplace liệt kê ${c(ch.marketplace.id)} ở phiên bản ${ch.marketplace.version ?? "chưa xác minh"}${ch.marketplace.publishedAt ? `, cập nhật ${date(ch.marketplace.publishedAt)}` : ""}. Lịch sử phiên bản có trên ${ext(ch.marketplace.url, "trang Marketplace")}.`),
      },
      {
        id: "how-releases-work",
        title: "Một bản phát hành được tạo ra thế nào",
        html: `${ul([
  `Đẩy một tag ${c("v*")} (do ${c("npm version")} tạo) sẽ khởi động workflow phát hành của repository. Nó kiểm tra tag khớp với phiên bản của gói npm và của ứng dụng desktop.`,
  "Workflow tạo một bản phát hành nháp, build và kiểm thử các trình cài đặt trên macOS, Windows và Linux, rồi tải chúng lên cùng siêu dữ liệu cập nhật.",
  "Khi mọi hệ thống đã tải lên, nó công bố bản phát hành. Các ứng dụng desktop đã cài sẽ thấy nó ở lần kiểm tra cập nhật kế tiếp. Nếu một hệ thống thất bại, bản phát hành vẫn là bản nháp.",
  "Gói npm và tiện ích VS Code được công bố thủ công, ngoài workflow đó.",
])}
${p(link("docs/desktop-updates", "Cập nhật ứng dụng desktop") + " giải thích ứng dụng đã cài làm gì với một bản phát hành mới.")}`,
      },
    ],
    related: ["download", "docs/desktop-updates", "docs/contributing"],
    next: p(link("download", "Tải phiên bản mới nhất") + "."),
  };
};
