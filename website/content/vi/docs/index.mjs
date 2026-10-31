import { SECTIONS } from "../../navigation.mjs";

const BLURBS = {
  "docs/concepts": "Agent, vai trò, workspace, cuộc trò chuyện và lần chạy: mô hình đằng sau mọi giao diện.",
  "docs/conversations": "Chat ba bên: người nhận, model, ghi chú, lịch sử và cách tiếp tục một cuộc trò chuyện.",
  "docs/discuss": "Cách /discuss để một agent trả lời, agent kia review, và Codex viết câu trả lời cuối.",
  "docs/pipeline": "Từng bước của /pipeline, các vai trò, vòng phản biện và review, cổng kiểm tra và cảnh báo.",
  "docs/decisions-resume": "Khi nào một lần chạy dừng lại để hỏi bạn, mỗi câu trả lời làm gì, và Stop, Esc cùng resume hoạt động ra sao.",
  "docs/attachments": "Tệp và ảnh trong tin nhắn: định dạng, giới hạn, nơi lưu bản sao, và mỗi agent nhận được gì.",
  "docs/configuration": "Cài đặt toàn cục, theo dự án và theo phiên, cách chúng ghi đè nhau, đặt lại, và khi nào thay đổi có hiệu lực.",
  "docs/permissions": "Mỗi agent được làm gì do CLI của chính nó quyết định; AgentDuo truyền, chuyển tiếp và cảnh báo những gì.",
  "docs/accounts-usage": "Tài khoản và giới hạn gói của từng agent trong chat, ứng dụng desktop và VS Code.",
  "docs/desktop-updates": "Cách ứng dụng desktop kiểm tra GitHub Releases, và mỗi loại gói có thể cài đặt những gì.",
  "docs/data-diagnostics": "Tệp của lần chạy, log, lịch sử cuộc trò chuyện, dữ liệu của ứng dụng desktop và xuất chẩn đoán.",
  "docs/cli": "Mọi lệnh và tùy chọn của duo, đầu ra thuần văn bản và mã thoát.",
  "docs/slash-commands": "Mọi lệnh của chat, các lệnh cài đặt và phím điều khiển.",
  "docs/config-reference": "Mọi khóa của config.yaml cùng kiểu, giá trị mặc định và ý nghĩa.",
  troubleshooting: "Thiếu CLI, đăng nhập, PATH khi mở từ launcher, công cụ bị từ chối, lỗi cấu hình, Git, đường dẫn Windows, ký ứng dụng và cập nhật.",
  "docs/contributing": "Build từ mã nguồn, chạy test, gửi thay đổi và báo lỗi.",
};

export default ({ link, p }, d) => ({
  title: "Tài liệu",
  description: "Tài liệu AgentDuo: khái niệm, cuộc trò chuyện, thảo luận, pipeline, cấu hình, quyền, dữ liệu, cập nhật ứng dụng desktop và tham chiếu lệnh.",
  lead: p("Mọi thứ AgentDuo làm, theo chủ đề. Nội dung áp dụng cho ứng dụng desktop, lệnh " + "<code>duo</code>" + " và tiện ích VS Code như nhau, trừ khi một mục nói khác. Mới làm quen? Hãy bắt đầu với " + link("learn", "Học") + "."),
  sections: SECTIONS.docs.filter((g) => g.key !== "overview" || true).map((g) => ({
    id: `group-${g.key}`,
    title: { overview: "Tổng quan", using: "Sử dụng AgentDuo", configure: "Cấu hình", reference: "Tham chiếu", help: "Trợ giúp" }[g.key],
    html: `<dl class="defs">${g.pages.filter((id) => id !== "docs").map((id) => `<dt>${link(id, d.titles?.[id] ?? id)}</dt><dd>${BLURBS[id]}</dd>`).join("")}</dl>`,
  })),
  related: ["learn", "faq", "troubleshooting"],
});
