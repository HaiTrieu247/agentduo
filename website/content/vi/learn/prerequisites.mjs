export default ({ c, link, ext, code, p, ul, table, note }, d) => ({
  title: "Bạn cần chuẩn bị gì",
  description: "Trước khi chạy AgentDuo: cài Claude Code và Codex CLI, đăng nhập cả hai, và biết khi nào cần Node.js và Git. AgentDuo không kèm gói đăng ký hay tín dụng API.",
  lead: p("AgentDuo chạy hai CLI do các công ty khác phát hành, bằng tài khoản của bạn. Cài và đăng nhập cả hai một lần; mọi giao diện của AgentDuo sau đó sẽ dùng chúng."),
  sections: [
    {
      id: "accounts",
      title: "Tài khoản của bạn và chi phí",
      html: `${p("AgentDuo miễn phí, nhưng không kèm Claude Code, Codex, gói đăng ký hay tín dụng API. Mỗi agent chạy bằng phiên đăng nhập của CLI tương ứng: một gói của nhà cung cấp, hoặc một API key. Mọi câu hỏi, thảo luận và bước pipeline đều dùng gói hoặc key đó.")}
${ul([
  `Một lượt chạy pipeline gọi agent nhiều lần: ít nhất một lần cho mỗi bước, nhiều hơn khi có các vòng phản biện và review. ${c("/discuss")} gọi từ 3 đến 2N+1 lần, với N là giới hạn review (mặc định là 3).`,
  `Ảnh bạn đính kèm được gửi lại trong mỗi lần gọi của một cuộc thảo luận hoặc pipeline, và mỗi lần đều tốn token.`,
  `${link("docs/accounts-usage", "Tài khoản &amp; Mức dùng")} cho biết bạn đã dùng bao nhiêu giới hạn của các gói; ${c("claude.max_budget_usd")} giới hạn chi phí của một lần gọi Claude.`,
])}`,
    },
    {
      id: "claude-code",
      title: "Cài và đăng nhập Claude Code",
      html: `${p("Làm theo " + ext(d.site.links.claudeCodeSetup, "hướng dẫn cài đặt Claude Code") + " của Anthropic cho hệ thống của bạn; trang đó liệt kê các trình cài đặt hiện hành. Sau đó chạy Claude Code một lần trong terminal và đăng nhập:")}
${code("claude\n# then, inside Claude Code:\n/login", { lang: "sh", label: "Terminal" })}
${p("Kiểm tra lệnh chạy được và đã đăng nhập. " + c("claude auth status") + " in thông tin đăng nhập dưới dạng JSON; khi chưa đăng nhập, lệnh thoát với lỗi nhưng vẫn in ra.")}
${code("claude --version\nclaude auth status", { lang: "sh", label: "Terminal" })}
${note(p("Nếu Claude Code chỉ được cài qua tiện ích VS Code, Cursor hoặc Windsurf, AgentDuo vẫn tìm thấy binary mà tiện ích đó đi kèm. Bạn cũng có thể trỏ AgentDuo đến bất kỳ binary nào bằng " + c("claude.bin") + "."))}`,
    },
    {
      id: "codex",
      title: "Cài và đăng nhập Codex CLI",
      html: `${p("Làm theo " + ext(d.site.links.codexCli, "tài liệu Codex CLI") + " của OpenAI để biết các trình cài đặt hiện hành. Ví dụ với npm:")}
${code("npm i -g @openai/codex\ncodex login", { lang: "sh", label: "Terminal" })}
${p(c("codex login") + " đăng nhập bằng ChatGPT hoặc một phương thức khác mà Codex hỗ trợ. Kiểm tra bằng:")}
${code("codex --version\ncodex login status", { lang: "sh", label: "Terminal" })}`,
    },
    {
      id: "node-and-git",
      title: "Khi nào cần Node.js và Git",
      html: `${table({
        caption: "Mỗi giao diện cần gì ngoài hai CLI",
        head: ["Giao diện", "Node.js 22.12 trở lên", "Git"],
        rows: [
          ["Ứng dụng desktop", "Không cần cho AgentDuo: engine của nó chạy trên Node có sẵn trong ứng dụng. CLI bạn cài bằng npm vẫn cần Node riêng trong PATH.", "Cho các lượt chạy pipeline"],
          [`Terminal (${c("duo")})`, "Có: gói npm chạy trên Node của bạn", "Cho các lượt chạy pipeline"],
          ["Tiện ích VS Code", `Có: nó lấy ${c("node")} phù hợp đầu tiên trong PATH của VS Code, hoặc ${c("agentduo.nodePath")}`, "Cho các lượt chạy pipeline"],
          ["Build từ mã nguồn", "Có, cùng với npm", "Có"],
        ],
      })}
${p("Một lượt chạy pipeline chụp snapshot và so sánh diff các tệp của bạn, nên workspace của nó phải nằm trong một kho Git. Chat và " + c("/discuss") + " chạy ở mọi thư mục, kể cả thư mục home. Tải Node.js từ " + ext(d.site.links.nodeDownload, "nodejs.org") + ".")}`,
    },
    {
      id: "check",
      title: "Kiểm tra mọi thứ cùng lúc",
      html: `${p("Mỗi giao diện đều kiểm tra các CLI mà không gọi model:")}
${ul([
  "Ứng dụng desktop: màn hình chạy lần đầu kiểm tra cả hai CLI: có hay thiếu, đã đăng nhập hay chưa. Settings → Diagnostics hiển thị chi tiết sau đó.",
  `Terminal: ${c("duo doctor")} kiểm tra Node, Git, cấu hình, cả hai CLI và các flag AgentDuo cần từ chúng.`,
  `VS Code: lệnh <em>agentduo: Doctor</em> ghi các kiểm tra tương tự vào kênh output agentduo.`,
])}
${code("duo doctor", { lang: "sh", label: "Terminal" })}
${p("Dòng bắt đầu bằng ✗ phải được sửa trước khi pipeline chạy được; dòng có ! là lời khuyên. " + link("troubleshooting#cli-not-found", "Nếu không tìm thấy CLI") + ".")}`,
    },
  ],
  related: ["download", "docs/accounts-usage", "docs/permissions", "troubleshooting"],
  next: p("Cài giao diện của bạn: " + link("learn/desktop", "ứng dụng desktop") + ", " + link("learn/cli", "lệnh terminal") + " hoặc " + link("learn/vscode", "tiện ích VS Code") + "."),
});
