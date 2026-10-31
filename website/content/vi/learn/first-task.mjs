import { FIRST_TASK_PROMPT, firstTaskScript } from "../../../lib/tutorial.mjs";

export default ({ c, kbd, link, code, ex, p, ul, steps, note }) => ({
  title: "Tác vụ đầu tiên của bạn, từ đầu đến cuối",
  description: "Một lượt chạy pipeline AgentDuo hoàn chỉnh trên dự án Node.js nhỏ: tạo dự án, thêm test gate, chạy pipeline, theo dõi agent, xem diff, tiếp tục và commit.",
  lead: p("Bạn sẽ tạo một dự án nhỏ có một test lỗi, cho AgentDuo một test gate, và để hai agent lập kế hoạch, sửa, kiểm tra và review lỗi đó. Mất vài phút và một số ít lần gọi agent trên tài khoản của bạn."),
  sections: [
    {
      id: "before",
      title: "Trước khi bắt đầu",
      html: ul([
        `Claude Code và Codex đã được cài và đăng nhập, và AgentDuo đã được cài: ${link("learn/desktop", "ứng dụng desktop")}, ${link("learn/cli", c("duo"))} hoặc ${link("learn/vscode", "tiện ích VS Code")}.`,
        `Node.js và Git trên máy của bạn: test của dự án chạy bằng ${c("node --test")}, và pipeline cần một kho Git.`,
      ]),
    },
    {
      id: "create-project",
      title: "Tạo dự án",
      html: `${p("Dự án có một hàm định dạng số giây thành “1h 02m 05s”, và một lỗi: với từ một giờ trở lên, nó đếm mọi phút kể từ lúc bắt đầu. Hãy tạo ba tệp này trong một thư mục mới tên " + c("duo-first-task") + ", bằng bất kỳ trình soạn thảo nào:")}
${ex("first-task/initial/package.json", { label: "package.json" })}
${ex("first-task/initial/src/duration.js", { label: "src/duration.js" })}
${ex("first-task/initial/test/duration.test.js", { label: "test/duration.test.js" })}
${p("Tiếp theo là cấu hình AgentDuo, với một gate: AgentDuo chạy " + c("npm test") + " sau mỗi vòng triển khai và đưa kết quả cho reviewer.")}
${ex("config/first-task.yaml", { label: ".agentduo/config.yaml" })}
${p("Trên macOS, Linux, WSL hoặc Git Bash, script này tạo cả bốn tệp cùng lúc:")}
${code(firstTaskScript(), { lang: "sh", label: "Terminal (POSIX shell)" })}`,
    },
    {
      id: "commit-start",
      title: "Khởi tạo kho Git",
      html: `${p("Trong thư mục " + c("duo-first-task") + " (các lệnh này cũng chạy được trong PowerShell):")}
${code('git init\ngit add .\ngit commit -m "Start: formatDuration with a failing test"', { lang: "sh", label: "Terminal" })}
${p("Nếu Git hỏi bạn là ai, hãy đặt " + c('git config user.name "Your Name"') + " và " + c('git config user.email "you@example.com"') + ", rồi commit lại.")}`,
    },
    {
      id: "see-it-fail",
      title: "Xem test thất bại",
      html: `${code("npm test", { lang: "sh", label: "Terminal" })}
${p("Hai test đạt và một test thất bại. Trong output:")}
${code(`✖ hours, minutes and seconds
  + '1h 62m 05s'
  - '1h 02m 05s'
ℹ tests 3
ℹ pass 2
ℹ fail 1`, { label: "Output (excerpt)" })}
${p("Với lệnh terminal, " + c("duo doctor") + " giờ cũng liệt kê gate: " + c("gate 'tests': npm test") + ".")}`,
    },
    {
      id: "run",
      title: "Chạy pipeline",
      html: `${p("Bên triển khai phải sửa một tệp. Để nó làm vậy mà không hỏi cho mỗi lần sửa, hãy chuyển chế độ của Claude sang <em>Edit automatically</em> trước. Nếu giữ <em>Manual</em>, hãy trả lời mỗi yêu cầu cấp quyền bằng <em>Allow once</em>.")}
${steps([
  ["Terminal", `${p("Mở chat trong thư mục dự án, chuyển chế độ, và giao tác vụ:")}${code(`duo\n/mode acceptEdits\n/pipeline ${FIRST_TASK_PROMPT.en}`, { label: "Terminal, then the chat" })}${p("Hoặc, không qua chat, chỉ bằng một lệnh: " + c(`duo --accept-edits "${FIRST_TASK_PROMPT.en}"`))}`],
  ["Ứng dụng desktop", p("Chọn <em>Open project…</em> và chọn " + c("duo-first-task") + ". Đặt chế độ quyền dưới ô nhập thành <em>Edit automatically</em>, chọn <em>Pipeline</em> trong menu người nhận (hoặc gõ " + c("/pipeline") + " trước tác vụ), và gửi tác vụ ở trên.")],
  ["VS Code", p("Mở thư mục, mở chat, chọn <em>Edit automatically</em> trên chip chế độ và <em>Pipeline</em> trên chip người nhận, rồi gửi tác vụ.")],
])}`,
    },
    {
      id: "watch",
      title: "Điều gì xảy ra",
      html: `${p("Các bước xuất hiện lần lượt, mỗi bước kèm agent đang làm và những gì nó chuyển cho bước sau. Nội dung chính xác khác nhau giữa các lượt chạy; trình tự là:")}
${steps([
  ["PLAN", p("Codex đọc dự án và viết kế hoạch: mục tiêu, các bước, tiêu chí chấp nhận (ba test đạt, giữ nguyên định dạng) và các rủi ro.")],
  ["PLAN_REVIEW", p("Claude Code đối chiếu kế hoạch với mã. Nếu yêu cầu thay đổi, Codex sẽ chỉnh lại.")],
  ["PLAN_FINALIZE", p("Codex duyệt kế hoạch cuối cùng.")],
  ["IMPLEMENT", p("Claude Code sửa " + c("src/duration.js") + " và báo cáo những gì đã làm.")],
  ["VERIFY", p("AgentDuo chạy " + c("npm test") + ". Nếu gate thất bại, công việc quay lại Claude Code trước khi có bất kỳ review nào.")],
  ["CODE_REVIEW", p("Codex review diff cùng kết quả gate. Nó chấp thuận, hoặc gửi các phát hiện trở lại cho một vòng nữa.")],
])}
${p("Lượt chạy kết thúc bằng " + c("DONE") + " khi Codex chấp thuận, không còn phát hiện chặn nào và gate đạt. Nếu thay vào đó nó dừng lại để hỏi bạn, xem " + link("docs/decisions-resume", "Quyết định, dừng và tiếp tục") + ".")}`,
    },
    {
      id: "review",
      title: "Xem lại kết quả",
      html: `${p("AgentDuo đã thay đổi working tree và không commit gì. Hãy xem thay đổi:")}
${code("git diff\nnpm test", { lang: "sh", label: "Terminal" })}
${p("Bạn sẽ thấy một thay đổi ở dòng tính phút, đại loại như:")}
${code(`-  const minutes = Math.floor(totalSeconds / 60);
+  const minutes = Math.floor((totalSeconds % 3600) / 60);`, { label: "git diff (excerpt)", lang: "diff" })}
${p("và " + c("ℹ pass 3") + ", " + c("ℹ fail 0") + " từ các test. Các agent có thể viết cách sửa khác; điều cần giữ vững là các test.")}
${ul([
  `Trong chat, ${c("/diff")} hiển thị những gì lượt chạy đã thay đổi và ${c("/plan")} hiển thị kế hoạch cuối cùng. Trong ứng dụng desktop và VS Code, hãy mở <em>Changes</em> và <em>Plan</em>.`,
  `${c("duo status")} hiển thị các bước và chi phí của lượt chạy; ${c("duo list")} liệt kê các lượt chạy của workspace. ${c("report.md")} của mỗi lượt nằm trong ${c(".agentduo/runs/<run-id>/")}.`,
])}`,
    },
    {
      id: "stop-resume",
      title: "Thử dừng và tiếp tục",
      html: `${p("Chạy lại tác vụ trên một bản sao mới (hoặc một tác vụ nhỏ khác), và nhấn " + kbd("Esc") + " (hoặc Stop) khi một bước đang chạy. Bước đó kết thúc và lượt chạy giữ nguyên trạng thái. Sau đó:")}
${code("/resume", { label: "duo" })}
${p("chạy lại bước đã dừng. Sau khi đóng chat, " + c("duo resume") + " trong cùng thư mục tiếp tục lượt chạy gần nhất, và ứng dụng desktop liệt kê nó dưới <em>Resumable runs</em>. " + c("/resume <note>") + " thêm ghi chú cho các agent.")}`,
    },
    {
      id: "commit",
      title: "Commit bản sửa",
      html: `${p("Khi diff trông ổn, hãy tự commit. Dữ liệu chạy dưới " + c(".agentduo/runs/") + " có " + c(".gitignore") + " riêng, nên nó không nằm trong commit.")}
${code('git add -A\ngit commit -m "Fix minutes in formatDuration"', { lang: "sh", label: "Terminal" })}
${note(p("Lần tới hãy dùng dự án của chính bạn. Thêm lệnh test của bạn làm gate, bắt đầu với tác vụ nhỏ, và giữ chế độ Manual cho đến khi bạn biết những công cụ nào muốn cho Claude dùng mà không cần hỏi. " + link("docs/permissions", "Quyền") + " hướng dẫn cách cho phép chúng."), "tip")}`,
    },
  ],
  related: ["docs/pipeline", "docs/decisions-resume", "docs/configuration", "docs/permissions"],
  next: p(link("docs", "Đọc tài liệu") + ", bắt đầu với " + link("docs/concepts", "cách AgentDuo hoạt động") + "."),
});
