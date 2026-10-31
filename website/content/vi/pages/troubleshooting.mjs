export default ({ c, link, code, ext, p, ul, steps, note, table }) => ({
  title: "Khắc phục sự cố",
  description: "Sửa các lỗi thường gặp của AgentDuo: không tìm thấy CLI hoặc chưa đăng nhập, lệnh gọi công cụ bị từ chối, lỗi cấu hình, Git, đường dẫn Windows, trình cài chưa ký, sandbox Linux và cập nhật.",
  lead: p("Phần lớn sự cố đến từ hai CLI mà AgentDuo chạy: chúng nằm ở đâu, đăng nhập thế nào và cấu hình riêng của chúng cho phép làm gì. Hãy bắt đầu bằng " + c("duo doctor") + " (hoặc Settings → Diagnostics trong ứng dụng desktop): lệnh này kiểm tra tất cả những điều đó mà không gọi mô hình nào."),
  sections: [
    {
      id: "cli-not-found",
      title: "Không tìm thấy Claude Code hoặc Codex",
      html: `${p(c("duo doctor") + " báo " + c("claude CLI not found (bin: 'claude')") + " (hoặc tương tự với " + c("codex") + ") khi không tìm thấy một CLI. Nó chỉ kiểm tra những CLI mà các vai trò của bạn dùng.")}
${ul([
  `Một tên như ${c("claude")} được tìm trong ${c("PATH")} mà ${c("duo")} (hoặc ứng dụng) nhận lúc khởi động. Một giá trị có dấu gạch chéo, hoặc bắt đầu bằng ${c("~")}, được hiểu là đường dẫn tới chính tệp đó.`,
  `Nếu Claude Code không có trong PATH, AgentDuo còn tìm trong ${c("~/.claude/local")} và trong extension Claude Code của VS Code, Cursor hoặc Windsurf.`,
  `Chạy ${c("claude --version")} và ${c("codex --version")} trong cùng terminal. Nếu ở đó chạy được mà AgentDuo vẫn không tìm thấy, hãy ghi đường dẫn đầy đủ vào cấu hình:`,
])}
${code("claude:\n  bin: /opt/homebrew/bin/claude\ncodex:\n  bin: ~/.npm-global/bin/codex", { lang: "yaml", label: "~/.config/agentduo/config.yaml" })}
${p("Trong ứng dụng desktop, bước kiểm tra lần đầu và Settings → Claude &amp; Codex cho phép bạn chọn tệp chạy; lựa chọn được lưu thành " + c("claude.bin") + " hoặc " + c("codex.bin") + " trong cấu hình người dùng, nơi mọi giao diện đều đọc.")}
${note(p("Một dòng như " + c("codex supports --json, … — missing: --output-schema") + " nghĩa là đã tìm thấy CLI nhưng phiên bản của nó quá cũ hoặc quá mới so với các cờ AgentDuo truyền vào. Hãy cập nhật CLI rồi chạy lại " + c("duo doctor") + "."))}`,
    },
    {
      id: "not-signed-in",
      title: "CLI chưa đăng nhập",
      html: `${p("AgentDuo không giữ thông tin đăng nhập nào: mỗi CLI tự đăng nhập. Khi một CLI đã đăng xuất, các lệnh gọi tới nó thất bại, và " + c("/usage") + ", bước kiểm tra lần đầu cùng ô Account &amp; Usage của ứng dụng desktop sẽ báo điều đó.")}
${table({
  caption: "Cách mỗi CLI đăng nhập",
  head: ["CLI", "Đăng nhập", "Kiểm tra"],
  rows: [
    ["Claude Code", c("claude") + ", rồi " + c("/login") + " (hoặc " + c("claude auth login") + ")", c("claude auth status")],
    ["Codex", c("codex login"), c("/usage") + " trong chat"],
  ],
})}
${p("Đăng nhập trong terminal, rồi chọn <em>Recheck</em> trong ứng dụng, hoặc mở lại chat. Xem " + link("docs/accounts-usage", "Tài khoản và mức sử dụng") + ".")}`,
    },
    {
      id: "launcher-path",
      title: "Ứng dụng không tìm thấy CLI mà terminal tìm thấy",
      html: `${p("Một ứng dụng mở từ Dock, Finder, menu Start hoặc trình khởi chạy desktop không nhận PATH của terminal. Vì vậy ứng dụng desktop tự dựng PATH cho các agent từ:")}
${ul([
  "PATH mà nó nhận lúc khởi động;",
  `trên macOS và Linux, PATH của login shell (hỏi ${c("$SHELL")} một lần, với thời hạn 5 giây);`,
  `các thư mục cài đặt quen thuộc: Homebrew, ${c("~/.local/bin")}, thư mục global của npm, ${c("%APPDATA%\\npm")}, các phiên bản Node của nvm và một số nơi khác.`,
])}
${p("Tệp chạy chọn trong Settings luôn được ưu tiên. Settings → Diagnostics cho thấy PATH mà các agent nhận và mỗi mục đến từ đâu. Nếu shell của bạn khởi động lâu hơn thời hạn, hoặc CLI nằm ở chỗ khác thường, hãy chọn tệp chạy.")}
${p("Một CLI cài bằng npm có thể cần Node.js của riêng nó trong PATH đó, dù bản thân ứng dụng không cần; Diagnostics hiển thị riêng điều này.")}`,
    },
    {
      id: "denied",
      title: "Lệnh gọi công cụ bị từ chối",
      html: `${p("AgentDuo không tự thêm cờ quyền nào: agent được làm gì là do cấu hình riêng của Claude Code và Codex quyết định. Khi một lệnh gọi bị từ chối, lượt chạy hiện một cảnh báo nêu tên công cụ và nơi cho phép nó, ví dụ:")}
${code('Claude was denied 2 tool call(s) (Edit, Bash); allow them in your Claude Code settings (permissions.defaultMode "acceptEdits" for edits; permissions.allow rules for Bash (e.g. "Bash(npm test:*)")) or via claude.role_args.implementer (a resumed run picks up config changes only with --reload-config)', { label: "Warning" })}
${ul([
  `Khi không có terminal để hỏi (CI, chạy nền, đầu ra qua pipe), Claude Code từ chối mọi lệnh gọi công cụ mà cấu hình của nó không cho phép. ${c("duo doctor")} cảnh báo khi implementer chưa được cấu hình quyền sửa tệp.`,
  `${c("codex exec")} chỉ đọc, trừ khi được cấu hình khác: đặt ${c("sandbox_mode")} trong ${c("~/.codex/config.toml")}, hoặc ${c("codex.role_args.implementer: [--sandbox, workspace-write]")}.`,
  `Một lượt chạy được tiếp tục giữ cấu hình lúc nó bắt đầu; thêm ${c("--reload-config")} để dùng các thay đổi của bạn.`,
])}
${p(link("docs/permissions", "Quyền") + " giải thích từng chế độ và các câu hỏi xin quyền trong chat.")}`,
    },
    {
      id: "config-errors",
      title: "Lỗi cấu hình",
      html: `${p("Một tệp cấu hình không phải YAML hợp lệ, hoặc chứa giá trị AgentDuo không chấp nhận, sẽ dừng lượt chạy trước khi bắt đầu. " + c("duo doctor") + " in lỗi ở dòng " + c("config:") + "; nếu không có lỗi, dòng đó liệt kê các tệp nó đã đọc.")}
${table({
  caption: "Vị trí các tệp cấu hình",
  head: ["Tệp", "Đường dẫn"],
  rows: [
    ["Người dùng (macOS, Linux)", c("~/.config/agentduo/config.yaml") + " (hoặc " + c("$XDG_CONFIG_HOME/agentduo/config.yaml") + ")"],
    ["Người dùng (Windows)", c("%APPDATA%\\agentduo\\config.yaml")],
    ["Dự án", c(".agentduo/config.yaml") + " trong workspace"],
  ],
})}
${p("Ứng dụng desktop để nguyên tệp không phải YAML hợp lệ: Settings hiện lỗi và số dòng, rồi mở tệp cho bạn. Nó không bao giờ ghi một thay đổi khiến cấu hình trở nên không hợp lệ. Xem " + link("docs/configuration", "Cấu hình") + ".")}`,
    },
    {
      id: "git",
      title: "Lỗi kho Git",
      html: `${ul([
  `Chat và ${c("/discuss")} chạy trong mọi thư mục. Chỉ pipeline (${c("/pipeline")}, ${c("duo run")}) và ${c("/resume")} cần workspace nằm trong một kho Git, vì chúng chụp snapshot và so sánh diff. Hãy chạy ${c("git init")} trước, hoặc ${c("duo init")} (lệnh này đề nghị chạy giúp).`,
  `Trong thư mục home (chat của ứng dụng desktop và extension VS Code khi chưa mở thư mục nào), hãy mở một thư mục dự án để chạy pipeline.`,
  `${c("codex exec")} từ chối chạy ngoài một kho Git, nên AgentDuo truyền ${c("--skip-git-repo-check")} cho các lượt hội thoại. Bên trong một kho, cờ này không thay đổi gì và không cấp quyền nào.`,
  `${c("duo doctor")} kiểm tra Git đã được cài chưa và workspace có nằm trong một kho không.`,
])}`,
    },
    {
      id: "windows-paths",
      title: "Đường dẫn trên Windows",
      html: `${ul([
  `Trong ${c("/attach")}, trên Windows dấu gạch ngược là dấu phân cách đường dẫn, không bao giờ là ký tự thoát: ${c("/attach C:\\Users\\me\\shot.png")} được đọc đúng như bạn gõ. Đặt đường dẫn có dấu cách trong ngoặc kép: ${c('/attach "C:\\Users\\me\\My notes.pdf"')}. ${c("~\\")} là thư mục home. Mỗi lần đính kèm một đường dẫn.`,
  `Windows đọc tên biến môi trường không phân biệt hoa thường, và một môi trường được sao chép có thể ghi ${c("Path")} thay vì ${c("PATH")}. AgentDuo đọc chúng theo cùng cách, kể cả ${c("PATHEXT")}.`,
  `npm cài Codex dưới dạng ${c("codex.cmd")} (bên cạnh một script ${c("codex")} dành cho Git Bash mà Windows không chạy được). AgentDuo tìm tệp ${c(".cmd")} qua ${c("PATHEXT")} và chạy nó qua shell, như Node yêu cầu với tệp ${c(".cmd")} và ${c(".bat")}.`,
  `Khi ghi đường dẫn trong YAML, dùng ngoặc đơn hoặc không dùng ngoặc: trong ngoặc kép, YAML hiểu dấu gạch ngược là ký tự thoát.`,
])}
${code("codex:\n  bin: 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'", { lang: "yaml", label: "%APPDATA%\\agentduo\\config.yaml" })}`,
    },
    {
      id: "unsigned-app",
      title: "Trình cài đặt hoặc ứng dụng bị chặn",
      html: `${p("Ứng dụng Mac được phát hành chưa được notarize và trình cài Windows chưa được ký mã, nên hệ thống cảnh báo ở lần đầu. Chỉ làm các bước dưới đây với tệp bạn tải từ " + ext("https://github.com/HaiTrieu247/agentduo/releases", "GitHub releases") + " của dự án.")}
${steps([
  ["macOS: Gatekeeper", p("Mở <em>System Settings → Privacy &amp; Security</em>, tìm thông báo về AgentDuo, chọn <em>Open Anyway</em> rồi xác nhận. Với bản build bạn tin tưởng, " + c("xattr -dr com.apple.quarantine /Applications/AgentDuo.app") + " cho kết quả tương tự.")],
  ["Windows: SmartScreen", p("Ở màn hình <em>Windows protected your PC</em>, chọn <em>More info</em>, kiểm tra tệp, rồi chọn <em>Run anyway</em>.")],
])}
${p(link("download#desktop", "Trang tải về") + " hướng dẫn chi tiết cho từng hệ điều hành.")}`,
    },
    {
      id: "linux-sandbox",
      title: "Ứng dụng không khởi động trên Linux (sandbox)",
      html: `${p("Ubuntu 24.04 trở lên hạn chế user namespace không đặc quyền, thứ mà sandbox của Chromium cần. AgentDuo không bao giờ tự tắt sandbox, nên khi không khởi động được sandbox thì ứng dụng không mở.")}
${ul([
  `Gói ${c(".deb")} cài vào ${c("/opt/AgentDuo")} kèm một profile AppArmor chỉ cho phép user namespace và không giới hạn gì khác, đồng thời đặt ${c("chrome-sandbox")} thành ${c("root:root")} mode ${c("4755")} ở nơi không có user namespace. Hãy cài gói này nếu AppImage lỗi.`,
  "AppImage không có cả hai điều đó. Hãy cài .deb thay thế, hoặc thêm một profile AppArmor cho đường dẫn của AppImage.",
  `Cách cuối cùng, kém an toàn hơn, là cho phép user namespace không đặc quyền trên toàn hệ thống: ${c("sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0")}.`,
])}`,
    },
    {
      id: "updates",
      title: "Lỗi cập nhật",
      html: `${table({
  caption: "Các thông báo cập nhật",
  head: ["Thông báo", "Ý nghĩa"],
  rows: [
    ["<em>No AgentDuo release is published on GitHub yet.</em>", "Chưa có phiên bản nào để cập nhật."],
    ["<em>Could not reach GitHub. Check your connection.</em>", "Không kết nối được. Ứng dụng sẽ kiểm tra lại sau, hoặc bạn chọn <em>Check now</em>."],
    ["<em>GitHub is limiting requests for now. Try again later.</em>", "GitHub đang giới hạn số yêu cầu."],
    ["<em>Get AgentDuo x.y.z</em>", "Ứng dụng Mac không có chữ ký Developer ID không tự thay thế được: nút này mở trang phát hành để bạn tải .dmg mới."],
  ],
})}
${ul([
  `Bản build phát triển (${c("npm run dev")}) và ứng dụng chạy với profile riêng (${c("AGENTDUO_DESKTOP_USER_DATA")}) không bao giờ cập nhật từ GitHub.`,
  `Gói .deb chỉ cài khi bạn chọn <em>Restart to update</em>, qua ${c("pkexec")}, lệnh này sẽ hỏi mật khẩu.`,
  "Trình cập nhật ghi nhật ký vào log của ứng dụng, xem được trong Settings → Diagnostics.",
])}
${p("Xem " + link("docs/desktop-updates", "cách cập nhật hoạt động") + ".")}`,
    },
    {
      id: "still-stuck",
      title: "Vẫn chưa giải quyết được",
      html: `${p("Mỗi lượt chạy lưu prompt, đầu ra thô của các agent và nhật ký sự kiện trong thư mục riêng: " + link("docs/data-diagnostics#run-files", "tệp của lượt chạy") + ". Settings → Diagnostics của ứng dụng desktop có thể xuất những gì nó hiển thị, không kèm thông tin đăng nhập, prompt hay tệp đính kèm.")}
${p("Sau đó hãy " + link("docs/contributing#report", "báo cáo sự cố") + ", kèm các thông tin được liệt kê ở đó và không có gì riêng tư.")}`,
    },
  ],
  related: ["learn/prerequisites", "docs/permissions", "docs/configuration", "docs/data-diagnostics", "docs/desktop-updates"],
});
