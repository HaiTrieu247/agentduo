export default ({ c, link, ext, table, p }, d) => ({
  title: "Giới thiệu AgentDuo",
  description: "Vì sao AgentDuo ra đời, cách nó chuyển giao công việc giữa Codex và Claude Code, vai trò mặc định của từng agent, quan hệ giữa ba giao diện và giấy phép.",
  lead: p("AgentDuo là một kênh giữa hai agent lập trình. Nó chạy Codex và Claude Code như đã cài trên máy bạn, chuyển đầu ra có cấu trúc của bên này cho bên kia, và cho bạn thấy cả hai đang làm gì."),
  sections: [
    {
      id: "goal",
      title: "Mục tiêu",
      html: `${p("Một agent lập trình đơn lẻ vừa lập kế hoạch, vừa viết, vừa tự đánh giá công việc của mình. AgentDuo chia những việc đó cho hai agent của hai nhà cung cấp khác nhau, để kế hoạch được kiểm tra trước khi xây dựng và diff được đọc bởi một agent không phải người viết ra nó.")}
${p("Nó làm vậy mà không thêm một lớp quy tắc riêng. Quyền, sandbox và quy ước vẫn nằm ở nơi bạn đã đặt: trong cấu hình của từng CLI và trong " + c("AGENTS.md") + " hoặc " + c("CLAUDE.md") + " của repository. AgentDuo báo lại những gì các agent đã làm, cảnh báo về thay đổi bất ngờ, và để các quyết định cùng việc commit cho bạn.")}`,
    },
    {
      id: "how-it-works",
      title: "Cách hoạt động",
      html: `${p("AgentDuo khởi động mỗi agent như một tiến trình con: " + c("codex exec") + " cho Codex và " + c("claude -p") + " cho Claude Code, trong thư mục workspace. Nó truyền các cờ mà giao thức cần (đầu ra JSON dạng stream, schema đầu ra cho vai trò, prompt qua standard input) cùng các đối số bạn cấu hình, và đọc luồng sự kiện của agent để hiển thị công cụ và tin nhắn khi chúng diễn ra.")}
${p("Trong một lượt chạy pipeline, mỗi vai trò trả lời bằng JSON phải khớp với một schema: kế hoạch, phản biện, phê duyệt, báo cáo triển khai, review. AgentDuo kiểm tra tính hợp lệ, lưu vào thư mục của lượt chạy, rồi chuyển cho vai trò kế tiếp. Giữa các vòng triển khai, nó snapshot working tree của bạn bằng Git, để bên review thấy đúng diff của vòng đó.")}
${p("Trong một hội thoại không có schema: bạn trò chuyện với cả hai agent, mỗi bên thấy cuộc trò chuyện từ đầu, và " + c("/pipeline") + " chuyển một tác vụ từ hội thoại sang quy trình. " + link("docs/concepts", "Cách AgentDuo hoạt động") + " đi vào chi tiết.")}`,
    },
    {
      id: "roles",
      title: "Vai trò mặc định",
      html: `${table({
        caption: "Mặc định ai làm gì",
        head: ["Vai trò", "Agent mặc định", "Làm gì"],
        rows: [
          ["Người lập kế hoạch", "Codex", "Viết kế hoạch: mục tiêu, phạm vi, các bước, tiêu chí chấp nhận, rủi ro. Sửa lại sau phản biện và chốt phiên bản cuối."],
          ["Người phản biện kế hoạch", "Claude Code", "Kiểm tra kế hoạch có khả thi với repository không; duyệt hoặc liệt kê các vấn đề chặn."],
          ["Người triển khai", "Claude Code", "Xây dựng theo kế hoạch cuối, rồi sửa các phát hiện của bên review qua từng vòng."],
          ["Người review mã", "Codex", "Review diff giữa các snapshot cùng kết quả gate, rồi duyệt hoặc báo các phát hiện theo mức độ nghiêm trọng."],
        ],
      })}
${p("Mỗi vai trò có thể giao cho một trong hai agent bằng các khóa " + c("agents") + " trong cấu hình. Trong " + c("/discuss") + ", Codex luôn viết bản tổng hợp cuối. " + link("docs/pipeline#roles", "Các vai trò trong pipeline") + ".")}`,
    },
    {
      id: "interfaces",
      title: "Ba giao diện, một engine",
      html: `${table({
        caption: "Ba giao diện",
        head: ["Giao diện", "Là gì", "Engine chạy trên"],
        rows: [
          ["Ứng dụng desktop (AgentDuo)", "Ứng dụng Electron cho macOS, Windows và Linux: dự án và hội thoại ở thanh bên, cuộc trò chuyện, bảng kiểm tra, Settings.", "Node.js bên trong Electron; không cần cài Node"],
          [c("duo") + " / " + c("agentduo"), "Gói npm: cuộc trò chuyện trong terminal với màn hình trực tiếp, và các lệnh cho script và CI.", "Node.js 22.12 trở lên của bạn"],
          ["Tiện ích VS Code", "Cuộc trò chuyện dạng tab trình soạn thảo, có màn hình Account &amp; Usage và trình soạn diff của VS Code.", "Node.js 22.12 trở lên của bạn (không dùng Node riêng của VS Code)"],
        ],
      })}
${p("Cả ba đọc cùng một cấu hình (" + c("~/.config/agentduo/config.yaml") + " và " + c(".agentduo/config.yaml") + " của workspace) và lưu các lượt chạy trong cùng một thư mục runs, được bảo vệ bởi cùng một khóa. Lượt chạy bắt đầu trong terminal có thể tiếp tục trong ứng dụng desktop hoặc VS Code, và ngược lại.")}`,
    },
    {
      id: "what-it-is-not",
      title: "AgentDuo không làm gì",
      html: `<ul>
<li>Nó không kèm Claude Code, Codex, gói đăng ký hay tín dụng API. Bạn tự cài cả hai CLI và đăng nhập bằng tài khoản của mình.</li>
<li>Nó không cấp quyền. Claude Code và Codex tự quyết định được phép làm gì theo cài đặt của chúng; AgentDuo chỉ chuyển các yêu cầu cấp quyền của Claude đến bạn khi có người trả lời được.</li>
<li>Nó không commit, push hay deploy. Các thay đổi của bạn nằm lại trong working tree.</li>
<li>Nó không gửi gì đến máy chủ riêng nào. Các agent trao đổi với nhà cung cấp của chúng như vẫn làm; trang web bạn đang đọc không có công cụ phân tích.</li>
</ul>`,
    },
    {
      id: "source-and-license",
      title: "Mã nguồn và giấy phép",
      html: `${p("AgentDuo là mã nguồn mở theo " + ext(d.site.links.license, "giấy phép MIT") + ". Mã nguồn của cả ba giao diện nằm trong một repository: " + ext(d.site.links.github, "github.com/HaiTrieu247/agentduo") + ". Hãy báo vấn đề tại " + ext(d.site.links.issues, "trang issue") + "; " + link("docs/contributing", "Build và đóng góp") + " giải thích cách build từ mã nguồn và gửi thay đổi.")}
${p("AgentDuo là một dự án độc lập và không liên kết với Anthropic hay OpenAI. Claude Code và Codex là sản phẩm và nhãn hiệu của họ.")}`,
    },
  ],
  related: ["docs/concepts", "download", "releases", "docs/contributing"],
  next: p(link("learn", "Học AgentDuo") + ": cài đặt và chạy tác vụ đầu tiên, từng bước một."),
});
