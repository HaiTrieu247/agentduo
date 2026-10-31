export default ({ c, link, p, ul, steps, note, table }) => ({
  title: "Bắt đầu với ứng dụng desktop",
  description: "Cài AgentDuo trên macOS, Windows hoặc Linux, qua bước kiểm tra lần đầu của hai CLI, chat không cần dự án, mở dự án, và tìm các lượt chạy, cài đặt và mức dùng.",
  lead: p("Ứng dụng desktop là AgentDuo trong một cửa sổ riêng: dự án và cuộc trò chuyện ở thanh bên, chat ba bên ở giữa, và một inspector cho kế hoạch, thay đổi và các lần kiểm tra."),
  sections: [
    {
      id: "install",
      title: "Cài ứng dụng",
      html: `${p("Tải trình cài đặt cho hệ thống của bạn từ " + link("download#desktop", "trang tải xuống") + ": .dmg cho macOS (Apple silicon hoặc Intel), .exe cho Windows x64, AppImage hoặc .deb cho Linux x86_64.")}
${note(p("Ứng dụng Mac đã phát hành chưa được notarize và trình cài đặt Windows chưa được ký mã, nên Gatekeeper hoặc SmartScreen sẽ cảnh báo lần đầu. Trang tải xuống hướng dẫn cách mở."), "warning")}
${p("Bản thân ứng dụng không cần Node.js. Nó cần Claude Code và Codex đã được cài và đăng nhập: " + link("learn/prerequisites", "Bạn cần chuẩn bị gì") + ".")}`,
    },
    {
      id: "first-run",
      title: "Kiểm tra lần đầu",
      html: `${p("Ở lần khởi động đầu tiên, ứng dụng kiểm tra " + c("claude") + " và " + c("codex") + " mà không gọi model. Mỗi thẻ cho biết CLI đang thiếu, đã cài, đã đăng nhập, chưa đăng nhập, hay không thể kiểm tra.")}
${ul([
  "Khi đã đăng nhập, thẻ hiển thị email đăng nhập, hoặc <em>API</em> nếu dùng API key hay nhà cung cấp đám mây, cùng gói nếu CLI báo cáo. Nó không bao giờ hiển thị key.",
  `Khi thiếu hoặc chưa đăng nhập, thẻ liên kết đến hướng dẫn cài đặt và nêu lệnh đăng nhập: ${c("claude")} rồi ${c("/login")}, hoặc ${c("codex login")}. Hãy đăng nhập trong terminal, rồi chọn <em>Recheck</em>.`,
  `Nếu CLI được cài ở nơi ứng dụng không tìm, hãy chọn binary của nó trên thẻ. Lựa chọn được lưu thành ${c("claude.bin")} hoặc ${c("codex.bin")} trong cấu hình người dùng, mà mọi giao diện đều đọc.`,
])}
${p("Sau đó bạn có thể vào thẳng một cuộc chat, hoặc chọn thư mục dự án trước.")}`,
    },
    {
      id: "conversations",
      title: "Chat không cần dự án",
      html: `${p("Ứng dụng mở một cuộc chat mà không hỏi thư mục. Các cuộc chat này được liệt kê dưới <em>Conversations</em> ở đầu thanh bên; nút đó đưa bạn quay lại chúng từ bất kỳ dự án nào.")}
${ul([
  `Chúng làm việc trong thư mục home của bạn, nên lịch sử mặc định được lưu dưới ${c("~/.agentduo/runs")}, và chúng trở lại sau khi khởi động lại cùng các bản nháp.`,
  `Tin nhắn thường và ${c("/discuss")} dùng được ở đó. Pipeline cần một dự án nằm trong kho Git: ở thư mục home, ứng dụng sẽ yêu cầu bạn mở một dự án.`,
])}`,
    },
    {
      id: "composer",
      title: "Trò chuyện với cả hai agent",
      html: `${p("Composer ở phía dưới là nơi bạn viết. Bên dưới ô nhập:")}
${table({
  caption: "Các điều khiển của composer",
  head: ["Điều khiển", "Chức năng"],
  rows: [
    ["Recipient and model", "Tin nhắn tiếp theo gửi cho ai (Codex trong cuộc trò chuyện mới) và dùng model nào. Menu của nó chuyển giữa Codex và Claude, hoặc biến tin nhắn tiếp theo thành câu hỏi <em>Discuss</em> hay tác vụ <em>Pipeline</em>."],
    ["Permission mode", "Chế độ của Claude trong chat và khi là bên triển khai của pipeline: Manual (hỏi trước mỗi lần sửa), Edit automatically, hoặc Auto. Shift+Tab trong composer chuyển sang chế độ kế tiếp."],
    ["Attach", "Thêm tệp và ảnh: chọn tệp, dán ảnh, hoặc kéo thả tệp vào composer."],
    ["Send / Stop", "Khi có thứ đang chạy và ô nhập trống, Send trở thành Stop; Esc cũng làm như vậy."],
  ],
})}
${p("Lệnh gõ trực tiếp được ưu tiên hơn menu: " + c("/claude <question>") + ", " + c("/codex <question>") + ", " + c("/discuss <question>") + ", " + c("/pipeline <task>") + ". Gõ " + c("/") + " để xem tất cả. " + link("docs/conversations", "Conversations") + " trình bày đầy đủ về chat.")}`,
    },
    {
      id: "projects",
      title: "Mở một dự án",
      html: `${steps([
  ["Chọn Open project…", p("ở thanh bên, và chọn một thư mục bằng bộ chọn thư mục của hệ thống. Với pipeline, thư mục phải nằm trong một kho Git.")],
  ["Làm việc trong đó", p("Dự án có các cuộc trò chuyện và lịch sử riêng. Mỗi dự án chạy engine riêng ở nền, nên chuyển sang dự án hoặc cuộc trò chuyện khác vẫn để cái đầu tiên tiếp tục làm việc, và bản nháp được giữ nguyên.")],
  ["Để ý chấm tròn", p("Một chấm nhấp nháy chậm đánh dấu dự án hoặc cuộc trò chuyện có agent đang làm việc. Một nhãn đếm số câu hỏi đang chờ bạn.")],
])}`,
    },
    {
      id: "inspector",
      title: "Kế hoạch, thay đổi và kiểm tra",
      html: `${p("Inspector bên phải (có thể thu gọn) hiển thị lượt chạy hiện tại:")}
${ul([
  "<strong>Plan</strong>: kế hoạch mà các agent đã thống nhất.",
  "<strong>Changes</strong>: mỗi tệp thay đổi dưới dạng diff theo dòng giữa các snapshot của lượt chạy. Diff bạn đang xem được giữ nguyên khi một vòng mới bắt đầu.",
  "<strong>Checks</strong>: kết quả các gate của bạn, từng vòng một.",
  "Bản review và báo cáo.",
])}`,
    },
    {
      id: "stop-and-resume",
      title: "Dừng, thoát và tiếp tục",
      html: `${ul([
  "Stop (hoặc Esc) kết thúc thứ đang chạy. Một câu trả lời bị dừng chỉ đơn giản kết thúc; một bước pipeline bị dừng có thể được tiếp tục.",
  "Thanh bên liệt kê các lượt chạy đã dừng hoặc đang chờ của dự án dưới <em>Resumable runs</em>. Một cú nhấp sẽ tiếp tục một lượt.",
  "Thoát ứng dụng dừng mọi lượt chạy, trả lời các câu hỏi đang mở như khi tắt máy, và giải phóng khóa của từng dự án. Lượt chạy đang diễn ra vẫn có thể tiếp tục, cả từ terminal hoặc VS Code.",
])}
${p(link("docs/decisions-resume", "Quyết định, dừng và tiếp tục") + " giải thích điều gì xảy ra với từng loại công việc.")}`,
    },
    {
      id: "settings-and-usage",
      title: "Cài đặt, mức dùng và cập nhật",
      html: `${ul([
  "<strong>Settings</strong> (biểu tượng bánh răng cuối thanh bên): giao diện và cỡ chữ, cả hai CLI cùng tài khoản của chúng, cấu hình của từng agent và của workflow, lưu trữ và chẩn đoán. " + link("docs/configuration#desktop-settings", "Settings trong ứng dụng desktop") + ".",
  "<strong>Account &amp; Usage</strong>, phía trên bánh răng: email của từng agent và mức giới hạn gói đã dùng. " + link("docs/accounts-usage", "Account &amp; Usage") + ".",
  "<strong>Updates</strong>: ứng dụng kiểm tra GitHub Releases. Ở nơi nó không tự cài được bản cập nhật (bản Mac không có Developer ID), nó thông báo cho bạn có phiên bản mới. " + link("docs/desktop-updates", "Cập nhật desktop") + ".",
])}`,
    },
  ],
  related: ["download", "docs/conversations", "docs/configuration", "docs/data-diagnostics"],
  next: p(link("learn/first-task", "Chạy tác vụ đầu tiên của bạn") + ": một dự án nhỏ, một test gate và một lượt chạy pipeline đầy đủ."),
});
