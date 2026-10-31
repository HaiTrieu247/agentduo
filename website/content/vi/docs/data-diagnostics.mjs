export default ({ c, link, code, p, ul, table, note, h3 }) => ({
  title: "Dữ liệu và chẩn đoán",
  description: "AgentDuo lưu lượt chạy, cuộc trò chuyện và file đính kèm ở đâu, mỗi file của lượt chạy chứa gì, và cách kiểm tra cài đặt bằng duo doctor và Diagnostics của ứng dụng desktop.",
  lead: p("AgentDuo lưu mọi thứ nó ghi vào thư mục runs trong workspace của bạn, dưới dạng file thường đọc được: kế hoạch, review, báo cáo của từng lượt chạy và log của mọi lần gọi CLI. Không có gì được gửi đi đâu ngoài hai CLI."),
  sections: [
    {
      id: "runs-dir",
      title: "Thư mục runs",
      html: `${p("Mặc định là " + c(".agentduo/runs") + " trong workspace; " + c("paths.runs_dir") + " đổi được vị trí. AgentDuo tạo thư mục này kèm một " + c(".gitignore") + " chứa " + c("*") + ", nên dữ liệu của nó nằm ngoài Git, và mọi snapshot đều bỏ qua nó.")}
${table({
  caption: "Thư mục runs chứa gì",
  head: ["Đường dẫn", "Là gì"],
  rows: [
    [c("<run id>/"), "một lượt chạy pipeline, ví dụ " + c("20261031-101500-add-refresh-tokens")],
    [c("conversations/<id>/"), "một cuộc trò chuyện trong chat: " + c("conversation.json") + " khi đã có nội dung, log của nó, và " + c("attachments/")],
    [c("LATEST"), "id của lượt chạy gần nhất, mà " + c("duo resume") + " chọn"],
    [c(".lock"), "khóa workspace: mỗi lúc một pipeline, chứa process id"],
  ],
})}
${note(p("Chỉ đổi " + c("paths.runs_dir") + " khi mọi AgentDuo đã đóng: khóa workspace nằm ở đó."), "warning")}`,
    },
    {
      id: "run-files",
      title: "File của lượt chạy",
      html: `${p("Mọi thứ về một lượt chạy nằm trong " + c(".agentduo/runs/<run id>/") + ":")}
${table({
  caption: "Các file của một lượt chạy",
  head: ["File", "Chứa gì"],
  rows: [
    [c("state.json"), "trạng thái lượt chạy, ghi lại sau mỗi bước; nhờ nó lượt chạy có thể resume"],
    [c("config.json"), "cấu hình lúc lượt chạy bắt đầu (" + c("duo resume --reload-config") + " thay nó)"],
    [c("report.md"), "dòng thời gian, kết quả gate, diff stat, vấn đề chưa giải quyết, cảnh báo, chi phí và token"],
    [c("events.jsonl"), "các sự kiện của lượt chạy, mỗi dòng một đối tượng JSON, kèm thời điểm"],
    [c("plan.v<n>.md") + ", " + c("plan.v<n>.json") + ", " + c("plan.md"), "từng phiên bản kế hoạch, và bản mới nhất"],
    [c("critique.r<n>.json") + ", " + c("plan-feedback.md"), "phản biện của từng vòng, và tất cả dưới dạng Markdown"],
    [c("approval.r<n>.json") + ", " + c("plan.final.md"), "phần chốt của planner và kế hoạch cuối cùng"],
    [c("review.r<n>.json") + ", " + c("review.json"), "từng lần review code, và lần mới nhất"],
    [c("gates/"), "output của từng gate, một file " + c(".log") + " cho mỗi gate và mỗi vòng"],
    [c("attachments/"), "bản sao các file đính kèm vào task"],
    [c("logs/"), "mọi lần gọi CLI, xem bên dưới"],
  ],
})}
${p("Mỗi JSON của agent mang task id, vòng, thời điểm, Git SHA và phiên bản kế hoạch.")}
${h3("call-logs", "Log của từng lần gọi")}
${p("Mỗi lần gọi CLI ghi các file đặt tên theo bước, vòng và lần thử (" + c("<step>.a<attempt>.*") + ") trong " + c("logs/") + ":")}
${ul([
  `${c(".prompt.md")}: prompt đúng như agent nhận (ảnh đính kèm chỉ được liệt kê, không bao giờ ghi nội dung byte);`,
  `${c(".cmd.json")}: dòng lệnh;`,
  `${c(".events.jsonl")}: luồng sự kiện thô của CLI; ${c(".stderr.txt")}: output lỗi của nó;`,
  `${c(".output.json")} hoặc ${c(".answer.md")}: câu trả lời AgentDuo đã đọc;`,
  `${c(".answers.jsonl")}: câu trả lời của bạn cho lời hỏi quyền của Claude; ${c(".attachments.json")}: các file mà lần gọi nhận được.`,
])}
${p("Một bước thất bại vì lỗi để lại " + c("logs/error-step<n>.txt") + ". Cuộc trò chuyện giữ log các lần gọi giống vậy trong thư mục riêng của nó.")}`,
    },
    {
      id: "attachments",
      title: "File đính kèm",
      html: `${ul([
  `AgentDuo sao chép từng file đính kèm, giữ nguyên byte, vào ${c("conversations/<id>/attachments/")}, hoặc vào ${c("attachments/")} của lượt chạy với task của pipeline, nên ${c("/resume")} không cần file gốc lẫn cuộc chat.`,
  "Các bản sao không bao giờ nằm trong snapshot hay trong diff mà reviewer xem.",
  "File đang chờ gửi sẽ bị bỏ khi dùng " + c("/new") + " và khi chat đóng; file đã gửi thì được giữ lại.",
])}
${p("Xem thêm: " + link("docs/attachments", "file đính kèm") + ".")}`,
    },
    {
      id: "doctor",
      title: "duo doctor",
      html: `${code("duo doctor", { lang: "sh", label: "Terminal" })}
${p("Kiểm tra cài đặt của bạn mà không gọi model:")}
${ul([
  "Node (22.12 trở lên), Git, và workspace có nằm trong một Git repository không;",
  "các file cấu hình và output schema;",
  "từng CLI: có tìm thấy không, phiên bản, và các cờ giao thức AgentDuo cần;",
  "ghi chú về quyền, chẳng hạn implementer là Codex thì dựa vào sandbox Codex của bạn;",
  "lệnh của từng gate, và thư mục runs có bị Git bỏ qua không.",
])}
${p("Hãy chạy nó sau khi cài hoặc nâng cấp Claude Code hay Codex. Ứng dụng desktop hiện cùng các bước kiểm tra này trong Settings → Diagnostics.")}`,
    },
    {
      id: "desktop",
      title: "Chẩn đoán trong ứng dụng desktop",
      html: `${ul([
  "<strong>Settings → Diagnostics</strong> hiện các phiên bản, PATH mà agent nhận và nguồn của từng mục, trạng thái của cả hai CLI, các bước kiểm tra của " + c("duo doctor") + " và các dòng log gần đây của ứng dụng, kể cả của bộ cập nhật.",
  "<strong>Export</strong> ghi đúng những gì phần xem trước hiển thị. Nó bỏ ra thông tin đăng nhập, prompt, file đính kèm và biến môi trường; thư mục home được ghi là " + c("~") + ", và các token dài trở thành " + c("[redacted]") + ".",
  "<strong>Settings → Storage</strong> (chỉ đọc) cho biết lượt chạy và cuộc trò chuyện nằm ở đâu, và ứng dụng giữ dữ liệu riêng ở đâu.",
])}
${table({
  caption: "Dữ liệu riêng của ứng dụng desktop (tùy chọn, dự án đã biết, bản nháp, log)",
  head: ["Hệ điều hành", "Thư mục"],
  rows: [
    ["macOS", c("~/Library/Application Support/AgentDuo")],
    ["Windows", c("%APPDATA%\\AgentDuo")],
    ["Linux", c("~/.config/AgentDuo")],
  ],
})}`,
    },
  ],
  related: ["docs/pipeline", "docs/decisions-resume", "docs/attachments", "docs/permissions"],
});
