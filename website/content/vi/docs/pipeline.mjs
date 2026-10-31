export default ({ c, link, code, ex, p, ul, table, steps, note, h3 }) => ({
  title: "Pipeline",
  description: "Mọi bước của một lượt chạy pipeline AgentDuo: vòng lập kế hoạch và phản biện, chốt kế hoạch, triển khai, cổng lệnh, review code, chính sách review, DONE và cảnh báo.",
  lead: p("Một lượt chạy pipeline đưa một tác vụ qua các bước plan → critique → finalize → implement → verify → review, mỗi bước do agent được cấu hình cho vai trò đó thực hiện, cho đến khi review chấp thuận hoặc lượt chạy hỏi bạn."),
  sections: [
    {
      id: "start",
      title: "Bắt đầu một lượt chạy",
      html: `${table({
  caption: "Các cách bắt đầu một lượt chạy pipeline",
  head: ["Ở đâu", "Cách làm"],
  rows: [
    ["Chat (mọi giao diện)", c("/pipeline <task>") + ", hoặc <em>Pipeline</em> trong menu người nhận của ứng dụng desktop và VS Code"],
    ["Terminal, chạy một lượt rồi thoát", c('duo "<task>"') + ", " + c('duo run "<task>"') + ", " + c("duo --task-file task.md")],
  ],
})}
${ul([
  "Workspace phải nằm trong một kho Git, và phải tìm thấy CLI của mọi vai trò. Cấu hình được kiểm tra trước khi bất cứ thứ gì bắt đầu.",
  "Mỗi workspace chỉ chạy một pipeline tại một thời điểm, được bảo vệ bằng một khóa trong thư mục runs của nó.",
  `Lượt chạy nhận một id như ${c("20261031-101500-add-refresh-tokens")} và một thư mục riêng: ${link("docs/data-diagnostics#run-files", "các tệp của lượt chạy")}.`,
])}`,
    },
    {
      id: "roles",
      title: "Vai trò",
      html: `${table({
  caption: "Các vai trò và agent mặc định",
  head: ["Bước", "Vai trò", "Agent mặc định"],
  rows: [
    [c("PLAN"), "người lập kế hoạch", "Codex"],
    [c("PLAN_REVIEW"), "người phản biện kế hoạch (" + c("plan_reviewer") + ")", "Claude Code"],
    [c("PLAN_FINALIZE"), "người lập kế hoạch, chốt kế hoạch", "Codex"],
    [c("IMPLEMENT"), "người triển khai", "Claude Code"],
    [c("VERIFY"), "các cổng của bạn", "AgentDuo chạy các lệnh"],
    [c("CODE_REVIEW"), "người review code", "Codex"],
  ],
})}
${p("Đổi agent đóng một vai trò bằng các khóa " + c("agents") + "; mỗi agent có " + c("role_args") + " riêng cho từng vai trò:")}
${ex("config/codex-implementer.yaml", { label: ".agentduo/config.yaml" })}`,
    },
    {
      id: "planning",
      title: "Vòng lập kế hoạch và phản biện",
      html: `${steps([
  ["PLAN", p("Người lập kế hoạch viết kế hoạch gồm mục tiêu, phạm vi, các bước, tiêu chí chấp nhận và rủi ro (" + c("plan.v1.md") + ").")],
  ["PLAN_REVIEW", p("Người phản biện kiểm tra kế hoạch có khả thi không và liệt kê các vấn đề theo mức độ nghiêm trọng. Chỉ chấp thuận khi không còn vấn đề nào chặn; một chấp thuận mà vẫn liệt kê vấn đề chặn được tính là yêu cầu thay đổi, kèm cảnh báo.")],
  ["PLAN_FINALIZE", p("Người lập kế hoạch trả lời phần phản biện và chốt kế hoạch cuối (" + c("plan.final.md") + "), hoặc yêu cầu thêm một vòng. Với " + c("quality_gates.require_plan_approval: false") + " bước này bị bỏ qua: kế hoạch mà người phản biện đã chấp thuận là kế hoạch cuối.")],
])}
${p("Yêu cầu thay đổi sẽ bắt đầu vòng lập kế hoạch tiếp theo. Sau " + c("limits.max_planning_rounds") + " vòng (mặc định là 4) mà chưa đồng thuận, lượt chạy dừng với " + c("max_planning_rounds") + " và hỏi bạn: resume sẽ triển khai kế hoạch mới nhất, được ghi nhận là do bạn chấp nhận. Với " + c("safety.pause_before_implement: true") + ", lượt chạy cũng dừng với " + c("plan_ready") + " khi kế hoạch đã chốt, để bạn đọc trước.")}`,
    },
    {
      id: "implementation",
      title: "Vòng triển khai",
      html: `${ul([
  "Trước vòng đầu tiên, AgentDuo chụp snapshot workspace làm mốc gốc; sau mỗi vòng nó chụp lại.",
  `Người triển khai xây dựng theo kế hoạch (vòng 1) hoặc sửa các phát hiện còn mở (các vòng sau), và báo ${c("completed")} hoặc ${c("blocked")} kèm lý do. ${c("blocked")} dừng lượt chạy với ${c("implementer_blocked")}.`,
  "Người triển khai không trả lời mọi phát hiện còn mở sẽ bị cảnh báo trong báo cáo.",
  `Các vòng tiếp tục cho đến khi review chấp thuận, tối đa ${c("limits.max_review_rounds")} (mặc định 5); sau đó lượt chạy dừng với ${c("max_review_rounds")}.`,
])}`,
    },
    {
      id: "gates",
      title: "Cổng lệnh (VERIFY)",
      html: `${p("Cổng là các lệnh của bạn mà AgentDuo tự chạy sau mỗi vòng triển khai, trong workspace, qua shell. Chúng là tùy chọn; nếu không có, lượt chạy đi thẳng từ IMPLEMENT sang CODE_REVIEW.")}
${ex("config/gates.yaml", { label: ".agentduo/config.yaml" })}
${ul([
  `Một cổng đạt khi lệnh của nó thoát với mã 0. ${c("required")} là true trừ khi bạn đặt thành false; cổng tùy chọn chỉ được báo cáo.`,
  `Mỗi cổng có ${c("timeout_sec")}, hoặc ${c("limits.gate_timeout_sec")} (900 giây). Đầu ra được ghi trong thư mục ${c("gates/")} của lượt chạy, và ${c("limits.max_gate_output_chars")} ký tự cuối (6.000) được gửi cho người review.`,
  `Khi một cổng bắt buộc thất bại, công việc quay lại người triển khai cho một vòng nữa, không qua review (trừ khi ${c("quality_gates.review_on_gate_failure")} là true). Sau ${c("limits.max_consecutive_gate_failures")} vòng thất bại liên tiếp (3), lượt chạy dừng với ${c("gates_failing")}.`,
  "Nếu một cổng làm thay đổi tệp trong cây làm việc, AgentDuo cảnh báo và chụp snapshot lại, để người review thấy cây đúng như các cổng để lại.",
  `${c("duo init")} gợi ý các cổng mà nó phát hiện được (script trong package.json, pytest, go test, cargo test, target test trong Makefile), ở dạng đã chú thích.`,
])}
${note(p("Cổng không giống với " + c("quality_gates") + ": " + c("gates") + " là các lệnh được chạy; " + c("quality_gates") + " là chính sách review bên dưới, không chạy gì cả."))}`,
    },
    {
      id: "review",
      title: "Review code",
      html: `${p("Người review nhận kế hoạch cuối, diff từ mốc gốc đến snapshot mới nhất (tối đa " + c("limits.max_diff_chars") + ", 120.000 ký tự; diff dài hơn bị cắt và người review được báo điều đó), diff stat, kết quả các cổng, các phát hiện còn mở và báo cáo của người triển khai. Người review phải nêu rõ snapshot đã review.")}
${p("Người review trả lời bằng các phát hiện, mỗi phát hiện có một mức độ (" + c("critical") + ", " + c("high") + ", " + c("medium") + ", " + c("low") + "), và chấp thuận hoặc không. Một lượt chạy là " + c("DONE") + " khi tất cả điều sau đều đúng:")}
${ul([
  `người review chấp thuận (hoặc ${c("quality_gates.require_codex_approval")} là false);`,
  `không phát hiện nào có mức độ chặn (${c("quality_gates.blocking_severities")}, mặc định là critical và high);`,
  `mọi cổng bắt buộc đều đạt, nếu bạn có cổng (và ${c("quality_gates.require_tests_pass")} là true).`,
])}
${p("Nếu không, người triển khai nhận thêm một vòng. Một phát hiện critical sẽ dừng lượt chạy với " + c("critical_finding") + " trước, khi " + c("quality_gates.stop_on_critical_issue") + " là true. Một chấp thuận mà vẫn liệt kê phát hiện chặn được tính là yêu cầu thay đổi, kèm cảnh báo.")}`,
    },
    {
      id: "review-policy",
      title: "Chính sách review (quality_gates)",
      html: `${table({
  caption: "Các khóa quality_gates",
  head: ["Khóa", "Mặc định", "Tác dụng"],
  rows: [
    [c("require_plan_approval"), c("true"), "Người lập kế hoạch chốt kế hoạch sau khi người phản biện chấp thuận (PLAN_FINALIZE)."],
    [c("require_tests_pass"), c("true"), "Một cổng bắt buộc thất bại sẽ ngăn lượt chạy đạt DONE và trả công việc lại."],
    [c("require_codex_approval"), c("true"), "Người review code phải chấp thuận. Tên này mang tính lịch sử: nó áp dụng cho bất kỳ agent nào đang review."],
    [c("stop_on_critical_issue"), c("true"), "Một phát hiện critical dừng lượt chạy và hỏi bạn."],
    [c("blocking_severities"), c("[critical, high]"), "Các phát hiện và vấn đề ở các mức này chặn việc chấp thuận."],
    [c("review_on_gate_failure"), c("false"), "Review một vòng dù có cổng bắt buộc thất bại."],
  ],
})}
${ex("config/review-policy.yaml", { label: ".agentduo/config.yaml" })}`,
    },
    {
      id: "warnings",
      title: "Cảnh báo",
      html: `${p("AgentDuo không chặn gì, nhưng nó báo cáo. Cảnh báo hiện trên màn hình ngay khi xảy ra và trong " + c("report.md") + " của lượt chạy:")}
${ul([
  "tệp bị agent lập kế hoạch hoặc agent review thay đổi;",
  "tệp bị thay đổi bên ngoài workspace trong một bước, với đường dẫn tương đối so với workspace (" + c("../shared/x.ts") + ");",
  "các lời gọi công cụ mà Claude bị từ chối, kèm tên công cụ;",
  "các cổng đã làm thay đổi cây làm việc;",
  "một chấp thuận còn vấn đề chặn, một người triển khai bỏ qua phát hiện, một bước chạy lại sau khi bị gián đoạn.",
])}`,
    },
    {
      id: "when-done",
      title: "Khi lượt chạy kết thúc",
      html: `${p("Không có gì được commit hay push. Các thay đổi nằm trong cây làm việc của bạn:")}
${code("git status\ngit diff", { lang: "sh", label: "Terminal" })}
${p(c("report.md") + " của lượt chạy có dòng thời gian, kết quả các cổng, diff stat, các vấn đề chưa giải quyết, cảnh báo, chi phí và token. " + c("/diff") + ", " + c("/plan") + " và " + c("/status") + " hiển thị chúng trong chat; bảng inspector của ứng dụng desktop và menu ⋯ của VS Code cũng mở được chúng.")}`,
    },
  ],
  related: ["docs/decisions-resume", "docs/config-reference#quality-gates", "docs/permissions", "learn/first-task"],
});
