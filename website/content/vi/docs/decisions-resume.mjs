export default ({ c, kbd, link, code, p, ul, table, note }) => ({
  title: "Quyết định, dừng và resume",
  description: "Khi nào một lượt chạy AgentDuo dừng để hỏi bạn, resume, revise, abort và quyết định sau làm gì, Stop và Esc hoạt động ra sao, và cách resume từ mọi giao diện.",
  lead: p("Một lượt chạy dừng theo hai cách: nó hỏi bạn một câu (" + c("HUMAN_REVIEW") + "), hoặc bạn dừng nó. Dù cách nào, trạng thái của nó được lưu và nó tiếp tục từ bước đang dở."),
  sections: [
    {
      id: "reasons",
      title: "Khi lượt chạy hỏi bạn",
      html: `${table({
  caption: "Các lý do lượt chạy dừng để chờ quyết định, và resume sẽ làm gì",
  head: ["Lý do", "Khi nào", "Resume làm gì"],
  rows: [
    [c("max_planning_rounds"), "Chưa có kế hoạch được đồng thuận sau giới hạn số vòng lập kế hoạch", "Triển khai kế hoạch mới nhất, được ghi nhận là do bạn chấp nhận"],
    [c("plan_ready"), "Kế hoạch đã chốt và " + c("safety.pause_before_implement") + " đang bật", "Bắt đầu triển khai"],
    [c("max_review_rounds"), "Chưa được chấp thuận sau giới hạn số vòng review", "Bắt đầu một vòng sửa khác"],
    [c("critical_finding"), "Người review báo một phát hiện critical", "Bắt đầu một vòng sửa khác"],
    [c("gates_failing"), "Các cổng bắt buộc thất bại nhiều vòng liên tiếp", "Bắt đầu một vòng sửa khác"],
    [c("implementer_blocked"), "Người triển khai báo bị chặn", "Chạy lại vòng triển khai"],
    [c("agent_error") + ", " + c("orchestrator_error"), "Một lời gọi agent thất bại sau các lần thử lại, hoặc AgentDuo gặp lỗi", "Chạy lại bước đã thất bại"],
  ],
})}`,
    },
    {
      id: "answers",
      title: "Câu trả lời của bạn",
      html: `${table({
  caption: "Bốn câu trả lời",
  head: ["Câu trả lời", "Tác dụng"],
  rows: [
    ["Resume", "Tiếp tục như bảng trên mô tả, có thể kèm một ghi chú cho các agent."],
    ["Revise", "Quay lại lập kế hoạch với ghi chú của bạn, ghi chú này nên giải quyết bất đồng."],
    ["Abort", "Kết thúc lượt chạy. Các tệp của nó vẫn còn; cây làm việc giữ nguyên mọi thay đổi đã thực hiện."],
    ["Decide later", "Để lượt chạy ở trạng thái chờ. Trả lời sau từ bất kỳ giao diện nào."],
  ],
})}
${ul([
  `<strong>Chat trong terminal và lượt chạy ${c('duo "<task>"')} trong terminal</strong>: một menu hiển thị lý do cùng Resume, Revise (kèm ghi chú), các chế độ xem kế hoạch, review, phản hồi về kế hoạch và diff stat, Abort, và Decide later. ${kbd("Ctrl")}+${kbd("C")} tại menu cũng có nghĩa là Decide later.`,
  "<strong>Ứng dụng desktop và VS Code</strong>: quyết định hiện phía trên ô soạn tin, có một ô ghi chú. Nó vẫn ở đó khi bạn chuyển cuộc hội thoại.",
  `<strong>Chế độ plain</strong> (CI, nền, đầu ra qua pipe): lượt chạy thoát với mã 2. Trả lời bằng ${c("duo resume --decision …")}.`,
])}
${code(`duo resume --decision resume
duo resume --decision revise --note "Keep the public API; change only the parser"
duo resume 20261031-101500-add-refresh-tokens --decision abort`, { lang: "sh", label: "Terminal" })}
${note(p("Các tệp đang chờ đính kèm không đi cùng một quyết định. Hãy gửi chúng kèm một tin nhắn trước (một ghi chú cho bước tiếp theo của lượt chạy), hoặc chọn Decide later rồi resume kèm ghi chú."))}`,
    },
    {
      id: "stop",
      title: "Stop và Esc",
      html: `${table({
  caption: "Việc dừng ảnh hưởng thế nào đến từng loại công việc",
  head: ["Công việc", "Dừng bằng Esc hoặc Stop", "Sau đó"],
  rows: [
    ["Một câu trả lời", "Nó kết thúc; không phần nào của nó được đưa vào cuộc hội thoại", "Hỏi lại"],
    ["Một cuộc thảo luận", "Nó kết thúc; không phần nào của nó được đưa vào cuộc hội thoại", "Hỏi lại"],
    ["Một bước pipeline", "Bước kết thúc; lượt chạy được lưu ở trạng thái bị gián đoạn", c("/resume [note]") + " chạy lại bước đó"],
  ],
})}
${ul([
  `Trong lượt chạy pipeline ở terminal (${c('duo "<task>"')}), ${kbd("q")} dừng sau bước hiện tại và ${kbd("Ctrl")}+${kbd("C")} dừng ngay. ${kbd("Ctrl")}+${kbd("C")} lần thứ hai kết thúc tiến trình ngay lập tức; mã thoát là 130.`,
  `Nhấn Enter trên dòng trống chỉ nhắc bạn về ${c("/resume")}. ${c("/pipeline")} khi một lượt chạy đang dừng sẽ bắt đầu một lượt chạy mới; lượt đã dừng giữ id của nó và vẫn có thể resume.`,
  "Đóng chat, thoát ứng dụng desktop hoặc tải lại VS Code sẽ dừng bước hiện tại theo cùng cách: các quyết định được hoãn, các yêu cầu cấp quyền chưa trả lời bị từ chối, khóa được giải phóng, và lượt chạy vẫn có thể resume.",
])}`,
    },
    {
      id: "resume",
      title: "Resume một lượt chạy",
      html: `${table({
  caption: "Các cách resume",
  head: ["Ở đâu", "Cách làm"],
  rows: [
    ["Chat", c("/resume") + " tiếp tục lượt chạy đã dừng hoặc đang chờ; " + c("/resume <note>") + " thêm ghi chú; " + c("/resume <run id>") + " chọn một lượt chạy, kể cả lượt từ phiên trước"],
    ["Terminal", c("duo resume") + " (lượt chạy mới nhất) hoặc " + c("duo resume <run id>")],
    ["Ứng dụng desktop", "<em>Resumable runs</em> trong thanh bên liệt kê các lượt chạy đã dừng và đang chờ của dự án; một cú nhấp để resume"],
    ["VS Code", "<em>Resume</em> trên thanh tiêu đề của một tab tiếp tục lượt chạy mới nhất"],
  ],
})}
${ul([
  "Các lượt chạy được chia sẻ: một lượt chạy bắt đầu ở một giao diện có thể được resume ở giao diện khác, trong cùng workspace. Một lượt chạy thuộc về workspace của nó; resume từ thư mục khác sẽ bị từ chối.",
  `Một lượt chạy được resume giữ cấu hình lúc nó bắt đầu (${c("config.json")} của nó). ${c("duo resume --reload-config")} dùng ${c("config.yaml")} hiện tại thay thế; cài đặt riêng của Claude Code và Codex luôn áp dụng đúng như hiện tại.`,
  `Các cài đặt thay đổi trong chat có hiệu lực từ lời gọi tiếp theo (model, effort, chế độ quyền và tương tự) cũng đến được lượt chạy đã resume; các cài đặt có hiệu lực từ lượt chạy tiếp theo (${c("agents.*")}, ${c("limits.*")}) thì không. ${link("docs/configuration#when-it-applies", "Khi nào một thay đổi có hiệu lực")}.`,
])}`,
    },
    {
      id: "conversation-vs-run",
      title: "Tiếp tục cuộc hội thoại không phải là resume một lượt chạy",
      html: `${p("Mở lại một cuộc hội thoại trước đó (trong thanh bên của ứng dụng desktop hoặc chế độ xem Conversations của VS Code) cho phép bạn tiếp tục trò chuyện: câu hỏi tiếp theo mang theo những gì đã nói. Nó không khởi động lại công việc nào. Resume tiếp tục một lượt chạy pipeline từ bước đã lưu; nó không cần cuộc hội thoại, cũng không cần các tệp đính kèm gốc mà lượt chạy đã sao chép.")}`,
    },
  ],
  related: ["docs/pipeline", "docs/cli#resume", "docs/conversations#history", "docs/configuration"],
});
