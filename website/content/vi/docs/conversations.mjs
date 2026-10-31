export default ({ c, kbd, link, p, ul, table, note, h3 }) => ({
  title: "Cuộc trò chuyện",
  description: "Chat ba bên giữa bạn, Claude Code và Codex: chọn ai trả lời, model, ghi chú khi đang chạy, lịch sử, chat ở thư mục home và cách tiếp tục một cuộc trò chuyện.",
  lead: p("Cuộc trò chuyện là cuộc chat giữa bạn và cả hai agent. Mỗi tin nhắn đến một agent, cả hai agent đều thấy những gì đã nói, và pipeline đầy đủ chỉ chạy khi bạn yêu cầu."),
  sections: [
    {
      id: "recipient",
      title: "Ai trả lời",
      html: `${p("Tin nhắn thường được gửi tới agent có tên bên dưới ô nhập: Codex trong cuộc trò chuyện mới, sau đó là agent bạn chọn gần nhất.")}
${table({
  caption: "Chọn người nhận",
  head: ["Bạn gõ hoặc chọn", "Điều xảy ra"],
  rows: [
    [c("/claude <question>"), "Hỏi Claude Code câu này một lần."],
    [c("/codex <question>"), "Hỏi Codex câu này một lần."],
    [c("/claude") + " hoặc " + c("/codex") + " đứng một mình", "Các tin nhắn tiếp theo của bạn đến agent đó."],
    [c("/claude -- <question>"), "Luôn là câu hỏi, kể cả khi nó trông giống một cài đặt (xem bên dưới)."],
    ["Menu người nhận (desktop, VS Code)", "Codex, Claude, <em>Discuss</em> hoặc <em>Pipeline</em> cho tin nhắn tiếp theo. Lệnh gõ tay được ưu tiên hơn menu."],
  ],
})}
${p("Mỗi câu trả lời được hiển thị đầy đủ, một lần, kèm biểu tượng của nhà cung cấp (Anthropic hoặc OpenAI) và model đã chạy.")}
${note(p(c("/claude model opus") + " đổi model của Claude, vì các từ khớp chính xác với cài đặt đó. " + c("/claude model which is best for this repo?") + " không khớp, nên nó được gửi cho Claude như một câu hỏi, nguyên văn từng chữ. " + link("docs/slash-commands#settings", "Lệnh cài đặt") + "."))}`,
    },
    {
      id: "context",
      title: "Mỗi agent thấy gì",
      html: `${ul([
  `Cả hai agent nhận toàn bộ cuộc trò chuyện, tối đa 120.000 ký tự. Các lượt trao đổi cũ hơn bị bỏ nguyên lượt, và chat sẽ báo điều đó.`,
  `${c("/pipeline <task>")} cho mọi vai trò của lần chạy biết những gì đã nói trước tác vụ, và các tác vụ pipeline trước đó của cuộc trò chuyện đã làm gì.`,
  `Một workspace chỉ chạy một pipeline tại một thời điểm. Trong VS Code, các tab cuộc trò chuyện trả lời song song; một ${c("/pipeline")} thứ hai sẽ cho biết lần chạy của cuộc trò chuyện nào đang diễn ra.`,
])}`,
    },
    {
      id: "models",
      title: "Model",
      html: `${p("Ô nhập hiển thị model của cả hai agent. Trước câu trả lời đầu tiên, AgentDuo tra cứu chúng mà không gọi model: model của Codex bằng " + c("codex doctor --json") + " (cùng các ghi đè " + c("-c") + ", " + c("--enable") + " và " + c("--disable") + " của bạn), model của Claude từ " + c("--model") + ", " + c("ANTHROPIC_MODEL") + " và các tệp cài đặt của Claude Code.")}
${ul([
  `Một alias trong cài đặt Claude hiển thị là ${c("default → sonnet (configured alias)")} cho đến khi câu trả lời đầu tiên của Claude nêu đúng model.`,
  `Với ${c("--profile")} của Codex, model hiển thị là chưa xác định, kèm lý do: ${c("codex doctor")} không nhận profile.`,
  `Mỗi câu hỏi và mỗi lần chạy tra cứu lại, nên ${c("~/.codex/config.toml")} hoặc tệp cài đặt Claude đã sửa sẽ hiển thị từ lần sau.`,
  `Chỉ đổi model cho AgentDuo bằng ${c("/claude model <name>")} hoặc ${c("/codex model <name> [effort]")}. ${link("docs/configuration", "Cấu hình")}.`,
])}`,
    },
    {
      id: "notes",
      title: "Tin nhắn khi pipeline đang chạy",
      html: `${p("Khi một bước pipeline đang chạy, những gì bạn gõ là một ghi chú: mọi bước từ bước kế tiếp trở đi đều mang theo nó. " + c("/claude") + ", " + c("/codex") + ", " + c("/pipeline") + " và " + c("/discuss") + " sẽ báo workspace đang bận. Tệp bạn đính kèm đi cùng ghi chú.")}`,
    },
    {
      id: "stop",
      title: "Dừng một câu trả lời",
      html: `${p(kbd("Esc") + " (hoặc Stop trong ứng dụng desktop và VS Code) dừng thứ đang chạy. Câu trả lời hoặc cuộc thảo luận bị dừng chỉ đơn giản kết thúc, và không có gì của nó được thêm vào cuộc trò chuyện. Một bước pipeline bị dừng vẫn có thể resume: " + link("docs/decisions-resume#stop", "Dừng và resume") + ".")}`,
    },
    {
      id: "history",
      title: "Lịch sử và tiếp tục cuộc trò chuyện",
      html: `${p("Cuộc trò chuyện được lưu trong thư mục runs, tại " + c(".agentduo/runs/conversations/<id>/") + ": nội dung đã nói, các tệp đính kèm và log của từng lần gọi.")}
${h3("history-desktop", "Ứng dụng desktop")}
${ul([
  "Thanh bên liệt kê các cuộc trò chuyện của từng dự án; <em>Conversations</em> ở trên cùng chứa các chat không thuộc dự án nào. Bấm vào một cuộc để tiếp tục: câu hỏi kế tiếp của nó mang theo những gì đã nói trước đó.",
  "Các cuộc trò chuyện quay lại sau khi khởi động lại, cùng nội dung đã hiển thị và bản nháp.",
])}
${h3("history-vscode", "VS Code")}
${ul([
  "Mỗi cuộc trò chuyện là một tab; VS Code mở lại chúng sau khi reload hoặc khởi động lại. View Conversations liệt kê các cuộc trò chuyện của workspace, đang mở và đã đóng; mở một cuộc đã đóng để tiếp tục.",
  "Một tab giữ tối đa 400 mục và khoảng 2.000.000 ký tự câu trả lời; các lượt cũ hơn bị bỏ nguyên lượt, kèm thông báo nơi có log đầy đủ, và câu trả lời mới nhất luôn được giữ.",
])}
${h3("history-terminal", "Terminal")}
${ul([
  `Mỗi phiên ${c("duo")} bắt đầu một cuộc trò chuyện mới; ${c("/new")} bắt đầu một cuộc khác trong cùng phiên. Các phiên trước vẫn nằm trên đĩa, nhưng chat trong terminal không mở lại chúng.`,
  `Thứ terminal có thể tiếp tục là một lần chạy pipeline: ${c("/resume")} hoặc ${c("duo resume")}, kể cả với lần chạy bắt đầu từ ứng dụng desktop hoặc VS Code.`,
])}`,
    },
    {
      id: "home-folder",
      title: "Chat không có dự án",
      html: `${p("Cuộc trò chuyện và " + c("/discuss") + " không cần repository Git. Khi không mở thư mục nào, ứng dụng desktop và tiện ích VS Code làm việc trong thư mục home của bạn, giống " + c("duo") + " khi bạn khởi động nó ở đó, nên các cuộc trò chuyện này và cấu hình của chúng nằm trong " + c("~/.agentduo") + ". Pipeline cần một thư mục dự án nằm trong repository Git; từ thư mục home bạn sẽ được yêu cầu mở một thư mục.")}`,
    },
  ],
  related: ["docs/discuss", "docs/pipeline", "docs/attachments", "docs/slash-commands"],
});
