export default ({ c, link, code, ex, p, ul, table, note, h3 }) => ({
  title: "Cấu hình",
  description: "Cấu hình của AgentDuo nằm ở đâu, thứ tự các file ghi đè nhau, cách đổi cài đặt từ chat hoặc ứng dụng desktop, và khi nào một thay đổi có hiệu lực.",
  lead: p("AgentDuo đọc các file YAML: giá trị mặc định có sẵn, user config dùng cho mọi workspace, và project config cho từng workspace. Chat, Settings của ứng dụng desktop và VS Code cùng sửa những file này, và mỗi thay đổi cho biết khi nào nó đến được với công việc đang chạy."),
  sections: [
    {
      id: "files",
      title: "Cấu hình nằm ở đâu",
      html: `${table({
  caption: "Các file cấu hình",
  head: ["Lớp", "Vị trí", "Áp dụng cho"],
  rows: [
    ["Mặc định có sẵn", "Trong chính AgentDuo (" + link("docs/config-reference", "mọi key và giá trị mặc định") + ")", "Mọi thứ"],
    ["User config", c("~/.config/agentduo/config.yaml") + "; " + c("$XDG_CONFIG_HOME/agentduo/config.yaml") + " khi biến đó được đặt; " + c("%APPDATA%\\agentduo\\config.yaml") + " trên Windows", "Mọi workspace, và các cuộc trò chuyện không thuộc project nào"],
    ["Project config", c("<workspace>/.agentduo/config.yaml") + ", hoặc file chỉ định bằng " + c("--config PATH"), "Một workspace"],
  ],
})}
${ul([
  `Key nào cũng là tùy chọn: chỉ ghi những key bạn muốn đổi. ${c("duo init")} tạo ${c(".agentduo/config.yaml")} với mọi dòng đều được comment, cùng ${c(".agentduo/.gitignore")} để thư mục runs không vào Git.`,
  `${c("--config PATH")} thay cho file của project, không thay user config: user config vẫn được đọc trước.`,
  "Terminal, ứng dụng desktop và extension VS Code đọc cùng các file này, nên một cài đặt lưu ở nơi này cũng có hiệu lực ở nơi kia.",
  `Một key viết sai hoặc không tồn tại sẽ gây cảnh báo và bị bỏ qua. Một giá trị sai kiểu là lỗi, kèm tên file; ${c("duo doctor")} kiểm tra cấu hình mà không gọi model nào.`,
])}`,
    },
    {
      id: "order",
      title: "Giá trị nào thắng",
      html: `${p("Lớp sau thắng lớp trước:")}
${code("built-in defaults  <  user config  <  project config (or --config)  <  this session", { label: "Thứ tự ghi đè" })}
${p("“This session” là một thay đổi trong chat không kèm " + c("--save") + " hay " + c("--global") + ", hoặc một thay đổi trong ứng dụng desktop với <em>Until app closes</em>. Nó kéo dài đến khi chat hoặc ứng dụng đóng lại.")}
${h3("merge-rules", "Các lớp được gộp thế nào")}
${ul([
  `<strong>Mapping</strong> được gộp theo từng key: một file project chỉ đặt ${c("claude.model")} vẫn giữ phần còn lại của ${c("claude")} từ user config.`,
  `<strong>${c("role_args")}</strong> được gộp theo từng role, nên mục ${c("implementer")} ở user config vẫn còn khi project đặt mục ${c("plan_reviewer")}.`,
  `<strong>List</strong> (${c("args")}, ${c("gates")}, ${c("blocking_severities")}) thay hẳn giá trị trước. ${c("claude.args: [--strict-mcp-config]")} sẽ bỏ ${c("--no-session-persistence")} mặc định, trừ khi bạn liệt kê lại nó.`,
  `Một key không có nội dung (chỉ ${c("codex:")} hay ${c("gates:")}) giữ nguyên giá trị trước.`,
  `${c("null")} là một giá trị thực sự: ${c("model: null")} trong file project nghĩa là “để CLI quyết định” và che mất model đặt trong user config. Muốn kế thừa thì bỏ hẳn key đó đi.`,
])}
${code(`# ~/.config/agentduo/config.yaml
claude:
  role_args:
    implementer: [--permission-mode, acceptEdits]

# .agentduo/config.yaml
claude:
  model: opus
  role_args:
    plan_reviewer: [--permission-mode, plan]

# in effect: model opus, and both role_args entries`, { lang: "yaml", label: "Hai lớp" })}`,
    },
    {
      id: "chat-settings",
      title: "Đổi cài đặt từ chat",
      html: `${p("Chat có các lệnh cài đặt của Claude Code và Codex. Mỗi lệnh chỉ đổi flag trong " + c("claude") + " hoặc " + c("codex") + ", không gì khác. " + c("/settings claude …") + " và " + c("/settings codex …") + " là dạng chuẩn; " + c("/claude …") + " và " + c("/codex …") + " là lối tắt, chỉ được hiểu là cài đặt khi các từ khớp đúng một cài đặt (nếu không, chúng là câu hỏi gửi cho agent đó).")}
${table({
  caption: "Các lệnh cài đặt trong chat",
  head: ["Lệnh", "Thay đổi gì trong config"],
  rows: [
    ["Shift+Tab, " + c("/mode manual|acceptEdits|auto"), c("--permission-mode") + " trong " + c("claude.role_args.implementer") + " (Claude trong chat và khi làm implementer của pipeline)"],
    [c("/claude model <name|default>"), c("claude.model")],
    [c("/claude effort low|medium|high|xhigh|max|default"), c("--effort") + " trong " + c("claude.args")],
    [c("/claude permissions [allow|deny|remove <rule>]"), c("--allowedTools") + " / " + c("--disallowedTools") + " trong " + c("claude.args")],
    [c("/claude add-dir <path>"), c("--add-dir") + " trong " + c("claude.args")],
    [c("/codex model <name|default> [effort]"), c("codex.model") + ", và " + c("-c model_reasoning_effort=…") + " trong " + c("codex.args")],
    [c("/codex permissions read-only|auto|full-access|default"), c("--sandbox") + " trong " + c("codex.args") + "; " + c("full-access") + " cần thêm " + c("--yes")],
    [c("/config"), "Hiển thị cả hai agent đang chạy với gì, và " + c("--save") + ", " + c("--global") + " ghi vào file nào"],
  ],
})}
${h3("save-global", "--save và --global")}
${ul([
  `Không có flag, thay đổi chỉ có hiệu lực trong chat này.`,
  `${c("--save")} ghi nó vào project config (${c(".agentduo/config.yaml")}, hoặc file ${c("--config")}).`,
  `${c("--global")} ghi nó vào user config, cho mọi workspace. Thay đổi được áp lên riêng file đó, nên không có gì từ config của workspace này bị ghi theo.`,
  `Nếu project config cũng đặt key đó, project vẫn thắng ở đó: chat sẽ báo cho bạn. ${c("--save --global")} ghi cả hai file.`,
  "Khi ghi file, comment và mọi key khác được giữ nguyên.",
])}
${code("/claude model opus --save\n/codex model gpt-5.5 high --global\n/mode acceptEdits --save --global", { label: "duo" })}
${p("Mọi lệnh và tùy chọn của chúng: " + link("docs/slash-commands", "Lệnh slash") + ".")}`,
    },
    {
      id: "when-it-applies",
      title: "Khi nào thay đổi có hiệu lực",
      html: `${p("Mỗi cài đặt thuộc loại <em>next call</em> hoặc <em>next run</em>. Sự khác biệt chỉ quan trọng với công việc đang chạy: một lần chạy pipeline, một cuộc thảo luận, hoặc một lần chạy bạn resume.")}
${table({
  caption: "Khi nào cài đặt có hiệu lực",
  head: ["Loại", "Cài đặt", "Đến được"],
  rows: [
    ["Next call", "model, effort, permission mode, rule allow và deny, " + c("add_dirs") + " (" + c("--add-dir") + "), " + c("args") + ", " + c("role_args") + ", " + c("bin") + ", " + c("max_budget_usd") + ", " + c("permission_prompts"), "Lần gọi kế tiếp của agent, kể cả bước kế tiếp của một lần chạy đang diễn ra; " + c("config.json") + " đã lưu của lần chạy được cập nhật, nên resume vẫn giữ nó"],
    ["Next run", c("agents.*") + " (ai đảm nhận role nào) và mọi " + c("limits.*"), "Chỉ công việc bắt đầu sau thay đổi: lần chạy, câu hỏi hoặc cuộc thảo luận kế tiếp. Lần chạy đang diễn ra, cuộc thảo luận đang dở và lần chạy được resume giữ giá trị lúc chúng bắt đầu"],
  ],
})}
${p("Một lần chạy không bao giờ đổi agent hay giới hạn giữa chừng. Khi chat resume một lần chạy đã dừng, nó bắt đầu từ " + c("config.json") + " của chính lần chạy đó rồi áp lại các thay đổi next-call của chat lên trên; thay đổi next-run không bao giờ được áp lại.")}
${h3("resume-config", "File config và duo resume")}
${p(c("duo resume") + " trong terminal tiếp tục một lần chạy với config lúc nó bắt đầu, nên sửa " + c("config.yaml") + " không ảnh hưởng gì. Thêm " + c("--reload-config") + " để dùng các file hiện tại. Thay đổi trong cài đặt riêng của Claude Code hay Codex thì có hiệu lực trong cả hai trường hợp. Xem thêm " + link("docs/decisions-resume", "Quyết định và resume") + ".")}`,
    },
    {
      id: "desktop-settings",
      title: "Settings trong ứng dụng desktop",
      html: `${p("Mở Settings bằng biểu tượng bánh răng ở cuối sidebar. <em>Configuration</em> sửa cùng các key như trong file, mỗi nhóm một tab:")}
${table({
  caption: "Các tab Configuration",
  head: ["Tab", "Key", "Hiệu lực"],
  rows: [
    ["Claude Code", c("claude.model") + ", " + c("claude.permission_prompts") + ", " + c("claude.max_budget_usd") + ", " + c("claude.args") + "; trong <em>Advanced</em> có " + c("claude.bin") + " và " + c("role_args") + " của từng role", "Next call"],
    ["Codex", c("codex.model") + ", " + c("codex.args") + "; trong <em>Advanced</em> có " + c("codex.bin") + " và " + c("role_args") + " của từng role", "Next call"],
    ["Workflow roles", c("agents.*"), "Next run"],
    ["Rounds & limits", "Mọi " + c("limits.*") + ", chia thành Rounds, Time và Size", "Next run"],
  ],
})}
${p("Ở trên cùng, <em>Apply changes to</em> chọn nơi lưu thay đổi. Thay đổi được lưu ngay.")}
${table({
  caption: "Phạm vi của Settings",
  head: ["Phạm vi", "Ghi vào", "Đến được"],
  rows: [
    ["All projects", "User config", "Mọi project, và các cuộc trò chuyện ngoài project; project nào tự đặt giá trị riêng thì vẫn thắng ở đó"],
    ["This project", c(".agentduo/config.yaml") + " của project", "Chỉ project đó"],
    ["Until app closes", "Không file nào", "Chỉ các cuộc trò chuyện đang mở của project này, đến khi ứng dụng đóng (cần có một cuộc trò chuyện đang mở)"],
  ],
})}
${ul([
  "Mỗi giá trị cho biết nó đến từ đâu (mặc định, all projects, this project, until the app closes), và cảnh báo khi project ghi đè user config của bạn.",
  `<em>Reset</em> xóa key khỏi file đó để nó kế thừa lại. Nó không bao giờ ghi ${c("null")}, vì ${c("null")} nghĩa là giá trị mặc định có sẵn và sẽ che mất user config.`,
  "Thay đổi nào làm cấu hình không hợp lệ thì không được ghi. Một file không phải YAML hợp lệ được để nguyên: Settings hiển thị lỗi cùng dòng của nó, và mở file cho bạn.",
  `Các tùy chọn thêm từ menu (reasoning effort, permission mode hoặc sandbox, tool được cho phép và bị cấm, thư mục bổ sung…) được ghi thành flag trong ${c("args")}; <em>Other flag…</em> nhận mọi flag khác.`,
  `${c("paths.runs_dir")} được hiển thị trong <em>Data &amp; storage</em> nhưng không sửa ở đó được: workspace lock nằm trong thư mục này. Hãy sửa nó trong file khi mọi AgentDuo đã đóng.`,
  "Thay đổi trong Settings, hay được lưu từ một chat, cũng đến được các chat đang mở của những project khác.",
])}`,
    },
    {
      id: "vscode",
      title: "VS Code",
      html: `${ul([
  `Bảng <em>Settings</em> của chat thay đổi những gì các lệnh cài đặt của chat thay đổi. Hai ô bên dưới lưu thay đổi vào ${c(".agentduo/config.yaml")} hoặc vào user config, như ${c("--save")} và ${c("--global")}.`,
  `<em>agentduo: Open Configuration</em> mở ${c(".agentduo/config.yaml")}.`,
  `VS Code chỉ có một cài đặt riêng, ${c("agentduo.nodePath")}: bản Node (22.12 trở lên) chạy engine của AgentDuo. Agent, model và quyền nằm trong các file config.`,
])}`,
    },
    {
      id: "examples",
      title: "Ví dụ",
      html: `${p("Model và effort chỉ cho các lần gọi của AgentDuo; cài đặt Claude Code và Codex của riêng bạn không đổi:")}
${ex("config/models.yaml", { label: ".agentduo/config.yaml" })}
${p("Những lần chạy không ai theo dõi, khi Claude không thể hỏi:")}
${ex("config/unattended.yaml", { label: ".agentduo/config.yaml" })}
${note(p("AgentDuo không tự thêm rule quyền nào. Mỗi agent được làm gì là do cấu hình CLI của nó và các flag bạn truyền vào: " + link("docs/permissions", "Quyền") + "."))}`,
    },
  ],
  related: ["docs/config-reference", "docs/slash-commands", "docs/permissions", "docs/decisions-resume"],
  next: p(link("docs/config-reference", "Mọi key cấu hình, kèm kiểu và giá trị mặc định →")),
});
