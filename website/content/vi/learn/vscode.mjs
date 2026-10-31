export default ({ c, link, ext, code, p, ul, note, table }, d) => ({
  title: "Bắt đầu trong VS Code",
  description: "Cài tiện ích AgentDuo cho VS Code, thiết lập Node và hai CLI, mở cuộc trò chuyện, dùng composer, Account & Usage, trình soạn diff và Doctor.",
  lead: p("Tiện ích đưa chat AgentDuo vào VS Code: mỗi cuộc trò chuyện là một tab trình soạn thảo, các quyết định và yêu cầu cấp quyền hiện phía trên composer, và các thay đổi của lượt chạy mở trong trình soạn diff của VS Code."),
  sections: [
    {
      id: "install",
      title: "Cài đặt",
      html: `${p("Cài " + c(d.site.marketplaceId) + " từ " + ext(d.site.links.marketplace, "Visual Studio Marketplace") + " hoặc khung Extensions, hoặc từ terminal:")}
${code(`code --install-extension ${d.site.marketplaceId}`, { lang: "sh", label: "Terminal" })}
${table({
  caption: "Tiện ích cần gì",
  head: ["Yêu cầu", "Chi tiết"],
  rows: [
    ["VS Code desktop 1.95 trở lên", "Với thư mục cục bộ đã được tin cậy, hoặc không có thư mục (khi đó nó làm việc trong thư mục home). Remote SSH, WSL, container và bản web không được hỗ trợ."],
    ["Node.js 22.12 trở lên", `Node riêng của VS Code không được dùng. Tiện ích lấy ${c("node")} phù hợp đầu tiên trong PATH mà VS Code thấy, hoặc đường dẫn trong thiết lập ${c("agentduo.nodePath")}.`],
    ["Claude Code và Codex CLI, đã đăng nhập", `Khi PATH của VS Code khác với PATH của terminal (thường gặp trên macOS khi mở VS Code từ Dock), hãy đặt ${c("claude.bin")} và ${c("codex.bin")} trong ${c(".agentduo/config.yaml")}.`],
  ],
})}
${p("Tiện ích mang theo engine riêng: không cần cài gói npm.")}`,
    },
    {
      id: "open-chat",
      title: "Mở một cuộc trò chuyện",
      html: `${ul([
  "Nhấp nút agentduo trên thanh tiêu đề của trình soạn thảo (cạnh nút của Claude Code và Codex), hoặc chạy <em>agentduo: Open Chat</em> từ Command Palette.",
  "Mỗi cuộc trò chuyện là một tab trình soạn thảo, đặt tên theo tin nhắn đầu tiên. ＋ trên thanh tiêu đề của tab (hoặc " + c("/new") + ") mở thêm một tab; các tab trả lời song song, nhưng một workspace chỉ chạy một pipeline tại một thời điểm.",
  "Sau khi tải lại hoặc khởi động lại, VS Code mở lại các tab: mỗi tab hiển thị nội dung như trước, và câu hỏi tiếp theo của nó vẫn mang theo những gì đã nói.",
  "Trong cửa sổ nhiều thư mục gốc, hãy chọn thư mục trước bằng <em>agentduo: Choose Workspace Folder</em>.",
])}`,
    },
    {
      id: "composer",
      title: "Composer",
      html: `${ul([
  "Chip dưới ô nhập cho biết tin nhắn gửi cho ai và dùng model nào (ban đầu là Codex). Menu của nó chuyển giữa Codex và Claude, hoặc biến tin nhắn tiếp theo thành câu hỏi <em>Discuss</em> hay tác vụ <em>Pipeline</em>. Lệnh slash gõ trong composer được ưu tiên hơn chip.",
  "Chip chế độ mở menu chế độ của Claude Code (Manual, Edit automatically, Auto). Shift+Tab trong composer chuyển sang chế độ kế tiếp.",
  "Biểu tượng kẹp giấy đính kèm tệp; bạn cũng có thể dán ảnh, hoặc giữ Shift khi kéo tệp từ Finder hay Explorer vào composer.",
  "Enter để gửi, Shift+Enter để xuống dòng. Khi có thứ đang chạy và ô nhập trống, nút gửi trở thành Stop (Esc cũng làm vậy). Một bước bị dừng được tiếp tục bằng " + c("/resume") + " hoặc <em>Resume</em>.",
])}`,
    },
    {
      id: "activity-bar",
      title: "Account & Usage và Conversations",
      html: `${p("Biểu tượng agentduo trên Activity Bar có hai khung nhìn:")}
${ul([
  "<strong>Account &amp; Usage</strong>: tài khoản của cả hai agent và mức giới hạn của mỗi gói đã dùng, với một thanh đo cho mỗi giới hạn và thời điểm nó được đặt lại. Nó hỏi các CLI, không hỏi model. " + link("docs/accounts-usage", "Account &amp; Usage") + ".",
  "<strong>Conversations</strong>: các cuộc trò chuyện của workspace, mới nhất trước. Mở một cuộc đã đóng để tiếp tục; ＋ bắt đầu cuộc mới; một huy hiệu đếm số câu hỏi đang chờ bạn.",
])}`,
    },
    {
      id: "runs",
      title: "Kế hoạch, thay đổi và báo cáo",
      html: `${ul([
  "Menu ⋯ của một tab, và các liên kết dưới mỗi bước, mở kế hoạch, review, phản hồi và báo cáo của lượt chạy trong trình soạn thảo.",
  "<strong>Changes</strong> liệt kê các tệp lượt chạy đã thay đổi và mở từng tệp trong trình soạn diff của VS Code, từ snapshot gốc của lượt chạy đến snapshot mới nhất, nên các chỉnh sửa bạn làm trước lượt chạy không được tính.",
  "<strong>Always allow</strong> trên một yêu cầu cấp quyền lưu quy tắc của Claude vào " + c(".claude/settings.local.json") + ", cùng tệp mà Claude Code dùng.",
])}
${note(p("Tải lại cửa sổ hoặc đóng VS Code sẽ dừng bước hiện tại, giống như Esc. Các quyết định đang chờ được hoãn lại, các yêu cầu cấp quyền chưa trả lời bị từ chối, và lượt chạy vẫn có thể tiếp tục. Tiện ích không bao giờ tự khởi động lại một tác vụ."))}`,
    },
    {
      id: "doctor",
      title: "Doctor và cấu hình",
      html: ul([
        "<em>agentduo: Doctor</em> kiểm tra Node, các CLI, cấu hình và workspace, và ghi kết quả vào kênh output agentduo.",
        "<em>agentduo: Open Configuration</em> mở " + c(".agentduo/config.yaml") + ". Cấu hình giống với của terminal và ứng dụng desktop: " + link("docs/configuration", "Cấu hình") + ".",
        "<em>Settings</em> trên thanh tiêu đề của tab thay đổi model, effort, chế độ và quyền, giống các lệnh cài đặt của chat, và có thể lưu chúng vào cấu hình workspace hoặc người dùng.",
      ]),
    },
  ],
  related: ["docs/conversations", "docs/attachments", "docs/configuration", "troubleshooting"],
  next: p(link("learn/first-task", "Chạy tác vụ đầu tiên của bạn") + ": nó hoạt động tương tự trong một tab của tiện ích."),
});
