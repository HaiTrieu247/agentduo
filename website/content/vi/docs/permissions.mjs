export default ({ c, link, code, ex, p, ul, table, note, h3 }) => ({
  title: "Quyền và phạm vi",
  description: "AgentDuo cho agent làm gì: không gì vượt quá những gì Claude Code và Codex đã cho phép. Cờ giao thức, lời hỏi quyền, Always allow, cảnh báo và chạy không người trông.",
  lead: p("AgentDuo không áp đặt gì cả. Mỗi agent được làm gì là do cấu hình của chính CLI đó quyết định: settings và permission mode của Claude Code, sandbox và approval của Codex. AgentDuo chỉ truyền các cờ mà giao thức của nó cần, chuyển lời hỏi quyền của Claude đến bạn khi có người trả lời được, và báo cáo những gì agent đã làm."),
  sections: [
    {
      id: "model",
      title: "Ai quyết định điều gì",
      html: `${p("AgentDuo chỉ truyền các cờ mà giao thức của nó cần: JSON dạng stream, output schema, và prompt qua stdin. Không cờ nào trong số đó cấp quyền. Mọi thứ khác do bạn đặt:")}
${ul([
  `<strong>Claude Code</strong>: settings của bạn (${c("~/.claude/settings.json")}, ${c(".claude/settings.json")}, ${c(".claude/settings.local.json")}). Ở chế độ không tương tác, Claude chỉ dùng được công cụ mà settings cho phép, hoặc công cụ bạn cho phép khi nó hỏi.`,
  `<strong>Codex</strong>: ${c("~/.codex/config.toml")}, ví dụ ${c("sandbox_mode")}. ${c("codex exec")} chỉ đọc, trừ khi bạn cấu hình khác.`,
  `<strong>Cờ riêng cho các lần gọi của AgentDuo</strong>: ${c("args")} cho mọi lần gọi một agent, ${c("role_args")} theo từng vai trò, trong ${c(".agentduo/config.yaml")}. Chúng đến CLI đúng như bạn viết; settings Claude Code và Codex của bạn giữ nguyên.`,
  `<strong>Hướng dẫn trong repository</strong>: ${c("AGENTS.md")} và ${c("CLAUDE.md")}, do chính các CLI đọc.`,
])}
${code(`claude:
  role_args:
    implementer: [--permission-mode, acceptEdits]
codex:
  role_args:
    code_reviewer: [--sandbox, read-only]`, { lang: "yaml", label: ".agentduo/config.yaml" })}
${note(p("Codex làm implementer cần quyền ghi: " + c('sandbox_mode = "workspace-write"') + " trong cấu hình Codex, hoặc " + c("codex.role_args.implementer: [--sandbox, workspace-write]") + "."))}`,
    },
    {
      id: "prompts",
      title: "Lời hỏi quyền của Claude",
      html: `${p("Khi Claude muốn dùng một công cụ mà settings không cho phép, lượt chạy tạm dừng và AgentDuo hiện đúng lời hỏi của Claude, trong terminal, ứng dụng desktop hoặc VS Code:")}
${code(`⚠ Claude (implementer) asks to use Bash
  Bash  npm test
❯ Allow once
  Always allow Bash(npm test:*)  saved by Claude to .claude/settings.local.json
  Deny
  Deny with a message…`, { label: "duo" })}
${ul([
  `<strong>Always allow</strong> trả lại cho Claude quy tắc nó đề xuất, và Claude lưu quy tắc đó vào ${c(".claude/settings.local.json")}, giống như khi bạn trả lời trực tiếp. File này không bao giờ nằm trong snapshot hay trong diff mà reviewer xem.`,
  "<strong>Deny with a message</strong> cho Claude biết nên làm gì thay thế.",
  "Thời gian chờ của agent ngừng đếm trong lúc lời hỏi đợi bạn.",
])}
${h3("host-mode", "Khi nào AgentDuo chuyển lời hỏi")}
${p("Claude chạy ở host mode (" + c("--permission-prompts host --permission-prompt-tool stdio") + ") chỉ khi có người trả lời được: một cuộc chat, một lượt chạy trong ứng dụng desktop hoặc VS Code, một lượt chạy trong terminal. Ở nơi không ai trả lời được (CI, chạy nền, output chuyển sang chỗ khác), mọi lần gọi đều nhận " + c("--permission-prompts none") + ", và Claude tự từ chối những lần gọi công cụ đó thay vì chờ mãi. " + c("claude.permission_prompts: deny") + " làm vậy ở mọi nơi; mặc định là " + c("ask") + ".")}`,
    },
    {
      id: "chat-settings",
      title: "Đổi quyền ngay trong chat",
      html: `${table({
  caption: "Các lệnh về quyền trong chat",
  head: ["Lệnh", "Thay đổi gì"],
  rows: [
    [c("/mode manual|acceptEdits|auto") + ", Shift+Tab", "permission mode của Claude, trong chat và khi làm implementer của pipeline; plan critic không bị ảnh hưởng"],
    [c("/claude permissions [allow|deny|remove <rule>]"), "quy tắc công cụ của Claude cho các lần gọi của AgentDuo, ví dụ " + c("Bash(npm test:*)")],
    [c("/claude add-dir <path>"), "thêm một thư mục mà Claude được làm việc"],
    [c("/codex permissions read-only|auto|full-access|default"), "sandbox của Codex; " + c("full-access") + " yêu cầu bạn xác nhận bằng " + c("--yes")],
  ],
})}
${p("Các lệnh này chỉ đổi cờ, và có hiệu lực từ lần gọi tiếp theo của agent. Ngoài chat, " + c('duo --accept-edits "<task>"') + " làm điều tương tự " + c("/mode acceptEdits") + ". Tất cả các lệnh: " + link("docs/slash-commands", "lệnh slash") + ".")}`,
    },
    {
      id: "warnings",
      title: "AgentDuo báo cáo những gì",
      html: `${p("AgentDuo không chặn việc agent làm; nó cảnh báo, trên màn hình và trong " + c("report.md") + " của lượt chạy:")}
${ul([
  `các lần gọi công cụ Claude bị từ chối: mỗi lần hiện là ${c("⊘ denied")}, sau đó một cảnh báo nêu tên các công cụ;`,
  "file bị thay đổi bởi agent đang lập kế hoạch hoặc review;",
  `file bị thay đổi ngoài workspace (ở chỗ khác trong cùng repository), với đường dẫn tương đối so với workspace, như ${c("../shared/x.ts")}.`,
])}
${p("AgentDuo không bao giờ commit hay push: hãy xem thay đổi bằng " + c("git diff") + " và tự commit.")}`,
    },
    {
      id: "unattended",
      title: "Chạy không người trông",
      html: `${p("Một lượt chạy không ai theo dõi (CI, tác vụ nền) không thể trả lời lời hỏi, nên những gì implementer cần phải được cho phép trước khi bắt đầu. Nếu không, các lần gọi công cụ sẽ bị từ chối và cảnh báo sẽ nêu tên chúng.")}
${ul([
  `<strong>Sửa file</strong> (${c("Edit")}, ${c("Write")}): ${c('"permissions": { "defaultMode": "acceptEdits" }')} trong settings Claude Code, hoặc ${c("--permission-mode acceptEdits")} trong ${c("role_args")} của implementer. Nó cho phép sửa file, không cho phép chạy lệnh.`,
  `<strong>Chạy lệnh</strong> (${c("Bash")}): quy tắc allow như ${c('"Bash(npm test:*)"')}. Khi không có gate, implementer tự chạy các bước kiểm tra của dự án, nên hãy cho phép các lệnh đó.`,
  `<strong>Codex làm implementer</strong>: một sandbox có quyền ghi, như ở trên.`,
  `<strong>Không bao giờ hỏi</strong>: ${c("claude.permission_prompts: deny")} khiến Claude từ chối mọi thứ settings không cho phép, kể cả khi có người theo dõi.`,
])}
${ex("config/unattended.yaml", { label: ".agentduo/config.yaml" })}
${p("Gate chạy các bước kiểm tra của bạn bất kể agent được phép làm gì: " + link("docs/pipeline", "pipeline") + ".")}`,
    },
  ],
  related: ["docs/pipeline", "docs/slash-commands", "docs/configuration", "docs/data-diagnostics"],
});
