export default ({ c, kbd, link, p, ul, table, note, h3 }) => ({
  title: "Tài khoản và mức sử dụng",
  description: "Cách AgentDuo cho biết Claude Code và Codex dùng tài khoản nào và đã dùng bao nhiêu hạn mức của gói: /usage, các khung Account & Usage, và số liệu lấy từ đâu.",
  lead: p("AgentDuo dùng chính phiên đăng nhập Claude Code và Codex của bạn. " + c("/usage") + " và các khung Account & Usage cho biết tài khoản của từng agent và đã dùng bao nhiêu hạn mức của gói, đọc trực tiếp từ các CLI, không gọi model."),
  sections: [
    {
      id: "accounts",
      title: "Tài khoản của bạn, không phải của AgentDuo",
      html: `${ul([
  "AgentDuo không kèm gói đăng ký hay tín dụng API nào, và không giữ thông tin đăng nhập. Mỗi CLI đăng nhập theo cách riêng: " + c("claude") + " rồi " + c("/login") + ", và " + c("codex login") + ".",
  "Mọi lần gọi agent đều tính vào gói hoặc API key của CLI đó, như thể bạn tự chạy CLI.",
  "Việc tra cứu tài khoản và hạn mức chỉ hỏi các CLI trên máy bạn; AgentDuo không gửi số liệu đi đâu khác.",
])}
${p("Cài đặt và đăng nhập các CLI: " + link("learn/prerequisites", "yêu cầu trước khi dùng") + ".")}`,
    },
    {
      id: "usage-command",
      title: "/usage",
      html: `${p("Trong chat, " + c("/usage") + " mở một bảng thay cho ô nhập, giống " + c("/usage") + " của chính Claude Code:")}
${ul([
  "tài khoản của từng agent: gói và email;",
  "đã dùng bao nhiêu trong từng hạn mức của gói, mỗi hạn mức một thanh, kèm thời điểm đặt lại;",
  "sau đó là phần “What’s contributing to your limits usage?” của Claude.",
])}
${p("Bảng mở ngay và phần của từng agent được điền khi agent đó trả lời, khoảng hai giây (mỗi bên có 15 giây). Nếu một bên lỗi, chỉ phần của bên đó nói lý do. " + kbd("↑") + kbd("↓") + " để cuộn, " + kbd("r") + " để tra lại, và " + kbd("Esc") + " chỉ đóng bảng: câu trả lời đang chạy vẫn tiếp tục. Trong VS Code, " + c("/usage") + " hoặc <em>Usage</em> trong menu ⋯ của tab mở cùng bảng đó phía trên ô soạn tin.")}`,
    },
    {
      id: "sources",
      title: "Số liệu lấy từ đâu",
      html: `${table({
  caption: "Cách hỏi từng agent",
  head: ["Agent", "Tài khoản", "Hạn mức"],
  rows: [
    ["Claude Code", c("claude auth status") + " (JSON): gói với tài khoản claude.ai, nếu không thì cách nó đăng nhập, cùng email", c("claude -p /usage") + ", in ra " + c("/usage") + " của Claude Code mà không gọi model"],
    ["Codex", c("account/read"), c("account/rateLimits/read") + ", cả hai hỏi " + c("codex app-server") + " qua JSON-RPC trên stdio, giống extension IDE của Codex, kèm các override " + c("-c") + "/" + c("--enable") + "/" + c("--disable") + " của bạn"],
  ],
})}
${note(p(c("/status") + " của Codex chỉ có trong giao diện terminal của nó, còn " + c('codex exec "/status"') + " sẽ gửi chữ đó cho model, nên AgentDuo hỏi app server thay vào đó."))}`,
    },
    {
      id: "desktop",
      title: "Trong ứng dụng desktop",
      html: `${h3("sidebar-box", "Khung Account & Usage ở thanh bên")}
${ul([
  "Ở cuối thanh bên, phía trên Settings: email của từng agent và các hạn mức, mỗi hạn mức một phần trăm và một thanh mảnh. Gói và thời điểm đặt lại nằm trong tooltip.",
  "Bấm vào tiêu đề để thu gọn; nó giữ trạng thái thu gọn.",
  "Nó tra số liệu khi ứng dụng khởi động và khi bạn đổi dự án (trừ khi số liệu chưa quá một phút), mỗi 5 phút khi cửa sổ đang hiện, sau mỗi lượt agent trả lời xong, và khi bấm nút làm mới. Khi thu gọn, nó không tra gì.",
])}
${h3("settings-cards", "Settings → Claude & Codex")}
${ul([
  "Mỗi CLI một thẻ: email đăng nhập, gói, đường dẫn và phiên bản, cùng các hạn mức, mỗi hạn mức một thanh kèm thời điểm đặt lại.",
  "API key hoặc nhà cung cấp cloud hiện là <em>API</em> thay cho email.",
  "Hạn mức được tra khi trang mở (trừ khi chưa quá một phút), mỗi 5 phút khi trang đang hiện, và khi bấm <em>Recheck</em>.",
])}
${p("Thanh chuyển sang màu hổ phách (màu cảnh báo) từ 70% và màu đỏ (màu lỗi) từ 90%. Các thanh của extension VS Code dùng cùng ngưỡng.")}`,
    },
    {
      id: "vscode",
      title: "Trong VS Code",
      html: `${p("Khung AgentDuo ở Activity Bar có view <strong>Account & Usage</strong> phía trên danh sách cuộc trò chuyện: cả hai tài khoản (gói và email) và một thanh cho mỗi hạn mức kèm thời điểm đặt lại.")}
${ul([
  "Nó tra số liệu khi hiện ra (tra lại khi số liệu đã quá một phút), khi bấm <strong>↻</strong>, mỗi 5 phút khi đang hiện, và sau một câu trả lời hay một lượt chạy ở bất kỳ tab nào, tối đa một lần mỗi phút. View đang thu gọn hoặc bị ẩn thì không tra gì.",
  "Nếu một agent không trả lời được, chỉ phần của nó nói lý do.",
  "<strong>View details</strong> mở bảng Usage của tab, kèm phần “What’s contributing to your limits usage?” của Claude.",
])}`,
    },
  ],
  related: ["learn/prerequisites", "docs/slash-commands", "docs/data-diagnostics", "learn/vscode"],
});
