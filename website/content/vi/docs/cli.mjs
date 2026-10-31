export default ({ c, kbd, link, code, p, ul, table, note, h3 }) => ({
  title: "Dòng lệnh",
  description: "Mọi lệnh và tùy chọn của duo: chat, run, resume, status, list, doctor và init, các tùy chọn chung, phím tắt khi theo dõi một lượt chạy và các mã thoát.",
  lead: p("Gói npm cài một chương trình dưới hai tên, " + c("duo") + " và " + c("agentduo") + ". Gõ " + c("duo") + " không kèm gì sẽ mở chat; kèm một nhiệm vụ thì nó chạy pipeline một lần rồi thoát."),
  sections: [
    {
      id: "commands",
      title: "Các lệnh",
      html: `${table({
  caption: "Các lệnh của duo",
  head: ["Lệnh", "Tác dụng"],
  rows: [
    [c("duo"), "Mở " + link("docs/conversations", "chat") + " trong workspace này (chỉ trong terminal tương tác)."],
    [c('duo "<task>"') + ", " + c('duo run "<task>"'), "Bắt đầu một lượt chạy pipeline với nhiệm vụ đó, hiển thị đến khi xong rồi thoát với " + link("docs/cli#exit-codes", "mã thoát") + " của nó."],
    [c("duo resume [runId]"), "Tiếp tục lượt chạy gần nhất, hoặc lượt được nêu tên, có thể kèm câu trả lời cho quyết định đang chờ."],
    [c("duo status [runId]"), "Hiển thị pha, số vòng, chi phí và token, các bước gần nhất và thư mục chứa file của một lượt chạy."],
    [c("duo list"), "Liệt kê các lượt chạy của workspace này: id, pha, lần cập nhật cuối và nhiệm vụ."],
    [c("duo doctor"), "Kiểm tra các CLI, cấu hình và workspace mà không gọi model nào."],
    [c("duo init"), "Tạo " + c(".agentduo/config.yaml") + " và " + c(".agentduo/.gitignore") + ", và đề nghị chạy " + c("git init") + "."],
    [c("duo --help") + ", " + c("duo <command> --help"), "In cách dùng."],
    [c("duo -V") + ", " + c("duo --version"), "In phiên bản."],
  ],
})}
${p(c("duo") + " và " + c("agentduo") + " là cùng một chương trình: mọi ví dụ trên trang này đều chạy được với cả hai tên.")}`,
    },
    {
      id: "options",
      title: "Tùy chọn chung",
      html: `${p("Lệnh nào cũng nhận các tùy chọn này, đặt trước hay sau tên lệnh đều được (" + c("duo --dir ../api list") + " và " + c("duo list --dir ../api") + " là như nhau).")}
${table({
  caption: "Tùy chọn mọi lệnh đều nhận",
  head: ["Tùy chọn", "Tác dụng"],
  rows: [
    [c("--dir <path>"), "Workspace: chính thư mục này, không phải thư mục gốc của repository phía trên. Mặc định: thư mục hiện tại."],
    [c("--config <path>"), "File cấu hình dùng thay cho " + c("<dir>/.agentduo/config.yaml") + ". Cấu hình người dùng vẫn được đọc trước."],
    [c("--plain"), "In từng dòng thuần có dấu thời gian thay cho giao diện terminal trực tiếp. Đây là mặc định khi stdout không phải terminal, khi " + c("CI=true") + ", hoặc khi tiến trình chạy nền (" + c("duo … &") + ")."],
    [c("-v") + ", " + c("--verbose"), "Hiển thị mọi hoạt động của agent, kể cả suy nghĩ."],
    [c("--no-color"), "Tắt màu. Đặt biến môi trường " + c("NO_COLOR") + " cũng có tác dụng tương tự."],
  ],
})}
${table({
  caption: "Tùy chọn của các lệnh bắt đầu hoặc tiếp tục lượt chạy",
  head: ["Tùy chọn", "Lệnh", "Tác dụng"],
  rows: [
    [c("--task-file <file>"), c("duo") + ", " + c("duo run"), "Đọc nhiệm vụ từ một file. Nếu có cả từ ngữ trên dòng lệnh, nội dung file nằm sau chúng."],
    [c("--accept-edits"), c("duo") + ", " + c("duo run") + ", " + c("duo resume"), "Implementer sửa file mà không hỏi: chế độ " + c("acceptEdits") + " của Claude, giống " + c("/mode acceptEdits") + " trong chat. Với " + c("duo") + " không kèm nhiệm vụ, nó đặt chế độ cho chat."],
    [c("--decision <decision>"), c("duo resume"), "Trả lời một lượt chạy đang chờ bạn: " + c("resume") + ", " + c("revise") + " hoặc " + c("abort") + "."],
    [c("--note <text>"), c("duo resume"), "Chỉ dẫn cho các agent, được ghi lại cùng quyết định. Chỉ dùng kèm " + c("--decision") + "."],
    [c("--reload-config"), c("duo resume"), "Dùng cấu hình hiện tại thay cho cấu hình lúc lượt chạy bắt đầu."],
  ],
})}`,
    },
    {
      id: "chat",
      title: "Chat: duo",
      html: `${p(c("duo") + " không kèm nhiệm vụ sẽ mở chat, nhưng chỉ ở nơi có người gõ được: một terminal tương tác, chạy ở foreground, ngoài CI, không có " + c("--plain") + ". Ở nơi khác, nó dừng với mã thoát 1 và yêu cầu một nhiệm vụ.")}
${ul([
  "Chat mở được trong mọi thư mục, kể cả khi thiếu CLI hay không có repository Git; mỗi câu hỏi kiểm tra CLI của agent nhận nó, còn " + c("/pipeline") + " kiểm tra thêm repository.",
  "Chat giữ khóa của workspace cho đến khi bạn thoát, nên trong lúc đó một " + c("duo run") + " trong cùng workspace sẽ bị từ chối.",
  "Khi thoát (" + c("/quit") + ", hoặc " + kbd("Ctrl") + "+" + kbd("C") + " hai lần), pipeline đang chạy dừng ở bước hiện tại và vẫn tiếp tục được. Mã thoát là 0.",
])}
${p("Mọi thứ bạn gõ trong chat được mô tả ở " + link("docs/slash-commands", "Lệnh gạch chéo") + ".")}`,
    },
    {
      id: "run",
      title: "Bắt đầu lượt chạy: duo \"<task>\" và duo run",
      html: `${code('duo "Add refresh tokens to the auth service"\nduo run "Fix the flaky upload test" --accept-edits\nduo --task-file task.md\nduo -- "-x is ignored by the parser"', { lang: "sh", label: "Terminal" })}
${ul([
  "Nhiệm vụ là mọi từ sau lệnh, nối lại với nhau. Nhiệm vụ bắt đầu bằng " + c("-") + " sẽ bị đọc thành tùy chọn: hãy đặt " + c("--") + " trước nó.",
  "Một từ duy nhất gần giống tên lệnh (" + c("duo stauts") + ") bị từ chối thay vì được gửi đi như một nhiệm vụ tốn tiền; " + c("duo run <word>") + " vẫn chạy nó.",
  "Trước khi bắt đầu, workspace phải nằm trong một repository Git và CLI của mọi vai trò phải tìm thấy được; nếu không, lượt chạy không bắt đầu (mã thoát 1).",
  "Mỗi workspace chỉ chạy một pipeline một lúc. " + c("duo run") + " thứ hai trong lúc một lượt đang chạy, hoặc trong lúc chat đang mở ở đó, sẽ bị từ chối.",
  "Lượt chạy có thư mục riêng trong thư mục runs (" + link("docs/data-diagnostics#run-files", "file của lượt chạy") + ") và giữ cấu hình lúc bắt đầu trong " + c("config.json") + ".",
])}
${p("Diễn biến tiếp theo được mô tả ở " + link("docs/pipeline", "Pipeline") + ".")}`,
    },
    {
      id: "terminal-run",
      title: "Theo dõi lượt chạy trong terminal",
      html: `${p("Trong terminal tương tác, lượt chạy có một màn hình cập nhật trực tiếp. Các phím sau dùng được khi nó đang chạy:")}
${table({
  caption: "Phím khi theo dõi lượt chạy",
  head: ["Phím", "Tác dụng"],
  rows: [
    [kbd("v"), "Hiện hoặc ẩn mọi hoạt động của agent, như " + c("--verbose") + "."],
    [kbd("q"), "Dừng sau bước đang chạy. Lượt chạy vẫn tiếp tục được (mã thoát 130)."],
    [kbd("Ctrl") + "+" + kbd("C"), "Dừng ngay agent hoặc gate đang chạy; bước đó sẽ chạy lại khi tiếp tục (mã thoát 130)."],
    [kbd("Ctrl") + "+" + kbd("C") + " hai lần", "Kết thúc các agent và thoát ngay (mã thoát 130)."],
  ],
})}
${ul([
  "Khi lượt chạy cần bạn, một menu thay cho màn hình: Resume, Revise (kèm ghi chú), xem plan, review, phản hồi về plan hoặc diff stat, Abort, hoặc Decide later. " + kbd("Ctrl") + "+" + kbd("C") + " tại menu cũng có nghĩa là Decide later (mã thoát 2). Xem " + link("docs/decisions-resume", "Quyết định và tiếp tục") + ".",
  "Trong terminal, các yêu cầu cấp quyền của Claude đến tay bạn, cả ở chế độ plain. Ở nơi không ai trả lời được (CI, pipe, chạy nền), Claude tự từ chối và lượt chạy báo các công cụ bị từ chối: " + link("docs/permissions", "Quyền") + ".",
  "Ở chế độ plain, lượt chạy cần quyết định sẽ thoát với mã 2; trả lời bằng " + c("duo resume --decision …") + ".",
])}`,
    },
    {
      id: "resume",
      title: "Tiếp tục lượt chạy: duo resume",
      html: `${code('duo resume\nduo resume 20261031-101500-add-refresh-tokens\nduo resume --decision revise --note "Keep the old endpoint until v2"\nduo resume --reload-config', { lang: "sh", label: "Terminal" })}
${ul([
  "Không có id, lệnh tiếp tục lượt chạy gần nhất trong thư mục runs. Bước bị ngắt giữa chừng sẽ chạy lại.",
  "Lượt chạy giữ cấu hình lúc bắt đầu (" + c("config.json") + " của nó). " + c("--reload-config") + " dùng các file cấu hình hiện tại của bạn và lưu nó làm cấu hình của lượt chạy.",
  c("--decision") + " trả lời lượt chạy đang chờ ở " + c("HUMAN_REVIEW") + ": " + c("resume") + " đi tiếp, " + c("revise") + " quay lại lập plan với ghi chú của bạn, " + c("abort") + " kết thúc lượt chạy (mã thoát 3). Lượt chạy không chờ quyết định sẽ từ chối (mã thoát 1).",
  c("--note") + " chỉ được chấp nhận khi đi kèm " + c("--decision") + ".",
  "Lượt chạy thuộc về workspace nơi nó bắt đầu. Tiếp tục nó từ workspace khác sẽ bị từ chối; hãy chạy từ đó, hoặc truyền " + c("--dir") + ".",
  "Giống một lượt chạy mới, nó cần repository Git, các CLI, và giữ khóa của workspace.",
])}
${note(p("Trong chat, " + c("/resume") + " làm việc tương tự và nhận một ghi chú hoặc id lượt chạy: " + link("docs/slash-commands#runs", "/resume") + "."))}`,
    },
    {
      id: "inspect",
      title: "Xem các lượt chạy: duo status và duo list",
      html: `${p(c("duo status [runId]") + " hiển thị lượt chạy gần nhất, hoặc lượt được nêu tên: pha, số vòng lập plan và triển khai so với giới hạn, các finding còn mở, chi phí và token, mười hai bước gần nhất, các cảnh báo và thư mục của nó. Lượt chạy đang chờ bạn còn hiện lý do và lệnh " + c("duo resume … --decision") + " để trả lời.")}
${p(c("duo list") + " in mỗi lượt chạy một dòng, từ thư mục runs của workspace này. Cả hai lệnh đều không gọi agent và không cần repository Git.")}`,
    },
    {
      id: "setup",
      title: "Thiết lập: duo doctor và duo init",
      html: `${h3("doctor", "duo doctor")}
${p("Kiểm tra các CLI, cấu hình và workspace mà không gọi model, mỗi mục kiểm tra in một dòng: " + c("✓") + " đạt, " + c("✗") + " một mục bắt buộc không đạt, " + c("!") + " cảnh báo. Cuối cùng là " + c("doctor: ready") + " (mã thoát 0) hoặc " + c("doctor: problems found") + " (mã thoát 1). Hãy chạy nó sau khi nâng cấp Codex hoặc Claude Code.")}
${h3("init", "duo init")}
${ul([
  "Tạo " + c(".agentduo/config.yaml") + " trong workspace, hoặc giữ nguyên file đã có.",
  "Gợi ý các gate nó phát hiện được (script trong package.json, pytest, go test, cargo test, target test trong Makefile), ở dạng đã comment.",
  "Tạo " + c(".agentduo/.gitignore") + " để dữ liệu lượt chạy không vào Git.",
  "Ngoài repository Git, nó đề nghị chạy " + c("git init") + " (trong terminal), hoặc nhắc bạn chạy lệnh đó trước " + c("duo run") + ".",
])}`,
    },
    {
      id: "exit-codes",
      title: "Mã thoát",
      html: `${table({
  caption: "Mã thoát",
  head: ["Mã", "Ý nghĩa"],
  rows: [
    [c("0"), "Xong: lượt chạy đạt " + c("DONE") + ", hoặc lệnh (" + c("status") + ", " + c("list") + ", " + c("init") + ", " + c("doctor") + " báo ready, chat, " + c("--help") + ") thành công."],
    [c("1"), "Lỗi cấu hình hoặc môi trường: tùy chọn hay cấu hình không hợp lệ, thiếu nhiệm vụ, không đọc được file nhiệm vụ, thiếu CLI, không có repository Git, workspace đang bận, " + c("doctor") + " phát hiện vấn đề, quyết định mà lượt chạy không nhận. Không có gì mới được chạy."],
    [c("2"), "Lượt chạy đang chờ bạn quyết định (" + c("HUMAN_REVIEW") + "): ở chế độ plain, hoặc sau Decide later. Trả lời bằng " + c("duo resume") + "."],
    [c("3"), "Lượt chạy đã bị hủy (abort)."],
    [c("130"), "Lượt chạy đã dừng (" + kbd("q") + ", " + kbd("Ctrl") + "+" + kbd("C") + ", một tín hiệu). Có thể tiếp tục."],
  ],
})}
${code('duo --plain "Upgrade the logger"\ncase $? in\n  0) echo done ;;\n  2) duo status ;;          # waiting for a decision\n  130) duo resume ;;        # stopped; continue it\nesac', { lang: "sh", label: "Terminal" })}`,
    },
  ],
  related: ["learn/cli", "docs/slash-commands", "docs/decisions-resume", "docs/pipeline", "troubleshooting"],
});
