export default ({ c, link, ex, p, ul, table, note }) => ({
  title: "Tham chiếu cấu hình",
  description: "Mọi key trong config.yaml của AgentDuo, kèm kiểu, giá trị mặc định và tác dụng: agents, limits, quality_gates, command gate, safety, claude, codex và paths.",
  lead: p("Mọi key AgentDuo đọc, kèm kiểu và giá trị mặc định có sẵn. Key nào cũng là tùy chọn; " + link("docs/configuration", "Cấu hình") + " giải thích các file nằm ở đâu và được gộp thế nào."),
  sections: [
    {
      id: "overview",
      title: "Các key cấp cao nhất",
      html: `${table({
  caption: "Các key cấp cao nhất",
  head: ["Key", "Chứa gì"],
  rows: [
    [c("agents"), "CLI nào đảm nhận từng role của pipeline"],
    [c("limits"), "Số vòng, số lần thử lại, timeout và kích thước"],
    [c("quality_gates"), "Chính sách review: khi nào một lần chạy là DONE hoặc dừng lại hỏi bạn. Nó không chạy lệnh nào"],
    [c("gates"), "Các lệnh AgentDuo chạy sau mỗi vòng implement (VERIFY)"],
    [c("safety"), "Có dừng lại trước khi implement hay không"],
    [c("claude"), "Cách gọi Claude Code"],
    [c("codex"), "Cách gọi Codex"],
    [c("paths"), "Nơi lưu các lần chạy và cuộc trò chuyện"],
  ],
})}
${p("Mọi key, đặt ở giá trị mặc định:")}
${ex("config/defaults.yaml", { label: "config.yaml" })}
${ul([
  `Key không tồn tại gây cảnh báo và bị bỏ qua. ${c("codex.extra_args")} và ${c("claude.extra_args")} từ agentduo v1 nay là ${c("codex.args")} và ${c("claude.args")}: tên cũ bị bỏ qua, kèm một cảnh báo nói rõ điều đó.`,
  `Giá trị sai kiểu là lỗi, kèm tên file. Flag phải là ${c("true")} hoặc ${c("false")}: YAML đọc ${c("yes")} và ${c("no")} thành chuỗi, và chúng bị từ chối.`,
])}`,
    },
    {
      id: "agents",
      title: "agents",
      html: `${p("Mỗi role nhận " + c("codex") + " hoặc " + c("claude") + ". Hai role có thể dùng cùng một agent. Thay đổi áp dụng cho lần chạy kế tiếp, không bao giờ cho lần đang chạy (" + link("docs/configuration#when-it-applies", "khi nào thay đổi có hiệu lực") + ").")}
${table({
  caption: "Các key của agents",
  head: ["Key", "Mặc định", "Role"],
  rows: [
    [c("agents.planner"), c("codex"), "Viết plan (PLAN) và chốt plan (PLAN_FINALIZE)"],
    [c("agents.plan_reviewer"), c("claude"), "Phản biện plan (PLAN_REVIEW)"],
    [c("agents.implementer"), c("claude"), "Implement plan và sửa các finding (IMPLEMENT)"],
    [c("agents.code_reviewer"), c("codex"), "Review các thay đổi (CODE_REVIEW)"],
  ],
})}
${ex("config/codex-implementer.yaml", { label: ".agentduo/config.yaml" })}`,
    },
    {
      id: "limits",
      title: "limits",
      html: `${p("Mọi giới hạn áp dụng cho lần chạy, cuộc thảo luận hoặc câu hỏi kế tiếp; công việc đang chạy giữ giới hạn lúc nó bắt đầu.")}
${table({
  caption: "Các key của limits",
  head: ["Key", "Kiểu", "Mặc định", "Tác dụng"],
  rows: [
    [c("max_planning_rounds"), "số nguyên ≥ 1", c("4"), "Số vòng lập plan chưa thống nhất trước khi lần chạy dừng với " + c("max_planning_rounds") + " và hỏi bạn"],
    [c("max_review_rounds"), "số nguyên ≥ 1", c("5"), "Số vòng implement và review trước khi lần chạy dừng với " + c("max_review_rounds")],
    [c("max_discussion_rounds"), "số nguyên ≥ 1", c("3"), c("/discuss") + ": số lần review tối đa trước khi Codex viết câu trả lời cuối"],
    [c("max_retries"), "số nguyên ≥ 0", c("1"), "Số lần thử thêm cho lần gọi agent của một bước pipeline bị lỗi (quá thời gian, im lặng quá lâu, hoặc trả lời không đọc được). Lượt trò chuyện chỉ được thử một lần"],
    [c("max_consecutive_gate_failures"), "số nguyên ≥ 1", c("3"), "Số vòng liên tiếp có required gate thất bại trước khi lần chạy dừng với " + c("gates_failing")],
    [c("agent_timeout_sec"), "số nguyên ≥ 1", c("1800"), "Thời gian tối đa của một lần gọi agent"],
    [c("agent_idle_timeout_sec"), "số nguyên ≥ 0", c("900"), "Dừng agent không in ra gì trong khoảng thời gian này; " + c("0") + " tắt kiểm tra"],
    [c("gate_timeout_sec"), "số nguyên ≥ 1", c("900"), "Timeout của gate không có " + c("timeout_sec") + " riêng"],
    [c("max_diff_chars"), "số nguyên ≥ 1", c("120000"), "Số ký tự của diff mà code reviewer nhận; diff dài hơn bị cắt, và reviewer được báo"],
    [c("max_gate_output_chars"), "số nguyên ≥ 1", c("6000"), "Số ký tự cuối trong output của mỗi gate được gửi cho reviewer"],
  ],
})}
${p("Timeout của agent tạm dừng trong lúc một yêu cầu cấp quyền chờ bạn trả lời.")}`,
    },
    {
      id: "quality-gates",
      title: "quality_gates",
      html: `${p("Chính sách review. Các key này quyết định khi nào một lần chạy là DONE, quay lại implementer, hay dừng lại hỏi bạn. Chúng không chạy lệnh nào; lệnh nằm trong " + c("gates") + ".")}
${table({
  caption: "Các key của quality_gates",
  head: ["Key", "Kiểu", "Mặc định", "Tác dụng"],
  rows: [
    [c("require_plan_approval"), "boolean", c("true"), "Planner chốt plan sau khi critic duyệt (PLAN_FINALIZE). Với " + c("false") + ", plan mà critic đã duyệt là bản cuối"],
    [c("require_tests_pass"), "boolean", c("true"), "Một required gate thất bại khiến lần chạy chưa thể DONE và đưa việc trở lại implementer"],
    [c("require_codex_approval"), "boolean", c("true"), "Code reviewer phải duyệt. Tên này có từ trước: nó áp dụng cho bất kỳ agent nào làm review"],
    [c("stop_on_critical_issue"), "boolean", c("true"), "Một finding critical dừng lần chạy với " + c("critical_finding") + " và hỏi bạn"],
    [c("blocking_severities"), "list gồm " + c("critical") + ", " + c("high") + ", " + c("medium") + ", " + c("low"), c("[critical, high]"), "Finding và issue của plan ở các mức này chặn việc duyệt. Là list: nó thay hẳn giá trị trước"],
    [c("review_on_gate_failure"), "boolean", c("false"), "Vẫn review một vòng dù có required gate thất bại"],
  ],
})}
${ex("config/review-policy.yaml", { label: ".agentduo/config.yaml" })}
${p("Các key này quyết định kết thúc một lần chạy ra sao: " + link("docs/pipeline#review", "Code review") + ".")}`,
    },
    {
      id: "gates",
      title: "gates",
      html: `${p("Danh sách lệnh AgentDuo chạy trong workspace, qua shell, sau mỗi vòng implement (bước VERIFY). Mặc định: không có, và lần chạy đi thẳng từ IMPLEMENT sang CODE_REVIEW.")}
${table({
  caption: "Các trường của một gate",
  head: ["Trường", "Kiểu", "Mặc định", "Tác dụng"],
  rows: [
    [c("name"), "chuỗi, bắt buộc", "—", "Tên gate trong report và log; không trùng trong " + c("gates")],
    [c("command"), "chuỗi, bắt buộc", "—", "Lệnh cần chạy; gate đạt khi lệnh thoát với mã 0"],
    [c("required"), "boolean", c("true"), "Required gate thất bại thì việc quay lại implementer; gate không bắt buộc chỉ được báo cáo"],
    [c("timeout_sec"), "số nguyên ≥ 1", c("limits.gate_timeout_sec"), "Timeout của gate này"],
  ],
})}
${p("Trường nào khác đều là lỗi. " + c("gates") + " là list, nên list của project thay hẳn list của user config.")}
${ex("config/gates.yaml", { label: ".agentduo/config.yaml" })}
${note(p(c("gates") + " là các lệnh được chạy; " + c("quality_gates") + " là chính sách review, không chạy gì. Xem thêm " + link("docs/pipeline#gates", "Command gate") + "."))}`,
    },
    {
      id: "safety",
      title: "safety",
      html: `${table({
  caption: "Các key của safety",
  head: ["Key", "Kiểu", "Mặc định", "Tác dụng"],
  rows: [
    [c("pause_before_implement"), "boolean", c("false"), "Khi plan đã chốt, lần chạy dừng với " + c("plan_ready") + " để bạn đọc trước khi bất cứ thứ gì được implement"],
  ],
})}`,
    },
    {
      id: "claude",
      title: "claude",
      html: `${table({
  caption: "Các key của claude",
  head: ["Key", "Kiểu", "Mặc định", "Tác dụng"],
  rows: [
    [c("bin"), "chuỗi", c("claude"), "File thực thi: một tên được tìm trên PATH, hoặc một đường dẫn"],
    [c("model"), "chuỗi hoặc " + c("null"), c("null"), "Truyền dưới dạng " + c("--model") + "; " + c("null") + " để cài đặt riêng của Claude Code quyết định"],
    [c("max_budget_usd"), "số &gt; 0 hoặc " + c("null"), c("null"), "Truyền dưới dạng " + c("--max-budget-usd") + ": Claude dừng một lần gọi sẽ tốn nhiều hơn mức này"],
    [c("permission_prompts"), c("ask") + " hoặc " + c("deny"), c("ask"), c("ask") + " chuyển yêu cầu cấp quyền của Claude đến bạn khi có người trả lời được; " + c("deny") + " không bao giờ hỏi, và Claude từ chối những gì cài đặt của nó không cho phép"],
    [c("args"), "list chuỗi", c("[--no-session-persistence]"), "Flag cho mọi lần gọi Claude. Là list: nó thay giá trị mặc định, nên hãy liệt kê lại " + c("--no-session-persistence") + " nếu muốn giữ"],
    [c("role_args"), "mapping từ role sang list chuỗi", c("{}"), "Flag cho các lần gọi pipeline của một role, đặt sau " + c("args") + ". Được gộp theo từng role giữa các file. Lần gọi trò chuyện chỉ nhận " + c("--permission-mode") + " của implementer"],
  ],
})}
${p("Các lệnh cài đặt trong chat ghi " + c("--effort") + ", " + c("--allowedTools") + ", " + c("--disallowedTools") + " và " + c("--add-dir") + " vào " + c("claude.args") + ", còn " + c("/mode") + " ghi " + c("--permission-mode") + " vào " + c("claude.role_args.implementer") + ".")}`,
    },
    {
      id: "codex",
      title: "codex",
      html: `${table({
  caption: "Các key của codex",
  head: ["Key", "Kiểu", "Mặc định", "Tác dụng"],
  rows: [
    [c("bin"), "chuỗi", c("codex"), "File thực thi: một tên được tìm trên PATH, hoặc một đường dẫn"],
    [c("model"), "chuỗi hoặc " + c("null"), c("null"), "Truyền dưới dạng " + c("--model") + "; " + c("null") + " để " + c("~/.codex/config.toml") + " quyết định"],
    [c("args"), "list chuỗi", c("[--ephemeral]"), "Flag cho mọi lần gọi Codex. Là list: nó thay giá trị mặc định"],
    [c("role_args"), "mapping từ role sang list chuỗi", c("{}"), "Flag cho các lần gọi pipeline của một role, đặt sau " + c("args") + ". Được gộp theo từng role giữa các file. Lần gọi trò chuyện không nhận chúng"],
  ],
})}
${p(c("/codex model <name> <effort>") + " ghi " + c("-c model_reasoning_effort=<effort>") + " vào " + c("codex.args") + ", còn " + c("/codex permissions") + " ghi " + c("--sandbox") + ". " + c("codex exec") + " chỉ đọc trừ khi được cấu hình khác, nên implementer là Codex cần " + c("codex.role_args.implementer: [--sandbox, workspace-write]") + " hoặc một sandbox đặt trong config riêng của Codex.")}`,
    },
    {
      id: "paths",
      title: "paths",
      html: `${table({
  caption: "Các key của paths",
  head: ["Key", "Kiểu", "Mặc định", "Tác dụng"],
  rows: [
    [c("runs_dir"), "chuỗi không rỗng", c(".agentduo/runs"), "Nơi chứa các lần chạy, cuộc trò chuyện và workspace lock. Tương đối so với workspace; " + c("~") + " là thư mục home của bạn"],
  ],
})}
${p("Chỉ đổi nó khi mọi AgentDuo đã đóng: workspace lock nằm ở đó. Ứng dụng desktop hiển thị nhưng không sửa nó. Bên trong có gì: " + link("docs/data-diagnostics#run-files", "File của lần chạy") + ".")}`,
    },
  ],
  related: ["docs/configuration", "docs/pipeline", "docs/permissions", "docs/cli"],
});
