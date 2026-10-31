export default ({ c, kbd, link, code, p, ul, table, note }) => ({
  title: "Bắt đầu trong terminal",
  description: "Cài lệnh duo từ npm, thiết lập workspace bằng duo init và duo doctor, chat với cả hai agent, chạy pipeline, và dùng duo trong script và CI.",
  lead: p(`Gói npm ${c("agentduo")} cài lệnh ${c("duo")}: chat trong terminal với góc nhìn trực tiếp vào cả hai agent, và các lệnh chạy pipeline không cần giám sát. ${c("agentduo")} là cùng một lệnh, dùng khi công cụ khác đã chiếm tên ${c("duo")}.`),
  sections: [
    {
      id: "install",
      title: "Cài đặt",
      html: `${p("Bạn cần Node.js 22.12 trở lên, Git, và cả hai CLI đã đăng nhập (" + link("learn/prerequisites", "Bạn cần chuẩn bị gì") + ").")}
${code("npm i -g agentduo\nduo --version", { lang: "sh", label: "Terminal" })}`,
    },
    {
      id: "workspace",
      title: "Thiết lập workspace",
      html: `${p("Workspace là thư mục bạn chạy " + c("duo") + " (hoặc thư mục chỉ định bằng " + c("--dir") + "). Nó có thể là thư mục con của một kho: khi đó chỉ thay đổi trong thư mục đó được gửi đến reviewer.")}
${code("cd my-project\nduo init\nduo doctor", { lang: "sh", label: "Terminal" })}
${ul([
  `${c("duo init")} tạo ${c(".agentduo/config.yaml")}, trong đó mọi thiết lập đều được comment lại, kèm các gate nó phát hiện được (ví dụ ${c("npm run test")} từ ${c("package.json")}) làm gợi ý. Nó cũng tạo ${c(".agentduo/.gitignore")}, giữ dữ liệu chạy ra khỏi Git, và đề nghị ${c("git init")} khi thư mục chưa phải là kho.`,
  `${c("duo doctor")} kiểm tra Node, Git, cấu hình và cả hai CLI, và không gọi model nào. Nó kết thúc bằng ${c("doctor: ready")} hoặc ${c("doctor: problems found")}.`,
])}`,
    },
    {
      id: "chat",
      title: "Chat với cả hai agent",
      html: `${p("Chạy " + c("duo") + " không kèm tác vụ để mở chat. Dòng dưới ô nhập cho biết tin nhắn của bạn gửi cho ai: Codex trong chat mới, sau đó là người bạn chọn gần nhất.")}
${code(`duo
› What does src/auth do, in two sentences?
› /claude Would you split it differently?
› /discuss Is the token check safe against replay?`, { label: "duo" })}
${ul([
  `${c("/claude <question>")} và ${c("/codex <question>")} hỏi một agent; ${c("/claude")} hoặc ${c("/codex")} đứng một mình sẽ chuyển người nhận cho các tin nhắn tiếp theo. Cả hai agent đều thấy toàn bộ cuộc trò chuyện.`,
  `${c("/discuss <question>")} để cả hai agent cùng tìm ra một câu trả lời, và Codex tổng hợp lại. ${link("docs/discuss", "Thảo luận")}.`,
  `Gõ ${c("/")} mở danh sách lệnh, lọc theo những gì bạn gõ. ${c("/help")} cũng liệt kê chúng.`,
  `${kbd("Esc")} dừng thứ đang chạy. ${c("/quit")} (hoặc ${kbd("Ctrl")}+${kbd("C")} hai lần) để thoát; pipeline đang chạy dừng ở bước hiện tại và vẫn có thể tiếp tục.`,
])}`,
    },
    {
      id: "pipeline",
      title: "Chạy pipeline",
      html: `${p("Trong một kho Git, giao một tác vụ cho toàn bộ workflow:")}
${code("/pipeline Add a --json flag to the export command, with tests", { label: "duo" })}
${p("Góc nhìn trực tiếp hiển thị từng bước, agent đang làm bước đó và những gì các agent chuyển cho nhau. Trong khi chạy, tin nhắn bạn gõ sẽ trở thành ghi chú cho bước tiếp theo. Khi kết thúc, hãy xem lại các thay đổi bằng " + c("git diff") + " và tự commit.")}
${p(link("learn/first-task", "Tác vụ đầu tiên") + " hướng dẫn một lượt chạy hoàn chỉnh; " + link("docs/pipeline", "Pipeline") + " giải thích từng bước.")}`,
    },
    {
      id: "scripts",
      title: "Trong script và CI",
      html: `${p("Đưa cho " + c("duo") + " một tác vụ để chạy pipeline một lần rồi thoát. Khi không có terminal (trong CI, chạy nền, hoặc output được pipe), nó in các dòng văn bản thuần có dấu thời gian.")}
${code(`duo --accept-edits "Fix the failing date test"
echo "exit code: $?"`, { lang: "sh", label: "Terminal" })}
${table({
  caption: "Ý nghĩa của mã thoát",
  head: ["Mã thoát", "Ý nghĩa"],
  rows: [
    ["0", "Lượt chạy đã hoàn tất."],
    ["2", "Lượt chạy đang chờ quyết định của bạn. Trả lời bằng " + c('duo resume --decision resume|revise|abort [--note "..."]') + "."],
    ["1, 3, 130", "Lỗi cấu hình hoặc môi trường, một lượt chạy bị hủy, hoặc một lượt chạy bị dừng có thể tiếp tục. " + link("docs/cli#exit-codes", "Mã thoát") + "."],
  ],
})}
${note(p(`Trong CI không ai trả lời được yêu cầu cấp quyền, nên Claude từ chối các lệnh gọi công cụ mà cài đặt của nó không cho phép. Hãy cho phép trước những gì bên triển khai cần: ${link("docs/permissions#unattended", "các lượt chạy không giám sát")}.`))}`,
    },
  ],
  related: ["docs/cli", "docs/slash-commands", "docs/configuration", "troubleshooting"],
  next: p(link("learn/first-task", "Chạy tác vụ đầu tiên của bạn") + " với một test gate, từ đầu đến cuối."),
});
