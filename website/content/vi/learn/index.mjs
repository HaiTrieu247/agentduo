export default ({ link, p, steps }) => ({
  title: "Tìm hiểu AgentDuo",
  description: "Lộ trình từng bước cho người mới: cần chuẩn bị gì, cài ứng dụng desktop, lệnh duo hoặc tiện ích VS Code, và một tác vụ đầu tiên từ đầu đến cuối.",
  lead: p("Năm bài học ngắn đưa bạn từ lúc chưa cài gì đến một tác vụ hoàn chỉnh được cả hai agent review. Hãy đọc theo thứ tự, hoặc nhảy thẳng đến giao diện bạn muốn dùng."),
  sections: [
    {
      id: "path",
      title: "Lộ trình",
      html: steps([
        [link("learn/prerequisites", "Bạn cần chuẩn bị gì"), p("Cài Claude Code và Codex, đăng nhập cả hai, và biết khi nào cần Node.js và Git. Khoảng mười phút nếu chưa cài CLI nào.")],
        ["Chọn giao diện", p(`${link("learn/desktop", "Ứng dụng desktop")} nếu bạn muốn một cửa sổ riêng; ${link("learn/cli", "terminal")} cho ${"<code>duo</code>"} và script; ${link("learn/vscode", "VS Code")} cho khung chat cạnh trình soạn thảo. Bạn có thể dùng nhiều giao diện: chúng dùng chung cấu hình và các lượt chạy.`)],
        [link("learn/first-task", "Tác vụ đầu tiên"), p("Tạo một dự án nhỏ có test lỗi, cấu hình test gate, chạy pipeline, xem diff và commit. Mọi lệnh đều có thể sao chép.")],
      ]),
    },
    {
      id: "words",
      title: "Bốn thuật ngữ bạn sẽ gặp",
      html: `<dl class="defs">
<dt>Workspace</dt><dd>Thư mục AgentDuo làm việc: nơi cả hai agent chạy, nơi ${"<code>.agentduo/</code>"} nằm, và là nơi duy nhất có thay đổi được gửi đến reviewer.</dd>
<dt>Conversation</dt><dd>Cuộc trò chuyện ba bên giữa bạn, Claude Code và Codex. Tin nhắn thường chỉ gửi cho một agent; cả hai đều thấy những gì đã nói.</dd>
<dt>Pipeline run</dt><dd>Quy trình bắt đầu bằng ${"<code>/pipeline</code>"}: lập kế hoạch, phản biện, chốt, triển khai, kiểm tra, review. Mỗi lượt có một id, các tệp riêng và có thể được tiếp tục.</dd>
<dt>Gate</dt><dd>Một lệnh của bạn, chẳng hạn ${"<code>npm test</code>"}, mà AgentDuo chạy sau mỗi vòng triển khai. Kết quả của nó quyết định không kém gì reviewer.</dd>
</dl>
${p(link("docs/concepts", "AgentDuo hoạt động thế nào") + " giải thích từng khái niệm sâu hơn.")}`,
    },
  ],
  related: ["docs", "faq", "download"],
});
