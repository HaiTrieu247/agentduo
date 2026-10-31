export default ({ c, link, ext, p, ul }, d) => ({
  title: "Câu hỏi thường gặp",
  description: "Giải đáp về AgentDuo: chi phí và tài khoản, nên dùng giao diện nào, hệ thống được hỗ trợ, chữ ký, cách xử lý mã của bạn, Git, dừng và tiếp tục.",
  lead: p("Câu trả lời ngắn, mỗi câu kèm liên kết đến trang có chi tiết. Với thông báo lỗi và cách sửa, xem " + link("troubleshooting", "Khắc phục sự cố") + "."),
  sections: [
    {
      id: "cost",
      title: "AgentDuo có miễn phí không? Có kèm Claude hay Codex không?",
      html: `${p("AgentDuo miễn phí và là mã nguồn mở theo giấy phép MIT. Nó không kèm Claude Code, Codex, gói đăng ký hay tín dụng API: nó chạy các CLI bạn đã cài, đăng nhập bằng tài khoản của bạn, và mức dùng của chúng được tính vào gói hoặc khóa của chính bạn.")}
${p("Để xem bạn đã dùng bao nhiêu giới hạn của các gói, mở " + link("docs/accounts-usage", "Account &amp; Usage") + ". Để giới hạn chi phí của một lần gọi Claude, đặt " + c("claude.max_budget_usd") + ".")}`,
    },
    {
      id: "both-clis",
      title: "Tôi có cần cả Claude Code và Codex không?",
      html: `${p("Với thiết lập mặc định thì có: Codex lập kế hoạch và review, Claude Code phản biện và triển khai, và " + c("/discuss") + " luôn để Codex viết bản tổng hợp cuối. Cả hai CLI phải được cài và đăng nhập.")}
${p("Các khóa " + c("agents") + " có thể giao mọi vai trò pipeline cho cùng một CLI. Khi đó một lượt chạy pipeline chỉ kiểm tra CLI đó, nhưng hội thoại và " + c("/discuss") + " vẫn dùng cả hai. " + link("docs/config-reference#agents", "Các khóa agents") + ".")}`,
    },
    {
      id: "which-interface",
      title: "Ứng dụng desktop, terminal hay VS Code: nên dùng cái nào?",
      html: `${ul([
  "<strong>Ứng dụng desktop</strong> nếu bạn muốn một cửa sổ riêng, hội thoại mà không cần mở thư mục, và không phải cài gì thêm ngoài hai CLI.",
  `<strong>Terminal (${c("duo")})</strong> nếu bạn quen làm việc trong terminal, hoặc muốn chạy pipeline từ script và CI (${c('duo "<task>"')}, mã thoát).`,
  "<strong>Tiện ích VS Code</strong> nếu bạn muốn cuộc trò chuyện cạnh trình soạn thảo và các thay đổi trong trình soạn diff của VS Code.",
])}
${p("Chúng dùng chung cấu hình và các lượt chạy, nên bạn có thể đổi bất cứ lúc nào. " + link("about#interfaces", "Quan hệ giữa các giao diện") + ".")}`,
    },
    {
      id: "platforms",
      title: "Những hệ thống nào được hỗ trợ?",
      html: `${p("Ứng dụng desktop được phát hành cho macOS (Apple silicon và Intel), Windows x64 và Linux x86_64 (AppImage và .deb). Không có bản cho Windows trên Arm hay Linux arm64. " + link("download", "Xem các trình cài đặt") + ".")}
${p("Những gì đã được xác minh được ghi trong repository: các bài kiểm thử của ứng dụng desktop, kiểm thử end-to-end và gói đã giải nén đều đạt trong CI trên cả ba hệ thống, và bản macOS đã được chạy trên máy Mac Apple silicon. Việc cài các gói Windows và Linux, cũng như tự cập nhật từ đầu đến cuối, chưa được xác minh. " + ext(d.site.links.desktopVerification, "VERIFICATION.md") + " liệt kê cái gì đã chạy ở đâu.")}
${p("Lệnh terminal cần Node.js 22.12 trở lên; các bài kiểm thử của nó chạy trong CI trên Windows, macOS và Ubuntu với Node 22 và 24. Tiện ích VS Code hoạt động trong VS Code desktop 1.95 trở lên với thư mục cục bộ; Remote SSH, WSL, container và bản web không được hỗ trợ.")}`,
    },
    {
      id: "signing",
      title: "Vì sao hệ thống cảnh báo khi tôi mở ứng dụng?",
      html: p(`Ứng dụng Mac đã phát hành được ký ad-hoc và chưa notarize, còn trình cài đặt Windows chưa được ký mã, nên Gatekeeper và SmartScreen cảnh báo ở lần đầu. ${link("download#desktop", "Trang tải về")} giải thích cách mở nó và cách kiểm tra checksum của tệp. Việc ký cần chứng chỉ mà dự án chưa có.`),
    },
    {
      id: "your-code",
      title: "AgentDuo có gửi mã của tôi đi đâu không?",
      html: `${p("AgentDuo không có máy chủ và không tự gửi gì cả. Các agent làm việc như vẫn làm: Claude Code và Codex đọc tệp và trao đổi với nhà cung cấp của chúng theo cài đặt riêng. AgentDuo truyền prompt cho chúng qua standard input, đọc đầu ra, và giữ các tệp của lượt chạy trong workspace của bạn.")}
${p("Ứng dụng desktop kết nối GitHub để kiểm tra cập nhật, bạn có thể tắt trong Settings → General. Account &amp; Usage hỏi hai CLI, không hỏi mô hình. " + link("docs/data-diagnostics", "Dữ liệu được lưu ở đâu") + ".")}`,
    },
    {
      id: "changes",
      title: "Nó có thay đổi tệp của tôi hay commit thay tôi không?",
      html: p(`Bên triển khai thay đổi các tệp trong working tree của bạn, trong phạm vi cài đặt quyền của chính nó cho phép. AgentDuo không bao giờ commit, push hay deploy: xem lại thay đổi bằng ${c("git diff")} hoặc màn hình diff, rồi tự commit. Nếu một agent lập kế hoạch hoặc review thay đổi tệp, hoặc có gì thay đổi ngoài workspace, bạn sẽ nhận cảnh báo. ${link("docs/permissions", "Quyền")}.`),
    },
    {
      id: "git",
      title: "Vì sao pipeline cần Git?",
      html: p(`Giữa các vòng, pipeline snapshot working tree của bạn bằng Git, để bên review đọc đúng diff của mỗi vòng và lượt chạy có thể tiếp tục. Trò chuyện và ${c("/discuss")} không cần repository và chạy ở mọi thư mục, kể cả thư mục home. Hãy chạy ${c("git init")} (hoặc ${c("duo init")}, có đề nghị việc này) trước pipeline đầu tiên trong một thư mục mới.`),
    },
    {
      id: "stop-resume",
      title: "Tôi có thể dừng một lượt chạy và tiếp tục sau không?",
      html: p(`Có. Esc (hoặc Stop) kết thúc bước đang chạy; lượt chạy giữ trạng thái và ${c("/resume")} chạy lại bước đó, cả sau khi khởi động lại và từ giao diện khác. Lượt chạy dừng để hỏi bạn sẽ chờ quyết định của bạn. ${link("docs/decisions-resume", "Quyết định, dừng và tiếp tục")}.`),
    },
    {
      id: "api-keys",
      title: "Tôi có thể dùng khóa API thay cho gói đăng ký không?",
      html: p(`AgentDuo dùng bất kỳ cách đăng nhập nào mà mỗi CLI có. Nếu Claude Code hoặc Codex được thiết lập với khóa API hoặc nhà cung cấp đám mây, ứng dụng desktop hiện <em>API</em> thay cho email. AgentDuo không bao giờ tự đọc hay lưu khóa.`),
    },
    {
      id: "offline",
      title: "Nó có chạy offline không?",
      html: p("Không. Claude Code và Codex cần kết nối tới nhà cung cấp của chúng để trả lời, nên mỗi lượt hội thoại và mỗi bước pipeline cũng cần kết nối."),
    },
    {
      id: "affiliation",
      title: "AgentDuo có phải của Anthropic hay OpenAI không?",
      html: p("Không. Đây là một dự án mã nguồn mở độc lập. Claude Code là sản phẩm của Anthropic, Codex là sản phẩm của OpenAI; AgentDuo chạy cả hai như đã cài trên máy bạn."),
    },
    {
      id: "report",
      title: "Làm sao báo lỗi hoặc đề xuất tính năng?",
      html: p(`Mở một issue trên ${ext(d.site.links.issues, "GitHub")}. ${link("docs/contributing#report", "Nên đưa gì vào")} liệt kê những gì hữu ích, và những gì nên bỏ ra (prompt, thông tin xác thực, mã riêng tư).`),
    },
  ],
  related: ["troubleshooting", "learn/prerequisites", "docs/concepts", "download"],
  next: p(link("learn", "Bắt đầu với Học") + " để có phần giới thiệu từng bước."),
});
