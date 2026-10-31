export default ({ c, link, date, p, ul, table, note, h3 }) => ({
  title: "Cập nhật ứng dụng desktop",
  description: "Ứng dụng desktop AgentDuo tìm và cài phiên bản mới từ GitHub Releases trên Windows, macOS và Linux ra sao, khi nào nó chỉ thông báo, và những gì đã được kiểm chứng.",
  lead: p("Ứng dụng desktop AgentDuo đã cài sẽ tìm phiên bản mới trong các GitHub Release đã phát hành của dự án. Bản nào tự thay thế được thì tải bản cập nhật ở chế độ nền và cài khi bạn khởi động lại; bản nào không thể thì chỉ báo cho bạn biết đã có phiên bản mới."),
  sections: [
    {
      id: "when",
      title: "Khi nào ứng dụng kiểm tra",
      html: `${ul([
  "15 giây sau khi ứng dụng khởi động, rồi cứ mỗi 4 giờ, khi <em>Check for updates automatically</em> đang bật (Settings → General).",
  "<em>Check now</em> trong Settings → General, hoặc <em>Check for Updates…</em> (menu AgentDuo trên macOS, menu Help trên Windows và Linux), kiểm tra ngay trong mọi trường hợp.",
  "Ứng dụng đọc feed của bản phát hành (" + c("latest.yml") + ", " + c("latest-mac.yml") + ", " + c("latest-linux.yml") + ") và so sánh phiên bản. Nó không bao giờ hạ phiên bản, và bản ổn định bỏ qua các bản pre-release.",
  "Settings → General hiện phiên bản của ứng dụng và tình trạng cập nhật: đã mới nhất, đang tải, sẵn sàng, đã có nhưng cần tự tải, hoặc lý do không kiểm tra được.",
])}
${p("Khi chưa có bản phát hành nào, lần kiểm tra sẽ báo <em>No AgentDuo release is published on GitHub yet.</em>")}`,
    },
    {
      id: "platforms",
      title: "Mỗi bản dựng làm gì",
      html: `${table({
  caption: "Cách mỗi loại bản dựng cập nhật",
  head: ["Bản dựng", "Điều gì xảy ra"],
  rows: [
    ["Windows (bộ cài NSIS), Linux AppImage", "Tải ở chế độ nền (có kiểm tra checksum), rồi thanh bên hiện <em>Restart to update</em>. Thoát mà không khởi động lại cũng sẽ cài."],
    ["Linux " + c(".deb"), "Tải giống vậy, nhưng chỉ cài khi bạn chọn <em>Restart to update</em>, qua " + c("pkexec") + ", có thể hỏi mật khẩu của bạn; không bao giờ tự cài bất ngờ khi bạn thoát."],
    ["macOS, ký bằng Developer ID", "Cập nhật giống Windows."],
    ["macOS, ký ad-hoc", "Chỉ thông báo: Squirrel.Mac chỉ cài bản cập nhật được ký bằng cùng Developer ID với ứng dụng đang chạy. <em>Get AgentDuo x.y.z</em> mở trang phát hành để tải file dmg."],
    ["Bản phát triển (" + c("npm run dev") + ")", "Không bao giờ kiểm tra."],
  ],
})}
${h3("restart", "Restart to update")}
${p("Khởi động lại sẽ thoát giống như <em>Quit</em>: các câu hỏi đang mở được trả lời, các lượt chạy dừng lại và khóa được giải phóng (pipeline đã dừng vẫn resume được). Sau đó bộ cài đặt đặt phiên bản mới vào chỗ và khởi động nó. Ứng dụng hỏi trước nếu có agent đang làm việc.")}`,
    },
    {
      id: "test-profiles",
      title: "Profile kiểm thử",
      html: `${p("Ứng dụng khởi động với profile riêng (" + c("AGENTDUO_DESKTOP_USER_DATA") + ", như mọi bài kiểm thử) không bao giờ kiểm tra GitHub. Nó chỉ kiểm tra feed do " + c("AGENTDUO_DESKTOP_UPDATE_CONFIG") + " chỉ định (một file " + c("app-update.yml") + ", ví dụ provider " + c("generic") + " của electron-updater trên một server cục bộ) và không cài gì: nó chỉ báo đã có phiên bản mới hơn. Không có biến đó thì cập nhật bị tắt.")}`,
    },
    {
      id: "releases",
      title: "Bản cập nhật đến từ đâu",
      html: `${p("Một tag " + c("v*") + " chạy " + c(".github/workflows/release.yml") + ":")}
${ul([
  "nó đối chiếu tag với phiên bản của các package và tạo một bản phát hành nháp (là pre-release khi phiên bản có dấu " + c("-") + ");",
  "macOS, Windows và Linux mỗi nơi tự build, chạy kiểm thử rồi tải bộ cài và feed cập nhật lên bản nháp;",
  "bản phát hành chỉ được công bố khi cả ba đã tải lên xong. Nếu một nơi thất bại, nó vẫn là bản nháp, và các ứng dụng đã cài không thấy gì.",
])}
${p("Không có chứng chỉ Developer ID thì ứng dụng Mac được ký ad-hoc, nên không tự cập nhật được; không có chứng chỉ Windows thì bộ cài không được ký và SmartScreen sẽ cảnh báo. Liên kết tải về: " + link("download", "Tải về") + ".")}`,
    },
    {
      id: "tested",
      title: "Những gì đã được kiểm chứng",
      html: `${note(p("Chưa có đường cập nhật nào qua bộ cài được kiểm chứng trọn vẹn, trừ một trường hợp: một bản macOS 0.8.0 ký ad-hoc đã tìm thấy 0.8.1 và hiện thông báo chỉ-báo-tin (chủ dự án quan sát ngày " + date("2026-10-31") + "). Việc cài bản cập nhật trên Windows, từ AppImage, từ " + c(".deb") + " hay trên bản Mac ký Developer ID vẫn chưa được kiểm chứng."), "warning")}
${p("Các bài kiểm thử tự động kiểm tra phần logic cập nhật, và trong E2E của desktop, một phiên bản mới hơn trên feed cục bộ với profile kiểm thử, vốn chỉ thông báo.")}
${p("Khi một lần kiểm tra hay tải về thất bại, ứng dụng nói lý do trong Settings → General, và các dòng log của bộ cập nhật được ghi vào log của ứng dụng: " + link("docs/data-diagnostics#desktop", "Diagnostics") + ".")}`,
    },
  ],
  related: ["learn/desktop", "docs/data-diagnostics", "docs/accounts-usage"],
});
