export default ({ c, kbd, link, code, p, ul, table, note, h3 }) => ({
  title: "Lệnh gạch chéo",
  description: "Mọi lệnh mà chat AgentDuo nhận, từ /claude, /codex, /pipeline và /discuss đến /resume, /attach, /usage, /mode và /settings, cùng các cờ và phím tắt.",
  lead: p("Dòng bắt đầu bằng " + c("/") + " là một lệnh; mọi dòng khác là tin nhắn cho agent được ghi bên dưới ô nhập, hoặc ghi chú cho pipeline đang chạy. Chat trong terminal, ứng dụng desktop và VS Code đọc lệnh theo cùng một cách."),
  sections: [
    {
      id: "typing",
      title: "Tin nhắn và lệnh",
      html: `${ul([
  "Tin nhắn thường được gửi tới người nhận hiện tại: Codex khi cuộc trò chuyện bắt đầu, cho đến khi " + c("/claude") + " hoặc " + c("/codex") + " đổi người nhận.",
  "Khi pipeline đang chạy, tin nhắn thường là một ghi chú cho nó: các agent nhận được từ bước tiếp theo. Xem " + link("docs/conversations#notes", "Ghi chú") + ".",
  "Gõ " + c("/") + " sẽ hiện danh sách lệnh, và các từ mỗi lệnh nhận khi bạn gõ tiếp.",
  "Lệnh mà chat không biết sẽ không được gửi đi đâu: chat trả lời " + c("unknown command … — /help lists the commands") + ".",
])}`,
    },
    {
      id: "agents",
      title: "Hỏi một agent",
      html: `${table({
  caption: "Các lệnh hỏi một agent",
  head: ["Lệnh", "Tác dụng"],
  rows: [
    [c("/claude <question>"), "Hỏi Claude Code, bất kể người nhận hiện tại là ai."],
    [c("/codex <question>"), "Hỏi Codex, bất kể người nhận hiện tại là ai."],
    [c("/claude") + ", " + c("/codex"), "Gõ riêng: các tin nhắn tiếp theo của bạn sẽ gửi tới agent đó."],
    [c("/claude -- <question>"), "Luôn là câu hỏi, kể cả khi nó bắt đầu bằng tên một thiết lập (" + c("/claude -- model of the cache?") + ")."],
  ],
})}
${p("Các từ sau " + c("/claude") + " hoặc " + c("/codex") + " chỉ là thiết lập khi chúng có đúng dạng của một thiết lập (" + link("docs/slash-commands#settings", "bên dưới") + "); mọi thứ khác là câu hỏi. Khi các từ bắt đầu giống một thiết lập nhưng không khớp, chúng được gửi đi như câu hỏi và chat cho biết cách đặt thiết lập đó.")}`,
    },
    {
      id: "work",
      title: "Giao việc cho cả hai agent",
      html: `${table({
  caption: "Các lệnh bắt đầu công việc",
  head: ["Lệnh", "Tác dụng"],
  rows: [
    [c("/pipeline <task>"), "Chạy toàn bộ quy trình: plan → critique → finalize → implement → verify → review. Cần repository Git. " + link("docs/pipeline", "Pipeline") + "."],
    [c("/discuss <question>"), "Người nhận trả lời, agent kia review, hai bên sửa cho đến khi đồng ý, rồi Codex tổng kết. Chạy được trong mọi thư mục. " + link("docs/discuss", "Thảo luận") + "."],
  ],
})}
${p("Không kèm từ nào, cả hai lệnh in ra cách dùng. Các file đang chờ gửi sẽ đi cùng nhiệm vụ hoặc câu hỏi.")}`,
    },
    {
      id: "runs",
      title: "Lượt chạy",
      html: `${table({
  caption: "Các lệnh về lượt chạy hiện tại",
  head: ["Lệnh", "Tác dụng"],
  rows: [
    [c("/resume"), "Tiếp tục lượt chạy đã dừng bằng " + kbd("Esc") + ", nếu không thì lượt chạy gần nhất của workspace, trừ khi nó đã kết thúc (" + c("DONE") + " hoặc " + c("ABORTED") + ")."],
    [c("/resume <note>"), "Như trên, kèm một ghi chú cho các agent (và các file đang chờ)."],
    [c("/resume <run id>"), "Tiếp tục lượt chạy đó của workspace này."],
    [c("/plan"), "Hiển thị plan cuối của lượt chạy hiện tại (hoặc plan mới nhất)."],
    [c("/diff"), "Hiển thị diff stat của những gì lượt chạy hiện tại đã thay đổi."],
    [c("/status"), "Hiển thị pha, số vòng lập plan và triển khai, chi phí và token của lượt chạy; cả ai đang trả lời hay thảo luận lúc này."],
  ],
})}
${p("Lượt chạy hiện tại là lượt đang chạy, nếu không thì lượt đã dừng, nếu không nữa thì lượt cuối của chat này. " + c("/resume") + " cần repository Git; xem " + link("docs/decisions-resume", "Quyết định và tiếp tục") + " để biết nó làm gì với từng kiểu dừng.")}`,
    },
    {
      id: "files",
      title: "File",
      html: `${table({
  caption: "Các lệnh cho file đính kèm",
  head: ["Lệnh", "Tác dụng"],
  rows: [
    [c("/attach <path>"), "Đính kèm bản sao của một file (ảnh, PDF, văn bản, mã nguồn…) vào tin nhắn tiếp theo. Mỗi lần một file; đường dẫn có dấu cách thì đặt trong ngoặc kép hoặc escape. " + c("~/") + " là thư mục home của bạn."],
    [c("/attachments"), "Liệt kê các file đang chờ gửi cùng tin nhắn tiếp theo, có đánh số."],
    [c("/detach <n>") + ", " + c("/detach all"), "Bỏ một file đang chờ (theo số thứ tự) hoặc bỏ tất cả."],
  ],
})}
${code('/attach screenshots/bug.png\n/attach "~/Desktop/My notes.pdf"\n/detach 1', { label: "Chat" })}
${p("Xem thêm ở " + link("docs/attachments", "File đính kèm") + ".")}`,
    },
    {
      id: "settings",
      title: "Thiết lập: /mode, /claude, /codex và /settings",
      html: `${p("Các lệnh này phỏng theo " + c("/model") + ", " + c("/effort") + ", " + c("/permissions") + " và " + c("/add-dir") + " của chính các CLI, và chỉ thay đổi các cờ mà AgentDuo truyền vào. Không kèm giá trị, mỗi lệnh hiển thị thiết lập hiện tại.")}
${table({
  caption: "Các lệnh thiết lập",
  head: ["Lệnh", "Tác dụng"],
  rows: [
    [c("/mode manual|acceptEdits|auto"), "Chế độ quyền của Claude, trong chat và khi làm implementer của pipeline: Manual (hỏi trước mỗi lần sửa), Edit automatically, hoặc Auto. " + kbd("Shift") + "+" + kbd("Tab") + " chuyển vòng qua các chế độ."],
    [c("/claude model <name|default>"), "Model hoặc bí danh của Claude (" + c("opus") + ", " + c("sonnet") + ", " + c("haiku") + ", hoặc tên đầy đủ)."],
    [c("/claude effort low|medium|high|xhigh|max|default"), "Mức effort của Claude."],
    [c("/claude permissions allow|deny <rule>"), "Một quy tắc công cụ cho các lệnh gọi của AgentDuo, bổ sung vào thiết lập riêng của Claude Code, ví dụ " + c("Bash(npm test:*)") + "."],
    [c("/claude permissions remove <rule>"), "Bỏ một quy tắc allow hoặc deny. Gõ riêng " + c("/claude permissions") + " để liệt kê các quy tắc."],
    [c("/claude add-dir <path>"), "Thêm một thư mục mà Claude được làm việc."],
    [c("/codex model <name|default> [effort]"), "Model của Codex, kèm mức reasoning effort nếu muốn: " + c("minimal") + ", " + c("low") + ", " + c("medium") + ", " + c("high") + ", " + c("xhigh") + ", " + c("max") + "."],
    [c("/codex permissions read-only|auto|full-access|default"), "Những gì Codex được làm: chỉ đọc, sửa file trong workspace, hoặc sửa mọi file và dùng mạng. " + c("full-access") + " cần thêm " + c("--yes") + "."],
    [c("/settings claude|codex <setting> …"), "Dạng chuẩn của cùng các thiết lập: gõ sai sẽ nhận được cách dùng thay vì trở thành câu hỏi. " + c("/settings mode …") + " tương đương " + c("/mode") + "."],
    [c("/settings") + ", " + c("/config"), "Hiển thị các thiết lập mà cả hai agent đang dùng, cùng model của chúng."],
  ],
})}
${h3("scope", "Chat này, workspace này, hay mọi workspace")}
${table({
  caption: "Nơi lưu một thiết lập",
  head: ["Cờ", "Lưu ở"],
  rows: [
    ["(không có)", "Chỉ trong chat này, đến khi nó kết thúc."],
    [c("--save"), "Ghi thêm vào " + c(".agentduo/config.yaml") + " của workspace."],
    [c("--global"), "Ghi thêm vào cấu hình người dùng (" + c("~/.config/agentduo/config.yaml") + ", hoặc " + c("%APPDATA%\\agentduo\\config.yaml") + " trên Windows), cho mọi workspace. Nếu cấu hình của workspace đặt cùng khóa đó, chat sẽ báo rằng cấu hình workspace thắng ở đó."],
    [c("--yes"), "Xác nhận " + c("/codex permissions full-access") + "."],
  ],
})}
${code("/claude model opus --save\n/codex permissions auto --global\n/mode acceptEdits\n/claude permissions allow Bash(npm test:*)", { label: "Chat" })}
${h3("reset", "Quay về mặc định")}
${p(c("default") + " ở vị trí model, effort hay quyền của Codex để CLI tự quyết theo cấu hình riêng của nó: AgentDuo không truyền cờ nào. " + c("/mode manual") + " là chế độ mặc định của Claude, và " + c("/claude permissions remove <rule>") + " bỏ một quy tắc.")}
${h3("when", "Khi nào thay đổi có hiệu lực")}
${p("Thay đổi từ các lệnh này áp dụng cho lượt chạy hoặc cuộc thảo luận đang diễn ra từ lần gọi agent kế tiếp, và vào cấu hình đã lưu của nó, nên lần tiếp tục sau vẫn giữ. Câu hỏi nhận thay đổi từ câu hỏi kế tiếp.")}
${note(p("Các thiết lập chỉ áp dụng cho công việc mới (vai trò " + c("agents") + " và mọi khóa " + c("limits") + ") không phải là lệnh chat; chúng nằm trong các file cấu hình: " + link("docs/config-reference", "Tham chiếu cấu hình") + "."))}`,
    },
    {
      id: "session",
      title: "Bản thân chat",
      html: `${table({
  caption: "Các lệnh về chat",
  head: ["Lệnh", "Tác dụng"],
  rows: [
    [c("/usage"), "Claude Code và Codex đã dùng bao nhiêu hạn mức của gói, không gọi model nào. " + link("docs/accounts-usage", "Tài khoản và mức dùng") + "."],
    [c("/new"), "Một cuộc trò chuyện mới: các agent không còn thấy những gì đã nói trước đó. Lượt chạy đã dừng vẫn tiếp tục được. Trong VS Code, nó mở trong một tab riêng."],
    [c("/help"), "Liệt kê các lệnh, thiết lập và phím tắt."],
    [c("/quit") + ", " + c("/exit"), "Thoát; pipeline đang chạy dừng ở bước hiện tại và vẫn tiếp tục được."],
  ],
})}`,
    },
    {
      id: "keys",
      title: "Phím tắt",
      html: `${table({
  caption: "Phím trong chat",
  head: ["Phím", "Tác dụng"],
  rows: [
    [kbd("Enter"), "Gửi dòng đã gõ. Nếu có file đang chờ mà không có chữ, các file được gửi riêng."],
    [kbd("Esc"), "Dừng việc đang chạy: câu trả lời hay cuộc thảo luận kết thúc tại đó; bước hiện tại của pipeline dừng lại và " + c("/resume") + " sẽ tiếp tục nó."],
    [kbd("Shift") + "+" + kbd("Tab"), "Đổi chế độ của Claude: Manual, Edit automatically, Auto (như trong Claude Code)."],
    [kbd("Ctrl") + "+" + kbd("C") + " hai lần", "Thoát chat trong terminal."],
  ],
})}
${p("Trong ứng dụng desktop và VS Code, menu người nhận còn có " + c("Discuss") + " và " + c("Pipeline") + ": khi đó nội dung bạn gửi là câu hỏi hoặc nhiệm vụ. Lệnh gõ tay vẫn được xử lý đúng như đã gõ.")}`,
    },
  ],
  related: ["docs/conversations", "docs/cli", "docs/permissions", "docs/config-reference"],
});
