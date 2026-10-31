import { flowFigure } from "../../../lib/figures.mjs";
import { FLOW } from "../pages/home.mjs";

export default ({ c, link, p, ul, table }) => ({
  title: "AgentDuo hoạt động thế nào",
  description: "Các ý tưởng đằng sau AgentDuo: hai agent chạy như CLI, vai trò, workspace, cuộc trò chuyện và lần chạy pipeline, snapshot, và vì sao AgentDuo không tự cưỡng chế gì.",
  lead: p("AgentDuo là một bộ chuyển tiếp. Nó khởi động Codex và Claude Code thành các tiến trình trong workspace của bạn, đưa cho mỗi bên prompt đúng với vai trò, kiểm tra kết quả trả về rồi chuyển tiếp. Dưới đây là các thành phần nó làm việc cùng."),
  sections: [
    {
      id: "agents",
      title: "Hai agent, chạy như CLI",
      html: `${p("Mỗi agent là CLI bạn đã cài: " + c("codex") + " (chạy bằng " + c("codex exec") + ") và " + c("claude") + " (chạy bằng " + c("claude -p") + "). AgentDuo không tự gọi API của model, không giữ thông tin xác thực và không thêm gì vào công cụ của các agent.")}
${p("Với mỗi lần gọi, AgentDuo chỉ truyền các cờ mà giao thức cần: sự kiện JSON dạng stream, schema đầu ra của vai trò (" + c("--output-schema") + " cho Codex, " + c("--json-schema") + " cho Claude) và prompt qua đầu vào chuẩn. " + c("args") + " và " + c("role_args") + " bạn đã cấu hình cũng được đi kèm. Mọi thứ còn lại (model mặc định, quyền, sandbox, máy chủ MCP) là cấu hình riêng của từng CLI.")}`,
    },
    {
      id: "roles",
      title: "Vai trò",
      html: `${table({
        caption: "Bốn vai trò của một lần chạy pipeline",
        head: ["Vai trò", "Khóa cấu hình", "Mặc định", "Trả lời bằng"],
        rows: [
          ["Planner (và duyệt kế hoạch)", c("agents.planner"), "Codex", "một kế hoạch; sau đó là phê duyệt kế hoạch cuối"],
          ["Plan critic", c("agents.plan_reviewer"), "Claude Code", "một bản phản biện: chấp thuận, hoặc các vấn đề theo mức độ"],
          ["Implementer", c("agents.implementer"), "Claude Code", "một báo cáo triển khai: hoàn thành hoặc bị chặn"],
          ["Code reviewer", c("agents.code_reviewer"), "Codex", "một bản review: chấp thuận, hoặc các phát hiện theo mức độ"],
        ],
      })}
${p("Mỗi câu trả lời là JSON phải khớp một schema nghiêm ngặt (thư mục " + c("schemas/") + " của repository). Lần gọi thất bại, hoặc có câu trả lời không khớp, sẽ được thử lại kèm lý do, tối đa thêm " + c("limits.max_retries") + " lần (mặc định là 1).")}`,
    },
    {
      id: "workspace",
      title: "Workspace",
      html: `${p("Workspace là thư mục AgentDuo chạy trong đó: thư mục bạn khởi động " + c("duo") + " (hoặc " + c("--dir") + "), dự án bạn mở trong ứng dụng desktop, hoặc thư mục VS Code. Khi không có thư mục nào, ứng dụng desktop và tiện ích dùng thư mục home của bạn.")}
${ul([
  "Cả hai agent đều chạy ở đó.",
  `${c(".agentduo/")} nằm ở đó: cấu hình dự án và, theo mặc định, thư mục runs.`,
  "Chỉ những thay đổi bên trong workspace mới được gửi cho reviewer. Thay đổi ở nơi khác trong cùng repository sẽ tạo cảnh báo, kèm đường dẫn tương đối so với workspace.",
])}`,
    },
    {
      id: "conversation-and-run",
      title: "Cuộc trò chuyện và lần chạy pipeline",
      html: `${p("Có hai loại công việc, và chúng được tách biệt:")}
${table({
  caption: "So sánh cuộc trò chuyện và lần chạy",
  head: ["", "Cuộc trò chuyện", "Lần chạy pipeline"],
  rows: [
    ["Bắt đầu bằng", "một tin nhắn, một câu hỏi cho agent, " + c("/discuss"), c("/pipeline <task>") + " hoặc " + c('duo "<task>"')],
    ["Câu trả lời", "văn bản thuần, hiển thị đầy đủ", "JSON theo từng vai trò, đã được kiểm tra"],
    ["Cần Git", "không", "có: nó chụp snapshot và diff workspace"],
    ["Lưu tại", c("<runs>/conversations/<id>/"), c("<runs>/<run-id>/")],
    ["Dừng bằng Esc", "câu trả lời kết thúc; không giữ lại gì", "bước kết thúc; lần chạy có thể được resume"],
  ],
})}
${p("Lần chạy pipeline bắt đầu từ một cuộc trò chuyện sẽ được cho biết những gì đã nói trước tác vụ, và các tác vụ pipeline trước đó của cuộc trò chuyện đã làm gì. " + link("docs/conversations", "Cuộc trò chuyện") + " và " + link("docs/pipeline", "Pipeline") + " đi sâu vào từng loại.")}`,
    },
    {
      id: "flow",
      title: "Pipeline trong một cái nhìn",
      html: `${flowFigure(FLOW, "concepts-flow")}
${p("Một lần chạy đến " + c("DONE") + " khi reviewer chấp thuận, không còn phát hiện chặn nào và mọi cổng bắt buộc đều qua. Khi chạm giới hạn, một agent thất bại hoặc bị chặn, hoặc xuất hiện phát hiện nghiêm trọng, nó dừng ở " + c("HUMAN_REVIEW") + " và hỏi bạn. " + link("docs/decisions-resume", "Quyết định, dừng và resume") + ".")}`,
    },
    {
      id: "snapshots",
      title: "Snapshot và diff",
      html: `${p("Trước vòng triển khai đầu tiên, AgentDuo ghi lại trạng thái workspace thành một snapshot Git, và ghi thêm một snapshot sau mỗi vòng. Snapshot là các commit object lưu dưới " + c("refs/agentduo/<run-id>/") + "; chúng dùng một index tạm, nên nhánh, index và các thay đổi đã stage của bạn không bị đụng tới. Reviewer nhận diff giữa mốc gốc và snapshot mới nhất, tối đa " + c("limits.max_diff_chars") + " ký tự. Thay đổi bạn làm trước lần chạy thuộc về mốc gốc, nên không nằm trong diff.")}
${p("Dữ liệu lần chạy, tệp đính kèm và " + c(".claude/settings.local.json") + " bị loại khỏi mọi snapshot. Không bao giờ có gì được commit vào nhánh của bạn hay được push.")}`,
    },
    {
      id: "no-rules",
      title: "AgentDuo không cưỡng chế gì",
      html: `${p("AgentDuo không có hệ thống quyền riêng và không chặn gì. Agent được làm gì do cài đặt của CLI quyết định; nên làm gì do prompt của bạn và " + c("AGENTS.md") + " hoặc " + c("CLAUDE.md") + " của repository.")}
${p("Việc AgentDuo làm là báo cáo. Tệp bị agent lập kế hoạch hoặc review thay đổi, và tệp thay đổi ngoài workspace, tạo ra một " + c("warning") + " trên màn hình và trong báo cáo của lần chạy; các lệnh gọi công cụ mà Claude bị từ chối cũng được liệt kê. " + link("docs/permissions", "Quyền") + ".")}`,
    },
  ],
  related: ["docs/pipeline", "docs/conversations", "docs/permissions", "about"],
});
